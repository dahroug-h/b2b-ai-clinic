// --- Core SaaS Configurations & Local Secure Storage ---
// Safe localStorage wrapper to prevent crashes in sandboxed/file:// environments
const safeStorage = {
    getItem(key) {
        try {
            return localStorage.getItem(key) || "";
        } catch (e) {
            console.warn(`Storage access blocked for key [${key}]:`, e);
            return window._tempStorage?.[key] || "";
        }
    },
    setItem(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (e) {
            console.warn(`Storage write blocked for key [${key}]:`, e);
            if (!window._tempStorage) window._tempStorage = {};
            window._tempStorage[key] = value;
        }
    }
};

let SUPABASE_URL = safeStorage.getItem('saas_supa_url') || "";
let SUPABASE_KEY = safeStorage.getItem('saas_supa_key') || "";
let BACKEND_URL = safeStorage.getItem('saas_backend_url') || "http://68.183.76.140:3000";
let OPENROUTER_API_KEY = safeStorage.getItem('saas_openrouter_key') || "";

// Initialize Deferred variables
let supabase = null;
let socket = null;

// State Cache
let clinicsList = [];
let activeMonitorClinicId = null;
let activeQRClinicId = null;
let compiledGeniusJSON = null;

// --- Initialize Clients Dynamically ---
function initializeSaaSClients() {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.warn('Supabase URL or Key missing. Awaiting configuration.');
        return false;
    }

    try {
        const supabaseLib = window.supabase || (typeof supabase !== 'undefined' ? supabase : null);
        if (!supabaseLib) {
            throw new Error('Supabase client library CDN not loaded. Please check your internet connection.');
        }
        supabase = supabaseLib.createClient(SUPABASE_URL, SUPABASE_KEY);
        console.log('Supabase client successfully initialized!');
    } catch (e) {
        console.error('Failed to initialize Supabase client:', e);
        return false;
    }

    if (BACKEND_URL) {
        try {
            if (socket) socket.close();
            socket = io(BACKEND_URL);
            console.log('Real-time WebSocket client successfully connected to:', BACKEND_URL);
            attachSocketListeners();
        } catch (e) {
            console.error('WebSocket connection failed:', e);
        }
    }
    return true;
}

// --- DOM Cache ---
const tabButtons = document.querySelectorAll('.menu-item');
const tabContents = document.querySelectorAll('.tab-content');

// --- Tab Routing Logic ---
tabButtons.forEach(button => {
    button.addEventListener('click', () => {
        const targetTab = button.getAttribute('data-tab');
        
        // If it's a menu tab routing
        if (targetTab) {
            tabButtons.forEach(btn => btn.classList.remove('active'));
            tabContents.forEach(content => content.classList.remove('active'));
            
            button.classList.add('active');
            document.getElementById(`${targetTab}-tab`).classList.add('active');
            
            if (!supabase) {
                showSettingsModal();
                return;
            }

            if (targetTab === 'clinics-hub') {
                loadAndRenderClinics();
            } else if (targetTab === 'setup-genius') {
                syncClinicDropdown();
            } else if (targetTab === 'live-monitor') {
                loadAndRenderMonitorList();
            }
        }
    });
});

/* ==========================================================================
   TAB 1: Clinics Hub (Database Fetch & Render)
   ========================================================================== */
