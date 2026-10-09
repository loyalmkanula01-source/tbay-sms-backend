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

// Redis keys
const K = {
  wallet: (phone) => `wallet:${phone}`,     // HASH: balance, netProfit (TSh)
  customer: (phone) => `customer:${phone}`, // Jina la mteja katika Redis
  sub: (phone) => `sub:${phone}`,
  subs: 'subscribers',              // SET ya namba zote zenye subscription
  queue: 'sms:queue',               // ZSET: member=jobId, score=muda wa kutuma (ms)
  job: (id) => `sms:job:${id}`,     // JSON ya kazi moja
  order: (id) => `order:${id}`,     // JSON ya oda + hali ya SMS 1–4
  history: 'sms:history',           // LIST ya SMS zote (mpya kwanza)
  phoneHistory: (p) => `sms:history:${p}`,
  cronLock: 'sms:cron:lock',
};

const HISTORY_LIMIT = 500;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2 * 60 * 1000;
const BATCH_SIZE = 20;
const SMS2_DELAY_MS = 10 * 60 * 1000;
const SMS3_DELAY_MS = 50 * 60 * 1000;
const SMS4_DELAY_MS = 24 * 60 * 60 * 1000;

// Siri ya cron/admin (weka CRON_SECRET kwenye Render env)
const CRON_SECRET = process.env.CRON_SECRET || '';
function checkSecret(req, res) {
  const key = req.query.key || req.headers['x-cron-key'];
  if (!CRON_SECRET || key !== CRON_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// ============================================
// VAPID KEYS
// ============================================
const VAPID_PUBLIC_KEY = (process.env.VAPID_PUBLIC_KEY || '').trim().replace(/\s/g, '');
const VAPID_PRIVATE_KEY = (process.env.VAPID_PRIVATE_KEY || '').trim().replace(/\s/g, '');
webpush.setVapidDetails('mailto:loyalmkanula01@gmail.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// ============================================
// BEEM CONFIG
// ============================================
const BEEM_API_KEY = process.env.BEEM_API_KEY;
const BEEM_SECRET_KEY = process.env.BEEM_SECRET_KEY;
const BEEM_SENDER_NAME = process.env.BEEM_SENDER_NAME || 'INFO';
const beemAuth = () => Buffer.from(`${BEEM_API_KEY}:${BEEM_SECRET_KEY}`).toString('base64');

// ============================================
// HELPERS
// ============================================
function normalizePhone(phone) {
  let p = String(phone || '').replace(/[\s\-()]/g, '');
  if (p.startsWith('+')) p = p.substring(1);
  if (p.startsWith('0')) p = '255' + p.substring(1);
  return p;
}
const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function cleanName(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 120) : '';
}

async function resolveCustomerName(phone, suppliedName) {
  const jinaLako = cleanName(suppliedName);
  if (jinaLako) {
    await redis.set(K.customer(phone), JSON.stringify({ phone, jinaLako, updatedAt: new Date().toISOString() }));
    return jinaLako;
  }
  const customer = parse(await redis.get(K.customer(phone)));
  return cleanName(customer?.jinaLako) || cleanName(customer?.fullName) || cleanName(customer?.name) || 'Mteja';
}

async function logHistory(entry) {
  const row = JSON.stringify(entry);
  await redis.lpush(K.history, row);
  await redis.ltrim(K.history, 0, HISTORY_LIMIT - 1);
  await redis.lpush(K.phoneHistory(entry.phone), row);
  await redis.ltrim(K.phoneHistory(entry.phone), 0, 99);
}

// ============================================
// SMS FUNCTION — inarudisha smsSent true/false + sababu
// ============================================
async function sendSms(phone, message) {
  const cleanPhone = normalizePhone(phone);
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
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${beemAuth()}` },
        timeout: 15000,
      }
    );
    // Beem hujibu { successful: true, request_id, code: 100, valid, invalid, duplicates }
    const ok = data && (data.successful === true || data.code === 100) && (data.invalid || 0) === 0;
    if (ok) {
      console.log(`✅ SMS imetumwa kwa ${cleanPhone} (request_id: ${data.request_id})`);
      return { smsSent: true, requestId: data.request_id || null, beem: data };
    }
    console.error(`❌ Beem imekataa SMS kwa ${cleanPhone}:`, data);
    return { smsSent: false, error: data?.message || 'Beem rejected', beem: data };
  } catch (error) {
    const err = error.response?.data || error.message;
    console.error(`❌ Kosa la SMS kwa ${cleanPhone}:`, err);
    return { smsSent: false, error: typeof err === 'string' ? err : JSON.stringify(err) };
  }
}

// ============================================
// WEB PUSH FUNCTION
// ============================================
async function sendWebPush(phone, title, body) {
  try {
    const sub = parse(await redis.get(K.sub(phone)));
    if (!sub) return { pushSent: false, reason: 'no_subscription' };
    await webpush.sendNotification(
      sub,
      JSON.stringify({ title, body, icon: 'https://cdn-icons-png.flaticon.com/512/869/869636.png' })
    );
    console.log(`✅ Web Push imetumwa kwa ${phone}`);
    return { pushSent: true };
  } catch (error) {
    console.error('❌ Kosa la Web Push:', error.message);
    if (error.statusCode === 410 || error.statusCode === 404) {
      await redis.del(K.sub(phone));
      await redis.srem(K.subs, phone);
    }
    return { pushSent: false, reason: error.message };
  }
}

// ============================================
// UJUMBE WA SMS 1–4
// ============================================
function fmtTsh(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function buildMessage(step, order) {
  const jinaLako = cleanName(order.jinaLako) || 'Mteja';
  const { orderName, payoutTsh } = order;
  const completedTsh = order.completedPayoutTsh ?? payoutTsh;
  if (step === 1) {
    return {
      sms: `Karibu TBay, ${jinaLako}! 🎉\n\nOda yako imepokelewa kikamilifu. Utaendelea kupokea taarifa kuhusu oda yako mpaka itakaponunuliwa.\n\nAsante kwa kutuamini — tunafurahi kukuhudumia!\n\nTBay Technologies`,
      title: '🛒 Odda Imepokelewa!',
      body: 'Hongera! Odda yako imepokelewa kikamilifu.',
    };
  }
  if (step === 2) {
    return {
      sms: `Habari ${jinaLako}!\n\nOda yako ya ${orderName} imesafirishwa. Itafika hivi karibuni.\n\nTunashukuru kwa kutumia TBay Technologies.\n\nKwa msaada WhatsApp: +255 750 910 821`,
      title: '🚚 Odda Imesafirishwa!',
      body: `Odda yako ya ${order.orderName} imesafirishwa.`,
    };
  }
  if (step === 3) return {
    sms: `Hongera ${jinaLako}! 🎉\n\nOda yako imenunuliwa kikamilifu. Umelipwa TSh ${fmtTsh(completedTsh)} (asilimia 20 ya oda yako).\n\nChukua pesa zako kupitia link hii:\n👉 tbay.shop\n\nAsante kwa kufanya biashara na TBay Technologies!\n\nKwa msaada WhatsApp: +255 750 910 821`,
    title: '🎉 Odda Imenunuliwa!',
    body: `Umelipwa TSh ${fmtTsh(completedTsh)}. Angalia akaunti yako.`,
  };
  if (step === 4) return {
    sms: `Karibu tena ${jinaLako}! 👋\n\nTunatarajia kukusaidia kutoa pesa zako kwenye akaunti yako ya TBay.\n\nKama bado hujatoa, ingia hapa:\n👉 tbay.shop\n\nTunafurahi kuwa nawe!\n\nTBay Technologies\nKwa msaada WhatsApp: +255 750 910 821`,
  };
  throw new Error('invalid_sms_step');
}

// Tuma hatua moja (1,2,3,4) ya oda na urekodi matokeo
function toTsh(v) {
  return Math.max(0, parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10) || 0);
}

async function runStep(orderId, step, attempt) {
  const order = parse(await redis.get(K.order(orderId)));
  if (!order) return { smsSent: false, error: 'order_not_found' };
  if (!cleanName(order.jinaLako)) order.jinaLako = await resolveCustomerName(order.phone);
  // Dakika 50: oda imenunuliwa — ongeza TSh Z kwenye Balance na Net Profit (mara moja tu)
  if (step === 3 && !order.completedCredited) {
    const z = toTsh(order.completedPayoutTsh ?? order.payoutTsh);
    const wp = order.walletPhone || order.phone;
    try {
      if (z > 0) {
        await redis.hincrby(K.wallet(wp), 'balance', z);
        await redis.hincrby(K.wallet(wp), 'netProfit', z);
      }
      order.completedCredited = true;
      await redis.set(K.order(orderId), JSON.stringify(order));
      console.log(`💰 +TSh ${z} kwa ${wp} (oda ${orderId} imenunuliwa)`);
    } catch (e) { console.error('❌ Wallet (SMS 3):', e.message); }
  }
  const msg = buildMessage(step, order);

  const sms = await sendSms(order.phone, msg.sms);
  // SMS 4 pekee; arifa za Web Push 1–3 hazibadilishwi.
  const push = step === 4 ? { pushSent: false } : await sendWebPush(order.phone, msg.title, msg.body);

  order.sms[step] = {
    smsSent: sms.smsSent,
    pushSent: push.pushSent,
    attempts: attempt,
    requestId: sms.requestId || null,
    error: sms.error || null,
    at: new Date().toISOString(),
  };
  await redis.set(K.order(orderId), JSON.stringify(order));

  await logHistory({
    orderId,
    phone: order.phone,
    step,
    message: msg.sms,
    smsSent: sms.smsSent,
    pushSent: push.pushSent,
    attempt,
    requestId: sms.requestId || null,
    error: sms.error || null,
    at: new Date().toISOString(),
  });
  return sms;
}

async function enqueue(orderId, step, dueAt, attempt = 1) {
  const jobId = `${orderId}:${step}:${attempt}`;
  await redis.set(K.job(jobId), JSON.stringify({ orderId, step, attempt }));
  await redis.zadd(K.queue, { score: dueAt, member: jobId });
}

// ============================================
// CRON — inachakata SMS zilizofika muda wake
// ============================================
async function processDueJobs() {
  // Lock moja tu kwa wakati mmoja (inaisha baada ya sekunde 55)
  const got = await redis.set(K.cronLock, '1', { nx: true, ex: 55 });
  if (!got) return { skipped: 'locked' };

  const results = [];
  try {
    const due = await redis.zrange(K.queue, 0, Date.now(), { byScore: true, offset: 0, count: BATCH_SIZE });
    for (const jobId of due) {
      // Dai kazi — zrem inarudisha 1 kwa mchakataji mmoja tu
      const claimed = await redis.zrem(K.queue, jobId);
      if (!claimed) continue;
      const job = parse(await redis.get(K.job(jobId)));
      await redis.del(K.job(jobId));
      if (!job) continue;

      const r = await runStep(job.orderId, job.step, job.attempt);
      if (!r.smsSent && job.attempt < MAX_ATTEMPTS && r.error !== 'order_not_found') {
        await enqueue(job.orderId, job.step, Date.now() + RETRY_DELAY_MS, job.attempt + 1);
      }
      results.push({ jobId, smsSent: r.smsSent });
    }
  } finally {
    await redis.del(K.cronLock);
  }
  return { processed: results.length, results };
}

// Wakati server iko macho, angalia kila dakika
setInterval(() => {
  processDueJobs().catch((e) => console.error('❌ Cron error:', e.message));
}, 60 * 1000);

// ============================================
// ROUTES
// ============================================
app.get('/', async (req, res) => {
  try {
    const subscribers = await redis.scard(K.subs);
    const pending = await redis.zcard(K.queue);
    res.json({
      status: 'TBay Backend is running!',
      sms: 'Beem',
      webpush: 'Enabled',
      database: 'Upstash Redis',
      subscribers,
      pendingSms: pending,
    });
  } catch (e) {
    res.json({ status: 'TBay Backend is running!', error: e.message });
  }
});

app.get('/api/vapid-public-key', (req, res) => res.json({ publicKey: VAPID_PUBLIC_KEY }));

app.post('/api/subscribe', async (req, res) => {
  const { subscription } = req.body;
  const phone = normalizePhone(req.body.phone);
  if (!phone || !subscription) return res.status(400).json({ error: 'Phone na subscription vinahitajika' });
  try {
    if (cleanName(req.body.jinaLako)) await resolveCustomerName(phone, req.body.jinaLako);
    await redis.set(K.sub(phone), JSON.stringify(subscription));
    await redis.sadd(K.subs, phone);
    const total = await redis.scard(K.subs);
    console.log(`✅ Mteja amejisajili: ${phone} (Jumla: ${total})`);
    res.json({ success: true, message: 'Umejisajili kwa notifications', total });
  } catch (error) {
    console.error('❌ Kosa la kuhifadhi:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/place-order', async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const { orderName, payoutTsh } = req.body;
  const completedPayoutTsh = req.body.completedPayoutTsh ?? payoutTsh;
  if (!phone) return res.status(400).json({ error: 'Namba inahitajika' });

  const orderId = newId();
  const now = Date.now();
  const jinaLako = await resolveCustomerName(phone, req.body.jinaLako);
  const walletPhone = normalizePhone(req.body.accountPhone) || phone;
  const order = { orderId, phone, walletPhone, jinaLako, orderName, payoutTsh, completedPayoutTsh, completedCredited: false, createdAt: new Date(now).toISOString(), sms: {} };
  await redis.set(K.order(orderId), JSON.stringify(order));
  console.log(`📦 Odda mpya ${orderId} kutoka ${phone}`);

  // Ongeza malipo kwenye Balance na Net Profit ya mteja (kwa namba ya akaunti)
  const amount = Math.max(0, parseInt(String(payoutTsh).replace(/[^0-9]/g, ''), 10) || 0);
  let wallet = null;
  try {
    if (amount > 0) {
      await redis.hincrby(K.wallet(walletPhone), 'balance', amount);
      await redis.hincrby(K.wallet(walletPhone), 'netProfit', amount);
    }
    wallet = await getWallet(walletPhone);
  } catch (e) { console.error('❌ Wallet:', e.message); }

  // Hifadhi SMS 2, 3 na 4 kabla ya kuwasiliana na Beem.
  await enqueue(orderId, 2, now + SMS2_DELAY_MS);
  await enqueue(orderId, 3, now + SMS3_DELAY_MS);
  await enqueue(orderId, 4, now + SMS4_DELAY_MS);

  // Website inasubiri sekunde 5 kabla ya POST; hapa SMS 1 inatumwa papo hapo.
  const first = await runStep(orderId, 1, 1);
  if (!first.smsSent) await enqueue(orderId, 1, now + RETRY_DELAY_MS, 2);

  res.json({
    success: true,
    orderId,
    smsSent: first.smsSent,
    error: first.smsSent ? null : first.error,
    wallet,
    message: 'Oda imepokelewa. SMS 2, 3 na 4 zimepangwa.',
  });
});

async function getWallet(phone) {
  const w = (await redis.hgetall(K.wallet(phone))) || {};
  return { phone, balance: parseInt(w.balance, 10) || 0, netProfit: parseInt(w.netProfit, 10) || 0 };
}

// Balance na Net Profit ya mteja mmoja (mteja mpya = 0)
app.get('/api/wallet', async (req, res) => {
  const phone = normalizePhone(req.query.phone);
  if (!phone) return res.status(400).json({ error: 'Namba inahitajika' });
  try { res.json(await getWallet(phone)); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

// Hali ya oda moja (SMS 1/2/3/4 smsSent true/false)
app.get('/api/order-status/:id', async (req, res) => {
  const order = parse(await redis.get(K.order(req.params.id)));
  if (!order) return res.status(404).json({ error: 'Oda haipo' });
  res.json(order);
});

// Cron ya nje (cron-job.org) — piga kila dakika 1
app.all('/api/cron/process-sms', async (req, res) => {
  if (!checkSecret(req, res)) return;
  try {
    res.json(await processDueJobs());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Salio la Beem
app.get('/api/beem-balance', async (req, res) => {
  if (!checkSecret(req, res)) return;
  try {
    const { data } = await axios.get('https://apisms.beem.africa/public/v1/vendors/balance', {
      headers: { Authorization: `Basic ${beemAuth()}` },
      timeout: 15000,
    });
    res.json({ success: true, credits: data?.data?.credit_balance ?? null, raw: data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.response?.data || e.message });
  }
});

// Historia ya SMS (zote au kwa namba moja)
app.get('/api/sms-history', async (req, res) => {
  if (!checkSecret(req, res)) return;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, HISTORY_LIMIT);
  const key = req.query.phone ? K.phoneHistory(normalizePhone(req.query.phone)) : K.history;
  const rows = await redis.lrange(key, 0, limit - 1);
  const items = rows.map(parse);
  res.json({
    total: items.length,
    sent: items.filter((r) => r.smsSent).length,
    failed: items.filter((r) => !r.smsSent).length,
    items,
  });
});

// ============================================
// TEST PUSH
// ============================================
app.post('/api/test-push', async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Namba inahitajika' });
  const r = await sendWebPush(phone, '🧪 Test Notification', 'Hongera! Mfumo wako wa TBay unafanya kazi!');
  if (r.pushSent) return res.json({ success: true, message: 'Test notification imetumwa!', phone });
  res.json({
    success: false,
    error: r.reason === 'no_subscription' ? 'Hakuna subscription. Fungua website na uweke odda kwanza.' : r.reason,
    phone,
  });
});

// Futa subscriptions pekee (historia na foleni ya SMS zinabaki)
app.post('/api/clear-subscriptions', async (req, res) => {
  if (!checkSecret(req, res)) return;
  try {
    const phones = await redis.smembers(K.subs);
    for (const p of phones) await redis.del(K.sub(p));
    await redis.del(K.subs);
    res.json({ success: true, message: `Subscriptions ${phones.length} zimefutwa.` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server inaendesha kwenye port ${PORT}`));
