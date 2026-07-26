"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const supabase_js_1 = require("@supabase/supabase-js");
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const pino_1 = __importDefault(require("pino"));
const dotenv_1 = __importDefault(require("dotenv"));
const qrcode_1 = __importDefault(require("qrcode"));
// Load environment variables
dotenv_1.default.config();
// Initialize Pino Logger
const logger = (0, pino_1.default)({
    level: process.env.LOG_LEVEL || 'info',
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:standard'
        }
    }
});
const app = (0, express_1.default)();
app.use(express_1.default.json());
const PORT = process.env.PORT || 3001;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const RENDER_SECRET_KEY = process.env.RENDER_SECRET_KEY || '';
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    logger.error('Missing Supabase environment variables! Gateway cannot run.');
    process.exit(1);
}
// Initialize Supabase Admin client
const supabase = (0, supabase_js_1.createClient)(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
        persistSession: false,
        autoRefreshToken: false
    }
});
// App connection states
let sock = null;
let isConnected = false;
let isLoggedIn = false;
let qrCodeString = null;
let connectionPhone = null;
const startTime = Date.now();
// Custom Supabase Auth Adapter for Baileys
async function useSupabaseAuthState(sessionId = 'default') {
    const writeData = async (keyId, value) => {
        try {
            // Use BufferJSON.replacer to properly serialize Buffer/Uint8Array
            const jsonString = JSON.stringify(value, baileys_1.BufferJSON.replacer);
            const dbData = JSON.parse(jsonString);
            const { error } = await supabase
                .from('whatsapp_sessions')
                .upsert({
                id: `${sessionId}:${keyId}`,
                data: dbData,
                updated_at: new Date().toISOString()
            });
            if (error) {
                logger.error({ error, keyId }, `Failed to write session key to Supabase`);
            }
        }
        catch (err) {
            logger.error({ err, keyId }, `Exception inside writeData auth adapter`);
        }
    };
    const readData = async (keyId) => {
        try {
            const { data, error } = await supabase
                .from('whatsapp_sessions')
                .select('data')
                .eq('id', `${sessionId}:${keyId}`)
                .maybeSingle();
            if (error) {
                logger.error({ error, keyId }, `Failed to read session key from Supabase`);
                return null;
            }
            if (!data)
                return null;
            // Revive state with BufferJSON.reviver
            return JSON.parse(JSON.stringify(data.data), baileys_1.BufferJSON.reviver);
        }
        catch (err) {
            logger.error({ err, keyId }, `Exception inside readData auth adapter`);
            return null;
        }
    };
    const removeData = async (keyId) => {
        try {
            const { error } = await supabase
                .from('whatsapp_sessions')
                .delete()
                .eq('id', `${sessionId}:${keyId}`);
            if (error) {
                logger.error({ error, keyId }, `Failed to delete session key from Supabase`);
            }
        }
        catch (err) {
            logger.error({ err, keyId }, `Exception inside removeData auth adapter`);
        }
    };
    // Load or initialize credentials
    let creds = await readData('creds');
    if (!creds) {
        creds = (0, baileys_1.initAuthCreds)();
        await writeData('creds', creds);
    }
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const result = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`keys:${type}:${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = baileys_1.proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        result[id] = value;
                    }));
                    return result;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const type in data) {
                        for (const id in data[type]) {
                            const value = data[type][id];
                            const key = `keys:${type}:${id}`;
                            if (value) {
                                tasks.push(writeData(key, value));
                            }
                            else {
                                tasks.push(removeData(key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            await writeData('creds', creds);
        }
    };
}
// Start Baileys connection and maintain a single socket
async function connectToWhatsApp() {
    logger.info('🔌 Starting WhatsApp connection initialization...');
    try {
        const { state, saveCreds } = await useSupabaseAuthState('default');
        sock = (0, baileys_1.default)({
            auth: state,
            logger: (0, pino_1.default)({ level: 'silent' }), // Suppress Baileys internal chatty logs
            printQRInTerminal: true,
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000
        });
        // Listen for credentials updates
        sock.ev.on('creds.update', async () => {
            await saveCreds();
        });
        // Listen for connection changes
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                logger.info('📱 New QR code generated.');
                qrCodeString = qr;
            }
            if (connection === 'connecting') {
                logger.info('🔄 Connecting to WhatsApp...');
                isConnected = false;
            }
            if (connection === 'open') {
                logger.info('✅ WhatsApp Connection is OPEN!');
                isConnected = true;
                isLoggedIn = true;
                qrCodeString = null;
                const userJid = sock.user?.id || '';
                connectionPhone = userJid.split(':')[0] || userJid.split('@')[0] || '';
                logger.info(`👥 Logged in as: ${connectionPhone}`);
            }
            if (connection === 'close') {
                isConnected = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode || 0;
                const shouldReconnect = statusCode !== baileys_1.DisconnectReason.loggedOut;
                logger.warn({ statusCode, shouldReconnect }, `🔌 Connection closed.`);
                if (statusCode === baileys_1.DisconnectReason.loggedOut) {
                    logger.info('🛑 Device logged out. Purging session keys from Supabase...');
                    isLoggedIn = false;
                    qrCodeString = null;
                    connectionPhone = null;
                    const { error } = await supabase
                        .from('whatsapp_sessions')
                        .delete()
                        .like('id', 'default:%');
                    if (error) {
                        logger.error(error, 'Error deleting session keys after logout');
                    }
                    // Re-init connection immediately to prompt for new QR code
                    setTimeout(() => connectToWhatsApp(), 3000);
                }
                else {
                    // Try reconnecting in 3 seconds
                    logger.info('♻️ Reconnecting to WhatsApp...');
                    setTimeout(() => connectToWhatsApp(), 3000);
                }
            }
        });
    }
    catch (err) {
        logger.error(err, 'Critical error in connectToWhatsApp. Retrying in 10s...');
        setTimeout(() => connectToWhatsApp(), 10000);
    }
}
// Check X-Secret-Key authentication middleware
const authenticateSecret = (req, res, next) => {
    const key = req.headers['x-secret-key'] || req.headers['X-Secret-Key'];
    if (!key || key !== RENDER_SECRET_KEY) {
        logger.warn({ ip: req.ip }, 'Unauthorized API access attempt');
        return res.status(401).json({ success: false, error: 'غير مصرح للوصول لهذه الدالة' });
    }
    next();
};
// --- EXPRESS ENDPOINTS ---
// 1. Send OTP Message
app.post('/send-otp', authenticateSecret, async (req, res) => {
    const { phone, otp } = req.body;
    if (!phone || !otp) {
        return res.status(400).json({ success: false, error: 'الرجاء إدخال رقم الهاتف والرمز' });
    }
    if (!isLoggedIn || !sock || !isConnected) {
        logger.error('Attempted to send OTP but WhatsApp socket is not connected/logged-in');
        return res.status(503).json({ success: false, error: 'خادم واتساب غير متصل حالياً' });
    }
    try {
        // Format phone to JID
        let cleanPhone = phone.replace(/\D/g, '');
        if (cleanPhone.startsWith('0') && cleanPhone.length === 10) {
            cleanPhone = '249' + cleanPhone.substring(1);
        }
        else if (cleanPhone.length === 9 && cleanPhone.startsWith('9')) {
            cleanPhone = '249' + cleanPhone;
        }
        const jid = `${cleanPhone}@s.whatsapp.net`;
        // Check if number is valid/registered on WhatsApp (optional but recommended)
        const [onWhatsApp] = await sock.onWhatsApp(cleanPhone);
        if (!onWhatsApp || !onWhatsApp.exists) {
            logger.warn({ cleanPhone }, 'Number does not exist on WhatsApp');
            return res.status(400).json({ success: false, error: 'رقم واتساب غير صحيح أو غير مسجل بالخدمة' });
        }
        const messageText = `رمز التحقق الخاص بك هو:

${otp}

صلاحية الرمز خمس دقائق فقط.

لا تشارك هذا الرمز مع أي شخص.

Passenger App`;
        logger.info({ jid }, 'Sending OTP message...');
        await sock.sendMessage(onWhatsApp.jid || jid, { text: messageText });
        logger.info({ phone: cleanPhone }, 'OTP message sent successfully');
        return res.status(200).json({ success: true, message: 'تم إرسال الرمز بنجاح' });
    }
    catch (error) {
        logger.error(error, 'Failed to send WhatsApp message');
        return res.status(500).json({ success: false, error: 'حدث خطأ أثناء إرسال رسالة الواتساب: ' + error.message });
    }
});
// 2. Gateway Status
app.get('/status', (req, res) => {
    return res.status(200).json({
        connected: isConnected,
        logged_in: isLoggedIn,
        phone: connectionPhone,
        uptime: Math.floor((Date.now() - startTime) / 1000)
    });
});
// 3. Render setup QR code
app.get('/qr', async (req, res) => {
    if (isLoggedIn && isConnected) {
        return res.status(200).send(`
            <!DOCTYPE html>
            <html dir="rtl" lang="ar">
            <head>
                <meta charset="utf-8">
                <title>تراكا - واتساب متصل</title>
                <style>
                    body { font-family: sans-serif; text-align: center; padding: 50px; background: #f0fdf4; color: #166534; }
                    .card { background: white; padding: 30px; border-radius: 12px; display: inline-block; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                </style>
            </head>
            <body>
                <div class="card">
                    <h2>✅ واتساب متصل بنجاح!</h2>
                    <p>الحساب المتصل حالياً: <strong>${connectionPhone}</strong></p>
                    <p>الخادم يعمل بكفاءة ولا يحتاج لمسح رمز QR حالياً.</p>
                </div>
            </body>
            </html>
        `);
    }
    if (!qrCodeString) {
        return res.status(200).send(`
            <!DOCTYPE html>
            <html dir="rtl" lang="ar">
            <head>
                <meta charset="utf-8">
                <title>تراكا - جاري توليد رمز QR</title>
                <meta http-equiv="refresh" content="5">
                <style>
                    body { font-family: sans-serif; text-align: center; padding: 50px; background: #fffbeb; color: #92400e; }
                </style>
            </head>
            <body>
                <h2>🔄 جاري توليد رمز QR...</h2>
                <p>الرجاء الانتظار، سيتم إعادة تحميل الصفحة تلقائياً خلال 5 ثوانٍ.</p>
            </body>
            </html>
        `);
    }
    try {
        const qrDataUrl = await qrcode_1.default.toDataURL(qrCodeString);
        return res.status(200).send(`
            <!DOCTYPE html>
            <html dir="rtl" lang="ar">
            <head>
                <meta charset="utf-8">
                <title>ربط تطبيق تراكا بالواتساب</title>
                <style>
                    body { font-family: sans-serif; text-align: center; padding: 30px; background: #f8fafc; color: #1e293b; }
                    .card { background: white; padding: 30px; border-radius: 16px; display: inline-block; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); border: 1px solid #e2e8f0; }
                    img { margin: 20px 0; border: 4px solid #16a34a; border-radius: 8px; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h2>📱 ربط تطبيق تراكا بالواتساب</h2>
                    <p>افتح الواتساب على هاتفك واذهب لـ: <strong>الأجهزة المرتبطة &gt; ربط جهاز</strong></p>
                    <p>ثم امسح رمز الـ QR أدناه:</p>
                    <div>
                        <img src="${qrDataUrl}" alt="Scan QR Code" width="280">
                    </div>
                    <p style="color: #64748b; font-size: 13px;">بعد نجاح الربط، سيتم حفظ الجلسة تلقائياً في Supabase.</p>
                </div>
            </body>
            </html>
        `);
    }
    catch (err) {
        logger.error(err, 'Failed to render QR Code page');
        return res.status(500).send('فشل توليد صفحة الـ QR Code: ' + err.message);
    }
});
// Run server and start socket
app.listen(PORT, () => {
    logger.info(`🚀 WhatsApp Gateway listening on port ${PORT}`);
    // Start Baileys connection
    connectToWhatsApp();
});
