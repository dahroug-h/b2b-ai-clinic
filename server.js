const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

const ws = require('ws');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    realtime: {
        transport: ws
    }
});

// Multi-Tenant Maps
const activeClients = new Map(); // clinic_id -> Client instance
const clientStatuses = new Map(); // clinic_id -> 'Disconnected' | 'Initializing' | 'Scanning' | 'Ready'
const currentQRs = new Map(); // clinic_id -> base64 QR

app.use(express.json());

// Enable CORS for administrative console
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// --- Google Sheets Service Account Auth ---
let googleAuth = null;
const credsPath = path.join(__dirname, 'google-credentials.json');
if (fs.existsSync(credsPath)) {
    googleAuth = new google.auth.GoogleAuth({
        keyFile: credsPath,
        scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
    });
    console.log('Google Sheets API credentials successfully loaded!');
} else {
    console.warn('⚠️ google-credentials.json not found. Sheets sync will bypass auth.');
}

function getSheetsClient() {
    if (!googleAuth) return null;
    return google.sheets({ version: 'v4', auth: googleAuth });
}

// Helper: Create a real Google Spreadsheet and share it with clinic email
async function createRealSpreadsheet(clinicName, clinicEmail) {
    if (!googleAuth) {
        throw new Error('Google Credentials not loaded on server.');
    }

    const sheets = google.sheets({ version: 'v4', auth: googleAuth });
    const drive = google.drive({ version: 'v3', auth: googleAuth });

    // 1. Create a new Spreadsheet in the service account's Drive
    const resource = {
        properties: {
            title: `حجوزات عيادة - ${clinicName}`,
        },
    };

    const spreadsheet = await sheets.spreadsheets.create({
        resource,
        fields: 'spreadsheetId,spreadsheetUrl',
    });

    const spreadsheetId = spreadsheet.data.spreadsheetId;
    const spreadsheetUrl = spreadsheet.data.spreadsheetUrl;
    console.log(`Created real spreadsheet for clinic [${clinicName}] with ID: ${spreadsheetId}`);

    // 2. Share spreadsheet with clinicEmail as a writer
    if (clinicEmail && clinicEmail.trim() !== '') {
        try {
            await drive.permissions.create({
                fileId: spreadsheetId,
                sendNotificationEmail: true,
                requestBody: {
                    type: 'user',
                    role: 'writer',
                    emailAddress: clinicEmail.trim(),
                },
            });
            console.log(`Successfully shared spreadsheet ${spreadsheetId} with clinic email ${clinicEmail}`);
        } catch (err) {
            console.error(`Failed to share spreadsheet ${spreadsheetId} with email ${clinicEmail}:`, err.message);
        }
    }

    // 3. Initialize first month's tab
    try {
        const parsedDate = new Date();
        const month = String(parsedDate.getMonth() + 1).padStart(2, '0');
        const year = parsedDate.getFullYear();
        const tabName = `${month}-${year}`;

        // Add monthly tab
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            resource: {
                requests: [{
                    addSheet: {
                        properties: { title: tabName }
                    }
                }]
            }
        });

        // Add headers to new tab
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `${tabName}!A1`,
            valueInputOption: 'RAW',
            resource: {
                values: [['التاريخ', 'الوقت', 'اسم المريض', 'رقم الهاتف', 'الحالة', 'تاريخ التسجيل']]
            }
        });

        // Set decorative text in default Sheet1
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `Sheet1!A1`,
            valueInputOption: 'RAW',
            resource: {
                values: [['تم إنشاء جدول حجوزات المواعيد بنجاح بالذكاء الاصطناعي للمنصة!']]
            }
        });

    } catch (tabErr) {
        console.error('Failed to initialize sheets structure:', tabErr.message);
    }

    return { spreadsheetId, spreadsheetUrl };
}

