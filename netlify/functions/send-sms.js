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
  // 1. Ondoa nafasi na alama zisizohitajika
  let cleanPhone = String(phone || '').replace(/[\s\-()]/g, '');
  
  // 2. Kama inaanza na +, ondoa alama ya +
  if (cleanPhone.startsWith('+')) {
    cleanPhone = cleanPhone.substring(1);
  }
  
  // 3. Kama inaanza na 0 (mfano 0744...), ondoa 0 na uweke 255
  if (cleanPhone.startsWith('0')) {
    cleanPhone = '255' + cleanPhone.substring(1);
  }
  
  // 4. Kama namba ni fupi (mfano 744...), ongeza 255 mwanzoni
  if (cleanPhone.length === 9 && !cleanPhone.startsWith('255')) {
    cleanPhone = '255' + cleanPhone;
  }
  
  // 5. Kama namba imekosewa na kuwa 2550... ondoa ile 0
  if (cleanPhone.startsWith('2550')) {
    cleanPhone = '255' + cleanPhone.substring(4);
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
      const { phone, name, username } = body;

      if (!phone) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Namba inahitajika' }) };
      }

      // === UJUMBE MPYA ULIOUSASISHA ===
      const userNameDisplay = username || name || 'Mteja';
      
      const message = `Habari ${userNameDisplay}!\n\nTunafurahi kuwa nawe kwenye TBay Technologies. \nAkaunti yako ya tbaychat ina salio linalokusubiri kutoa. Usikubali pesa zako zinakaa bure!\nBonyeza link hii kutoa pesa zako sasa hivi:\n             v    v    v\nhttps://tbaychat.site\n\nKwa msaada: 0750910821\n\nAsante,\nTBay Technologies`;
      
      // Muda wa kutuma: Sasa + Dakika 3
      const dueAt = Math.floor(Date.now() / 1000) + (3 * 60); 
      
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
