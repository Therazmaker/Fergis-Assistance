/**
 * Mamá Girasol CRM v2.0
 * fergismarrero.com · Mayo 2026
 *
 * Basado en Fergis Assistant v0.1
 */

const LS_KEY = "fa_v01_state"; // Keeping original key for persistence
const SETTINGS_KEY = "fa_v01_settings";
const DB_NAME = "mama_girasol_db";
const DB_VERSION = 1;

const PROSPECT_PIPELINE = ["Investigando", "Lead", "Conversando", "Exploratoria", "Agendado", "Pagó", "No avanzó"];
const PROSPECT_ORIGINS = ["Instagram — orgánico", "TikTok — orgánico", "Pinterest", "Web — formulario", "Referido por clienta", "Comunidad Entre Diosas", "Lead magnet", "Otro"];
const CONTACT_CHANNELS = ["DM Instagram", "WhatsApp", "Email", "Formulario web"];
const CLIENT_STATES = ["Activa", "En pausa", "Seguimiento", "Finalizada"];
const SERVICE_TYPES = ["Diosa en guía", "Tu guía en cualquier momento", "Servicio espiritual", "Ninguno"];
const SPIRITUAL_SERVICES = ["Tarot", "Astrología", "Otro"];
const PAYMENT_METHODS = ["Yape", "Plin", "Transferencia", "PayPal", "Otro"];

let STATE;
let SETTINGS;