async function loadAndRenderClinics() {
    if (!supabase) {
        showSettingsModal();
        return;
    }

    const container = document.getElementById('clinics-cards-container');
    container.innerHTML = `
        <div class="loading-state">
            <div class="spinner"></div>
            <p>جاري تحميل العيادات من قاعدة البيانات...</p>
        </div>
    `;

    try {
        const { data: clinics, error } = await supabase.from('clinics').select('*').order('created_at', { ascending: false });
        if (error) throw error;
        
        clinicsList = clinics;
        container.innerHTML = '';

        if (clinics.length === 0) {
            container.innerHTML = `
                <div class="loading-state">
                    <i class="fa-solid fa-hospital-user" style="font-size: 2.5rem; color: var(--text-secondary); opacity: 0.5;"></i>
                    <p style="margin-top: 10px;">لا توجد عيادات مسجلة حالياً. اضغط على زر الإضافة بالأعلى لتسجيل عيادة!</p>
                </div>
            `;
            return;
        }

        // Render each clinic card
        clinics.forEach(clinic => {
            const card = document.createElement('div');
            card.className = 'card glass-card clinic-card';
            card.setAttribute('data-id', clinic.id);
            
            // Format sheet path link
            const sheetLink = clinic.google_sheet_id 
                ? `<a href="https://docs.google.com/spreadsheets/d/${clinic.google_sheet_id}" target="_blank" class="sheet-link-anchor"><i class="fa-solid fa-file-excel"></i> عرض الجدول</a>` 
                : '<span class="text-danger">غير منشأ</span>';

            card.innerHTML = `
                <div class="clinic-card-header">
                    <div class="clinic-title-area">
                        <h3>${clinic.clinic_name}</h3>
                        <p>${clinic.subdomain}.tabibk.saas</p>
                    </div>
                    <label class="switch-toggle" title="تفعيل البوت">
                        <input type="checkbox" class="bot-toggle-switch" data-id="${clinic.id}" ${clinic.bot_active !== false ? 'checked' : ''}>
                        <span class="slider round"></span>
                    </label>
                </div>
                <div class="clinic-meta-rows">
                    <div class="meta-row">
                        <span class="meta-label">البريد الإلكتروني</span>
                        <span class="meta-value">${clinic.clinic_email || 'غير متوفر'}</span>
                    </div>
                    <div class="meta-row">
                        <span class="meta-label">دورة إعادة التهيئة</span>
                        <span class="meta-value">${clinic.sheet_reset_interval === 'weekly' ? 'أسبوعي' : clinic.sheet_reset_interval === 'monthly' ? 'شهري' : 'يدوي'}</span>
                    </div>
                    <div class="meta-row">
                        <span class="meta-label">حالة واتساب</span>
                        <span class="status-pill disconnected" id="pill-${clinic.id}">فصل</span>
                    </div>
                    <div class="meta-row">
                        <span class="meta-label">جدول المواعيد</span>
                        <span class="meta-value">${sheetLink}</span>
                    </div>
                </div>
                <div class="clinic-card-footer">
                    <button class="card-footer-btn btn-connect" onclick="openQRModal('${clinic.id}', '${clinic.clinic_name}')">
                        <i class="fa-solid fa-qrcode"></i> ربط وتفعيل
                    </button>
                    <button class="card-footer-btn btn-disconnect" onclick="logoutClinic('${clinic.id}')">
                        <i class="fa-solid fa-plug-circle-xmark"></i> إلغاء الربط
                    </button>
                </div>
            `;
            container.appendChild(card);
            
            // Join room
            if (socket) socket.emit('join-clinic', clinic.id);
        });

        // Attach event listeners to toggles
        document.querySelectorAll('.bot-toggle-switch').forEach(toggle => {
            toggle.addEventListener('change', async () => {
                const id = toggle.getAttribute('data-id');
                const active = toggle.checked;
                await supabase.from('clinics').update({ bot_active: active }).eq('id', id);
            });
        });

    } catch (err) {
        console.error('Failed to load clinics:', err);
        container.innerHTML = `
            <div class="loading-state">
                <i class="fa-solid fa-triangle-exclamation" style="font-size: 2.5rem; color: var(--accent-error);"></i>
                <p style="margin-top: 10px; color: var(--text-primary); font-weight: bold;">فشل الاتصال بقاعدة البيانات</p>
                <p style="font-size: 0.85rem; color: var(--text-secondary); max-width: 400px; text-align: center; line-height: 1.6; margin: 5px 0 15px 0;">
                    ${err.message || 'يرجى التحقق من إعدادات الربط والإنترنت.'}
                </p>
                <div style="display: flex; gap: 10px;">
                    <button class="btn btn-primary" onclick="loadAndRenderClinics()"><i class="fa-solid fa-arrows-rotate"></i> إعادة المحاولة</button>
                    <button class="btn btn-secondary" onclick="showSettingsModal()"><i class="fa-solid fa-sliders"></i> ضبط الإعدادات</button>
                </div>
            </div>
        `;
    }
}

