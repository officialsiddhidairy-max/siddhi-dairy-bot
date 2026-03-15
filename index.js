require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object) {
        if (body.entry?.[0]?.changes?.[0]?.value?.messages) {
            const changes = body.entry[0].changes[0].value;
            const message = changes.messages[0];
            const contact = changes.contacts?.[0];
            if (message.type === 'text') {
                const phone = message.from;
                const text = message.text.body;
                const name = contact?.profile?.name || 'Customer';
                processMessage(phone, text, name).catch(console.error);
            }
        }
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

app.get('/privacy', (req, res) => {
    res.send('<h1>Privacy Policy - Siddhi Dairy</h1><p>We collect your phone number and name to process orders.</p>');
});

app.listen(PORT, () => console.log(`Siddhi Dairy Bot listening on port ${PORT}`));