// ---- Utils ----
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const escapeHtml = (s) => (s||"").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = (prefix="id") => `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const nowISO = () => new Date().toISOString();
const todayKey = () => new Date().toISOString().split("T")[0];
const normalizeSearchText = (v) => String(v||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const amountNum = (v) => {
  if(typeof v === "number") return v;
  const n = parseFloat(String(v || "").replace(/[^\d.-]/g, ""));
  return isNaN(n) ? 0 : n;
};
const pad2 = (n) => String(n).padStart(2,"0");

// ---- State Management & Migration ----
async function loadState(){
  let st = null;
  try {
    const db = await openDB();
    const store = db.transaction("state", "readonly").objectStore("state");
    st = await new Promise(r => {
      const req = store.get("main");
      req.onsuccess = () => r(req.result);
      req.onerror = () => r(null);
    });
  } catch(e) { console.error("Error loading from IndexedDB", e); }

  if(!st) {
    console.log("No state in IndexedDB, checking localStorage...");
    try {
      const raw = localStorage.getItem(LS_KEY);
      if(raw) st = JSON.parse(raw);
    } catch(e) { console.error("Error loading from localStorage", e); }
  }

  return normalizeState(st);
}

function normalizeState(st){
  st = st || {};

  // Migration from v0.1 to v2.0
  const savedV = localStorage.getItem(LS_KEY + "_v");
  const currentV = st.v || savedV;

  if(!currentV || currentV === "0.1") {
    console.log("Migrating state from v0.1 to v2.0");
    // Preserve clients if they exist in old structure
    if(st.clients && Array.isArray(st.clients)) {
      st.clients = st.clients.map(c => ({
        id: c.id || uid("cli"),
        name: c.name || "",
        lastName: c.lastName || "",
        phone: c.phone || "",
        email: c.email || "",
        status: c.status || "Activa",
        activeService: c.activeService || "Ninguno",
        startDate: c.startDate || "",
        questionsUsed: c.questionsUsed || 0,
        generalNotes: c.notes || c.generalNotes || ""
      }));
    }

    // Migrate financial history if possible
    if(!st.payments) st.payments = [];
    if(st.subscriptions && Array.isArray(st.subscriptions)){
      st.subscriptions.forEach(s => {
        const client = st.clients.find(c => c.id === s.clientId);
        st.payments.push({
          id: uid("pay"), createdAt: s.createdAt || nowISO(),
          clientId: s.clientId, clientName: client ? `${client.name} ${client.lastName}` : "Legacy",
          amount: s.amount || 45, currency: s.currency || "USD",
          paymentDate: s.startDate || todayKey(), service: "Diosa en guía",
          paymentMethod: "Legacy", voucher: false
        });
      });
    }
    if(st.oneToOneSessions && Array.isArray(st.oneToOneSessions)){
      st.oneToOneSessions.forEach(s => {
        const client = st.clients.find(c => c.id === s.clientId);
        st.payments.push({
          id: uid("pay"), createdAt: s.createdAt || nowISO(),
          clientId: s.clientId, clientName: client ? `${client.name} ${client.lastName}` : "Legacy",
          amount: s.price || 0, currency: s.currency || "PEN",
          paymentDate: s.date || todayKey(), service: "Servicio espiritual",
          paymentMethod: "Legacy", voucher: false
        });
      });
    }
  }

  st.v = "2.0";
  st.prospects = Array.isArray(st.prospects) ? st.prospects : [];
  st.clients = Array.isArray(st.clients) ? st.clients : [];
  st.bookings = Array.isArray(st.bookings) ? st.bookings : [];
  st.payments = Array.isArray(st.payments) ? st.payments : [];
  st.eventQueue = Array.isArray(st.eventQueue) ? st.eventQueue : []; // Preserve sync queue
  st.activeTab = st.activeTab || "prospeccion";
  st.calMonth = st.calMonth || todayKey().slice(0,7);
  st.financeRange = st.financeRange || "1M";

  return st;
}

async function saveState(){
  try {
    const db = await openDB();
    const tx = db.transaction("state", "readwrite");
    tx.objectStore("state").put(STATE, "main");
    // Still keep version in localStorage to help break loops if IDB is wiped
    localStorage.setItem(LS_KEY + "_v", STATE.v || "2.0");
  } catch(e) {
    console.error("Error saving state to IndexedDB:", e);
  }
  if(SETTINGS.syncEnabled) syncSoon();
}

function loadSettings(){
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if(raw) return JSON.parse(raw);
  } catch(e) {}
  return { syncEnabled: false, appsScriptUrl: "", exchangeRate: 3.75, heroBlur: 1.5, heroOverlay: 0.75 };
}
function saveSettings(){ localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS)); }

// ---- IndexedDB (Vouchers / Hero) ----
function openDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if(!db.objectStoreNames.contains("assets")) db.createObjectStore("assets");
      if(!db.objectStoreNames.contains("state")) db.createObjectStore("state");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function saveAsset(id, data){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("assets", "readwrite");
    const store = tx.objectStore("assets");
    try {
      const req = store.put(data, id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    } catch(e) { reject(e); }
  });
}
async function loadAsset(id){
  const db = await openDB();
  return new Promise(r => {
    const req = db.transaction("assets").objectStore("assets").get(id);
    req.onsuccess = () => r(req.result);
  });
}

// ---- Sync Logic ----
let syncTimer = null;
function syncSoon(){
  if(syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(performSync, 5000);
}
async function performSync(){
  if(!SETTINGS.syncEnabled || !SETTINGS.appsScriptUrl) return;
  if(STATE.eventQueue.length === 0) return;

  console.log("Syncing events:", STATE.eventQueue.length);
  try {
    const res = await fetch(SETTINGS.appsScriptUrl, {
      method: "POST",
      body: JSON.stringify({
        app: "MamáGirasolCRM",
        v: "2.0",
        apiKey: SETTINGS.apiKey,
        events: STATE.eventQueue
      })
    });
    const data = await res.json();
    if(data.ok) {
      STATE.eventQueue = STATE.eventQueue.filter(e => !data.acked.includes(e.id));
      saveState();
      console.log("Sync successful, remaining events:", STATE.eventQueue.length);
    }
  } catch(e) { console.error("Sync failed", e); }
}

function pushEvent(type, payload){
  const evt = { id: uid("evt"), type, payload, ts: nowISO() };
  STATE.eventQueue.push(evt);
  // Cap the queue to 200 events to prevent localStorage bloat if sync is off/broken
  if(STATE.eventQueue.length > 200) STATE.eventQueue.shift();
  saveState();
}

// ---- CRUD Logic ----
function addProspect(obj){
  const p = { id: uid("pro"), createdAt: nowISO(), status: "Investigando", ...obj };
  STATE.prospects.unshift(p);
  pushEvent("add_prospect", p);
  saveState();
  render();
}
function updateProspect(id, patch){
  const p = STATE.prospects.find(x=>x.id===id);
  if(!p) return;
  Object.assign(p, patch);
  if(p.status === "Pagó"){
    addClient({
      name: p.name.split(" ")[0],
      lastName: p.name.split(" ").slice(1).join(" "),
      referredBy: p.referredBy,
      generalNotes: p.notes,
      startDate: todayKey(),
      status: "Activa",
      activeService: "Diosa en guía"
    });
    STATE.prospects = STATE.prospects.filter(x=>x.id!==id);
    toast("¡Conversión exitosa! Nueva clienta agregada. 🌻");
  }
  saveState();
  render();
}
function addClient(obj){
  const c = { id: uid("cli"), createdAt: nowISO(), questionsUsed: 0, status: "Activa", activeService: "Ninguno", ...obj };
  STATE.clients.unshift(c);
  pushEvent("add_client", c);
  saveState();
  render();
}
function updateClient(id, patch){
  const c = STATE.clients.find(x=>x.id===id);
  if(c) Object.assign(c, patch);
  saveState();
  render();
}
function addBooking(obj){
  const b = { id: uid("book"), createdAt: nowISO(), status: "Programada", sessionNotes: {}, ...obj };
  STATE.bookings.unshift(b);
  saveState();
  render();
}
function updateBooking(id, patch){
  const b = STATE.bookings.find(x=>x.id===id);
  if(b) Object.assign(b, patch);
  saveState();
  render();
}

// ---- UI Rendering ----
function render(){
  renderTabs();
  const tab = STATE.activeTab;
  if(tab === "prospeccion") renderProspects();
  if(tab === "clientes") renderClients();
  if(tab === "calendario") { renderCalendar(); renderBookings(); }
  if(tab === "finanzas") renderFinance();
  if(tab === "archivo") renderArchive();
  renderMetrics();
}

function renderTabs(){
  const activeTab = STATE.activeTab;
  $$(".tabBtn").forEach(b => {
    const isActive = b.dataset.tab === activeTab;
    b.classList.toggle("active", isActive);
  });
  $$(".tabPanel").forEach(p => {
    const isActive = p.dataset.panel === activeTab;
    p.classList.toggle("active", isActive);
    // Use the global .hidden class for more robust hiding
    if(isActive) p.classList.remove("hidden");
    else p.classList.add("hidden");
  });
}

function renderProspects(){
  const list = $("#prospectsList");
  if(!list) return;
  const filter = $("#prospectFilter").value;
  const q = normalizeSearchText($("#prospectSearch").value);
  let items = STATE.prospects.filter(p => filter === "all" || p.status === filter);
  if(q) items = items.filter(p => normalizeSearchText(p.name + (p.notes||"")).includes(q));

  list.innerHTML = items.map(p => `
    <div class="item">
      <div class="itemLeft">
        <div>
          <div class="itemTitle">${escapeHtml(p.name)} <span class="pill mini">${p.origin}</span></div>
          <div class="itemMeta">Estado: <b>${p.status}</b> • Próximo: ${escapeHtml(p.nextStep || "—")}</div>
        </div>
      </div>
      <button class="btn ghost btn-edit-prospect" data-id="${p.id}">Ficha</button>
    </div>
  `).join("") || '<div class="itemMeta">No hay prospectos activos.</div>';
}

function renderClients(){
  const list = $("#clientsList");
  if(!list) return;
  const filter = $("#clientFilter").value;
  const q = normalizeSearchText($("#clientSearch").value);
  let items = STATE.clients.filter(c => filter === "all" || c.status === filter);
  if(q) items = items.filter(c => normalizeSearchText(c.name + " " + c.lastName).includes(q));

  list.innerHTML = items.map(c => `
    <div class="item">
      <div class="itemLeft">
        <div>
          <div class="itemTitle">${escapeHtml(c.name)} ${escapeHtml(c.lastName || "")}</div>
          <div class="itemMeta">Servicio: ${escapeHtml(c.activeService || "Ninguno")} • <b>${c.status}</b></div>
          ${c.activeService === "Tu guía en cualquier momento" ? `<div class="itemMeta">Preguntas: ${c.questionsUsed || 0}/10</div>` : ''}
        </div>
      </div>
      <button class="btn ghost btn-edit-client" data-id="${c.id}">Ficha</button>
    </div>
  `).join("") || '<div class="itemMeta">Sin clientas registradas.</div>';
}

function renderCalendar(){
  const cal = $("#calendar");
  if(!cal) return;
  const ym = STATE.calMonth;
  const [y, m] = ym.split("-").map(Number);
  const first = new Date(y, m-1, 1);
  const last = new Date(y, m, 0);
  $("#calMonthLabel").textContent = first.toLocaleDateString('es', { month: 'long', year: 'numeric' });

  let html = '<div class="calendarGrid" style="display:grid; grid-template-columns:repeat(7, 1fr); gap:4px;">';
  ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"].forEach(d => html += `<div class="calDow" style="text-align:center; font-weight:700; font-size:10px; color:var(--muted)">${d}</div>`);
  let startDay = first.getDay() || 7;
  for(let i=1; i<startDay; i++) html += '<div></div>';
  for(let d=1; d<=last.getDate(); d++){
    const k = `${y}-${pad2(m)}-${pad2(d)}`;
    const items = STATE.bookings.filter(b => b.startAt.startsWith(k));
    const isToday = k === todayKey() ? 'background:rgba(245,200,66,.2); border-color:var(--girasol);' : '';
    html += `<div class="calCell" style="border:1px solid var(--line); padding:4px; min-height:45px; border-radius:8px; cursor:pointer; ${isToday}" data-day="${k}">
      <div style="font-size:11px; font-weight:700;">${d}</div>
      ${items.length ? `<div style="width:6px; height:6px; background:var(--girasol); border-radius:50%; margin: 4px auto 0;"></div>` : ''}
    </div>`;
  }
  html += '</div>';
  cal.innerHTML = html;
}

function renderBookings(){
  const list = $("#bookingsList");
  if(!list) return;
  const items = STATE.bookings.filter(b => b.status === "Programada").sort((a,b)=> new Date(a.startAt) - new Date(b.startAt));
  list.innerHTML = items.map(b => `
    <div class="item">
      <div class="itemLeft">
        <div>
          <div class="itemTitle">${escapeHtml(b.clientName)}</div>
          <div class="itemMeta">${new Date(b.startAt).toLocaleString()} • ${escapeHtml(b.serviceType)}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn ghost btn-notes-booking" data-id="${b.id}">📝 Notas</button>
        <button class="btn ghost btn-edit-booking" data-id="${b.id}">✎ Editar</button>
      </div>
    </div>
  `).join("") || '<div class="itemMeta">Sin próximas sesiones programadas.</div>';
}

function renderFinance(){
  const range = STATE.financeRange;
  const now = new Date();
  let startDate = new Date(now.getFullYear(), now.getMonth(), 1);
  if(range === "3M") startDate.setMonth(now.getMonth() - 2);
  if(range === "6M") startDate.setMonth(now.getMonth() - 5);
  if(range === "1Y") startDate.setFullYear(now.getFullYear() - 1);

  const filteredPayments = STATE.payments.filter(p => new Date(p.paymentDate) >= startDate);
  const totalPEN = filteredPayments.filter(p=>p.currency==="PEN").reduce((s,p)=>s+amountNum(p.amount),0);
  const totalUSD = filteredPayments.filter(p=>p.currency==="USD").reduce((s,p)=>s+amountNum(p.amount),0);

  const byService = {};
  filteredPayments.forEach(p => {
    byService[p.service] = (byService[p.service] || 0) + (p.currency === "USD" ? amountNum(p.amount) * SETTINGS.exchangeRate : amountNum(p.amount));
  });

  $("#financeTotals").innerHTML = `
    <div class="metric"><div class="metricLabel">Ingresos PEN</div><div class="metricValue">S/ ${totalPEN.toFixed(2)}</div></div>
    <div class="metric"><div class="metricLabel">Ingresos USD</div><div class="metricValue">$ ${totalUSD.toFixed(2)}</div></div>
    <div class="metric" style="grid-column: span 2"><div class="metricLabel">Por Servicio (equiv. PEN)</div>
      <div class="itemMeta" style="margin-top:5px">
        ${Object.entries(byService).map(([s,v]) => `<div>${s}: <b>S/ ${v.toFixed(0)}</b></div>`).join("") || "Sin datos"}
      </div>
    </div>
    <button class="btn primary" id="btnOpenPaymentModal" style="grid-column: span 2">+ Registrar Pago</button>
  `;

  const list = $("#financeChart");
  if(!list) return;
  list.innerHTML = `<h4>Últimos Pagos (${range})</h4>` + filteredPayments.slice(0,10).map(p => `
    <div class="item compact">
      <div class="itemLeft">
        <div>
          <div class="itemTitle">${escapeHtml(p.clientName)} - ${p.currency} ${p.amount}</div>
          <div class="itemMeta">${p.paymentDate} • ${p.service} • ${p.paymentMethod}</div>
          ${!p.voucher ? '<div class="voucher-pending">⚠ Comprobante pendiente</div>' : ''}
        </div>
      </div>
      ${p.voucher ? `<button class="btn ghost tiny btn-view-voucher" data-id="${p.id}">Ver Comprobante</button>` : ''}
    </div>
  `).join("");
}

function renderArchive(){
  const list = $("#archiveList");
  if(!list) return;
  const filter = $("#archiveModuleFilter").value;
  const q = normalizeSearchText($("#archiveSearch").value);
  let html = "";
  if(filter === "all" || filter === "prospectos"){
    STATE.prospects.filter(p=>p.status==="No avanzó").forEach(p => {
      if(q && !normalizeSearchText(p.name).includes(q)) return;
      html += `<div class="item"><div class="itemLeft"><div><div class="itemTitle">${escapeHtml(p.name)}</div><div class="itemMeta">No avanzó • Recontacto: ${p.recontactDate || "—"}</div></div></div><button class="btn ghost btn-edit-prospect" data-id="${p.id}">Ficha</button></div>`;
    });
  }
  if(filter === "all" || filter === "clientes"){
    STATE.clients.filter(c=>c.status==="Finalizada").forEach(c => {
      if(q && !normalizeSearchText(c.name + " " + c.lastName).includes(q)) return;
      html += `<div class="item"><div class="itemLeft"><div><div class="itemTitle">${escapeHtml(c.name)} ${escapeHtml(c.lastName)}</div><div class="itemMeta">Finalizada</div></div></div><button class="btn ghost btn-edit-client" data-id="${c.id}">Ficha</button></div>`;
    });
  }
  if(filter === "all" || filter === "sesiones"){
    STATE.bookings.filter(b=>["Realizada", "Cancelada"].includes(b.status)).forEach(b => {
      if(q && !normalizeSearchText(b.clientName).includes(q)) return;
      html += `<div class="item"><div class="itemLeft"><div><div class="itemTitle">${escapeHtml(b.clientName)}</div><div class="itemMeta">${b.status} el ${new Date(b.startAt).toLocaleDateString()}</div></div></div><button class="btn ghost btn-edit-booking" data-id="${b.id}">Detalles</button></div>`;
    });
  }
  list.innerHTML = html || '<div class="itemMeta">Archivo vacío.</div>';
}

function renderMetrics(){
  const disp = $("#heroLevelDisplay");
  if(disp){
    const soles = STATE.payments.reduce((sum, p) => sum + amountNum(p.amount) * (p.currency==="USD"?SETTINGS.exchangeRate:1), 0);
    const level = Math.min(11, Math.floor(soles/200) + 1);
    disp.innerHTML = `<div class="level-display"><div class="level-info"><div class="level-header"><span class="level-badge-num">${level}</span> <span class="level-name">Nivel Mensual</span></div><div class="level-soles">Total: S/ ${soles.toFixed(0)}</div></div></div>`;
  }

  const list = $("#recontactRemindersList");
  if(!list) return;
  const now = todayKey();

  const recontacts = STATE.prospects.filter(p => p.status === "No avanzó" && p.recontactDate && p.recontactDate <= now);
  const imminent = STATE.bookings.filter(b => b.status === "Programada" && new Date(b.startAt) > new Date() && (new Date(b.startAt) - new Date()) < 3600000);
  const renewals = STATE.clients.filter(c => {
    if(c.status !== "Activa" || !c.startDate || !["Diosa en guía", "Tu guía en cualquier momento"].includes(c.activeService)) return false;
    const start = new Date(c.startDate);
    const today = new Date();
    const months = (today.getFullYear() - start.getFullYear()) * 12 + today.getMonth() - start.getMonth();
    const next = new Date(start);
    next.setMonth(start.getMonth() + months + (today.getDate() >= start.getDate() ? 1 : 0));
    const diff = next - today;
    return diff >= 0 && diff < (5 * 86400000);
  });

  let html = recontacts.map(p => `
    <div class="item imminent-session">
      <div class="itemLeft"><div><div class="itemTitle">🔔 Recontacto: ${escapeHtml(p.name)}</div><div class="itemMeta">Razón: ${escapeHtml(p.reasonNoAdvance || "—")}</div></div></div>
      <button class="btn primary tiny btn-edit-prospect" data-id="${p.id}">Ver</button>
    </div>`).join("");

  html += imminent.map(b => `
    <div class="item imminent-session">
      <div class="itemLeft"><div><div class="itemTitle">⏰ Próxima Sesión: ${escapeHtml(b.clientName)}</div><div class="itemMeta">Comienza muy pronto</div></div></div>
      <button class="btn primary tiny btn-notes-booking" data-id="${b.id}">Notas</button>
    </div>`).join("");

  html += renewals.map(c => `
    <div class="item imminent-session" style="border-left:4px solid var(--ok)">
      <div class="itemLeft"><div><div class="itemTitle">📅 Renovación: ${escapeHtml(c.name)}</div><div class="itemMeta">Vence en pocos días</div></div></div>
      <button class="btn primary tiny btn-edit-client" data-id="${c.id}">Ver</button>
    </div>`).join("");

  list.innerHTML = html || '<div class="itemMeta">No hay recordatorios pendientes para hoy.</div>';
}

// ---- Modals ----
function openModal(title, bodyHtml, footHtml, opts={}){
  const modal = $(".modal");
  modal.className = "modal " + (opts.size === "lg" ? "modal-lg" : "modal-md");
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = bodyHtml;
  $("#modalFoot").innerHTML = footHtml;
  $("#modalOverlay").classList.remove("hidden");
}
const closeModal = () => $("#modalOverlay").classList.add("hidden");

function openProspectModal(id){
  const p = id ? STATE.prospects.find(x=>x.id===id) : null;
  openModal(id?"Ficha de Prospecto":"Nuevo Prospecto", `
    <div class="grid2">
      <div class="row"><label class="label">Nombre / Usuario</label><input id="mPName" class="input" value="${escapeHtml(p?.name||"")}" /></div>
      <div class="row"><label class="label">Origen</label><select id="mPOrigin" class="input">${PROSPECT_ORIGINS.map(o=>`<option ${p?.origin===o?"selected":""}>${o}</option>`).join("")}</select></div>
      <div class="row"><label class="label">Fecha Contacto</label><input id="mPFirst" type="date" class="input" value="${p?.firstContactDate||todayKey()}" /></div>
      <div class="row"><label class="label">Canal</label><select id="mPChannel" class="input">${CONTACT_CHANNELS.map(c=>`<option ${p?.contactChannel===c?"selected":""}>${c}</option>`).join("")}</select></div>
      <div class="row"><label class="label">Estado</label><select id="mPStatus" class="input">${PROSPECT_PIPELINE.map(s=>`<option ${p?.status===s?"selected":""}>${s}</option>`).join("")}</select></div>
      <div class="row"><label class="label">Referida por</label><input id="mPRef" class="input" value="${escapeHtml(p?.referredBy||"")}" /></div>
    </div>
    <div class="row"><label class="label">Notas</label><textarea id="mPNotes" class="input" rows="3">${escapeHtml(p?.notes||"")}</textarea></div>
    <div class="divider"></div>
    <div class="grid2">
      <div class="row"><label class="label">Próximo Paso</label><input id="mPNext" class="input" value="${escapeHtml(p?.nextStep||"")}" /></div>
      <div class="row"><label class="label">Fecha P. Paso</label><input id="mPNextDate" type="date" class="input" value="${p?.nextStepDate||""}" /></div>
      <div class="row"><label class="label">Último contacto</label><input id="mPLast" type="date" class="input" value="${p?.lastContactDate||""}" /></div>
      <div class="row"><label class="label">Fecha Recontacto</label><input id="mPRecon" type="date" class="input" value="${p?.recontactDate||""}" /></div>
    </div>
    <div class="row"><label class="label">Motivo no avanzó</label><input id="mPReason" class="input" value="${escapeHtml(p?.reasonNoAdvance||"")}" /></div>
  `, `<button class="btn btn-close-modal">Cerrar</button><button class="btn primary btn-save-prospect" data-id="${id||""}">Guardar</button>`, {size:"lg"});
}

function openClientModal(id){
  const c = id ? STATE.clients.find(x=>x.id===id) : null;
  const isQuestionService = c?.activeService === "Tu guía en cualquier momento";
  openModal(id?"Ficha de Clienta":"Nueva Clienta", `
    <div class="grid2">
      <div class="row"><label class="label">Nombre</label><input id="mCName" class="input" value="${escapeHtml(c?.name||"")}" /></div>
      <div class="row"><label class="label">Apellido</label><input id="mCLastName" class="input" value="${escapeHtml(c?.lastName||"")}" /></div>
      <div class="row"><label class="label">Año Nacimiento</label><input id="mCBirthYear" type="number" class="input" value="${c?.birthYear||""}" /></div>
      <div class="row"><label class="label">Email</label><input id="mCEmail" type="email" class="input" value="${escapeHtml(c?.email||"")}" /></div>
      <div class="row"><label class="label">Teléfono</label><input id="mCPhone" class="input" value="${escapeHtml(c?.phone||"")}" /></div>
      <div class="row"><label class="label">Servicio Activo</label><select id="mCService" class="input">${SERVICE_TYPES.map(s=>`<option ${c?.activeService===s?"selected":""}>${s}</option>`).join("")}</select></div>
      <div class="row"><label class="label">Estado</label><select id="mCStatus" class="input">${CLIENT_STATES.map(s=>`<option ${c?.status===s?"selected":""}>${s}</option>`).join("")}</select></div>
      <div class="row"><label class="label">Fecha Inicio</label><input id="mCStart" type="date" class="input" value="${c?.startDate||""}" /></div>
      <div class="row"><label class="label">Referida por</label><input id="mCRef" class="input" value="${escapeHtml(c?.referredBy||"")}" /></div>
      ${isQuestionService ? `
      <div class="row">
        <label class="label">Preguntas Usadas (${c.questionsUsed||0}/10)</label>
        <div style="display:flex;gap:4px">
          <button class="btn tiny btn-client-q" data-id="${c.id}" data-delta="-1">-1</button>
          <button class="btn tiny primary btn-client-q" data-id="${c.id}" data-delta="1">+1</button>
          <button class="btn tiny ghost btn-client-q" data-id="${c.id}" data-delta="reset">Reset</button>
        </div>
      </div>` : ''}
    </div>
    <div class="row"><label class="label">Lugar Nacimiento</label><input id="mCBP" class="input" value="${escapeHtml(c?.birthPlace||"")}" /></div>
    <div class="row"><label class="label">Lugar Residencia</label><input id="mCRP" class="input" value="${escapeHtml(c?.residencePlace||"")}" /></div>
    <div class="row"><label class="label">Notas generales</label><textarea id="mCNotes" class="input" rows="3">${escapeHtml(c?.generalNotes||"")}</textarea></div>
  `, `<button class="btn btn-close-modal">Cerrar</button><button class="btn primary btn-save-client" data-id="${id||""}">Guardar</button>`, {size:"lg"});
}

function openPaymentModal(){
  const clientOptions = STATE.clients.map(c=>`<option value="${c.id}">${escapeHtml(c.name)} ${escapeHtml(c.lastName||"")}</option>`).join("");
  openModal("Registrar Pago", `
    <div class="row"><label class="label">Clienta</label><select id="mPayC" class="input">${clientOptions}</select></div>
    <div class="grid2">
      <div class="row"><label class="label">Monto</label><input id="mPayA" type="number" class="input" step="0.01" /></div>
      <div class="row"><label class="label">Moneda</label><select id="mPayCur" class="input"><option>PEN</option><option>USD</option></select></div>
    </div>
    <div class="row"><label class="label">Servicio</label><select id="mPaySer" class="input">${SERVICE_TYPES.map(s=>`<option>${s}</option>`).join("")}</select></div>
    <div class="row"><label class="label">Método de pago</label><select id="mPayMeth" class="input">${PAYMENT_METHODS.map(m=>`<option>${m}</option>`).join("")}</select></div>
    <div class="row"><label class="label">Comprobante</label><input id="mPayVoucher" type="file" class="input" /></div>
  `, `<button class="btn btn-close-modal">Cancelar</button><button class="btn primary btn-save-payment">Guardar Pago</button>`);
}

function openBookingModal(id){
  const b = id ? STATE.bookings.find(x=>x.id===id) : null;
  const clientOptions = STATE.clients.map(c=>`<option value="${c.id}" ${b?.clientId===c.id?"selected":""}>${escapeHtml(c.name)} ${escapeHtml(c.lastName||"")}</option>`).join("");
  openModal(id?"Editar Sesión":"Programar Sesión", `
    <div class="row"><label class="label">Clienta</label><select id="mBC" class="input"><option value="">-- Seleccionar --</option>${clientOptions}</select></div>
    <div class="row"><label class="label">Fecha</label><input id="mBStart" type="datetime-local" class="input" value="${b?.startAt ? b.startAt.slice(0,16) : ""}" /></div>
    <div class="row"><label class="label">Tipo</label><select id="mBType" class="input">${SPIRITUAL_SERVICES.map(s=>`<option ${b?.type===s?"selected":""}>${s}</option>`).join("")}</select></div>
    <div class="row"><label class="label">Estado</label><select id="mBStatus" class="input"><option ${b?.status==="Programada"?"selected":""}>Programada</option><option ${b?.status==="Realizada"?"selected":""}>Realizada</option><option ${b?.status==="Cancelada"?"selected":""}>Cancelada</option></select></div>
  `, `<button class="btn btn-close-modal">Cancelar</button><button class="btn primary btn-save-booking" data-id="${id||""}">Guardar</button>`);
}

function openSessionNotesModal(id){
  const b = STATE.bookings.find(x=>x.id===id);
  openModal("Notas de Sesión", `
    <div class="row"><label class="label">Lo que se habló (Resumen)</label><textarea id="mTalk" class="input" rows="3" placeholder="Resumen de los temas principales...">${b.sessionNotes?.talk||""}</textarea></div>
    <div class="row"><label class="label">Recomendaciones dadas</label><textarea id="mRecs" class="input" rows="3" placeholder="Sugerencias, ejercicios, reflexiones...">${b.sessionNotes?.recs||""}</textarea></div>
    <div class="row"><label class="label">Lo que surgió</label><textarea id="mEmer" class="input" rows="3" placeholder="Emociones, patrones, momentos importantes...">${b.sessionNotes?.emer||""}</textarea></div>
    <div class="row"><label class="label">Preparación próxima sesión</label><input id="mPrep" class="input" placeholder="Qué revisar o profundizar..." value="${b.sessionNotes?.prep||""}" /></div>
    <div class="row"><label class="label">Observaciones</label><textarea id="mObs" class="input" rows="2">${b.sessionNotes?.obs||""}</textarea></div>
  `, `<button class="btn btn-close-modal">Cerrar</button><button class="btn primary btn-save-session-notes" data-id="${id}">Finalizar y Guardar</button>`, {size:"lg"});
}

// ---- Event Wiring ----
function wire(){
  // Tabs
  $("#tabsNav").onclick = e => {
    const btn = e.target.closest(".tabBtn");
    if(btn) { STATE.activeTab = btn.dataset.tab; saveState(); render(); }
  };

  // Generic Search/Filter
  $("#prospectFilter").onchange = render;
  $("#prospectSearch").oninput = render;
  $("#clientFilter").onchange = render;
  $("#clientSearch").oninput = render;
  $("#archiveModuleFilter").onchange = render;
  $("#archiveSearch").oninput = render;

  $("#financeRangeFilters").onclick = e => {
    const btn = e.target.closest("button");
    if(btn) { STATE.financeRange = btn.dataset.range; render(); }
  };

  // Add buttons
  $("#btnAddProspect").onclick = () => openProspectModal();
  $("#btnAddClient").onclick = () => openClientModal();
  $("#btnAddBooking").onclick = () => openBookingModal();

  // Calendar Nav
  $("#btnCalPrev").onclick = () => {
    const [y,m] = STATE.calMonth.split("-").map(Number);
    let nm = m-1, ny = y; if(nm<1){ nm=12; ny--; }
    STATE.calMonth = `${ny}-${pad2(nm)}`; render();
  };
  $("#btnCalNext").onclick = () => {
    const [y,m] = STATE.calMonth.split("-").map(Number);
    let nm = m+1, ny = y; if(nm>12){ nm=1; ny++; }
    STATE.calMonth = `${ny}-${pad2(nm)}`; render();
  };

  // Global Modal Events
  $("#modalOverlay").onclick = e => {
    // Save Prospect
    if(e.target.closest(".btn-save-prospect")){
      const id = e.target.closest(".btn-save-prospect").dataset.id;
      const data = {
        name: $("#mPName").value, origin: $("#mPOrigin").value, firstContactDate: $("#mPFirst").value,
        contactChannel: $("#mPChannel").value, status: $("#mPStatus").value, referredBy: $("#mPRef").value,
        nextStep: $("#mPNext").value, nextStepDate: $("#mPNextDate").value, lastContactDate: $("#mPLast").value,
        recontactDate: $("#mPRecon").value, reasonNoAdvance: $("#mPReason").value, notes: $("#mPNotes").value
      };
      if(id) updateProspect(id, data); else addProspect(data);
      closeModal();
    }
    // Save Client
    if(e.target.closest(".btn-save-client")){
      const id = e.target.closest(".btn-save-client").dataset.id;
      const data = {
        name: $("#mCName").value, lastName: $("#mCLastName").value, birthYear: $("#mCBirthYear").value,
        email: $("#mCEmail").value, phone: $("#mCPhone").value, activeService: $("#mCService").value,
        status: $("#mCStatus").value, startDate: $("#mCStart").value, referredBy: $("#mCRef").value,
        birthPlace: $("#mCBP").value, residencePlace: $("#mCRP").value, generalNotes: $("#mCNotes").value
      };
      if(id) updateClient(id, data); else addClient(data);
      closeModal();
    }
    // Client Question Counter
    if(e.target.closest(".btn-client-q")){
      const btn = e.target.closest(".btn-client-q");
      const id = btn.dataset.id;
      const delta = btn.dataset.delta;
      const c = STATE.clients.find(x=>x.id===id);
      if(c){
        if(delta === "reset") c.questionsUsed = 0;
        else c.questionsUsed = Math.max(0, Math.min(10, (c.questionsUsed||0) + parseInt(delta)));
        saveState();
        openClientModal(id);
      }
    }
    // Save Payment
    if(e.target.closest(".btn-save-payment")){
      (async () => {
        const c = STATE.clients.find(x=>x.id===$("#mPayC").value);
        const fileEl = $("#mPayVoucher");
        const payId = uid("pay");
        let hasVoucher = false;
        if(fileEl.files && fileEl.files[0]) {
          const data = await new Promise(r => { const reader = new FileReader(); reader.onload = e => r(e.target.result); reader.readAsDataURL(fileEl.files[0]); });
          await saveAsset(`vouch_${payId}`, data);
          hasVoucher = true;
        }
        const service = $("#mPaySer").value;
        const pay = {
          id: payId, createdAt: nowISO(), clientId: c?.id, clientName: c?`${c.name} ${c.lastName}`:'Manual',
          amount: $("#mPayA").value, currency: $("#mPayCur").value, voucher: hasVoucher,
          paymentDate: todayKey(), service, paymentMethod: $("#mPayMeth").value
        };
        STATE.payments.unshift(pay);

        // Automation: Schedule 4 sessions for "Diosa en guía"
        if(service === "Diosa en guía" && c){
          const baseDate = new Date();
          for(let i=1; i<=4; i++){
            const d = new Date(baseDate);
            d.setDate(d.getDate() + (i * 7)); // Once a week
            addBooking({
              clientId: c.id, clientName: `${c.name} ${c.lastName}`,
              startAt: d.toISOString().slice(0,16),
              serviceType: "Tarot", // Default spiritual type
              status: "Programada",
              sessionNumberLabel: `${i} de 4`
            });
          }
          toast("Suscripción renovada: 4 sesiones agendadas automáticamente. 🌻");
        }

        saveState(); render(); closeModal();
      })();
    }
    // Save Booking
    if(e.target.closest(".btn-save-booking")){
      const id = e.target.closest(".btn-save-booking").dataset.id;
      const c = STATE.clients.find(x=>x.id===$("#mBC").value);
      const data = { clientId: c?.id, clientName: c?`${c.name} ${c.lastName}`:'Manual', startAt: $("#mBStart").value, serviceType: $("#mBType").value, status: $("#mBStatus").value };
      if(id) updateBooking(id, data); else addBooking(data);
      closeModal();
    }
    // Save Session Notes
    if(e.target.closest(".btn-save-session-notes")){
      const id = e.target.closest(".btn-save-session-notes").dataset.id;
      updateBooking(id, {
        status: "Realizada",
        sessionNotes: {
          talk: $("#mTalk").value, recs: $("#mRecs").value, emer: $("#mEmer").value,
          prep: $("#mPrep").value, obs: $("#mObs").value
        }
      });
      closeModal();
    }
    if(e.target.closest(".btn-close-modal") || e.target.id === "modalClose") closeModal();
  };

  // Settings
  $("#btnSettings").onclick = () => {
    openModal("Ajustes", `
      <div class="row"><label class="label">Apps Script URL</label><input id="sUrl" class="input" value="${SETTINGS.appsScriptUrl||""}" /></div>
      <div class="row"><label class="label">API Key</label><input id="sKey" class="input" value="${SETTINGS.apiKey||""}" /></div>
      <div class="row"><label class="label">Tipo de cambio (PEN/USD)</label><input id="sRate" type="number" step="0.01" class="input" value="${SETTINGS.exchangeRate}" /></div>
      <div class="row"><label style="display:flex;align-items:center;gap:8px"><input id="sSync" type="checkbox" ${SETTINGS.syncEnabled?"checked":""} /> Habilitar Sync</label></div>
      <div class="divider"></div>
      <div class="row"><button class="btn warn" id="btnExport">Exportar Backup JSON</button></div>
    `, `<button class="btn btn-close-modal">Cerrar</button><button class="btn primary btn-save-settings">Guardar Ajustes</button>`);
  };

  // Delegation for list items
  document.body.onclick = e => {
    if(e.target.closest(".btn-save-settings")){
      SETTINGS.appsScriptUrl = $("#sUrl").value;
      SETTINGS.apiKey = $("#sKey").value;
      SETTINGS.exchangeRate = parseFloat($("#sRate").value);
      SETTINGS.syncEnabled = $("#sSync").checked;
      saveSettings();
      closeModal();
      toast("Ajustes guardados.");
      render();
    }
    if(e.target.id === "btnExport"){
      const blob = new Blob([JSON.stringify(STATE)], {type:"application/json"});
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `mama_girasol_backup_${todayKey()}.json`;
      a.click();
    }
    const editProspect = e.target.closest(".btn-edit-prospect");
    if(editProspect) openProspectModal(editProspect.dataset.id);

    const editClient = e.target.closest(".btn-edit-client");
    if(editClient) openClientModal(editClient.dataset.id);

    const editBooking = e.target.closest(".btn-edit-booking");
    if(editBooking) openBookingModal(editBooking.dataset.id);

    const notesBooking = e.target.closest(".btn-notes-booking");
    if(notesBooking) openSessionNotesModal(notesBooking.dataset.id);

    if(e.target.id === "btnOpenPaymentModal") openPaymentModal();

    const viewVoucher = e.target.closest(".btn-view-voucher");
    if(viewVoucher) (async () => {
      const src = await loadAsset(`vouch_${viewVoucher.dataset.id}`);
      if(src) {
        const w = window.open();
        if(src.startsWith("data:application/pdf")) w.location.href = src;
        else w.document.write(`<body style="margin:0; background:#3E1F0E; display:flex; align-items:center; justify-content:center;"><img src="${src}" style="max-width:100%; max-height:100vh;"></body>`);
      }
    })();

    const calCell = e.target.closest(".calCell");
    if(calCell) {
      const day = calCell.dataset.day;
      const items = STATE.bookings.filter(b => b.startAt.startsWith(day));
      let html = items.map(b => `<div class="item"><div>${b.clientName}</div><button class="btn ghost btn-edit-booking" data-id="${b.id}">✎</button></div>`).join("") || 'Nada hoy.';
      openModal(`Agenda ${day}`, html);
    }
  };

  // Hero BG image
  const imgInput = $("#heroImageInput");
  $("#heroImagePlaceholder").onclick = () => imgInput.click();
  imgInput.onchange = () => {
    const file = imgInput.files[0];
    if(file){
      const reader = new FileReader();
      reader.onload = e => {
        const img = new Image();
        img.onload = async () => {
          // Resize image to max 1920px width/height to save space
          const canvas = document.createElement("canvas");
          let w = img.width, h = img.height;
          const max = 1920;
          if(w > max || h > max){
            if(w > h) { h *= max/w; w = max; }
            else { w *= max/h; h = max; }
          }
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          const src = canvas.toDataURL("image/jpeg", 0.75); // Compress as JPEG
          
          $("#heroBgImage").style.backgroundImage = `url(${src})`;
          $("#heroBgImage").classList.remove("hidden");
          $("#heroBgOverlay").classList.remove("hidden");
          $("#heroCard").classList.add("has-bg-image");
          try {
            await saveAsset("hero_img", src);
            toast("Imagen de fondo guardada. 🌻");
          } catch(err) {
            console.error("Error saving hero image", err);
            toast("Error al guardar imagen (espacio insuficiente)");
          }
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    }
  };
}

// ---- Helper UI ----
function toast(msg){ const el = document.createElement("div"); el.className = "toast"; el.textContent = msg; document.body.appendChild(el); setTimeout(()=>el.remove(), 2000); }

// ---- Init ----
(async () => {
  STATE = await loadState();
  SETTINGS = loadSettings();
  
  // Try loading hero img
  try {
    const src = await loadAsset("hero_img");
    if(src){
      $("#heroBgImage").style.backgroundImage = `url(${src})`;
      $("#heroBgImage").classList.remove("hidden");
      $("#heroBgOverlay").classList.remove("hidden");
      $("#heroCard").classList.add("has-bg-image");
    }
  } catch(e) {}

  wire();
  render();
})();