// Helper: Extract slots from Google Sheet or return defaults if blank
async function fetchSheetSlotsForDate(sheetId, targetDate, clinicDefaultSlots = []) {
    const sheets = getSheetsClient();
    if (!sheets || !sheetId) {
        // Return structured defaults if sheet is disconnected
        return clinicDefaultSlots.length > 0 ? clinicDefaultSlots : ["02:00 PM", "02:30 PM", "03:00 PM", "03:30 PM", "04:00 PM", "04:30 PM"];
    }

    try {
        const parsedDate = new Date(targetDate);
        if (isNaN(parsedDate.getTime())) return ["02:00 PM", "02:30 PM", "03:00 PM", "03:30 PM"];

        const month = String(parsedDate.getMonth() + 1).padStart(2, '0');
        const year = parsedDate.getFullYear();
        const tabName = `${month}-${year}`;

        // Get reservations log from tab
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: `${tabName}!A:F`
        });
        const rows = res.data.values || [];
        
        // Find booked slots for this target date
        const bookedTimes = new Set();
        for (let i = 1; i < rows.length; i++) {
            const rowDate = rows[i][0];
            const rowTime = rows[i][1];
            const rowStatus = rows[i][4];
            if (rowDate === targetDate && rowStatus !== 'ملغي') {
                bookedTimes.add(rowTime);
            }
        }

        // Return only slots that aren't booked
        const allSlots = clinicDefaultSlots.length > 0 ? clinicDefaultSlots : ["02:00 PM", "02:30 PM", "03:00 PM", "03:30 PM", "04:00 PM", "04:30 PM"];
        return allSlots.filter(slot => !bookedTimes.has(slot));

    } catch (err) {
        console.warn('Could not read slots from sheet, returning default slots. Error:', err.message);
        return clinicDefaultSlots.length > 0 ? clinicDefaultSlots : ["02:00 PM", "02:30 PM", "03:00 PM", "03:30 PM"];
    }
}

// Helper: Ensure Monthly Tab Exists & Log Reservation (Sync)
async function syncReservationToSheet(sheetId, date, time, name, phone, actionType = 'book') {
    const sheets = getSheetsClient();
    if (!sheets || !sheetId) return;

    try {
        const parsedDate = new Date(date);
        if (isNaN(parsedDate.getTime())) throw new Error(`Invalid date format: ${date}`);

        const month = String(parsedDate.getMonth() + 1).padStart(2, '0');
        const year = parsedDate.getFullYear();
        const tabName = `${month}-${year}`;

        const metadata = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
        const sheetExists = metadata.data.sheets.some(s => s.properties.title === tabName);

        if (!sheetExists) {
            console.log(`Creating new monthly tab in Google Sheet: ${tabName}`);
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId: sheetId,
                resource: {
                    requests: [{
                        addSheet: {
                            properties: { title: tabName }
                        }
                    }]
                }
            });
            await sheets.spreadsheets.values.append({
                spreadsheetId: sheetId,
                range: `${tabName}!A1`,
                valueInputOption: 'RAW',
                resource: {
                    values: [['التاريخ', 'الوقت', 'اسم المريض', 'رقم الهاتف', 'الحالة', 'تاريخ التسجيل']]
                }
            });
        }

        if (actionType === 'book') {
            await sheets.spreadsheets.values.append({
                spreadsheetId: sheetId,
                range: `${tabName}!A:F`,
                valueInputOption: 'USER_ENTERED',
                resource: {
                    values: [[date, time, name, phone, 'مؤكد', new Date().toLocaleString('en-CA', { timeZone: 'Africa/Cairo' })]]
                }
            });
            console.log(`Reservation successfully synchronized to sheet tab ${tabName}`);
        } else if (actionType === 'cancel') {
            const res = await sheets.spreadsheets.values.get({
                spreadsheetId: sheetId,
                range: `${tabName}!A:F`
            });
            const rows = res.data.values || [];
            for (let i = 1; i < rows.length; i++) {
                if (rows[i][0] === date && rows[i][1] === time && rows[i][3] === phone) {
                    await sheets.spreadsheets.values.update({
                        spreadsheetId: sheetId,
                        range: `${tabName}!E${i + 1}`,
                        valueInputOption: 'RAW',
                        resource: { values: [['ملغي']] }
                    });
                    console.log(`Reservation successfully cancelled in sheet tab ${tabName}`);
                    break;
                }
            }
        }
    } catch (err) {
        console.error('Google Sheets Sync Failed:', err);
    }
}

