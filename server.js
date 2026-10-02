const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const BEEM_API_KEY = process.env.BEEM_API_KEY;
const BEEM_SECRET_KEY = process.env.BEEM_SECRET_KEY;
const BEEM_SENDER_NAME = process.env.BEEM_SENDER_NAME || 'INFO';

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
        console.log(`SMS imetumwa kwa ${cleanPhone}`);
        return { success: true };
    } catch (error) {
        console.error('Kosa la SMS:', error.response?.data || error.message);
        return { success: false };
    }
}

app.get('/', (req, res) => {
    res.json({ status: 'TBay SMS Backend is running!' });
});

app.post('/api/place-order', async (req, res) => {
    const { phone, orderName, payoutTsh } = req.body;
    if (!phone) return res.status(400).json({ error: 'Namba inahitajika' });

    console.log(`Odda mpya kutoka ${phone}`);

    await sendSms(phone, "Hongera! Odda Yako imepokelewa kikamilifu utaendelea kupokea Taharifa kuhusu odda yako mpaka itakaponunuliwa. Asante kwa kuichagua TBay Technologies");

    setTimeout(async () => {
        await sendSms(phone, `Habari! Odda yako ya ${orderName} imesafirishwa. Itafika hivi karibuni. Asante kwa kutumia TBay Technologies.`);
    }, 10 * 60 * 1000);

    setTimeout(async () => {
        await sendSms(phone, `Hongera! Odda yako imenunuliwa kikamilifu. Umelipwa asilimia 20 ya odda yako sawa na TSh ${payoutTsh}. Tembelea akaunti yako ya TBay kuthibitisha malipo yako. Asante.`);
    }, 50 * 60 * 1000);

    res.json({ success: true, message: 'Odda imepokelewa. SMS 3 zitatumwa kwa muda uliopangwa.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server inaendesha kwenye port ${PORT}`);
});
