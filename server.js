const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// إعداد عميل الواتساب
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        // executablePath تم تعطيلها ليعمل المتصفح المدمج مع Puppeteer على أي نظام (Linux/Windows)
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-dev-shm-usage',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-site-isolation-trials'
        ]
    }
});

let isReady = false;
let latestQR = '';

client.on('qr', (qr) => {
    console.log('تم إنشاء كود QR. يرجى فتح المتصفح على http://localhost:' + port + ' لمسح الكود.');
    latestQR = qr;
});

client.on('ready', () => {
    console.log('✅ تم ربط الواتساب بنجاح! الخادم جاهز لإرسال الرسائل.');
    isReady = true;
    latestQR = ''; // تنظيف الكود بعد الربط
});

client.on('auth_failure', msg => {
    console.error('❌ فشل في تسجيل الدخول للواتساب:', msg);
});

client.on('disconnected', (reason) => {
    console.log('❌ تم فصل الواتساب:', reason);
    isReady = false;
});

// بدء العميل
client.initialize();

// واجهة برمجية لمعرفة حالة الخادم
app.get('/status', (req, res) => {
    res.json({ ready: isReady });
});

// الصفحة الرئيسية لعرض كود QR
app.get('/', (req, res) => {
    if (isReady) {
        res.send('<h1 style="color: green; text-align: center; font-family: sans-serif; margin-top: 50px;">✅ تم ربط الواتساب بنجاح! الخادم جاهز.</h1><p style="text-align:center;">يمكنك الآن العودة لصفحة الدرجات والبدء في الإرسال.</p>');
    } else if (latestQR) {
        const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(latestQR);
        res.send(`
            <div style="text-align: center; font-family: sans-serif; margin-top: 50px;">
                <h2>امسح كود الـ QR لربط الواتساب</h2>
                <p>افتح الواتساب في هاتفك > الأجهزة المرتبطة > ربط جهاز</p>
                <img src="${qrUrl}" alt="QR Code" style="border: 2px solid #ccc; padding: 10px; border-radius: 10px; margin-top: 20px;">
                <p style="color: #666; margin-top: 20px;">ستتحدث هذه الصفحة تلقائياً بعد المسح...</p>
                <script>
                    setInterval(() => {
                        fetch('/status').then(r => r.json()).then(data => {
                            if(data.ready) location.reload();
                        });
                    }, 2000);
                </script>
            </div>
        `);
    } else {
        res.send('<h1 style="text-align: center; font-family: sans-serif; margin-top: 50px;">⏳ جاري تحضير الواتساب وتوليد كود الـ QR... يرجى الانتظار ثواني ثم تحديث الصفحة.</h1>');
    }
});

// واجهة برمجية لإرسال الرسائل
app.post('/send-bulk', async (req, res) => {
    if (!isReady) {
        return res.status(400).json({ success: false, message: 'الخادم لم يتم ربطه بالواتساب بعد.' });
    }

    const { messages } = req.body; // مصفوفة { phone, text }
    
    if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ success: false, message: 'بيانات غير صحيحة.' });
    }

    let results = {
        sent: 0,
        failed: 0,
        errors: []
    };

    // إرسال الرسائل بفاصل زمني لتجنب الحظر
    const sendWithDelay = async () => {
        for (let i = 0; i < messages.length; i++) {
            let { phone, text } = messages[i];
            
            // تنظيف رقم الهاتف وإضافة رمز الدولة إذا لم يكن موجوداً
            phone = phone.replace(/[^0-9+]/g, '');
            if (phone.startsWith('01')) phone = '+2' + phone; // افتراضاً لمصر إذا بدأ بـ 01
            if (phone.startsWith('+')) phone = phone.substring(1); // إزالة علامة + 
            
            const chatId = phone + '@c.us';

            let maxRetries = 3;
            let success = false;
            let lastError = null;

            for (let r = 0; r < maxRetries; r++) {
                try {
                    // التحقق من وجود الرقم على الواتساب
                    const isRegistered = await client.isRegisteredUser(chatId);
                    
                    if (isRegistered) {
                        await client.sendMessage(chatId, text);
                        if (r === 0) {
                            results.sent++;
                        } else {
                            results.sent++; // still sent
                        }
                        console.log(`تم الإرسال إلى ${phone}`);
                    } else {
                        results.failed++;
                        results.errors.push({ phone, reason: 'الرقم غير مسجل في واتساب' });
                        console.log(`الرقم غير مسجل: ${phone}`);
                    }
                    
                    success = true;
                    break; // نجاح، اخرج من حلقة المحاولات
                    
                } catch (error) {
                    lastError = error;
                    console.error(`محاولة ${r + 1} فشلت للرقم ${phone}:`, error.message);
                    
                    // إذا كان الخطأ بسبب مشاكل الإطار المنفصل أو تدمير السياق، انتظر ثم أعد المحاولة
                    if (error.message.includes('detached Frame') || error.message.includes('Execution context was destroyed')) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    } else {
                        // أخطاء أخرى (مثل خطأ في صيغة الرقم) لا نعيد المحاولة لها
                        break;
                    }
                }
            }

            if (!success && lastError) {
                results.failed++;
                results.errors.push({ phone, reason: lastError.message });
                console.error(`خطأ نهائي أثناء الإرسال لـ ${phone}:`, lastError.message);
            }
            
            // فاصل زمني بين كل رسالة (2 إلى 4 ثواني عشوائية)
            const delay = Math.floor(Math.random() * 2000) + 2000;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    };

    // الرد الفوري بأن العملية بدأت، والإرسال سيستمر في الخلفية
    res.json({ success: true, message: 'بدأت عملية الإرسال في الخلفية.', expectedCount: messages.length });
    
    // تشغيل الدالة
    sendWithDelay().then(() => {
        console.log('✅ اكتملت عملية الإرسال المجمع:', results);
    });
});

app.listen(port, () => {
    console.log(`🚀 خادم المراسلة يعمل على المنفذ ${port}`);
});