// --- WhatsApp Client Factory ---
function getOrCreateClinicClient(clinicId) {
    if (activeClients.has(clinicId)) {
        return activeClients.get(clinicId);
    }

    console.log(`Creating fresh WhatsApp browser instance for Clinic: ${clinicId}`);
    clientStatuses.set(clinicId, 'Initializing');

    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: `clinic-${clinicId}`
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
        }
    });

    client.on('qr', async (qr) => {
        console.log(`QR received for Clinic [${clinicId}]`);
        clientStatuses.set(clinicId, 'Scanning');
        
        try {
            const qrImage = await qrcode.toDataURL(qr);
            currentQRs.set(clinicId, qrImage);
            io.to(`clinic-${clinicId}`).emit('status-update', {
                status: 'Scanning',
                qr: qrImage,
                clinicId: clinicId
            });
        } catch (err) {
            console.error('QR conversion error:', err);
        }
    });

    client.on('authenticated', () => {
        console.log(`Clinic [${clinicId}] WhatsApp Authenticated successfully!`);
        clientStatuses.set(clinicId, 'Initializing');
        io.to(`clinic-${clinicId}`).emit('status-update', { status: 'Initializing', qr: null, clinicId: clinicId });
    });

    client.on('ready', () => {
        console.log(`Clinic [${clinicId}] WhatsApp is READY!`);
        clientStatuses.set(clinicId, 'Ready');
        currentQRs.delete(clinicId);
        io.to(`clinic-${clinicId}`).emit('status-update', { status: 'Ready', qr: null, clinicId: clinicId });
    });

    client.on('disconnected', async (reason) => {
        console.log(`Clinic [${clinicId}] WhatsApp disconnected:`, reason);
        clientStatuses.set(clinicId, 'Disconnected');
        io.to(`clinic-${clinicId}`).emit('status-update', { status: 'Disconnected', qr: null, clinicId: clinicId });
        
        setTimeout(() => {
            if (clientStatuses.get(clinicId) === 'Disconnected') {
                console.log(`Attempting to restart client for Clinic [${clinicId}]...`);
                client.initialize().catch(e => console.error('Restart failed:', e));
            }
        }, 10000);
    });

    client.on('message', async (msg) => {
        if (msg.isStatus || msg.from === 'status@broadcast' || msg.from.includes('status') || msg.broadcast || msg.from.endsWith('@broadcast')) {
            return;
        }

        const chat = await msg.getChat();
        if (chat.isGroup) return;

        console.log(`Clinic [${clinicId}] incoming message from ${msg.from}: ${msg.body}`);

        let resolvedSenderName = 'Unknown Patient';
        try {
            const contact = await msg.getContact();
            resolvedSenderName = contact.name || chat.name || contact.pushname || msg._data.notifyName || msg.from.split('@')[0];
        } catch (e) {
            resolvedSenderName = msg._data.notifyName || chat.name || msg.from.split('@')[0];
        }

        io.to(`clinic-${clinicId}`).emit('new-message', {
            id: msg.id.id,
            from: msg.from,
            senderName: resolvedSenderName,
            body: msg.body || '',
            timestamp: new Date().toLocaleTimeString(),
            type: 'received',
            clinicId: clinicId
        });

        // Trigger AI Core Processing Hook
        processAIChatLoop(clinicId, msg, resolvedSenderName);
    });

    client.initialize().catch(err => {
        console.error(`Failed to boot client for Clinic [${clinicId}]`, err);
        clientStatuses.set(clinicId, 'Disconnected');
        setTimeout(() => getOrCreateClinicClient(clinicId), 15000);
    });

    activeClients.set(clinicId, client);
    return client;
}

