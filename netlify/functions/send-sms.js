const axios = require('axios');
const { Redis } = require('@upstash/redis');

const BEEM_API_KEY = process.env.BEEM_API_KEY;
const BEEM_SECRET_KEY = process.env.BEEM_SECRET_KEY;
const BEEM_SENDER_NAME = process.env.BEEM_SENDER_NAME;
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;

const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

const beemAuth = () => Buffer.from(`${BEEM_API_KEY}:${BEEM_SECRET_KEY}`).toString('base64');

// JSON mbaya, tupu, au yenye nafasi isiharibu kazi nzima.
function safeJsonParse(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    console.warn('JSON batili imerukwa bila kusimamisha mfumo:', error.message);
    return fallback;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Safisha namba: ondoa alama zisizo tarakimu na sifuri baada ya 255 au mwanzoni.
function normalizePhone(phone) {
  let clean = String(phone || '').replace(/\D/g, '');
  if (!clean) return '';
  if (clean.startsWith('2550')) {
    clean = '255' + clean.slice(4).replace(/^0+/, '');
  } else if (clean.startsWith('0')) {
    clean = '255' + clean.slice(1).replace(/^0+/, '');
  } else if (clean.length === 9 && !clean.startsWith('255')) {
    clean = '255' + clean;
  }
  return clean;
}

function buildWelcomeMessage(user) {
  const userNameDisplay = (user && (user.username || user.name)) || 'Mteja';
  return `Habari ${userNameDisplay}!\n\nTunafurahi kuwa nawe kwenye TBay Technologies. \nAkaunti yako ya tbaychat ina salio linalokusubiri kutoa. Usikubali pesa zako zinakaa bure!\nBonyeza link hii kutoa pesa zako sasa hivi:\n             v    v    v\nhttps://tbaychat.site\n\nKwa msaada: 0750910821\n\nAsante,\nTBay Technologies`;
}

function createJobId(phone) {
  return `sms:${phone}:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveDelaySeconds(body) {
  const rawSeconds = Number(body.seconds);
  if (Number.isFinite(rawSeconds) && rawSeconds > 0) {
    return Math.max(1, Math.round(rawSeconds));
  }
  const rawHours = Number(body.hours);
  if (Number.isFinite(rawHours) && rawHours > 0) {
    return Math.max(1, Math.round(rawHours * 3600));
  }
  return 24 * 60 * 60;
}

async function removeJob(jobId) {
  if (!jobId) return;
  await redis.zrem('sms:queue', jobId);
  await redis.del(`sms:job:${jobId}`);
}

async function findUserRecord(rawPhone) {
  const candidates = [];
  if (rawPhone) candidates.push(String(rawPhone));
  const clean = normalizePhone(rawPhone);
  if (clean && !candidates.includes(clean)) candidates.push(clean);

  for (const key of candidates) {
    const raw = await redis.hget('registered_users', key);
    if (raw) {
      const user = safeJsonParse(raw);
      if (isRecord(user)) return { userKey: key, user };
    }
  }
  return null;
}

async function sendSms(phone, message) {
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone) {
    return { success: false, error: 'Namba ya simu si sahihi' };
  }

  try {
    const { data } = await axios.post(
      'https://apisms.beem.africa/v1/send',
      {
        source_addr: BEEM_SENDER_NAME,
        schedule_time: '',
        encoding: 0,
        message,
        recipients: [{ recipient_id: 1, dest_addr: cleanPhone }],
      },
      { headers: { 'Content-Type': 'application/json', Authorization: `Basic ${beemAuth()}` }, timeout: 15000 }
    );
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

exports.handler = async (event, context) => {
  // === CORS HEADERS ===
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: 'OK' };
  }

  // 1. CRON JOB (Inakagua foleni na kutuma SMS zilizofika muda)
  if (event.httpMethod === 'GET' && event.queryStringParameters?.action === 'process') {
    const secret = event.headers['x-cron-secret'] || event.queryStringParameters?.secret;
    if (secret !== CRON_SECRET) return { statusCode: 401, headers, body: 'Unauthorized' };

    const now = Math.floor(Date.now() / 1000);
    const dueJobs = await redis.zrange('sms:queue', 0, now, { byScore: true, limit: { offset: 0, count: 20 } });
    let sentCount = 0;

    for (const jobId of dueJobs) {
      try {
        const jobData = await redis.get(`sms:job:${jobId}`);
        if (!jobData) {
          console.warn(`Cron imefuta kazi hewa (hakuna data): ${jobId}`);
          await redis.zrem('sms:queue', jobId);
          continue;
        }

        const parsed = safeJsonParse(jobData);
        if (!isRecord(parsed) || !parsed.phone) {
          console.warn(`Cron imeruka na kufuta kazi yenye JSON batili: ${jobId}`);
          await removeJob(jobId);
          continue;
        }

        const found = await findUserRecord(parsed.userKey || parsed.phone);
        if (found) {
          const { userKey, user } = found;
          if (user.status === 'cancelled') {
            await removeJob(jobId);
            continue;
          }
          if (user.jobId && user.jobId !== jobId) {
            // Kazi ya zamani imeshapitwa na Resend mpya — ifute bila kutuma tena.
            await removeJob(jobId);
            continue;
          }

          const smsResult = await sendSms(parsed.phone, parsed.message || buildWelcomeMessage(user));
          if (smsResult.success) {
            user.status = 'sent';
            await redis.hset('registered_users', { [userKey]: JSON.stringify(user) });
            sentCount += 1;
          } else {
            console.error(`Beem SMS imeshindwa kwa ${parsed.phone}:`, smsResult.error);
          }
        } else {
          const smsResult = await sendSms(parsed.phone, parsed.message);
          if (smsResult.success) sentCount += 1;
        }

        await removeJob(jobId);
      } catch (error) {
        console.error(`Cron imeshindwa kusoma au kutekeleza kazi ${jobId}:`, error.message);
      }
    }
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ message: 'Processed', count: dueJobs.length, sent: sentCount }),
    };
  }

  // 2. USAJILI MPYA (POST kutoka Lovable)
  if (event.httpMethod === 'POST' && !event.queryStringParameters?.adminAction) {
    try {
      const body = safeJsonParse(event.body);
      if (!isRecord(body)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON ya usajili si sahihi' }) };

      const { phone, name, username } = body;
      const cleanPhone = normalizePhone(phone);
      if (!cleanPhone) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Namba inahitajika' }) };

      // Kama mtumiaji alishajisajili awali, futa kazi yake ya zamani isilete mgongano.
      const existing = await findUserRecord(cleanPhone);
      if (existing?.user?.jobId) {
        await removeJob(existing.user.jobId);
      }

      const message = buildWelcomeMessage({ name, username });
      const dueAt = Math.floor(Date.now() / 1000) + (24 * 60 * 60); // Masaa 24
      const jobId = createJobId(cleanPhone);

      await redis.set(`sms:job:${jobId}`, JSON.stringify({ phone: cleanPhone, userKey: cleanPhone, message }));
      await redis.zadd('sms:queue', { score: dueAt, member: jobId });
      await redis.hset('registered_users', {
        [cleanPhone]: JSON.stringify({
          phone: cleanPhone,
          name,
          username,
          registered_at: new Date().toISOString(),
          status: 'pending',
          jobId,
        }),
      });

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, phone: cleanPhone, jobId }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // 3. MAAGIZO YA ADMIN (Cancel, Resend, Delete)
  if (event.httpMethod === 'POST' && event.queryStringParameters?.adminAction) {
    try {
      const body = safeJsonParse(event.body);
      if (!isRecord(body)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON ya Admin si sahihi' }) };

      const { phone, jobId } = body;
      const action = event.queryStringParameters.adminAction;
      const found = await findUserRecord(phone);

      if (!found) return { statusCode: 404, headers, body: 'User not found' };
      const { userKey, user } = found;

      if (action === 'cancel') {
        user.status = 'cancelled';
        await redis.hset('registered_users', { [userKey]: JSON.stringify(user) });
        await removeJob(user.jobId);
        if (jobId && jobId !== user.jobId) await removeJob(jobId);
        return { statusCode: 200, headers, body: 'Cancelled' };
      }

      if (action === 'resend') {
        const cleanPhone = normalizePhone(user.phone || phone) || userKey;
        await removeJob(user.jobId);
        if (jobId && jobId !== user.jobId) await removeJob(jobId);

        const newJobId = createJobId(cleanPhone);
        const delaySeconds = resolveDelaySeconds(body);
        const dueAt = Math.floor(Date.now() / 1000) + delaySeconds;
        const message = buildWelcomeMessage(user);

        await redis.set(`sms:job:${newJobId}`, JSON.stringify({ phone: cleanPhone, userKey: cleanPhone, message }));
        await redis.zadd('sms:queue', { score: dueAt, member: newJobId });

        user.phone = cleanPhone;
        user.status = 'pending';
        user.jobId = newJobId;
        await redis.hset('registered_users', { [cleanPhone]: JSON.stringify(user) });
        if (userKey !== cleanPhone) {
          await redis.hdel('registered_users', userKey);
        }

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true, status: 'pending', phone: cleanPhone, jobId: newJobId, dueAt }),
        };
      }

      if (action === 'delete') {
        await redis.hdel('registered_users', userKey);
        await removeJob(user.jobId);
        if (jobId && jobId !== user.jobId) await removeJob(jobId);
        return { statusCode: 200, headers, body: 'Deleted' };
      }
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // 4. KULETA ORODHA YA WATU (Kwa ajili ya Dashibodi)
  if (event.httpMethod === 'GET' && event.queryStringParameters?.adminAction === 'get-users') {
    try {
      const usersData = await redis.hgetall('registered_users');
      const usersList = [];

      if (usersData) {
        for (const key in usersData) {
          try {
            const user = safeJsonParse(usersData[key]);
            if (isRecord(user)) usersList.push(user);
          } catch (error) {
            console.warn('Get-users imeruka rekodi:', error.message);
          }
        }
      }

      usersList.sort((a, b) => new Date(b.registered_at) - new Date(a.registered_at));
      return { statusCode: 200, headers, body: JSON.stringify(usersList) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, headers, body: 'Method Not Allowed' };
};
