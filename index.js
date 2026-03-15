require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');

const app = express();
app.use(express.json());

// Environment Variables
const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// API Clients
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Session Management
const sessions = new Map();
const SESSION_TIMEOUT = 30 * 60 * 1000;

function clearStaleSessions() {
    const now = Date.now();
    for (const [phone, session] of sessions.entries()) {
        if (now - session.lastActive > SESSION_TIMEOUT) {
            sessions.delete(phone);
        }
    }
}
setInterval(clearStaleSessions, 60 * 1000);

function getSession(phone) {
    if (!sessions.has(phone)) {
        sessions.set(phone, {
            state: 'IDLE',
            lastActive: Date.now(),
            customer_id: null,
            cart: [],
            tempData: {}
        });
    } else {
        sessions.get(phone).lastActive = Date.now();
    }
    return sessions.get(phone);
}

// Send WhatsApp Message
async function sendWhatsAppMessage(to, text) {
    try {
        await axios.post(
            `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to: to,
                type: 'text',
                text: { body: text }
            },
            {
                headers: {
                    Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
    } catch (error) {
        console.error('Error sending message:', error.response ? error.response.data : error.message);
    }
}

// Auto Customer Registration
async function ensureCustomerExists(phone, name) {
    const cleanPhone = phone.replace(/\D/g, '');
    let { data: customer } = await supabase
        .from('customers')
        .select('*')
        .eq('phone', cleanPhone)
        .single();

    if (!customer) {
        const { data: newCustomer, error: insertError } = await supabase
            .from('customers')
            .insert([{ full_name: name || 'Customer', phone: cleanPhone, status: 'active' }])
            .select()
            .single();
        if (insertError) {
            console.error('Error creating customer:', insertError);
            return null;
        }
        return newCustomer;
    }
    return customer;
}

// Main Message Processing
async function processMessage(phone, text, senderName) {
    const textLower = text.trim().toLowerCase();
    const session = getSession(phone);

    if (!session.customer_id) {
        const customer = await ensureCustomerExists(phone, senderName);
        if (customer) {
            session.customer_id = customer.id;
            session.customer_name = customer.full_name;
        }
    }

    const mainMenuText = `Siddhi Dairy mein aapka swagat hai! 🙏\nKripya ek option chunein:\n\n1️⃣ Products & Prices\n2️⃣ Order karein\n3️⃣ Order status check\n4️⃣ Subscription lena\n5️⃣ Payment info`;

    if (['hi', 'hello', 'namaste', 'menu', 'cancel'].includes(textLower)) {
        session.state = 'IDLE';
        session.cart = [];
        return await sendWhatsAppMessage(phone, mainMenuText);
    }

    switch (session.state) {
        case 'IDLE':
            if (textLower === '1') {
                const { data: products } = await supabase.from('products').select('*').eq('status', 'active');
                if (!products || products.length === 0) {
                    return await sendWhatsAppMessage(phone, "Abhi koi products available nahi hain.");
                }
                let msg = "🥛 *Hamare Products:*\n\n";
                products.forEach(p => {
                    msg += `ID: ${p.id} - ${p.name} (₹${p.price} per ${p.unit})\nStock: ${p.stock}\n\n`;
                });
                msg += "Order karne ke liye '2' dabayein.";
                return await sendWhatsAppMessage(phone, msg);

            } else if (textLower === '2') {
                session.state = 'ORDER_EXPECTING_ID';
                return await sendWhatsAppMessage(phone, "🛒 *Order karein*\nProduct ka ID likhein (e.g., 1, 2)");

            } else if (textLower === '3') {
                if (!session.customer_id) return await sendWhatsAppMessage(phone, "Aapka details nahi mila.");
                const { data: orders } = await supabase
                    .from('orders')
                    .select('*')
                    .eq('customer_id', session.customer_id)
                    .order('created_at', { ascending: false })
                    .limit(3);
                if (!orders || orders.length === 0) {
                    return await sendWhatsAppMessage(phone, "Aapka koi recent order nahi hai.");
                }
                let msg = "📦 *Aapke Recent Orders:*\n\n";
                orders.forEach(o => {
                    msg += `Order ID: ${o.id}\nStatus: ${o.status}\nAmount: ₹${o.total_amount}\n\n`;
                });
                return await sendWhatsAppMessage(phone, msg);

            } else if (textLower === '4') {
                const { data: plans } = await supabase.from('subscription_plans').select('*').eq('is_active', true);
                if (!plans || plans.length === 0) {
                    return await sendWhatsAppMessage(phone, "Abhi koi subscription plans active nahi hain.");
                }
                let msg = "📅 *Subscription Plans:*\n\n";
                plans.forEach(p => {
                    msg += `ID: ${p.id} - ${p.name}\n${p.description}\nPrice: ₹${p.price} for ${p.duration_days} days\n\n`;
                });
                msg += "Plan ka ID likhein.";
                session.state = 'SUBSCRIPTION_EXPECTING_ID';
                return await sendWhatsAppMessage(phone, msg);

            } else if (textLower === '5') {
                return await sendWhatsAppMessage(phone, "💳 *Payment Info:*\nUPI ID: siddhidairy@upi\nPhonePe/GPay: 9119868589\nPayment ke baad screenshot zaroor bhejein.");

            } else {
                try {
                    const completion = await openai.chat.completions.create({
                        model: "gpt-4o-mini",
                        messages: [
                            { role: "system", content: "You are customer support for 'Siddhi Dairy', an Indian dairy shop. Respond in Hinglish. Keep it short and guide people to type 'menu'." },
                            { role: "user", content: text }
                        ],
                        max_tokens: 150
                    });
                    const reply = completion.choices[0].message.content;
                    return await sendWhatsAppMessage(phone, reply);
                } catch (e) {
                    console.error('OpenAI Error:', e);
                    return await sendWhatsAppMessage(phone, "Menu dekhne ke liye 'menu' likhein.");
                }
            }
            break;

        case 'ORDER_EXPECTING_ID': {
            const productId = parseInt(textLower);
            if (isNaN(productId)) {
                return await sendWhatsAppMessage(phone, "Sahi product ID likhein. Ya 'cancel' likhein.");
            }
            const { data: product } = await supabase.from('products').select('*').eq('id', productId).single();
            if (!product) {
                return await sendWhatsAppMessage(phone, "Product nahi mila. Sahi ID likhein.");
            }
            session.tempData.selectedProduct = product;
            session.state = 'ORDER_EXPECTING_QTY';
            return await sendWhatsAppMessage(phone, `Aapne chuna: ${product.name} (₹${product.price}/${product.unit}).\nQuantity batayein (e.g., 1, 2, 5).`);
        }

        case 'ORDER_EXPECTING_QTY': {
            const qty = parseInt(textLower);
            if (isNaN(qty) || qty <= 0) {
                return await sendWhatsAppMessage(phone, "Sahi quantity likhein.");
            }
            const prod = session.tempData.selectedProduct;
            session.cart.push({
                product_id: prod.id,
                product_name: prod.name,
                unit_price: prod.price,
                quantity: qty,
                total_price: prod.price * qty
            });
            session.tempData.selectedProduct = null;
            session.state = 'ORDER_CONFIRM_OR_MORE';
            return await sendWhatsAppMessage(phone, "Item cart mein add ho gaya! 🛒\nAur kuch order karna hai? (yes/no)");
        }

        case 'ORDER_CONFIRM_OR_MORE':
            if (['yes', 'ha', 'haan'].includes(textLower)) {
                session.state = 'ORDER_EXPECTING_ID';
                return await sendWhatsAppMessage(phone, "Naye product ka ID likhein.");
            } else {
                let totalAmount = 0;
                let summary = "📝 *Order Summary:*\n\n";
                session.cart.forEach(item => {
                    summary += `${item.product_name} x ${item.quantity} = ₹${item.total_price}\n`;
                    totalAmount += item.total_price;
                });
                summary += `\n*Total: ₹${totalAmount}*\n\nConfirm karne ke liye 'confirm' likhein.`;
                session.state = 'ORDER_FINAL_CONFIRM';
                return await sendWhatsAppMessage(phone, summary);
            }

        case 'ORDER_FINAL_CONFIRM':
            if (textLower === 'confirm') {
                let totalAmount = 0;
                session.cart.forEach(item => totalAmount += item.total_price);

                const { data: orderParams, error: orderErr } = await supabase
                    .from('orders')
                    .insert([{
                        customer_id: session.customer_id,
                        customer_name: session.customer_name,
                        customer_phone: phone,
                        status: 'pending',
                        total_amount: totalAmount,
                        payment_status: 'unpaid'
                    }])
                    .select()
                    .single();

                if (orderErr) {
                    console.error(orderErr);
                    return await sendWhatsAppMessage(phone, "Order save karne mein error. Thodi der baad try karein.");
                }

                const orderItemsToInsert = session.cart.map(item => ({
                    order_id: orderParams.id,
                    ...item
                }));
                await supabase.from('order_items').insert(orderItemsToInsert);

                await supabase.from('alerts').insert([{
                    type: 'new_order',
                    title: `New Order #${orderParams.id}`,
                    message: `Customer ${session.customer_name} ne ₹${totalAmount} ka order diya.`,
                    target_role: 'admin',
                    is_read: false
                }]);

                session.cart = [];
                session.state = 'IDLE';
                return await sendWhatsAppMessage(phone, `Order place ho gaya! 🎉\nOrder ID: ${orderParams.id}\nThank you! 🥛`);
            } else {
                return await sendWhatsAppMessage(phone, "'confirm' ya 'cancel' likhein.");
            }

        case 'SUBSCRIPTION_EXPECTING_ID': {
            const planId = parseInt(textLower);
            if (isNaN(planId)) {
                return await sendWhatsAppMessage(phone, "Sahi Plan ID likhein.");
            }
            const { data: plan } = await supabase.from('subscription_plans').select('*').eq('id', planId).single();
            if (!plan) {
                return await sendWhatsAppMessage(phone, "Plan nahi mila. Sahi ID likhein.");
            }
            await supabase.from('subscription_requests').insert([{
                customer_id: session.customer_id,
                customer_name: session.customer_name,
                customer_phone: phone,
                plan_id: plan.id,
                plan_name: plan.name,
                amount: plan.price,
                status: 'pending'
            }]);
            session.state = 'IDLE';
            return await sendWhatsAppMessage(phone, `Subscription request (${plan.name}) receive ho gayi! 🥳\nHamari team jald contact karegi.`);
        }

        default:
            session.state = 'IDLE';
            return await sendWhatsAppMessage(phone, mainMenuText);
    }
}

// Routes
app.get('/privacy', (req, res) => {
    res.send(`<html><body><h1>Privacy Policy - Siddhi Dairy</h1><p>We collect your phone number and name to process orders and subscriptions. Data is not shared with third parties.</p></body></html>`);
});

app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('WEBHOOK_VERIFIED');
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

app.post('/notify/order-delivered', async (req, res) => {
    const { phone, order_id } = req.body;
    if (!phone || !order_id) {
        return res.status(400).json({ error: "Missing phone or order_id" });
    }
    try {
        await sendWhatsAppMessage(phone, `✅ *Delivery Update*\nAapka Order #${order_id} deliver ho gaya! 🥛\nSiddhi Dairy chune ke liye dhanyawad!`);
        res.status(200).json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Failed to send notification" });
    }
});

app.listen(PORT, () => console.log(`Siddhi Dairy Bot is listening on port ${PORT}`));