// Core LLM Execution & Booking Engine
async function processAIChatLoop(clinicId, msg, resolvedSenderName) {
    try {
        const [{ data: clinic }, { data: content }] = await Promise.all([
            supabase.from("clinics").select("*").eq("id", clinicId).single(),
            supabase.from("clinic_content").select("*").eq("clinic_id", clinicId).single(),
        ]);

        if (!clinic || !clinic.bot_active || !content) return;

        let { data: conversation } = await supabase
            .from("conversations")
            .select("*")
            .match({ clinic_id: clinicId, patient_phone: msg.from })
            .single();

        if (!conversation) {
            const { data: newConv } = await supabase
                .from("conversations")
                .insert({ clinic_id: clinicId, patient_phone: msg.from, messages: [] })
                .select()
                .single();
            conversation = newConv;
        }

        const cairoNow = new Date().toLocaleString("en-CA", { timeZone: "Africa/Cairo", hour12: false }).replace(",", "");
        const cairoDate = cairoNow.split(" ")[0]; // YYYY-MM-DD
        const cairoTime = cairoNow.split(" ")[1].slice(0, 5); // HH:MM

        const history = (conversation.messages || []).slice(-12);
        history.push({ id: Math.random().toString(36).substring(7), role: "user", content: msg.body, created_at: new Date().toISOString() });

        // Retrieve structured setup JSON compiled by "Data Setup Genius"
        const setupJSON = JSON.stringify(content.structured_data);
        const defaultSlots = content.structured_data?.availabilities?.[0]?.time_slots || [];

        // Fetch primary current available slots from sheet dynamically
        const liveSlots = await fetchSheetSlotsForDate(clinic.google_sheet_id, cairoDate, defaultSlots);

        let systemPrompt = `أنت مساعد ذكي يستقبل مرضى عيادة في مصر.
تتكلم بالعامية المصرية الودية البسيطة جداً. ممنوع الرسميات أو الفصحى نهائياً.
ممنوع تقول إنك بوت أو ذكاء اصطناعي.
النهارده هو ${cairoDate} والساعة الآن ${cairoTime}.

=== بيانات العيادة وهيكلتها ===
${setupJSON}
=== التوجيهات الخاصة بالعيادة ===
${content.custom_instructions || 'لا يوجد'}

=== المواعيد المتاحة حالياً لليوم ===
${liveSlots.join(', ')}

إذا طلب المريض الحجز في تاريخ آخر (مثلاً الأسبوع القادم أو بعد أسبوعين)، يرجى استخدام الإجراء get_slots وتحديد التاريخ المطلوب.
أرسل JSON الإجراء في نهاية الرد دائماً:
<<<ACTION>>>{"action": null}<<<END>>>

في حالة طلب الاستفسار عن مواعيد يوم محدد:
<<<ACTION>>>{"action": "get_slots", "date": "YYYY-MM-DD"}<<<END>>>

وعند التأكيد النهائي والكامل من المريض:
<<<ACTION>>>{"action": "book", "date": "YYYY-MM-DD", "time": "hh:mm AM/PM", "patient_name": "الاسم"}<<<END>>>

أو إذا طلب المريض إلغاء موعد مؤكد:
<<<ACTION>>>{"action": "cancel", "date": "YYYY-MM-DD", "time": "hh:mm AM/PM"}<<<END>>>`;

        // First LLM invocation
        let responseText = await callOpenRouterLLM(systemPrompt, history);
        let action = parseActionSentinel(responseText);
        let finalReplyText = responseText;

        if (action) {
            finalReplyText = responseText.slice(0, responseText.indexOf("<<<ACTION>>>")).trim();
        }

        // --- RECURSIVE GET SLOTS LOGIC (100% FLEXIBILITY FOR DYNAMIC DATE INTERVALS) ---
        if (action?.action === 'get_slots' && action.date) {
            console.log(`AI requested slots fetch dynamically for date: ${action.date}`);
            const dynamicSlots = await fetchSheetSlotsForDate(clinic.google_sheet_id, action.date, defaultSlots);
            
            // Append system message containing newly fetched slots
            history.push({ 
                id: Math.random().toString(36).substring(7), 
                role: "system", 
                content: `[تنبيه للنظام: المواعيد المتاحة ليوم ${action.date} هي: ${dynamicSlots.join(', ')}]` 
            });

            // Re-call LLM with updated slots context
            responseText = await callOpenRouterLLM(systemPrompt, history);
            action = parseActionSentinel(responseText);
            finalReplyText = responseText;
            if (action) {
                finalReplyText = responseText.slice(0, responseText.indexOf("<<<ACTION>>>")).trim();
            }
        }

        // Save conversation history to Supabase
        history.push({ id: Math.random().toString(36).substring(7), role: "assistant", content: responseText, created_at: new Date().toISOString() });
        await supabase.from("conversations").update({ messages: history, last_message_at: new Date().toISOString() }).eq("id", conversation.id);

        // Execute Actions & Google Sheets Sync
        if (action?.action === 'book') {
            console.log(`[ACTION] Confirmed booking in monthly sheet page for ${action.patient_name}`);
            await syncReservationToSheet(clinic.google_sheet_id, action.date, action.time, action.patient_name, msg.from, 'book');
            
            await supabase.from("appointments").insert({
                clinic_id: clinicId,
                patient_phone: msg.from,
                patient_name: action.patient_name,
                appointment_date: action.date,
                appointment_time: action.time,
                status: 'confirmed'
            });
        } else if (action?.action === 'cancel') {
            console.log(`[ACTION] Confirmed cancellation in sheet for ${msg.from}`);
            await syncReservationToSheet(clinic.google_sheet_id, action.date, action.time, null, msg.from, 'cancel');
            
            await supabase.from("appointments").update({ status: 'cancelled' })
                .match({ clinic_id: clinicId, patient_phone: msg.from, status: 'confirmed' });
        }

        // Send Text message on WhatsApp Web
        setTimeout(async () => {
            try {
                const client = activeClients.get(clinicId);
                if (client) {
                    const sentMsg = await client.sendMessage(msg.from, finalReplyText);
                    io.to(`clinic-${clinicId}`).emit('new-message', {
                        id: sentMsg.id.id,
                        from: sentMsg.to,
                        senderName: 'AI Auto-Responder (You)',
                        body: finalReplyText,
                        timestamp: new Date().toLocaleTimeString(),
                        type: 'sent',
                        clinicId: clinicId
                    });
                }
            } catch (e) {
                console.error('Error sending message reply:', e);
            }
        }, 1500);

    } catch (e) {
        console.error('AI chat loop failed:', e);
    }
}