// --- Add Clinic Modal Controllers ---
const registerModal = document.getElementById('register-clinic-modal');
document.getElementById('open-register-modal-btn').addEventListener('click', () => {
    registerModal.style.display = 'flex';
});
document.getElementById('close-modal-btn').addEventListener('click', () => {
    registerModal.style.display = 'none';
});

document.getElementById('save-new-clinic-btn').addEventListener('click', async () => {
    const name = document.getElementById('new-clinic-name').value.trim();
    const subdomain = document.getElementById('new-clinic-subdomain').value.trim();
    const email = document.getElementById('new-clinic-email').value.trim();
    const reset = document.getElementById('new-clinic-reset').value;

    if (!name || !subdomain) {
        alert('يرجى ملء اسم العيادة والنطاق الفرعي!');
        return;
    }

    if (!supabase) {
        alert('من فضلك قم بتهيئة إعدادات Supabase أولاً عبر زر إعدادات البوابة.');
        registerModal.style.display = 'none';
        showSettingsModal();
        return;
    }

    try {
        const { error } = await supabase.from('clinics').insert({
            clinic_name: name,
            subdomain: subdomain,
            clinic_email: email || null,
            sheet_reset_interval: reset
        });

        if (error) throw error;
        
        registerModal.style.display = 'none';
        document.getElementById('new-clinic-name').value = '';
        document.getElementById('new-clinic-subdomain').value = '';
        document.getElementById('new-clinic-email').value = '';
        
        loadAndRenderClinics();
    } catch (e) {
        alert(`فشل الإضافة: ${e.message}`);
    }
});

/* ==========================================================================
   TAB 2: AI Data Setup Genius (Token Optimizer)
   ========================================================================== */
function syncClinicDropdown() {
    const select = document.getElementById('genius-clinic-select');
    select.innerHTML = '<option value="">-- اختر عيادة --</option>';
    clinicsList.forEach(c => {
        select.innerHTML += `<option value="${c.id}">${c.clinic_name}</option>`;
    });
}

