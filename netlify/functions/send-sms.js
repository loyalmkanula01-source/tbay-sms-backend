const axios = require('axios');
const { Redis } = require('@upstash/redis');

// Hizi zitakuja kwenye Netlify Environment Variables
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

// Function ya kutuma SMS kwa Beem
async function sendSms(phone, message) {
  let cleanPhone = String(phone || '').replace(/[\s\-()]/g, '');
  if (cleanPhone.startsWith('+')) cleanPhone = cleanPhone.substring(1);
  if (cleanPhone.startsWith('0')) cleanPhone = '255' + cleanPhone.substring(1);

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
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${beemAuth()}`,
        },
        timeout: 15000,
      }
    );
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

exports.handler = async (event, context) => {
  // 1. Cron Job inapiga hii endpoint kuangalia kama muda umefika
  if (event.httpMethod === 'GET' && event.queryStringParameters?.action === 'process') {
    const secret = event.headers['x-cron-secret'] || event.queryStringParameters?.secret;
    if (secret !== CRON_SECRET) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const now = Math.floor(Date.now() / 1000);
    
    // Tumetumia zrange badala ya zrangebyscore
    const dueJobs = await redis.zrange('sms:queue', 0, now, { byScore: true, limit: { offset: 0, count: 20 } });
    
    for (const jobId of dueJobs) {
      const jobData = await redis.get(`sms:job:${jobId}`);
      if (jobData) {
        const parsed = typeof jobData === 'string' ? JSON.parse(jobData) : jobData;
        await sendSms(parsed.phone, parsed.message);
        await redis.del(`sms:job:${jobId}`);
        await redis.zrem('sms:queue', jobId);
      }
    }

    return { statusCode: 200, body: JSON.stringify({ message: 'Processed', count: dueJobs.length }) };
  }

  // 2. Mtumiaji anapojisajili (POST kutoka kwenye index.html)
  if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body);
      const { phone, name, username } = body; // Tunapokea username pia

      if (!phone) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Namba inahitajika' }) };
      }

      // === UJUMBE MPYA ULIOOMBA ===
      const userNameDisplay = username || name || 'Mteja';
      
      const message = `Karibu tena ${userNameDisplay}!\n\nTunafurahi kuwa nawe kwenye TBay Technologies. Tumegundua kuwa una salio la kutoa kwenye akaunti yako.\n\nUsikubali pesa zako zinakaa bure. Gusa link hapa chini ili kutoa pesa zako moja kwa moja:\n           ↓    ↓    ↓\nhttps://tbaychat.site\n\nTunafurahi kukuona ukifanikiwa!\n\nKwa msaada zaidi:\nWhatsApp: +255 750 910 821\nSMS za kawaida: +255 750 910 821\n\nAsante,\nTBay Technologies`;
      
      // Muda wa kutuma: Sasa + Dakika 3
      const dueAt = Math.floor(Date.now() / 1000) + (3 * 60); // 3 * 60 seconds = Dakika 3
      
      const jobId = `sms:${phone}:${Date.now()}`;

      await redis.set(`sms:job:${jobId}`, JSON.stringify({ phone, message }));
      await redis.zadd('sms:queue', { score: dueAt, member: jobId });

      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, message: 'SMS scheduled in 3 minutes' }),
      };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