// Call OpenRouter Gemini API
async function callOpenRouterLLM(systemPrompt, history) {
    try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`
            },
            body: JSON.stringify({
                model: "google/gemini-3.1-flash-lite-preview",
                max_tokens: 450,
                messages: [
                    { role: "system", content: systemPrompt },
                    ...history
                ]
            })
        });
        const data = await response.json();
        return data.choices?.[0]?.message?.content || "عذراً، يرجى المحاولة بعد قليل.";
    } catch (err) {
        console.error('OpenRouter call error:', err);
        return "عذراً، يرجى المحاولة بعد قليل.";
    }
}

function parseActionSentinel(text) {
    const match = text.match(/<<<ACTION>>>([\s\S]*?)<<<END>>>/);
    if (match) {
        try {
            return JSON.parse(match[1].trim());
        } catch (e) {
            return null;
        }
    }
    return null;
}

// --- WebSocket Handshakes & Multi-Tenant Mappings ---
io.on('connection', (socket) => {
    console.log('Socket client connected:', socket.id);

    socket.on('join-clinic', async (clinicId) => {
        socket.join(`clinic-${clinicId}`);
        console.log(`Socket joined room: clinic-${clinicId}`);
        
        const status = clientStatuses.get(clinicId) || 'Disconnected';
        const qr = currentQRs.get(clinicId) || null;
        socket.emit('status-update', { status, qr, clinicId: clinicId });
    });

    socket.on('generate-qr', (clinicId) => {
        console.log(`Generate QR requested for clinic: ${clinicId}`);
        getOrCreateClinicClient(clinicId);
    });

    socket.on('logout-clinic', async (clinicId) => {
        console.log(`Disconnect requested for clinic: ${clinicId}`);
        const client = activeClients.get(clinicId);
        if (client) {
            try {
                await client.logout();
            } catch (e) {
                console.error('Logout error:', e);
            }
            activeClients.delete(clinicId);
            clientStatuses.set(clinicId, 'Disconnected');
            currentQRs.delete(clinicId);
            io.to(`clinic-${clinicId}`).emit('status-update', { status: 'Disconnected', qr: null, clinicId: clinicId });
        }
    });
});

// Expose loaded server configuration securely for the admin panel
app.get('/api/config', (req, res) => {
    res.json({
        SUPABASE_URL: process.env.SUPABASE_URL || "",
        SUPABASE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || ""
    });
});

// Expose dynamic spreadsheet provisioning endpoint
app.post('/api/create-sheet', async (req, res) => {
    const { clinicId, clinicName, clinicEmail } = req.body;

    if (!clinicId || !clinicName) {
        return res.status(400).json({ error: 'clinicId and clinicName are required' });
    }

    try {
        console.log(`Creating real spreadsheet for Clinic ID ${clinicId} (${clinicName}), Email: ${clinicEmail}`);
        const result = await createRealSpreadsheet(clinicName, clinicEmail);
        
        // Update database Google Sheet ID in Supabase
        const { data, error } = await supabase
            .from('clinics')
            .update({ google_sheet_id: result.spreadsheetId })
            .eq('id', clinicId)
            .select();

        if (error) throw error;

        res.json({
            success: true,
            sheetId: result.spreadsheetId,
            sheetUrl: result.spreadsheetUrl
        });
    } catch (err) {
        console.error('Failed to create sheet:', err);
        res.status(500).json({ error: err.message || 'Failed to create sheet' });
    }
});

server.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(`  B2B SaaS WhatsApp Engine listening on Port ${PORT}`);
    console.log(`  Cloud Server successfully active on DigitalOcean`);
    console.log(`===================================================`);
});