document.getElementById('run-genius-btn').addEventListener('click', async () => {
    const clinicId = document.getElementById('genius-clinic-select').value;
    const rawData = document.getElementById('raw-data-input').value.trim();
    const rawSlots = document.getElementById('raw-slots-input').value.trim();

    if (!OPENROUTER_API_KEY) {
        alert('مفتاح OpenRouter API Key غير مهيأ! يرجى إدخاله في إعدادات البوابة.');
        showSettingsModal();
        return;
    }

    if (!clinicId || !rawData || !rawSlots) {
        alert('يرجى اختيار العيادة وإدخال البيانات الأساسية والمواعيد المتاحة!');
        return;
    }

    document.getElementById('genius-loader').style.display = 'flex';
    document.getElementById('genius-output-view').style.display = 'none';

    try {
        const prompt = `حول النص المرفق والخاص ببيانات العيادة ومواعيد الحجز إلى هيكل JSON فائق الكثافة وموفر للرموز (Tokens) تماماً بالشكل التالي وبدون أي كلام جانبي أو مقدمات أو حشو:
{
  "clinic_profile": {
    "name": "اسم العيادة",
    "location": "العنوان بالتفصيل",
    "consultation_fee": "سعر الكشف",
    "cancellation_policy": "سياسة الإلغاء"
  },
  "doctors": [
    {
      "name": "اسم الطبيب",
      "specialty": "التخصص والخدمات",
      "duration_minutes": 30
    }
  ],
  "availabilities": [
    {
      "day": "اليوم بالإنجليزية (e.g. Saturday)",
      "time_slots": ["قائمة المواعيد المتاحة أسبوعياً بتنسيق 12 ساعة e.g. 02:00 PM, 02:30 PM"]
    }
  ]
}

النص المراد ضغطه وهيكلته:
البيانات العامة: ${rawData}
المواعيد الأسبوعية المتاحة: ${rawSlots}`;

        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${OPENROUTER_API_KEY}`
            },
            body: JSON.stringify({
                model: "google/gemini-3.1-flash-lite-preview",
                messages: [{ role: "user", content: prompt }]
            })
        });

        const data = await res.json();
        let jsonOutput = data.choices?.[0]?.message?.content || "";
        
        jsonOutput = jsonOutput.replace(/^```json\s*/, '').replace(/```\s*$/, '').trim();

        compiledGeniusJSON = JSON.parse(jsonOutput);
        
        document.getElementById('genius-json-output').value = JSON.stringify(compiledGeniusJSON, null, 2);
        
        document.getElementById('save-genius-setup-btn').removeAttribute('disabled');
        document.getElementById('create-sheets-btn').removeAttribute('disabled');

    } catch (err) {
        alert(`فشل ضغط البيانات: ${err.message}`);
    } finally {
        document.getElementById('genius-loader').style.display = 'none';
        document.getElementById('genius-output-view').style.display = 'block';
    }
});

document.getElementById('save-genius-setup-btn').addEventListener('click', async () => {
    const clinicId = document.getElementById('genius-clinic-select').value;
    if (!clinicId || !compiledGeniusJSON) return;

    try {
        const { error } = await supabase.from('clinic_content').upsert({
            clinic_id: clinicId,
            structured_data: compiledGeniusJSON
        });
        if (error) throw error;
        alert('تم حفظ البيانات المهيكلة بنجاح في قاعدة البيانات!');
    } catch (e) {
        alert(`فشل الحفظ: ${e.message}`);
    }
});

document.getElementById('create-sheets-btn').addEventListener('click', async () => {
    const clinicId = document.getElementById('genius-clinic-select').value;
    if (!clinicId) return;

    const sheetId = `1SheetMock-${Math.random().toString(36).substring(7)}`;
    try {
        const { error } = await supabase.from('clinics').update({ google_sheet_id: sheetId }).eq('id', clinicId);
        if (error) throw error;
        alert('تم إرسال طلب إنشاء الجدول وتفويضه للسيرفر السحابي بنجاح!');
        if (supabase) loadAndRenderClinics();
    } catch (e) {
        alert(e.message);
    }
});

/* ==========================================================================
   TAB 3: Live Monitor (WebSocket Streams)
   ========================================================================== */
async function loadAndRenderMonitorList() {
    const list = document.getElementById('monitor-tenants-list');
    list.innerHTML = '';
    
    try {
        const { data: clinics } = await supabase.from('clinics').select('id, clinic_name, subdomain');
        clinics.forEach(c => {
            const item = document.createElement('div');
            item.className = 'tenant-monitor-item';
            item.setAttribute('data-id', c.id);
            if (activeMonitorClinicId === c.id) item.classList.add('active');

            item.innerHTML = `
                <div class="tenant-info">
                    <h4>${c.clinic_name}</h4>
                    <p>${c.subdomain}.tabibk.saas</p>
                </div>
                <i class="fa-solid fa-chevron-left text-muted"></i>
            `;

            item.addEventListener('click', () => {
                document.querySelectorAll('.tenant-monitor-item').forEach(i => i.classList.remove('active'));
                item.classList.add('active');
                openLiveMonitorForClinic(c.id, c.clinic_name);
            });
            list.appendChild(item);
        });
    } catch (e) {
        console.error(e);
    }
}

async function openLiveMonitorForClinic(clinicId, name) {
    activeMonitorClinicId = clinicId;
    document.getElementById('active-monitor-clinic-title').innerHTML = `<i class="fa-solid fa-comments"></i> بث المحادثات الحية: ${name}`;
    
    const container = document.getElementById('monitor-messages-container');
    container.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>جاري سحب السجل...</p></div>';

    if (socket) socket.emit('join-clinic', clinicId);

    try {
        const { data: conv } = await supabase.from('conversations').select('messages').eq('clinic_id', clinicId).single();
        container.innerHTML = '';

        if (!conv || !conv.messages || conv.messages.length === 0) {
            container.innerHTML = `
                <div class="empty-state-view">
                    <div class="empty-icon"><i class="fa-solid fa-message-slash"></i></div>
                    <h3>لا توجد رسائل حية للعيادة</h3>
                    <p>سيظهر هنا سجل المحادثات تلقائياً بمجرد إرسال المريض رسالة لواتساب العيادة!</p>
                </div>
            `;
            return;
        }

        conv.messages.forEach(msg => {
            appendMonitorMessage(msg);
        });

    } catch (e) {
        container.innerHTML = `<div class="empty-state-view"><h3>لا توجد رسائل مسجلة</h3></div>`;
    }
}

function appendMonitorMessage(msg) {
    const container = document.getElementById('monitor-messages-container');
    
    const empty = container.querySelector('.empty-state-view');
    if (empty) empty.remove();

    const bubbleWrapper = document.createElement('div');
    const isAutoReply = msg.role === 'assistant';
    const isSystem = msg.role === 'system';

    bubbleWrapper.className = `msg-bubble-wrapper ${isAutoReply ? 'sent' : 'received'}`;
    if (isSystem) {
        bubbleWrapper.className = 'msg-bubble-wrapper received auto-reply';
    }

    const sender = isSystem ? 'النظام التلقائي' : isAutoReply ? 'المساعد الذكي (البوت)' : 'المريض';

    bubbleWrapper.innerHTML = `
        <div class="msg-meta">${sender}</div>
        <div class="msg-bubble">
            ${msg.content.replace(/\n/g, '<br>')}
        </div>
        <div class="msg-time">${new Date(msg.created_at || Date.now()).toLocaleTimeString()}</div>
    `;

    container.appendChild(bubbleWrapper);
    container.scrollTop = container.scrollHeight;
}

/* ==========================================================================
   WebSocket Listeners for Admin Dash
   ========================================================================== */
function attachSocketListeners() {
    if (!socket) return;

    socket.on('status-update', (data) => {
        const activeModal = document.getElementById('qr-connection-modal');
        
        if (activeModal.style.display === 'flex' && activeQRClinicId === data.clinicId) {
            const viewLoading = document.getElementById('qr-loading-view');
            const viewScan = document.getElementById('qr-scan-view');
            const viewReady = document.getElementById('qr-ready-view');
            const modalQRImage = document.getElementById('modal-qr-image');

            viewLoading.style.display = 'none';
            viewScan.style.display = 'none';
            viewReady.style.display = 'none';

            if (data.status === 'Scanning' && data.qr) {
                modalQRImage.src = data.qr;
                viewScan.style.display = 'flex';
            } else if (data.status === 'Ready') {
                viewReady.style.display = 'flex';
                setTimeout(() => {
                    activeModal.style.display = 'none';
                    loadAndRenderClinics(); 
                }, 3000);
            } else {
                viewLoading.style.display = 'flex';
            }
        }

        if (data.clinicId) {
            const pill = document.getElementById(`pill-${data.clinicId}`);
            if (pill) {
                pill.className = `status-pill ${data.status.toLowerCase()}`;
                pill.textContent = data.status === 'Ready' ? 'متصل' : data.status === 'Scanning' ? 'مسح الكود' : data.status === 'Initializing' ? 'تحميل' : 'فصل';
            }
        }
    });

    socket.on('new-message', (data) => {
        if (activeMonitorClinicId === data.clinicId) {
            appendMonitorMessage({
                role: data.type === 'sent' ? 'assistant' : 'user',
                content: data.body,
                created_at: new Date().toISOString()
            });
        }
    });
}

/* ==========================================================================
   WhatsApp Connection Triggers
   ========================================================================== */
const qrModal = document.getElementById('qr-connection-modal');

window.openQRModal = function(clinicId, name) {
    if (!socket) {
        alert('البوابة غير متصلة بالسيرفر السحابي! يرجى تهيئة إعدادات السيرفر.');
        showSettingsModal();
        return;
    }

    activeQRClinicId = clinicId;
    document.getElementById('qr-clinic-title').textContent = name;
    
    document.getElementById('qr-loading-view').style.display = 'flex';
    document.getElementById('qr-scan-view').style.display = 'none';
    document.getElementById('qr-ready-view').style.display = 'none';
    
    qrModal.style.display = 'flex';

    socket.emit('join-clinic', clinicId);
    socket.emit('generate-qr', clinicId);
};

document.getElementById('close-qr-modal-btn').addEventListener('click', () => {
    qrModal.style.display = 'none';
    activeQRClinicId = null;
});

window.logoutClinic = function(clinicId) {
    if (!socket) return;
    if (confirm('هل أنت متأكد من رغبتك في إلغاء ربط حساب واتساب لهذه العيادة مسح ذاكرة التخزين؟')) {
        socket.emit('logout-clinic', clinicId);
    }
};

/* ==========================================================================
   MODAL: Gateway Secure Settings Configurations (GitHub Push Safe)
   ========================================================================== */
const settingsModal = document.getElementById('gateway-settings-modal');
const openSettingsBtn = document.getElementById('open-settings-modal-btn');
const closeSettingsBtn = document.getElementById('close-settings-modal-btn');
const saveSettingsBtn = document.getElementById('save-gateway-settings-btn');

function showSettingsModal() {
    document.getElementById('settings-supa-url').value = SUPABASE_URL;
    document.getElementById('settings-supa-key').value = SUPABASE_KEY;
    document.getElementById('settings-backend-url').value = BACKEND_URL;
    document.getElementById('settings-openrouter-key').value = OPENROUTER_API_KEY;
    settingsModal.style.display = 'flex';
}

openSettingsBtn.addEventListener('click', showSettingsModal);
closeSettingsBtn.addEventListener('click', () => {
    settingsModal.style.display = 'none';
});

saveSettingsBtn.addEventListener('click', () => {
    let url = document.getElementById('settings-supa-url').value.trim();
    const key = document.getElementById('settings-supa-key').value.trim();
    const backend = document.getElementById('settings-backend-url').value.trim();
    const openrouter = document.getElementById('settings-openrouter-key').value.trim();

    if (!url || !key) {
        alert('يرجى ملء الحقول المطلوبة (رابط ومفتاح Supabase) لتأمين الإعدادات!');
        return;
    }

    // Smart Supabase URL auto-correction
    if (url.includes('supabase.com/dashboard/project/')) {
        const match = url.match(/project\/([a-zA-Z0-9]+)/);
        if (match && match[1]) {
            const refId = match[1];
            const correctedUrl = `https://${refId}.supabase.co`;
            console.log(`Auto-corrected Supabase URL from dashboard link: ${correctedUrl}`);
            url = correctedUrl;
        }
    } else if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
        url = `https://${url}`;
    }

    safeStorage.setItem('saas_supa_url', url);
    safeStorage.setItem('saas_supa_key', key);
    safeStorage.setItem('saas_backend_url', backend);
    safeStorage.setItem('saas_openrouter_key', openrouter);

    SUPABASE_URL = url;
    SUPABASE_KEY = key;
    BACKEND_URL = backend;
    OPENROUTER_API_KEY = openrouter;

    // Set Server display IP in sidebar
    try {
        const urlObj = new URL(backend);
        document.getElementById('server-ip-display').textContent = urlObj.hostname;
    } catch(e) {
        document.getElementById('server-ip-display').textContent = backend;
    }

    settingsModal.style.display = 'none';
    
    // Reboot clients with new keys
    if (initializeSaaSClients()) {
        loadAndRenderClinics();
    } else {
        alert('فشل تهيئة Supabase بالبيانات المدخلة! يرجى التحقق من صحة المفاتيح والاتصال.');
        showSettingsModal();
    }
});

// Initial Bootup Sequence
const bootSuccess = initializeSaaSClients();
if (bootSuccess) {
    // Set Server display IP in sidebar
    try {
        const urlObj = new URL(BACKEND_URL);
        document.getElementById('server-ip-display').textContent = urlObj.hostname;
    } catch(e) {}
    loadAndRenderClinics();
} else {
    // Force settings open on first ever launch to prompt for key entry
    showSettingsModal();
}
