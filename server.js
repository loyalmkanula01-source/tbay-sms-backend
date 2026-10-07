const express = require('express');
const cors = require('cors');
const axios = require('axios');
const webpush = require('web-push');
const { Redis } = require('@upstash/redis');
const app = express();

app.use(cors());
app.use(express.json());

// ============================================
// UPSTASH REDIS
// ============================================
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ============================================
// VAPID KEYS
// ============================================
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

webpush.setVapidDetails(
  'mailto:loyalmkanula01@gmail.com',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// ============================================
// BEEM SMS CONFIG
// ============================================
const BEEM_API_KEY = process.env.BEEM_API_KEY;
const BEEM_SECRET_KEY = process.env.BEEM_SECRET_KEY;
const BEEM_SENDER_NAME = process.env.BEEM_SENDER_NAME || 'INFO';

// ============================================
// SMS FUNCTION
// ============================================
async function sendSms(phone, message) {
    try {
        let cleanPhone = phone.replace(/[\s\-()]/g, '');
        if (cleanPhone.startsWith('0')) cleanPhone = '255' + cleanPhone.substring(1);
        if (cleanPhone.startsWith('+')) cleanPhone = cleanPhone.substring(1);

        const auth = Buffer.from(`${BEEM_API_KEY}:${BEEM_SECRET_KEY}`).toString('base64');

        await axios.post(
            'https://apisms.beem.africa/v1/send',
            {
                source_addr: BEEM_SENDER_NAME,
                schedule_time: '',
                encoding: 0,
                message: message,
                recipients: [{ recipient_id: 1, dest_addr: cleanPhone }]
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Basic ${auth}`
                }
            }
        );
        console.log(`✅ SMS imetumwa kwa ${cleanPhone}`);
        return { success: true };
    } catch (error) {
        console.error('❌ Kosa la SMS:', error.response?.data || error.message);
        return { success: false };
    }
}

// ============================================
// WEB PUSH FUNCTION
// ============================================
async function sendWebPush(phone, title, body) {
    try {
        const subscription = await redis.get(`sub:${phone}`);
        
        if (!subscription) {
            console.log(`⚠️ Hakuna subscription kwa ${phone}`);
            return { success: false, reason: 'no_subscription' };
        }

        const parsedSub = typeof subscription === 'string' ? JSON.parse(subscription) : subscription;

        await webpush.sendNotification(parsedSub, JSON.stringify({
            title: title,
            body: body,
            icon: 'https://cdn-icons-png.flaticon.com/512/869/869636.png'
        }));
        console.log(`✅ Web Push imetumwa kwa ${phone}`);
        return { success: true };
    } catch (error) {
        console.error('❌ Kosa la Web Push:', error.message);
        if (error.statusCode === 410 || error.statusCode === 404) {
            await redis.del(`sub:${phone}`);
        }
        return { success: false };
    }
}

// ============================================
// ROUTES
// ============================================
app.get('/', async (req, res) => {
    try {
        const count = await redis.dbsize();
        res.json({ 
            status: 'TBay Backend is running!',
            sms: 'Beem',
            webpush: 'Enabled',
            database: 'Upstash Redis',
            subscribers: count
        });
    } catch (e) {
        res.json({ status: 'TBay Backend is running!', error: e.message });
    }
});

app.get('/api/vapid-public-key', (req, res) => {
    res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/subscribe', async (req, res) => {
    const { phone, subscription } = req.body;
    
    if (!phone || !subscription) {
        return res.status(400).json({ error: 'Phone na subscription vinahitajika' });
    }

    try {
        await redis.set(`sub:${phone}`, JSON.stringify(subscription));
        
        const count = await redis.dbsize();
        console.log(`✅ Mteja amejisajili: ${phone} (Jumla: ${count})`);

        res.json({ 
            success: true, 
            message: 'Umejisajili kwa notifications',
            total: count
        });
    } catch (error) {
        console.error('❌ Kosa la kuhifadhi:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/place-order', async (req, res) => {
    const { phone, orderName, payoutTsh } = req.body;
    if (!phone) return res.status(400).json({ error: 'Namba inahitajika' });

    console.log(`📦 Odda mpya kutoka ${phone}`);

    const sms1 = "Hongera! Odda Yako imepokelewa kikamilifu utaendelea kupokea Taharifa kuhusu odda yako mpaka itakaponunuliwa. Asante kwa kuichagua TBay Technologies";
    await sendSms(phone, sms1);
    await sendWebPush(phone, '🛒 Odda Imepokelewa!', 'Hongera! Odda yako imepokelewa kikamilifu.');

    setTimeout(async () => {
        const sms2 = `Habari! Odda yako ya ${orderName} imesafirishwa. Itafika hivi karibuni. Asante kwa kutumia TBay Technologies.`;
        await sendSms(phone, sms2);
        await sendWebPush(phone, '🚚 Odda Imesafirishwa!', `Odda yako ya ${orderName} imesafirishwa.`);
    }, 10 * 60 * 1000);

    setTimeout(async () => {
        const sms3 = `Hongera! Odda yako imenunuliwa kikamilifu. Umelipwa asilimia 20 ya odda yako sawa na TSh ${payoutTsh}. Tembelea akaunti yako ya TBay kuthibitisha malipo yako. Asante.`;
        await sendSms(phone, sms3);
        await sendWebPush(phone, '🎉 Odda Imenunuliwa!', `Umelipwa TSh ${payoutTsh}. Angalia akaunti yako.`);
    }, 50 * 60 * 1000);

    res.json({ 
        success: true, 
        message: 'Odda imepokelewa. SMS 3 + Web Push 3 zitatumwa.'
    });
});
// ============================================
// TEST ENDPOINT - Tuma notification moja
// ============================================
app.post('/api/test-push', async (req, res) => {
    const { phone } = req.body;
    
    if (!phone) {
        return res.status(400).json({ error: 'Namba inahitajika' });
    }

    console.log(`🧪 Test notification kwa ${phone}`);

    // Angalia kama subscription ipo
    const subscription = await redis.get(`sub:${phone}`);
    
    if (!subscription) {
        console.log(`❌ Hakuna subscription kwa ${phone}`);
        return res.json({ 
            success: false, 
            error: 'Hakuna subscription. Fungua website na uweke odda kwanza.',
            phone: phone
        });
    }

    console.log(`✅ Subscription ipo kwa ${phone}`);

    // Tuma notification
    try {
        const parsedSub = typeof subscription === 'string' ? JSON.parse(subscription) : subscription;

        await webpush.sendNotification(parsedSub, JSON.stringify({
            title: '🧪 Test Notification',
            body: 'Hongera! Mfumo wako wa TBay unafanya kazi!',
            icon: 'https://cdn-icons-png.flaticon.com/512/869/869636.png'
        }));

        console.log(`✅ Test notification imetumwa kwa ${phone}`);
        res.json({ 
            success: true, 
            message: 'Test notification imetumwa!',
            phone: phone
        });
    } catch (error) {
        console.error('❌ Kosa la test notification:', error.message);
        res.json({ 
            success: false, 
            error: error.message 
        });
    }
});

// ============================================
// ANZISHA SERVER
// ============================================
// ============================================
// ANZISHA SERVER
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server inaendesha kwenye port ${PORT}`);
    console.log(`📱 SMS: Beem`);
    console.log(`🔔 Web Push: Enabled`);
    console.log(`💾 Database: Upstash Redis`);
});
