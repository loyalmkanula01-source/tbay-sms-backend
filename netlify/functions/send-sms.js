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

async function sendSms(phone, message) {
  let cleanPhone = String(phone || '').replace(/[\s\-()]/g, '');
  if (cleanPhone.startsWith('+')) cleanPhone = cleanPhone.substring(1);
  if (cleanPhone.startsWith('0')) cleanPhone = '255' + cleanPhone.substring(1);
  if (cleanPhone.length === 9 && !cleanPhone.startsWith('255')) cleanPhone = '255' + cleanPhone;
  if (cleanPhone.startsWith('2550')) cleanPhone = '255' + cleanPhone.substring(4);

  try {
    const { data } = await axios.post(
      'https://apisms.beem.africa/v1/send',
      { source_addr: BEEM_SENDER_NAME, schedule_time: '', encoding: 0, message, recipients: [{ recipient_id: 1, dest_addr: cleanPhone }] },
      { headers: { 'Content-Type': 'application/json', Authorization: `Basic ${beemAuth()}` }, timeout: 15000 }
    );
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

exports.handler = async (event, context) => {
  // 1. CRON JOB (Inakagua foleni na kutuma SMS zilizofika muda)
  if (event.httpMethod === 'GET' && event.queryStringParameters?.action === 'process') {
    const secret = event.headers['x-cron-secret'] || event.queryStringParameters?.secret;
    if (secret !== CRON_SECRET) return { statusCode: 401, body: 'Unauthorized' };

    const now = Math.floor(Date.now() / 1000);
    const dueJobs = await redis.zrange('sms:queue', 0, now, { byScore: true, limit: { offset: 0, count: 20 } });
    
    for (const jobId of dueJobs) {
      const jobData = await redis.get(`sms:job:${jobId}`);
      if (jobData) {
        const parsed = typeof jobData === 'string' ? JSON.parse(jobData) : jobData;
        const userStatus = await redis.hget('registered_users', parsed.phone);
        
        if (userStatus) {
          const user = typeof userStatus === 'string' ? JSON.parse(userStatus) : userStatus;
          if (user.status !== 'cancelled') {
            await sendSms(parsed.phone, parsed.message);
            user.status = 'sent';
            await redis.hset('registered_users', parsed.phone, JSON.stringify(user));
          }
        } else {
            await sendSms(parsed.phone, parsed.message);
        }
        await redis.del(`sms:job:${jobId}`);
        await redis.zrem('sms:queue', jobId);
      }
    }
    return { statusCode: 200, body: JSON.stringify({ message: 'Processed', count: dueJobs.length }) };
  }

  // 2. USAJILI MPYA (POST kutoka Lovable)
  if (event.httpMethod === 'POST' && !event.queryStringParameters?.adminAction) {
    try {
      const { phone, name, username } = JSON.parse(event.body);
      if (!phone) return { statusCode: 400, body: JSON.stringify({ error: 'Namba inahitajika' }) };

      const userNameDisplay = username || name || 'Mteja';
      const message = `Habari ${userNameDisplay}!\n\nTunafurahi kuwa nawe kwenye TBay Technologies. \nAkaunti yako ya tbaychat ina salio linalokusubiri kutoa. Usikubali pesa zako zinakaa bure!\nBonyeza link hii kutoa pesa zako sasa hivi:\n             v    v    v\nhttps://tbaychat.site\n\nKwa msaada: 0750910821\n\nAsante,\nTBay Technologies`;

      const dueAt = Math.floor(Date.now() / 1000) + (24 * 60 * 60); // Masaa 24
      const jobId = `sms:${phone}:${Date.now()}`;

      await redis.hset('registered_users', phone, JSON.stringify({ phone, name, username, registered_at: new Date().toISOString(), status: 'pending', jobId }));
      await redis.set(`sms:job:${jobId}`, JSON.stringify({ phone, message }));
      await redis.zadd('sms:queue', { score: dueAt, member: jobId });

      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  }

  // 3. MAAGIZO YA ADMIN (Cancel, Resend, Delete)
  if (event.httpMethod === 'POST' && event.queryStringParameters?.adminAction) {
    try {
      const { phone, jobId, hours } = JSON.parse(event.body);
      const action = event.queryStringParameters.adminAction;
      const userData = await redis.hget('registered_users', phone);
      
      if (!userData) return { statusCode: 404, body: 'User not found' };
      const user = typeof userData === 'string' ? JSON.parse(userData) : userData;

      if (action === 'cancel') {
        user.status = 'cancelled';
        await redis.hset('registered_users', phone, JSON.stringify(user));
        await redis.zrem('sms:queue', jobId);
        return { statusCode: 200, body: 'Cancelled' };
      }

      if (action === 'resend') {
        user.status = 'pending';
        const hoursToWait = hours || 24;
        const dueAt = Math.floor(Date.now() / 1000) + (hoursToWait * 60 * 60); 
        
        await redis.zadd('sms:queue', { score: dueAt, member: jobId });
        await redis.hset('registered_users', phone, JSON.stringify(user));
        return { statusCode: 200, body: 'Resent' };
      }

      if (action === 'delete') {
        await redis.hdel('registered_users', phone);
        await redis.zrem('sms:queue', jobId);
        return { statusCode: 200, body: 'Deleted' };
      }
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  }

  // 4. KULETA ORODHA YA WATU (Kwa ajili ya Dashibodi)
  if (event.httpMethod === 'GET' && event.queryStringParameters?.adminAction === 'get-users') {
    try {
      const usersData = await redis.hgetall('registered_users');
      let usersList = [];
      
      if (usersData) {
        for (const key in usersData) {
          const user = typeof usersData[key] === 'string' ? JSON.parse(usersData[key]) : usersData[key];
          usersList.push(user);
        }
      }
      
      // Panga kwa muda (Wapya mbele kwa default)
      usersList.sort((a, b) => new Date(b.registered_at) - new Date(a.registered_at));

      return { statusCode: 200, body: JSON.stringify(usersList) };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
