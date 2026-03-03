// Fergis Assistant v0.1
// Local-first + cola de eventos para sync a Google Sheets (Apps Script) cuando lo activemos.
// Importante: esto es un arranque estable, con estructura clara para crecer.

const LS_KEY = "fa_v01_state";
const SETTINGS_KEY = "fa_v01_settings";
const DB_NAME = "fergis_assistant_db";
const DB_VERSION = 1;
const STATE_STORE = "state_snapshots";
const STATE_SNAPSHOT_ID = "main";

const DEFAULT_SETTINGS = {
  syncEnabled: false,
  appsScriptUrl: "",        // ejemplo: https://script.google.com/macros/s/XXXX/exec
  apiKey: ""                // opcional (si lo quieres validar en Apps Script)
};

// IMPORTANT:
// `STATE` is referenced by helper functions declared near the top of this file.
// Declare it here (without initialization) to avoid the Temporal Dead Zone error
// "Cannot access 'STATE' before initialization".
let STATE;
let CONTENT_DRAG = null;
let IDB_PROMISE = null;

const nowISO = () => new Date().toISOString();
const todayKey = () => new Date().toISOString().slice(0,10);

// ---- Zodiac helpers ----
const ZODIAC_SIGNS = [
  "Aries","Tauro","Géminis","Cáncer","Leo","Virgo","Libra","Escorpio","Sagitario","Capricornio","Acuario","Piscis"
];

function normHandle(h){
  return (h||"").trim().replace(/^@/,"").toLowerCase();
}

function zodiacFromDob(dob){
  // dob: "YYYY-MM-DD"
  try{
    if(!dob) return "";
    const [y,m,d] = dob.split("-").map(Number);
    if(!m || !d) return "";
    const md = m*100 + d;
    if(md >= 321 && md <= 419) return "Aries";
    if(md >= 420 && md <= 520) return "Tauro";
    if(md >= 521 && md <= 620) return "Géminis";
    if(md >= 621 && md <= 722) return "Cáncer";
    if(md >= 723 && md <= 822) return "Leo";
    if(md >= 823 && md <= 922) return "Virgo";
    if(md >= 923 && md <= 1022) return "Libra";
    if(md >= 1023 && md <= 1121) return "Escorpio";
    if(md >= 1122 && md <= 1221) return "Sagitario";
    if(md >= 1222 || md <= 119) return "Capricornio";
    if(md >= 120 && md <= 218) return "Acuario";
    if(md >= 219 && md <= 320) return "Piscis";
    return "";
  }catch(e){ return ""; }
}

function findClientByBookingClientString(str, st = STATE){
  // Busca por handle (con o sin @) o por nombre
  // Nota: durante normalizeState(), STATE aún puede no estar inicializado.
  // Por eso aceptamos `st` (state candidato) y caemos a [] si no hay clientes.
  const clients = (st && Array.isArray(st.clients)) ? st.clients : [];
  const q = (str||"").trim();
  if(!q) return null;
  const nh = normHandle(q);
  let c = clients.find(x => normHandle(x.handle) === nh);
  if(c) return c;
  const ql = q.toLowerCase();
  c = clients.find(x => (x.name||"").toLowerCase() === ql);
  if(c) return c;
  c = clients.find(x => ((x.name||"")+" "+(x.handle||"")).toLowerCase().includes(ql));
  return c || null;
}


// ---- Week helpers (ISO-ish) ----
function pad2(n){ return String(n).padStart(2,"0"); }

// Returns ISO week id like "2026-W08"
function weekIdISO(d=new Date()){
  // Based on ISO week date algorithm
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7; // 1..7 (Mon..Sun)
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(),0,1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1)/7);
  return `${date.getUTCFullYear()}-W${pad2(weekNo)}`;
}

function weekStartMonday(d=new Date()){
  const date = new Date(d);
  const day = date.getDay(); // 0..6 (Sun..Sat)
  const diff = (day === 0 ? -6 : 1 - day); // move to Monday
  date.setDate(date.getDate() + diff);
  date.setHours(0,0,0,0);
  return date;
}

function addDays(date, days){
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function dateKey(d){
  const x = new Date(d);
  const yyyy = x.getFullYear();
  const mm = pad2(x.getMonth()+1);
  const dd = pad2(x.getDate());
  return `${yyyy}-${mm}-${dd}`;
}

// ---- Month helpers ----
function monthKey(d=new Date()){
  const x = new Date(d);
  return `${x.getFullYear()}-${pad2(x.getMonth()+1)}`;
}
function startOfMonth(ym){
  const [y,m] = (ym||monthKey()).split("-").map(Number);
  return new Date(y, (m-1), 1, 0,0,0,0);
}
function endOfMonth(ym){
  const s = startOfMonth(ym);
  return new Date(s.getFullYear(), s.getMonth()+1, 0, 23,59,59,999);
}
function toInputDateTimeLocal(iso){
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth()+1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}
function parseInputDateTimeLocal(val){
  // val: "YYYY-MM-DDTHH:MM" en zona local
  const d = new Date(val);
  if(Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

const CONTENT_SECTIONS = [
  ["stories", "🌻 Stories"],
  ["entreDiosas", "🌻 Entre Diosas"],
  ["threads", "🌻 Threads"],
  ["postVideo", "🌻 Post / Video"]
];

const APP_TABS = ["plan","contenido","investigacion","clientes","sesiones11","suscripcion"];
const SUBSCRIPTION_TYPES = [
  { key:"oneToOne", label:"Suscripciones · 1:1", sessions:4 },
  { key:"preguntas", label:"Suscripciones · Preguntas", sessions:9 }
];
const MONTHS_ES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

function getTodayKey(){ return todayKey(); }

function formatContentDateLabel(dayKey){
  const d = new Date(`${dayKey}T00:00:00`);
  const pretty = d.toLocaleDateString("es-AR", { weekday:"short", day:"2-digit", month:"short" });
  const base = pretty.charAt(0).toUpperCase() + pretty.slice(1).replace(/\./g, "");
  return dayKey === getTodayKey() ? `Hoy · ${base}` : base;
}

function defaultContentSections(){
  return { stories: [], entreDiosas: [], threads: [], postVideo: [] };
}

function ensureContentDay(dayKey){
  if(!STATE.contentTodo.days[dayKey]){
    STATE.contentTodo.days[dayKey] = {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sections: defaultContentSections()
    };
  }
  const day = STATE.contentTodo.days[dayKey];
  day.sections = day.sections || defaultContentSections();
  for(const [key] of CONTENT_SECTIONS){
    day.sections[key] = Array.isArray(day.sections[key]) ? day.sections[key] : [];
  }
  return day;
}

function archiveContentIfDayChanged(){
  const today = getTodayKey();
  const active = STATE.contentTodo.activeDate || today;
  ensureContentDay(today);
  ensureContentDay(active);
  return active !== today;
}


function uid(prefix="id"){
  return `${prefix}_${crypto.randomUUID?.() || (Date.now()+"_"+Math.random().toString(16).slice(2))}`;
}

// ---------- Indexed local state ----------
function loadState(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(raw) return JSON.parse(raw);
  }catch(e){ console.warn("State parse error", e); }
  return {
    v: "0.1",
    createdAt: nowISO(),
    tasks: [],
    sessions: [],
    bookings: [],
    reminders: [],
    clients: [],
    ideas: [],
    eventQueue: [],  // para sync incremental
    planWeekId: null,
    calMonth: null,
    updatedAtMs: Date.now(),
    contentTodo: {
      activeDate: todayKey(),
      days: {},
      historyOrder: []
    },
    activeTab: "plan",
    subscriptions: {
      viewYear: new Date().getFullYear(),
      viewMonth: new Date().getMonth()+1,
      entries: []
    },
    oneToOneSessions: {
      viewYear: new Date().getFullYear(),
      viewMonth: new Date().getMonth()+1,
      entries: []
    }
  };
}
function openStateDB(){
  if(!("indexedDB" in window)) return Promise.resolve(null);
  if(IDB_PROMISE) return IDB_PROMISE;

  IDB_PROMISE = new Promise((resolve) => {
    try{
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if(!db.objectStoreNames.contains(STATE_STORE)){
          db.createObjectStore(STATE_STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        console.warn("IndexedDB open error", req.error);
        resolve(null);
      };
    }catch(e){
      console.warn("IndexedDB unavailable", e);
      resolve(null);
    }
  });

  return IDB_PROMISE;
}

async function saveStateSnapshotToIDB(snapshot){
  const db = await openStateDB();
  if(!db) return;

  await new Promise((resolve) => {
    try{
      const tx = db.transaction(STATE_STORE, "readwrite");
      tx.objectStore(STATE_STORE).put({ id: STATE_SNAPSHOT_ID, snapshot, savedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        console.warn("IndexedDB save error", tx.error);
        resolve();
      };
    }catch(e){
      console.warn("IndexedDB tx save error", e);
      resolve();
    }
  });
}

async function recoverStateFromIDB(){
  const db = await openStateDB();
  if(!db) return;

  const row = await new Promise((resolve) => {
    try{
      const tx = db.transaction(STATE_STORE, "readonly");
      const req = tx.objectStore(STATE_STORE).get(STATE_SNAPSHOT_ID);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => {
        console.warn("IndexedDB read error", req.error);
        resolve(null);
      };
    }catch(e){
      console.warn("IndexedDB tx read error", e);
      resolve(null);
    }
  });

  if(!row?.snapshot) return;

  const snapshot = normalizeState_(row.snapshot);
  const currentUpdated = Number(STATE.updatedAtMs || 0);
  const backupUpdated = Number(snapshot.updatedAtMs || 0);
  if(backupUpdated <= currentUpdated) return;

  STATE = snapshot;
  try{
    localStorage.setItem(LS_KEY, JSON.stringify(STATE));
  }catch(e){
    console.warn("LocalStorage restore write error", e);
  }
  render();
  toast("Recuperé una copia guardada localmente 💾");
}

function saveState(){
  STATE.updatedAtMs = Date.now();
  const snapshot = JSON.stringify(STATE);
  localStorage.setItem(LS_KEY, snapshot);
  saveStateSnapshotToIDB(JSON.parse(snapshot));
}

function loadSettings(){
  try{
    const raw = localStorage.getItem(SETTINGS_KEY);
    if(raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  }catch(e){ console.warn("Settings parse error", e); }
  return { ...DEFAULT_SETTINGS };
}
function saveSettings(){
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS));
}

// ---------- State normalization ----------
function normalizeState_(st){
  st = st || {};
  st.v = st.v || "0.1";
  st.tasks = Array.isArray(st.tasks) ? st.tasks : [];
  st.sessions = Array.isArray(st.sessions) ? st.sessions : [];
  st.bookings = Array.isArray(st.bookings) ? st.bookings : [];
  st.reminders = Array.isArray(st.reminders) ? st.reminders : [];
  st.clients = Array.isArray(st.clients) ? st.clients : [];
  st.ideas = Array.isArray(st.ideas) ? st.ideas : [];
  st.eventQueue = Array.isArray(st.eventQueue) ? st.eventQueue : [];
  st.planWeekId = st.planWeekId || null;
  st.calMonth = st.calMonth || null;
  st.updatedAtMs = Number(st.updatedAtMs || Date.now());

  st.contentTodo = st.contentTodo || {};
  st.contentTodo.activeDate = st.contentTodo.activeDate || todayKey();
  st.contentTodo.days = st.contentTodo.days && typeof st.contentTodo.days === "object" ? st.contentTodo.days : {};
  st.contentTodo.historyOrder = Array.isArray(st.contentTodo.historyOrder) ? st.contentTodo.historyOrder : [];

  st.activeTab = APP_TABS.includes(st.activeTab) ? st.activeTab : "plan";
  st.subscriptions = st.subscriptions || {};
  st.subscriptions.viewYear = Number(st.subscriptions.viewYear || new Date().getFullYear());
  st.subscriptions.viewMonth = Number(st.subscriptions.viewMonth || (new Date().getMonth()+1));
  st.subscriptions.entries = Array.isArray(st.subscriptions.entries) ? st.subscriptions.entries : [];
  for(const sub of st.subscriptions.entries){
    if(!sub.id) sub.id = uid("sub");
    sub.type = sub.type || "oneToOne";
    sub.paymentDate = sub.paymentDate || todayKey();
    sub.name = (sub.name || "").trim();
    sub.costSoles = Number(sub.costSoles || 0) || 0;
    sub.costDolares = Number(sub.costDolares || 0) || 0;
    sub.sessionsDone = Array.isArray(sub.sessionsDone) ? sub.sessionsDone : [];
    sub.observations = sub.observations || "";
    sub.invoiceImage = sub.invoiceImage || "";
    sub.invoiceImageName = sub.invoiceImageName || "";
  }

  st.oneToOneSessions = st.oneToOneSessions || {};
  st.oneToOneSessions.viewYear = Number(st.oneToOneSessions.viewYear || new Date().getFullYear());
  st.oneToOneSessions.viewMonth = Number(st.oneToOneSessions.viewMonth || (new Date().getMonth()+1));
  st.oneToOneSessions.entries = Array.isArray(st.oneToOneSessions.entries) ? st.oneToOneSessions.entries : [];
  for(const sess of st.oneToOneSessions.entries){
    if(!sess.id) sess.id = uid("s11");
    sess.date = sess.date || todayKey();
    sess.consultant = (sess.consultant || "").trim();
    sess.contact = (sess.contact || "").trim();
    sess.birthDate = sess.birthDate || "";
    sess.sessionType = (sess.sessionType || "").trim();
    sess.modality = (sess.modality || "").trim();
    sess.costSoles = Number(sess.costSoles || 0) || 0;
    sess.costDolares = Number(sess.costDolares || 0) || 0;
    sess.invoiceImage = sess.invoiceImage || "";
    sess.invoiceImageName = sess.invoiceImageName || "";
  }

  // Back-compat: tasks sin category -> mission
  for(const t of st.tasks){
    if(!t.category) t.category = "mission"; // mission | plan
    if(!t.pinnedDay) t.pinnedDay = todayKey();
  }

  // Back-compat: client profile fields
  for(const c of st.clients){
    if(!c.name) c.name = c.name || "";
    if(!c.handle) c.handle = c.handle || "";
    if(!c.status) c.status = c.status || "lead";
    if(!c.nextStep) c.nextStep = c.nextStep || "";
    if(!c.notes) c.notes = c.notes || "";
    if(!c.dob) c.dob = c.dob || "";           // YYYY-MM-DD
    if(!c.zodiac) c.zodiac = c.zodiac || "";   // opcional (si no, se puede calcular)
  }

  // Back-compat: bookings + reminders
  for(const b of st.bookings){
    if(!b.type) b.type = "tarot";
    if(!b.status) b.status = "scheduled";
    if(!b.startAt) b.startAt = nowISO();
    if(!b.durationMin) b.durationMin = 60;
    if(typeof b.amount !== "number") b.amount = Number(b.amount || 0) || 0;
    if(!b.recurrence) b.recurrence = null;
    // Link to CRM client (preferred)
    if(!('clientId' in b)) b.clientId = null;
    b.sessionRecords = Array.isArray(b.sessionRecords) ? b.sessionRecords : [];
  }

  // Back-compat: auto-link bookings to clients when possible
  // (If a booking has client text but no clientId, try match by handle/name.)
  for(const b of st.bookings){
    if(b.clientId) continue;
    const clientStr = (b.client || "").trim();
    if(!clientStr) continue;
    const c = findClientByBookingClientString(clientStr, st);
    if(c) b.clientId = c.id;
  }
  for(const r of st.reminders){
    if(!r.text) r.text = "";
    if(!r.createdAt) r.createdAt = nowISO();
    if(!r.doneAt) r.doneAt = null;
    if(!r.dueAt) r.dueAt = null;
  }
  return st;
}

// ---------- Client/booking helpers ----------
function zodiacElement_(z){
  const map = {
    "Aries":"fire","Leo":"fire","Sagitario":"fire",
    "Tauro":"earth","Virgo":"earth","Capricornio":"earth",
    "Géminis":"air","Libra":"air","Acuario":"air",
    "Cáncer":"water","Escorpio":"water","Piscis":"water"
  };
  return map[z] || "";
}

function getClientForBooking_(b){
  if(!b) return { client:null, display:"", zodiac:"", element:"", handleShow:"" };
  let c = null;
  if(b.clientId) c = STATE.clients.find(x=>x.id===b.clientId) || null;
  if(!c && b.client){
    c = findClientByBookingClientString(b.client);
    if(c && !b.clientId){
      // Opportunistic upgrade in-memory; persist on next saveState()
      b.clientId = c.id;
    }
  }
  const zodiac = c ? (c.zodiac || (c.dob ? zodiacFromDob(c.dob) : "")) : "";
  const element = zodiac ? zodiacElement_(zodiac) : "";
  const handleShow = c?.handle ? "@"+String(c.handle).replace(/^@/,"") : (b.client||"");
  const display = c ? (c.name || handleShow || "(sin nombre)") : (b.client || "(sin cliente)");
  return { client:c, display, zodiac, element, handleShow };
}

// ---------- Bookings (sesiones programadas) ----------
function makeBooking_(obj={}){
  return {
    id: uid("book"),
    type: obj.type || "tarot", // tarot | astrologia | suscripcion
    title: (obj.title || "").trim() || null,
    // Prefer linking to a CRM client via clientId.
    // Keep client text as display/back-compat.
    clientId: obj.clientId || null,
    client: (obj.client || "").trim(),
    startAt: obj.startAt || nowISO(), // ISO
    durationMin: Math.max(15, Number(obj.durationMin || 60) || 60),
    amount: Number(obj.amount || 0) || 0,
    status: obj.status || "scheduled", // scheduled | done | cancelled
    notes: (obj.notes || "").trim(),
    recurrence: obj.recurrence || null, // { freq:"weekly", interval:1, until:"YYYY-MM-DD" }
    createdAt: nowISO()
  };
}

function addBooking(obj){
  const b = makeBooking_(obj);
  STATE.bookings.unshift(b);
  enqueueEvent("booking_add", b);
  saveState();
  renderCalendar();
  renderBookings();
}

function updateBooking(id, patch){
  const b = STATE.bookings.find(x => x.id === id);
  if(!b) return;
  Object.assign(b, patch);
  enqueueEvent("booking_update", { id, patch });
  saveState();
  renderCalendar();
  renderBookings();
}

function deleteBooking(id){
  STATE.bookings = STATE.bookings.filter(x => x.id !== id);
  enqueueEvent("booking_delete", { id });
  saveState();
  renderCalendar();
  renderBookings();
}

// ---------- Reminders ----------
function makeReminder_(obj={}){
  return {
    id: uid("rem"),
    text: (obj.text || "").trim(),
    dueAt: obj.dueAt || null, // ISO o null
    doneAt: obj.doneAt || null,
    createdAt: nowISO()
  };
}

function addReminder(obj){
  const r = makeReminder_(obj);
  if(!r.text){ toast("Escribe el recordatorio."); return; }
  STATE.reminders.unshift(r);
  enqueueEvent("reminder_add", r);
  saveState();
  renderReminders();
  renderMetrics();
}

function toggleReminderDone(id){
  const r = STATE.reminders.find(x => x.id === id);
  if(!r) return;
  r.doneAt = r.doneAt ? null : nowISO();
  enqueueEvent("reminder_toggle_done", { id, doneAt: r.doneAt });
  saveState();
  renderReminders();
  renderMetrics();
}

function deleteReminder(id){
  STATE.reminders = STATE.reminders.filter(x => x.id !== id);
  enqueueEvent("reminder_delete", { id });
  saveState();
  renderReminders();
  renderMetrics();
}

function makeTask_(title, opts={}){
  return {
    id: uid("task"),
    title: String(title || "").trim(),
    createdAt: opts.createdAt || nowISO(),
    doneAt: opts.doneAt || null,
    pinnedDay: opts.pinnedDay || todayKey(),
    notes: opts.notes || "",
    category: opts.category || "mission" // mission | plan
  };
}

function addContentItem(dayKey, sectionKey, title){
  const clean = String(title || "").trim();
  if(!clean) return null;
  const day = ensureContentDay(dayKey);
  const item = { id: uid("ct"), title: clean, done: false, doneAt: null, notes: "" };
  day.sections[sectionKey].unshift(item);
  day.updatedAt = Date.now();
  saveState();
  render();
  return item;
}

function toggleContentDone(dayKey, sectionKey, itemId){
  const day = ensureContentDay(dayKey);
  const item = day.sections[sectionKey].find(x => x.id === itemId);
  if(!item) return;
  item.done = !item.done;
  item.doneAt = item.done ? Date.now() : null;
  day.updatedAt = Date.now();
  saveState();
  render();
}

function editContentItem(dayKey, sectionKey, itemId, patch={}){
  const day = ensureContentDay(dayKey);
  const item = day.sections[sectionKey].find(x => x.id === itemId);
  if(!item) return;
  if(typeof patch.title === "string") item.title = patch.title.trim() || item.title;
  if(typeof patch.notes === "string") item.notes = patch.notes.trim();
  day.updatedAt = Date.now();
  saveState();
  render();
}

function deleteContentItem(dayKey, sectionKey, itemId){
  const day = ensureContentDay(dayKey);
  day.sections[sectionKey] = day.sections[sectionKey].filter(x => x.id !== itemId);
  day.updatedAt = Date.now();
  saveState();
  render();
}

function moveContentItem(dayKey, fromSectionKey, toSectionKey, itemId, targetIndex=null){
  const day = ensureContentDay(dayKey);
  const fromItems = day.sections[fromSectionKey] || [];
  const toItems = day.sections[toSectionKey] || [];
  const fromIndex = fromItems.findIndex(x => x.id === itemId);
  if(fromIndex < 0) return;

  const [item] = fromItems.splice(fromIndex, 1);
  if(!item) return;

  let insertAt = Number.isInteger(targetIndex) ? targetIndex : toItems.length;
  if(fromSectionKey === toSectionKey && fromIndex < insertAt) insertAt -= 1;
  insertAt = Math.max(0, Math.min(insertAt, toItems.length));

  toItems.splice(insertAt, 0, item);
  day.sections[fromSectionKey] = fromItems;
  day.sections[toSectionKey] = toItems;
  day.updatedAt = Date.now();
  saveState();
  render();
}

function moveContentItemByOffset(dayKey, sectionKey, itemId, offset){
  const day = ensureContentDay(dayKey);
  const items = day.sections[sectionKey] || [];
  const fromIndex = items.findIndex((x) => x.id === itemId);
  if(fromIndex < 0) return;

  const toIndex = fromIndex + offset;
  if(toIndex < 0 || toIndex >= items.length) return;

  const [item] = items.splice(fromIndex, 1);
  if(!item) return;
  items.splice(toIndex, 0, item);

  day.sections[sectionKey] = items;
  day.updatedAt = Date.now();
  saveState();
  render();
}

function duplicateContentToTomorrow(dayKey, sectionKey, itemId){
  const day = ensureContentDay(dayKey);
  const item = day.sections[sectionKey].find(x => x.id === itemId);
  if(!item) return;
  const tomorrow = dateKey(addDays(new Date(dayKey+"T00:00:00"), 1));
  addContentItem(tomorrow, sectionKey, item.title);
  toast("Duplicado para mañana 📌");
}

function applyContentTemplate(mode){
  const dayKey = STATE.contentTodo.activeDate || getTodayKey();
  const day = ensureContentDay(dayKey);
  const templates = {
    light: {
      stories: ["Story: check-in emocional", "Story: CTA suave"],
      entreDiosas: ["Pregunta a la comunidad"],
      threads: ["Thread corto del día"],
      postVideo: []
    },
    full: {
      stories: ["Lo primero que sentí al abrir los ojos hoy fue...", "Marte entra a Piscis...", "La pregunta que este cielo te hace...", "Ofreciendo mis servicios..."],
      entreDiosas: ["Mis diosas girasoles...", "Pregunta a la comunidad", "Recordatorio eclipse"],
      threads: ["Soltar el control..."],
      postVideo: ["Idea: No actuar desde el debería", "Copy: Marte en Piscis..."]
    }
  };
  const tpl = templates[mode] || templates.light;
  for(const [sectionKey] of CONTENT_SECTIONS){
    const rows = tpl[sectionKey] || [];
    for(const title of rows){
      day.sections[sectionKey].push({ id: uid("ct"), title, done: false, doneAt: null, notes: "" });
    }
  }
  day.updatedAt = Date.now();
  saveState();
  render();
}

function archiveActiveContentDay(){
  const key = STATE.contentTodo.activeDate || getTodayKey();
  if(!STATE.contentTodo.historyOrder.includes(key)) STATE.contentTodo.historyOrder.unshift(key);
  const next = getTodayKey();
  STATE.contentTodo.activeDate = next;
  ensureContentDay(next);
  saveState();
  render();
}


// ---------- Event queue (para sync) ----------
function enqueueEvent(type, payload){
  const evt = {
    id: uid("evt"),
    type,
    payload,
    ts: nowISO(),
    syncedAt: null
  };
  STATE.eventQueue.push(evt);
  saveState();
}

function markEventsSynced(eventIds){
  const set = new Set(eventIds);
  let changed = false;
  for(const e of STATE.eventQueue){
    if(set.has(e.id) && !e.syncedAt){
      e.syncedAt = nowISO();
      changed = true;
    }
  }
  if(changed) saveState();
}

// ---------- Simple domain actions ----------
function addTask(title, opts={}){
  const t = makeTask_(title, {
    pinnedDay: opts.pinnedDay || todayKey(),
    category: opts.category || "mission",
    notes: opts.notes || "",
    createdAt: opts.createdAt || nowISO()
  });

  STATE.tasks.unshift(t);
  enqueueEvent("task_add", t);
  saveState();
  render();
}
function toggleTaskDone(taskId){
  const t = STATE.tasks.find(x => x.id === taskId);
  if(!t) return;
  t.doneAt = t.doneAt ? null : nowISO();
  enqueueEvent("task_toggle_done", { id: t.id, doneAt: t.doneAt });
  saveState();
  render();
}
function deleteTask(taskId){
  STATE.tasks = STATE.tasks.filter(x => x.id !== taskId);
  enqueueEvent("task_delete", { id: taskId });
  saveState();
  render();
}

function movePlanTaskByOffset(taskId, offset){
  const planIndexes = [];
  for(let i=0;i<STATE.tasks.length;i++){
    const task = STATE.tasks[i];
    if(task.category === "plan") planIndexes.push(i);
  }

  const relIndex = planIndexes.findIndex((idx) => STATE.tasks[idx].id === taskId);
  if(relIndex < 0) return;

  const targetRelIndex = relIndex + offset;
  if(targetRelIndex < 0 || targetRelIndex >= planIndexes.length) return;

  const fromAbsIndex = planIndexes[relIndex];
  const toAbsIndex = planIndexes[targetRelIndex];
  const [task] = STATE.tasks.splice(fromAbsIndex, 1);
  if(!task) return;

  STATE.tasks.splice(toAbsIndex, 0, task);
  saveState();
  renderPlan();
}

let ACTIVE_SESSION = null;
let TIMER = { startMs: 0, tick: null };

function startSession(taskId, note=""){
  const task = STATE.tasks.find(t => t.id === taskId) || null;
  const s = {
    id: uid("sess"),
    taskId: taskId || null,
    taskTitle: task?.title || "(sin tarea)",
    startAt: nowISO(),
    endAt: null,
    durationSec: null,
    status: "active", // active | done | paused
    pauseReason: null,
    note: note?.trim() || "",
    day: todayKey()
  };
  ACTIVE_SESSION = s;
  TIMER.startMs = Date.now();
  TIMER.tick = setInterval(updateTimerUI, 250);
  setSessionUIRunning(true);
  updateTimerUI();
  enqueueEvent("session_start", s);
  renderSessions();
  renderMetrics();
}

function finishSession(status, pauseReason=null){
  if(!ACTIVE_SESSION) return;
  const endMs = Date.now();
  const durationSec = Math.max(1, Math.round((endMs - TIMER.startMs)/1000));
  ACTIVE_SESSION.endAt = nowISO();
  ACTIVE_SESSION.durationSec = durationSec;
  ACTIVE_SESSION.status = status;
  ACTIVE_SESSION.pauseReason = pauseReason;

  STATE.sessions.unshift(ACTIVE_SESSION);
  enqueueEvent("session_end", { ...ACTIVE_SESSION });

  ACTIVE_SESSION = null;
  clearInterval(TIMER.tick);
  TIMER.tick = null;
  TIMER.startMs = 0;

  setSessionUIRunning(false);
  updateTimerUI(true);

  saveState();
  render();
}

function addClient(obj){
  const c = {
    id: uid("cli"),
    handle: (obj.handle || "").trim(),
    name: (obj.name || "").trim(),
    status: obj.status || "lead",
    nextStep: (obj.nextStep || "").trim(),
    lastContactAt: obj.lastContactAt || null,
    notes: (obj.notes || "").trim(),
    createdAt: nowISO()
  };
  STATE.clients.unshift(c);
  enqueueEvent("client_add", c);
  saveState();
  renderClients();
}
function updateClient(id, patch){
  const c = STATE.clients.find(x => x.id === id);
  if(!c) return;
  Object.assign(c, patch);
  enqueueEvent("client_update", { id, patch });
  saveState();
  renderClients();
}
function deleteClient(id){
  STATE.clients = STATE.clients.filter(x => x.id !== id);
  enqueueEvent("client_delete", { id });
  saveState();
  renderClients();
}

function addIdea(obj){
  const i = {
    id: uid("idea"),
    title: (obj.title || "").trim(),
    kind: obj.kind || "idea", // idea | post | story | thread
    tags: (obj.tags || "").trim(),
    notes: (obj.notes || "").trim(),
    createdAt: nowISO()
  };
  STATE.ideas.unshift(i);
  enqueueEvent("idea_add", i);
  saveState();
  renderIdeas();
}
function updateIdea(id, patch){
  const i = STATE.ideas.find(x => x.id === id);
  if(!i) return;
  Object.assign(i, patch);
  enqueueEvent("idea_update", { id, patch });
  saveState();
  renderIdeas();
}
function deleteIdea(id){
  STATE.ideas = STATE.ideas.filter(x => x.id !== id);
  enqueueEvent("idea_delete", { id });
  saveState();
  renderIdeas();
}

// ---------- Sync ----------
async function syncNow(){
  const statusEl = document.querySelector("#syncStatus");
  const btn = document.querySelector("#btnSync");

  if(!SETTINGS.syncEnabled || !SETTINGS.appsScriptUrl){
    statusEl.textContent = "Sync: desactivado";
    toast("Sync desactivado. Actívalo en Ajustes.");
    return;
  }

  const pending = STATE.eventQueue.filter(e => !e.syncedAt);
  if(!pending.length){
    statusEl.textContent = "Sync: al día ✅";
    toast("Nada nuevo para sincronizar.");
    return;
  }

  btn.disabled = true;
  statusEl.textContent = `Sync: enviando ${pending.length}…`;

  try{
    await fetch(SETTINGS.appsScriptUrl, {
      method: "POST",
      mode: "no-cors",             // ✅ evita CORS
      body: JSON.stringify({       // ✅ sin headers = no preflight
        app: "FergisAssistant",
        v: "0.1",
        apiKey: SETTINGS.apiKey || "",
        deviceTs: nowISO(),
        events: pending
      })
    });

    // OJO: con no-cors no podemos leer respuesta (opaque)
    statusEl.textContent = "Sync: enviado ✅ (verificar en Sheet)";
    toast("Enviado. Revisa 'Sync_Audit' y 'Events_Raw'.");
  }catch(err){
    console.warn("Sync error", err);
    statusEl.textContent = "Sync: error ⚠";
    toast("Falló el envío (red). Reintenta.");
  }finally{
    btn.disabled = false;
  }
}


// ---------- UI ----------
STATE = normalizeState_(loadState());
let SETTINGS = loadSettings();

function $(sel){ return document.querySelector(sel); }
function escapeHtml(s){ return (s||"").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function formatMin(sec){
  const m = Math.floor(sec/60);
  if(m < 60) return `${m}m`;
  const h = Math.floor(m/60);
  const mm = m%60;
  return `${h}h ${mm}m`;
}

function escapeAttr(s){ return escapeHtml(s).replace(/\n/g," "); }


function formatTimer(sec){
  const mm = String(Math.floor(sec/60)).padStart(2,"0");
  const ss = String(sec%60).padStart(2,"0");
  return `${mm}:${ss}`;
}
function badgeForStatus(status){
  const map = {
    lead: ["Lead","neutral"],
    chat: ["Chat","neutral"],
    booked: ["Agendado","ok"],
    paid: ["Pagó","ok"],
    delivered: ["Entregado","ok"],
    followup: ["Seguimiento","warn"]
  };
  return map[status] || ["","neutral"];
}

function render(){
  renderPlan();
  renderContentTodo();
  renderSessionTaskSelect();
  renderSessions();
  renderCalendar();
  renderBookings();
  renderReminders();
  renderClients();
  renderIdeas();
  renderMetrics();
  renderTabs();
  renderSubscriptions();
  renderOneToOneSessions();
  updateSyncUI();
}


function renderTabs(){
  document.querySelectorAll(".tabBtn").forEach((btn)=>{
    const on = btn.dataset.tab === STATE.activeTab;
    btn.classList.toggle("active", on);
  });
  document.querySelectorAll(".tabPanel").forEach((panel)=>{
    const on = panel.dataset.panel === STATE.activeTab;
    panel.classList.toggle("active", on);
  });
}

function monthTitle(m){ return MONTHS_ES[(m-1)] || `Mes ${m}`; }
function sessionColumns(type){
  const t = SUBSCRIPTION_TYPES.find(x=>x.key===type) || SUBSCRIPTION_TYPES[0];
  return Array.from({ length: t.sessions }, (_,i)=> i+1);
}
function renderSubscriptions(){
  const ySel = $("#subscriptionYear");
  const mSel = $("#subscriptionMonth");
  const boards = $("#subscriptionBoards");
  if(!ySel || !mSel || !boards) return;

  const years = new Set([STATE.subscriptions.viewYear, ...STATE.subscriptions.entries.map(e => new Date(`${e.paymentDate}T00:00:00`).getFullYear())]);
  const sortedYears = [...years].filter(Boolean).sort((a,b)=>b-a);
  ySel.innerHTML = sortedYears.map(y=>`<option value="${y}" ${Number(y)===Number(STATE.subscriptions.viewYear)?"selected":""}>${y}</option>`).join("");
  mSel.innerHTML = MONTHS_ES.map((m,idx)=>`<option value="${idx+1}" ${(idx+1)===Number(STATE.subscriptions.viewMonth)?"selected":""}>${m}</option>`).join("");

  const vY = Number(STATE.subscriptions.viewYear);
  const vM = Number(STATE.subscriptions.viewMonth);
  const rows = STATE.subscriptions.entries.filter(e=>{
    const d = new Date(`${e.paymentDate}T00:00:00`);
    return d.getFullYear()===vY && (d.getMonth()+1)===vM;
  });

  boards.innerHTML = SUBSCRIPTION_TYPES.map((type) => {
    const cols = sessionColumns(type.key);
    const byType = rows.filter(x => x.type===type.key);
    const body = byType.length ? byType.map((e)=>{
      const checks = cols.map((n)=>`<td><input type="checkbox" data-act="subToggleSession" data-id="${e.id}" data-session="${n}" ${e.sessionsDone.includes(n)?"checked":""} /></td>`).join("");
      return `<tr>
        <td>${escapeHtml(new Date(`${e.paymentDate}T00:00:00`).toLocaleDateString('es-PE', { day:'numeric', month:'long', year:'numeric' }))}</td>
        <td>${escapeHtml(e.name)}</td>
        <td>${e.costSoles || ""}</td>
        <td>${e.costDolares || ""}</td>
        ${checks}
        <td><input class="input small" data-act="subObservations" data-id="${e.id}" value="${escapeAttr(e.observations || "")}" /></td>
        <td>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="file" data-act="subInvoice" data-id="${e.id}" accept="image/*" style="display:none" />
            <button class="btn ghost" data-act="subUpload" data-id="${e.id}">${e.invoiceImage ? "Cambiar" : "Subir"}</button>
            ${e.invoiceImage ? `<button class="btn ghost" data-act="subViewInvoice" data-id="${e.id}">Ver</button>` : `<span class="subEmpty">Sin imagen</span>`}
          </div>
        </td>
        <td><button class="btn ghost" data-act="subDelete" data-id="${e.id}">🗑</button></td>
      </tr>`;
    }).join("") : `<tr><td colspan="99" class="subEmpty">No hay registros para este mes.</td></tr>`;

    const totalS = byType.reduce((a,x)=>a+Number(x.costSoles||0),0);
    const totalD = byType.reduce((a,x)=>a+Number(x.costDolares||0),0);
    const headers = cols.map(n=>`<th>Sesión ${n}</th>`).join("");
    return `<div class="subBoard">
      <h4>${escapeHtml(type.label)}</h4>
      <div class="subTableWrap">
        <table class="subTable">
          <thead>
            <tr>
              <th>Fecha de pago</th><th>Nombre</th><th>Costo soles</th><th>Costo dólares</th>${headers}<th>Observaciones</th><th>Factura</th><th></th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
          <tfoot><tr><td colspan="2">Totales</td><td>${totalS}</td><td>${totalD}</td><td colspan="${cols.length+3}"></td></tr></tfoot>
        </table>
      </div>
    </div>`;
  }).join("");
}

function openImagePreviewModal(src, title="Factura"){
  openModal(
    title,
    `<div style="display:flex;justify-content:center"><img src="${src}" alt="${escapeAttr(title)}" style="max-width:100%;max-height:65vh;border-radius:10px;border:1px solid var(--line);object-fit:contain" /></div>`,
    `<button class="btn" id="mCloseInvoice">Cerrar</button>`
  );
  $("#mCloseInvoice").onclick = closeModal;
}

function addSubscription(obj={}){
  const entry = {
    id: uid("sub"),
    type: obj.type || "oneToOne",
    paymentDate: obj.paymentDate || todayKey(),
    name: (obj.name || "").trim(),
    costSoles: Number(obj.costSoles || 0) || 0,
    costDolares: Number(obj.costDolares || 0) || 0,
    sessionsDone: [],
    observations: (obj.observations || "").trim(),
    invoiceImage: "",
    invoiceImageName: "",
    createdAt: nowISO()
  };
  STATE.subscriptions.entries.unshift(entry);
  enqueueEvent("subscription_add", entry);
  saveState();
  renderSubscriptions();
}

function openSubscriptionModal(){
  openModal(
    "Nuevo registro de suscripción",
    `<div class="row"><label class="label">Tipo</label><select id="mSubType" class="input">${SUBSCRIPTION_TYPES.map(t=>`<option value="${t.key}">${t.label}</option>`).join("")}</select></div>
    <div class="row"><label class="label">Fecha de pago</label><input id="mSubDate" type="date" class="input" value="${todayKey()}" /></div>
    <div class="row"><label class="label">Nombre</label><input id="mSubName" class="input" placeholder="Nombre de cliente" /></div>
    <div class="row"><label class="label">Costo soles</label><input id="mSubSoles" type="number" class="input" min="0" step="0.01" /></div>
    <div class="row"><label class="label">Costo dólares</label><input id="mSubDol" type="number" class="input" min="0" step="0.01" /></div>
    <div class="row"><label class="label">Observaciones</label><input id="mSubObs" class="input" /></div>`,
    `<button class="btn" id="mCancel">Cancelar</button><button class="btn primary" id="mSave">Guardar</button>`
  );
  $("#mCancel").onclick = closeModal;
  $("#mSave").onclick = () => {
    addSubscription({
      type: $("#mSubType").value,
      paymentDate: $("#mSubDate").value || todayKey(),
      name: $("#mSubName").value,
      costSoles: $("#mSubSoles").value,
      costDolares: $("#mSubDol").value,
      observations: $("#mSubObs").value
    });
    closeModal();
  };
}

function renderOneToOneSessions(){
  const ySel = $("#oneToOneYear");
  const mSel = $("#oneToOneMonth");
  const boards = $("#oneToOneBoards");
  if(!ySel || !mSel || !boards) return;

  const years = new Set([STATE.oneToOneSessions.viewYear, ...STATE.oneToOneSessions.entries.map(e => new Date(`${e.date}T00:00:00`).getFullYear())]);
  const sortedYears = [...years].filter(Boolean).sort((a,b)=>b-a);
  ySel.innerHTML = sortedYears.map(y=>`<option value="${y}" ${Number(y)===Number(STATE.oneToOneSessions.viewYear)?"selected":""}>${y}</option>`).join("");
  mSel.innerHTML = MONTHS_ES.map((m,idx)=>`<option value="${idx+1}" ${(idx+1)===Number(STATE.oneToOneSessions.viewMonth)?"selected":""}>${m}</option>`).join("");

  const vY = Number(STATE.oneToOneSessions.viewYear);
  const vM = Number(STATE.oneToOneSessions.viewMonth);
  const rows = STATE.oneToOneSessions.entries.filter(e=>{
    const d = new Date(`${e.date}T00:00:00`);
    return d.getFullYear()===vY && (d.getMonth()+1)===vM;
  });

  const body = rows.length ? rows.map((e)=>`<tr>
      <td>${escapeHtml(new Date(`${e.date}T00:00:00`).toLocaleDateString('es-PE', { day:'numeric', month:'long', year:'numeric' }))}</td>
      <td>${escapeHtml(e.consultant || "")}</td>
      <td>${escapeHtml(e.contact || "")}</td>
      <td>${e.birthDate ? escapeHtml(new Date(`${e.birthDate}T00:00:00`).toLocaleDateString('es-PE', { day:'2-digit', month:'2-digit', year:'numeric' })) : ""}</td>
      <td><input class="input small" data-act="s11SessionType" data-id="${e.id}" value="${escapeAttr(e.sessionType || "")}" /></td>
      <td><input class="input small" data-act="s11Modality" data-id="${e.id}" value="${escapeAttr(e.modality || "")}" /></td>
      <td>${e.costSoles || ""}</td>
      <td>${e.costDolares || ""}</td>
      <td>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="file" data-act="s11Invoice" data-id="${e.id}" accept="image/*" style="display:none" />
          <button class="btn ghost" data-act="s11Upload" data-id="${e.id}">${e.invoiceImage ? "Cambiar" : "Subir"}</button>
          ${e.invoiceImage ? `<button class="btn ghost" data-act="s11ViewInvoice" data-id="${e.id}">Ver</button>` : `<span class="subEmpty">Sin imagen</span>`}
        </div>
      </td>
      <td><button class="btn ghost" data-act="s11Delete" data-id="${e.id}">🗑</button></td>
    </tr>`).join("") : `<tr><td colspan="99" class="subEmpty">No hay registros para este mes.</td></tr>`;

  const totalS = rows.reduce((a,x)=>a+Number(x.costSoles||0),0);
  const totalD = rows.reduce((a,x)=>a+Number(x.costDolares||0),0);

  boards.innerHTML = `<div class="subBoard">
    <h4>Sesiones 1:1</h4>
    <div class="subTableWrap">
      <table class="subTable">
        <thead>
          <tr>
            <th>Fecha</th><th>Consultante</th><th>Contacto</th><th>Fecha de nacimiento</th><th>Tipo de sesión</th><th>Modalidad</th><th>Costo en soles</th><th>Costo en dólares</th><th>Factura</th><th></th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
        <tfoot><tr><td colspan="6">Totales</td><td>${totalS}</td><td>${totalD}</td><td colspan="2"></td></tr></tfoot>
      </table>
    </div>
  </div>`;
}

function addOneToOneSession(obj={}){
  const entry = {
    id: uid("s11"),
    date: obj.date || todayKey(),
    consultant: (obj.consultant || "").trim(),
    contact: (obj.contact || "").trim(),
    birthDate: obj.birthDate || "",
    sessionType: (obj.sessionType || "").trim(),
    modality: (obj.modality || "").trim(),
    costSoles: Number(obj.costSoles || 0) || 0,
    costDolares: Number(obj.costDolares || 0) || 0,
    invoiceImage: "",
    invoiceImageName: "",
    createdAt: nowISO()
  };
  STATE.oneToOneSessions.entries.unshift(entry);
  enqueueEvent("session11_add", entry);
  saveState();
  renderOneToOneSessions();
}

function openOneToOneSessionModal(){
  openModal(
    "Nueva sesión 1:1",
    `<div class="row"><label class="label">Fecha</label><input id="mS11Date" type="date" class="input" value="${todayKey()}" /></div>
    <div class="row"><label class="label">Consultante</label><input id="mS11Consultant" class="input" /></div>
    <div class="row"><label class="label">Contacto</label><input id="mS11Contact" class="input" /></div>
    <div class="row"><label class="label">Fecha de nacimiento</label><input id="mS11BirthDate" type="date" class="input" /></div>
    <div class="row"><label class="label">Tipo de sesión</label><input id="mS11SessionType" class="input" placeholder="Escribe libremente" /></div>
    <div class="row"><label class="label">Modalidad</label><input id="mS11Modality" class="input" placeholder="Escribe libremente" /></div>
    <div class="row"><label class="label">Costo en soles</label><input id="mS11Soles" type="number" class="input" min="0" step="0.01" /></div>
    <div class="row"><label class="label">Costo en dólares</label><input id="mS11Dol" type="number" class="input" min="0" step="0.01" /></div>`,
    `<button class="btn" id="mCancel">Cancelar</button><button class="btn primary" id="mSave">Guardar</button>`
  );
  $("#mCancel").onclick = closeModal;
  $("#mSave").onclick = () => {
    addOneToOneSession({
      date: $("#mS11Date").value || todayKey(),
      consultant: $("#mS11Consultant").value,
      contact: $("#mS11Contact").value,
      birthDate: $("#mS11BirthDate").value,
      sessionType: $("#mS11SessionType").value,
      modality: $("#mS11Modality").value,
      costSoles: $("#mS11Soles").value,
      costDolares: $("#mS11Dol").value
    });
    closeModal();
  };
}

function renderPlan(){
  const list = $("#planList");
  if(!list) return;
  const items = STATE.tasks.filter(t => t.category === "plan");

  if(!items.length){
    list.innerHTML = `<div class="item">
      <div class="itemLeft">
        <div>
          <div class="itemTitle">Sin tareas del plan para este día</div>
          <div class="itemMeta">Puedes agregar una tarea 🌻 si hace falta (sin presión).</div>
        </div>
      </div>
      <div><span class="pill">Plan Girasol</span></div>
    </div>`;
    return;
  }

  list.innerHTML = items.map((t, idx) => {
    const done = !!t.doneAt;
    const isFirst = idx === 0;
    const isLast = idx === items.length - 1;
    return `<div class="item">
      <div class="itemLeft">
        <button class="btn ${done ? "primary":""}" data-act="planToggle" data-id="${t.id}" title="Marcar hecho">
          ${done ? "✓":"○"}
        </button>
        <div>
          <div class="itemTitle">${escapeHtml(t.title)}</div>
          <div class="itemMeta">${done ? "Hecho ✅" : "Por hacer"}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn ghost" data-act="planMoveUp" data-id="${t.id}" title="Subir" ${isFirst ? "disabled" : ""}>↑</button>
        <button class="btn ghost" data-act="planMoveDown" data-id="${t.id}" title="Bajar" ${isLast ? "disabled" : ""}>↓</button>
        <button class="btn ghost" data-act="planEdit" data-id="${t.id}" title="Editar">✎</button>
        <button class="btn ghost" data-act="planDelete" data-id="${t.id}" title="Eliminar">🗑</button>
      </div>
    </div>`;
  }).join("");
}

function renderMetrics(){
  const day = todayKey();
  const sessionsToday = STATE.sessions.filter(s => s.day === day);
  const totalSec = sessionsToday.reduce((a,s)=>a + (s.durationSec||0), 0);
  $("#mActiveToday").textContent = totalSec ? formatMin(totalSec) : "0m";
  $("#mSessionsToday").textContent = String(sessionsToday.length);

  const contentDay = ensureContentDay(STATE.contentTodo.activeDate || day);
  const contentPending = CONTENT_SECTIONS
    .flatMap(([k]) => contentDay.sections[k] || [])
    .filter(x => !x.done).length;
  const pendingRem = STATE.reminders.filter(r => !r.doneAt).length;
  $("#mPendingTasks").textContent = String(contentPending + pendingRem);
}

function renderContentTodo(){
  archiveContentIfDayChanged();
  const dayKey = STATE.contentTodo.activeDate || getTodayKey();
  const day = ensureContentDay(dayKey);
  const list = $("#contentTodoList");
  if(!list) return;

  const dateLabel = $("#contentDateLabel");
  if(dateLabel) dateLabel.textContent = formatContentDateLabel(dayKey);

  const html = CONTENT_SECTIONS.map(([sectionKey, label]) => {
    const items = day.sections[sectionKey] || [];
    const itemRows = items.length ? items.map((item, idx) => {
      const doneMark = item.done ? "primary" : "";
      const doneMeta = item.doneAt ? ` • Publicado a las ${new Date(item.doneAt).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" })}` : "";
      const isFirst = idx === 0;
      const isLast = idx === items.length - 1;
      return `<div class="item compact contentRow" draggable="true" data-content-id="${item.id}" data-content-section="${sectionKey}">
        <div class="itemLeft">
          <span class="dragGrip" title="Arrastrar para mover">⋮⋮</span>
          <button class="btn ${doneMark}" data-act="contentToggle" data-section="${sectionKey}" data-id="${item.id}" title="Marcar hecho">${item.done ? "✓" : "○"}</button>
          <div>
            <div class="itemTitle">${escapeHtml(item.title)}</div>
            <div class="itemMeta">${item.notes ? `📝 ${escapeHtml(item.notes)}` : "Sin copy aún"}${doneMeta}</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="btn ghost" data-act="contentMoveUp" data-section="${sectionKey}" data-id="${item.id}" title="Subir" ${isFirst ? "disabled" : ""}>↑</button>
          <button class="btn ghost" data-act="contentMoveDown" data-section="${sectionKey}" data-id="${item.id}" title="Bajar" ${isLast ? "disabled" : ""}>↓</button>
          <button class="btn ghost" data-act="contentEdit" data-section="${sectionKey}" data-id="${item.id}">✏️</button>
          <button class="btn ghost" data-act="contentDelete" data-section="${sectionKey}" data-id="${item.id}">🗑</button>
          <button class="btn ghost" data-act="contentTomorrow" data-section="${sectionKey}" data-id="${item.id}">📌 Mañana</button>
        </div>
      </div>`;
    }).join("") : `<div class="item compact"><div class="itemMeta">Sin items todavía.</div></div>`;

    return `<details class="contentAccordion" open>
      <summary>${label} (${items.length})</summary>
      <div class="list" data-content-section-list="${sectionKey}">${itemRows}</div>
    </details>`;
  }).join("");

  list.innerHTML = html;

  const allItems = CONTENT_SECTIONS.flatMap(([k]) => day.sections[k] || []);
  const doneCount = allItems.filter(x => x.done).length;
  const summary = $("#contentTodoSummary");
  if(summary) summary.textContent = `${doneCount}/${allItems.length} completadas`;
}

function renderSessionTaskSelect(){
  const sel = $("#sessionTaskSelect");
  const day = todayKey();
  const tasksToday = STATE.tasks.filter(t => t.pinnedDay === day).slice(0,10);
  const options = [
    `<option value="">(sin tarea)</option>`,
    ...tasksToday.map(t => {
      const tag = (t.category === "plan") ? " 🌻" : "";
      return `<option value="${t.id}">${escapeHtml(t.title)}${tag}</option>`;
    })
  ];
  sel.innerHTML = options.join("");
}

function renderSessions(){
  const list = $("#sessionsList");
  const items = STATE.sessions.slice(0,6);
  if(!items.length){
    list.innerHTML = `<div class="item">
      <div class="itemLeft">
        <div>
          <div class="itemTitle">Aún no hay sesiones</div>
          <div class="itemMeta">Inicia una sesión para medir tiempo real. ⏱</div>
        </div>
      </div>
      <div><span class="pill">Local-first</span></div>
    </div>`;
    return;
  }
  list.innerHTML = items.map(s => {
    const label = s.status === "done" ? ["Completada","ok"] : ["Pausada","warn"];
    const dur = s.durationSec ? formatMin(s.durationSec) : "";
    const reason = s.pauseReason ? ` • ${escapeHtml(s.pauseReason)}` : "";
    return `<div class="item">
      <div class="itemLeft">
        <div>
          <div class="itemTitle">${escapeHtml(s.taskTitle)}</div>
          <div class="itemMeta">${new Date(s.startAt).toLocaleString()} • ${dur}${reason}</div>
        </div>
      </div>
      <div><span class="badge ${label[1]}">${label[0]}</span></div>
    </div>`;
  }).join("");
}

function renderClients(){
  const list = $("#clientsList");
  const filter = $("#clientFilter").value;
  const q = ($("#clientSearch").value || "").trim().toLowerCase();

  let items = [...STATE.clients];
  if(filter !== "all") items = items.filter(c => c.status === filter);
  if(q) items = items.filter(c => (c.name+" "+c.handle+" "+c.nextStep).toLowerCase().includes(q));

  if(!items.length){
    list.innerHTML = `<div class="item">
      <div class="itemLeft">
        <div>
          <div class="itemTitle">Sin clientes aún</div>
          <div class="itemMeta">Agrega leads o clientes para darles seguimiento.</div>
        </div>
      </div>
      <div><span class="pill">CRM mini</span></div>
    </div>`;
    return;
  }

  list.innerHTML = items.slice(0,20).map(c => {
    const [lbl, cls] = badgeForStatus(c.status);
    const name = c.name || c.handle || "(sin nombre)";
    const handle = c.handle ? `@${c.handle.replace(/^@/,"")}` : "";
    const next = c.nextStep ? escapeHtml(c.nextStep) : "—";
    const dob = c.dob ? escapeHtml(c.dob) : "";
    const zodiac = (c.zodiac || (c.dob ? zodiacFromDob(c.dob) : "")) || "";
    const zPill = zodiac ? ` <span class="pill">♈ ${escapeHtml(zodiac)}</span>` : "";
    const bdayMeta = dob ? ` • ${dob}` : "";
    return `<div class="item">
      <div class="itemLeft">
        <div>
          <div class="itemTitle">${escapeHtml(name)} <span class="pill">${escapeHtml(handle)}</span>${zPill}</div>
          <div class="itemMeta"><b>Próximo:</b> ${next}${bdayMeta}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <span class="badge ${cls}">${lbl}</span>
        <button class="btn ghost" data-act="clientEdit" data-id="${c.id}" title="Editar">✎</button>
        <button class="btn ghost" data-act="clientDel" data-id="${c.id}" title="Eliminar">🗑</button>
      </div>
    </div>`;
  }).join("");
}

function renderIdeas(){
  const list = $("#ideasList");
  const items = STATE.ideas.slice(0,20);
  if(!items.length){
    list.innerHTML = `<div class="item">
      <div class="itemLeft">
        <div>
          <div class="itemTitle">Inbox vacío</div>
          <div class="itemMeta">Captura ideas rápidas de astrología, ganchos, lecturas, tendencias.</div>
        </div>
      </div>
      <div><span class="pill">Ideas → Post</span></div>
    </div>`;
    return;
  }
  list.innerHTML = items.map(i => {
    const kindMap = { idea:["Idea","neutral"], post:["Post","ok"], story:["Historia","ok"], thread:["Hilo","neutral"] };
    const k = kindMap[i.kind] || ["Idea","neutral"];
    const tags = i.tags ? ` • ${escapeHtml(i.tags)}` : "";
    const notes = i.notes ? `<div class="itemMeta">${escapeHtml(i.notes)}</div>` : "";
    return `<div class="item">
      <div class="itemLeft">
        <div>
          <div class="itemTitle">${escapeHtml(i.title)}</div>
          <div class="itemMeta">${new Date(i.createdAt).toLocaleString()}${tags}</div>
          ${notes}
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <span class="badge ${k[1]}">${k[0]}</span>
        <button class="btn ghost" data-act="ideaEdit" data-id="${i.id}" title="Editar">✎</button>
        <button class="btn ghost" data-act="ideaDel" data-id="${i.id}" title="Eliminar">🗑</button>
      </div>
    </div>`;
  }).join("");
}

// ---------- Calendar + bookings ----------
function bookingTypeLabel(type){
  const map = { tarot:["Tarot","neutral"], astrologia:["Astrología","ok"], suscripcion:["Suscripción","warn"] };
  return map[type] || [type,"neutral"];
}

function bookingDotClass(type){
  if(type === "tarot") return "neutral";
  if(type === "astrologia") return "alt";
  if(type === "suscripcion") return "";
  return "neutral";
}

function occurrencesInRange(rangeStart, rangeEnd){
  // Genera ocurrencias (incluye repetición semanal)
  const out = [];
  const rs = new Date(rangeStart).getTime();
  const re = new Date(rangeEnd).getTime();

  for(const b of STATE.bookings){
    const baseStart = new Date(b.startAt);
    const baseMs = baseStart.getTime();
    if(Number.isNaN(baseMs)) continue;

    // Sin repetición
    if(!b.recurrence){
      if(baseMs >= rs && baseMs <= re) out.push({ bookingId: b.id, startAt: b.startAt });
      continue;
    }

    const freq = b.recurrence.freq || "weekly";
    const interval = Math.max(1, Number(b.recurrence.interval || 1) || 1);
    const untilKey = b.recurrence.until || null; // YYYY-MM-DD
    const untilMs = untilKey ? new Date(untilKey + "T23:59:59").getTime() : null;

    if(freq !== "weekly"){
      // Por ahora solo weekly
      if(baseMs >= rs && baseMs <= re) out.push({ bookingId: b.id, startAt: b.startAt });
      continue;
    }

    // Empieza desde el primer evento que cae dentro del rango
    let k = 0;
    // Evitar loops locos: límite razonable
    while(k < 520){
      const occMs = baseMs + (k * interval * 7 * 86400000);
      if(untilMs && occMs > untilMs) break;
      if(occMs > re) break;
      if(occMs >= rs) out.push({ bookingId: b.id, startAt: new Date(occMs).toISOString() });
      k++;
    }
  }
  return out;
}

function renderCalendar(){
  const cal = $("#calendar");
  const lbl = $("#calMonthLabel");
  if(!cal || !lbl) return;

  if(!STATE.calMonth) STATE.calMonth = monthKey(new Date());

  const first = startOfMonth(STATE.calMonth);
  const last = endOfMonth(STATE.calMonth);
  const monthLabel = first.toLocaleDateString(undefined, { month:"long", year:"numeric" });
  lbl.textContent = monthLabel;

  // Monday-first calendar
  const dowMonFirst = (d)=> (d.getDay()===0 ? 6 : d.getDay()-1);
  const offset = dowMonFirst(first);
  const gridStart = addDays(first, -offset);

  const occ = occurrencesInRange(gridStart.toISOString(), addDays(last, 14).toISOString());
  const byDay = new Map();
  for(const o of occ){
    const k = dateKey(o.startAt);
    if(!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(o);
  }

  const dows = ["Lun","Mar","Mié","Jue","Vie","Sáb","Dom"].map(x=>`<div class="calDow">${x}</div>`).join("");

  const cells = [];
  const today = todayKey();
  for(let i=0;i<42;i++){
    const d = addDays(gridStart, i);
    const k = dateKey(d);
    const inMonth = d.getMonth() === first.getMonth();
    const items = byDay.get(k) || [];
    const dots = items.slice(0,3).map(o => {
      const b = STATE.bookings.find(x=>x.id===o.bookingId);
      const cls = bookingDotClass(b?.type);
      const info = getClientForBooking_(b);
      const zcls = info.element ? `z-${info.element}` : "";
      return `<span class="dot ${cls} ${zcls}" title="${escapeHtml(info.display || '')}"></span>`;
    }).join("");
    const more = items.length > 3 ? `<span class="pill">+${items.length-3}</span>` : "";
    const cls = ["calCell", inMonth?"":"muted", (k===today)?"calToday":""].join(" ").trim();
    cells.push(`<div class="${cls}" data-act="calDay" data-day="${k}">
      <div class="calNum">${d.getDate()}</div>
      <div class="calMeta">${dots}${more}</div>
    </div>`);
  }
  cal.innerHTML = dows + cells.join("");
}

function renderBookings(){
  const list = $("#bookingsList");
  if(!list) return;

  const now = Date.now();
  const rangeEnd = Date.now() + (60*86400000);
  const occ = occurrencesInRange(new Date(now - (86400000)).toISOString(), new Date(rangeEnd).toISOString())
    .map(o => {
      const b = STATE.bookings.find(x=>x.id===o.bookingId);
      return { o, b };
    })
    .filter(x => x.b)
    .sort((a,b)=> new Date(a.o.startAt) - new Date(b.o.startAt));

  if(!occ.length){
    list.innerHTML = `<div class="item">
      <div class="itemLeft"><div>
        <div class="itemTitle">Sin sesiones programadas</div>
        <div class="itemMeta">Agrega una sesión, y aquí verás el registro de próximas fechas.</div>
      </div></div>
      <div><span class="pill">Calendario</span></div>
    </div>`;
    return;
  }

  list.innerHTML = occ.slice(0,10).map(({o,b}) => {
    const dt = new Date(o.startAt);
    const when = dt.toLocaleString(undefined, { weekday:"short", month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" });
    const [lbl, cls] = bookingTypeLabel(b.type);
    const amount = b.amount ? ` • S/ ${b.amount}` : "";
    const info = getClientForBooking_(b);
    const client = info.display ? ` • ${escapeHtml(info.display)}` : (b.client ? ` • ${escapeHtml(b.client)}` : "");
    const zpill = info.zodiac ? ` <span class="pill mini">${escapeHtml(info.zodiac)}</span>` : "";
    const statusBadge = b.status === "done" ? ["Hecha","ok"] : (b.status === "cancelled" ? ["Cancelada","warn"] : ["Programada","neutral"]);
    const title = b.title ? escapeHtml(b.title) : lbl;
    const rep = b.recurrence?.freq ? " • semanal" : "";
    return `<div class="item">
      <div class="itemLeft">
        <div>
          <div class="itemTitle">${title}${zpill}</div>
          <div class="itemMeta">${when}${client}${amount}${rep}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <span class="badge ${cls}">${lbl}</span>
        <span class="badge ${statusBadge[1]}">${statusBadge[0]}</span>
        ${(b.sessionRecords||[]).some(r=>r.occStartAt===o.startAt) ? `<span class="pill">log</span>` : ``}
        <button class="btn ghost" data-act="bookSession" data-id="${b.id}" data-occ="${escapeHtml(o.startAt)}" title="Abrir sesión">📝</button>
        <button class="btn ghost" data-act="bookEdit" data-id="${b.id}" title="Editar">✎</button>
        <button class="btn ghost" data-act="bookDel" data-id="${b.id}" title="Eliminar">🗑</button>
      </div>
    </div>`;
  }).join("");
}

function renderReminders(){
  const list = $("#remindersList");
  if(!list) return;
  const items = [...STATE.reminders].sort((a,b)=>{
    // pendientes arriba, luego por dueAt
    const ad = a.doneAt ? 1 : 0;
    const bd = b.doneAt ? 1 : 0;
    if(ad !== bd) return ad - bd;
    const at = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
    const bt = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
    return at - bt;
  });

  if(!items.length){
    list.innerHTML = `<div class="item">
      <div class="itemLeft"><div>
        <div class="itemTitle">Nada pendiente</div>
        <div class="itemMeta">Si algo ronda tu cabeza, ponlo aquí y suéltalo. 🧠✨</div>
      </div></div>
      <div><span class="pill">To-do</span></div>
    </div>`;
    return;
  }

  list.innerHTML = items.slice(0,20).map(r => {
    const done = !!r.doneAt;
    const due = r.dueAt ? new Date(r.dueAt).toLocaleString() : "sin fecha";
    return `<div class="item">
      <div class="itemLeft">
        <button class="btn ${done?"primary":""}" data-act="remToggle" data-id="${r.id}">${done?"✓":"○"}</button>
        <div>
          <div class="itemTitle ${done?"remDone":""}">${escapeHtml(r.text)}</div>
          <div class="itemMeta">${due}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn ghost" data-act="remEdit" data-id="${r.id}" title="Editar">✎</button>
        <button class="btn ghost" data-act="remDel" data-id="${r.id}" title="Eliminar">🗑</button>
      </div>
    </div>`;
  }).join("");
}

function updateSyncUI(){
  const el = $("#syncStatus");
  if(!SETTINGS.syncEnabled || !SETTINGS.appsScriptUrl){
    el.textContent = "Sync: desactivado";
    return;
  }
  const pending = STATE.eventQueue.filter(e => !e.syncedAt).length;
  el.textContent = pending ? `Sync: ${pending} pendientes` : "Sync: al día ✅";
}

function setSessionUIRunning(isRunning){
  $("#btnStartSession").disabled = isRunning;
  $("#btnFinishSession").disabled = !isRunning;
  $("#btnPauseSession").disabled = !isRunning;
  $("#sessionTaskSelect").disabled = isRunning;
}

function updateTimerUI(forceReset=false){
  const v = $("#timerValue");
  const hint = $("#timerHint");
  if(forceReset || !TIMER.startMs){
    v.textContent = "00:00";
    hint.textContent = "Lista para empezar.";
    return;
  }
  const sec = Math.max(0, Math.floor((Date.now() - TIMER.startMs)/1000));
  v.textContent = formatTimer(sec);
  hint.textContent = "En progreso…";
}

// ---------- Modal helpers ----------
function openModal(title, bodyHtml, footHtml="", opts={}){
  const modal = document.querySelector("#modalOverlay .modal");
  if(modal){
    // reset variant/size classes
    modal.classList.remove("modal-lg","modal-md","modal-sm","modal-session");
    const size = String(opts?.size || "md").toLowerCase();
    if(size === "lg") modal.classList.add("modal-lg");
    else if(size === "sm") modal.classList.add("modal-sm");
    else modal.classList.add("modal-md");
    if(opts?.variant) modal.classList.add(`modal-${opts.variant}`);
  }

  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = bodyHtml;
  $("#modalFoot").innerHTML = footHtml;
  $("#modalOverlay").classList.remove("hidden");
}
function closeModal(){
  const modal = document.querySelector("#modalOverlay .modal");
  if(modal) modal.classList.remove("modal-lg","modal-md","modal-sm","modal-session");
  $("#modalOverlay").classList.add("hidden");
  $("#modalBody").innerHTML = "";
  $("#modalFoot").innerHTML = "";
}

function toast(msg){
  const el = document.createElement("div");
  el.textContent = msg;
  el.style.position = "fixed";
  el.style.left = "50%";
  el.style.bottom = "18px";
  el.style.transform = "translateX(-50%)";
  el.style.padding = "10px 12px";
  el.style.borderRadius = "12px";
  el.style.border = "1px solid rgba(255,255,255,.10)";
  el.style.background = "rgba(0,0,0,.55)";
  el.style.color = "#e9f1ff";
  el.style.backdropFilter = "blur(10px)";
  el.style.zIndex = "99";
  el.style.maxWidth = "min(640px, 92vw)";
  document.body.appendChild(el);
  setTimeout(()=> el.remove(), 1800);
}

function wire(){
  $("#tabsNav")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".tabBtn");
    if(!btn) return;
    STATE.activeTab = btn.dataset.tab;
    saveState();
    renderTabs();
  });

  $("#btnAddContentItem").addEventListener("click", () => {
    openContentItemModal();
  });

  $("#btnUseContentTemplate").addEventListener("click", () => {
    openModal(
      "Usar plantilla",
      `<div class="itemMeta">Elige la intensidad para hoy.</div>`,
      `<button class="btn" id="mLight">Plantilla 2/3/4</button><button class="btn primary" id="mFull">Plantilla Full</button><button class="btn" id="mCancel">Cancelar</button>`
    );
    $("#mLight").onclick = () => { applyContentTemplate("light"); closeModal(); };
    $("#mFull").onclick = () => { applyContentTemplate("full"); closeModal(); };
    $("#mCancel").onclick = closeModal;
  });

  $("#btnArchiveContentDay").addEventListener("click", () => {
    archiveActiveContentDay();
    toast("Día archivado 🌙");
  });

  const contentDateBtn = $("#btnPickContentDate");
  if(contentDateBtn){
    contentDateBtn.addEventListener("click", () => {
      openModal(
        "Elegir fecha de contenido",
        `
          <div class="row">
            <label class="label">Fecha</label>
            <input id="mContentDay" type="date" class="input" value="${STATE.contentTodo.activeDate || getTodayKey()}" />
          </div>
        `,
        `<button class="btn" id="mCancel">Cancelar</button><button class="btn primary" id="mSave">Ir a fecha</button>`
      );
      $("#mCancel").onclick = closeModal;
      $("#mSave").onclick = () => {
        const selected = $("#mContentDay").value;
        if(!selected){ toast("Elige una fecha"); return; }
        STATE.contentTodo.activeDate = selected;
        ensureContentDay(selected);
        saveState();
        renderContentTodo();
        renderMetrics();
        closeModal();
      };
    });
  }

  $("#btnAddPlanTask").addEventListener("click", () => {
    openTaskModal_({ category: "plan" });
  });

  // Calendar navigation
  const prev = $("#btnCalPrev");
  const next = $("#btnCalNext");
  const addBookBtn = $("#btnAddBooking");
  if(prev && next){
    prev.addEventListener("click", ()=>{
      if(!STATE.calMonth) STATE.calMonth = monthKey(new Date());
      const s = startOfMonth(STATE.calMonth);
      s.setMonth(s.getMonth()-1);
      STATE.calMonth = monthKey(s);
      saveState();
      renderCalendar();
    });
    next.addEventListener("click", ()=>{
      if(!STATE.calMonth) STATE.calMonth = monthKey(new Date());
      const s = startOfMonth(STATE.calMonth);
      s.setMonth(s.getMonth()+1);
      STATE.calMonth = monthKey(s);
      saveState();
      renderCalendar();
    });
  }

  if(addBookBtn){
    addBookBtn.addEventListener("click", ()=> openBookingModal());
  }

  // Calendar day click
  const cal = $("#calendar");
  if(cal){
    cal.addEventListener("click", (e)=>{
      const cell = e.target.closest("[data-act='calDay']");
      if(!cell) return;
      const day = cell.dataset.day;
      const start = new Date(day + "T00:00:00").toISOString();
      const end = new Date(day + "T23:59:59").toISOString();
      const items = occurrencesInRange(start, end);
      if(items && items.length){
        openDayAgendaModal(day);
      }else{
        openBookingModal(null, { day });
      }
    });
  }

  // Bookings list actions
  const bookingsList = $("#bookingsList");
  if(bookingsList){
    bookingsList.addEventListener("click", (e)=>{
      const btn = e.target.closest("button[data-act]");
      if(!btn) return;
      const act = btn.dataset.act;
      const id = btn.dataset.id;
      if(act === "bookSession"){
        const occStartAt = btn.dataset.occ || null;
        openClientSessionModal(id, occStartAt);
      }
      if(act === "bookEdit") openBookingModal(id);
      if(act === "bookDel"){
        openModal(
          "Eliminar sesión",
          `<div class="itemMeta">Se elimina del calendario y del registro local.</div>`,
          `<button class="btn" id="mCancel">Cancelar</button><button class="btn warn" id="mOk">Eliminar</button>`
        );
        $("#mCancel").onclick = closeModal;
        $("#mOk").onclick = ()=>{ deleteBooking(id); closeModal(); };
      }
    });
  }

  // Reminders
  const addRem = $("#btnAddReminder");
  if(addRem) addRem.addEventListener("click", ()=> openReminderModal());

  const remList = $("#remindersList");
  if(remList){
    remList.addEventListener("click", (e)=>{
      const btn = e.target.closest("button[data-act]");
      if(!btn) return;
      const act = btn.dataset.act;
      const id = btn.dataset.id;
      if(act === "remToggle") toggleReminderDone(id);
      if(act === "remEdit") openReminderModal(id);
      if(act === "remDel"){
        openModal(
          "Eliminar recordatorio",
          `<div class="itemMeta">Se borra localmente (y queda registro para sync).</div>`,
          `<button class="btn" id="mCancel">Cancelar</button><button class="btn warn" id="mOk">Eliminar</button>`
        );
        $("#mCancel").onclick = closeModal;
        $("#mOk").onclick = ()=>{ deleteReminder(id); closeModal(); };
      }
    });
  }

  function openTaskModal_(defaults){
    const defCat = defaults?.category || "mission";
    const defDay = defaults?.pinnedDay || todayKey();
    const isPlan = defCat === "plan";

    openModal(
      isPlan ? "Agregar tarea al Plan Girasol" : "Agregar misión del día",
      `
        <div class="row">
          <label class="label">Título</label>
          <input id="mTaskTitle" class="input" placeholder="Ej: 10 min de investigación (Luna en Piscis)" />
        </div>

        ${isPlan ? "" : `
        <div class="row">
          <label class="label">Fecha</label>
          <input id="mTaskDay" type="date" class="input" value="${defDay}" />
          <div class="itemMeta">Puedes planear para otro día sin cargar el “hoy”.</div>
        </div>
        `}

        <div class="row">
          <label class="label">Tipo</label>
          <select id="mTaskCat" class="input">
            <option value="mission" ${defCat==="mission" ? "selected":""}>Misión (máx 3 hoy)</option>
            <option value="plan" ${defCat==="plan" ? "selected":""}>Plan Girasol 🌻</option>
          </select>
        </div>

        <div class="divider"></div>
        <div class="itemMeta">Tip: si está pesado, hazlo micro (5-10 min). Esto es estructura suave.</div>
      `,
      `
        <button class="btn" id="mCancel">Cancelar</button>
        <button class="btn primary" id="mOk">Agregar</button>
      `
    );

    $("#mCancel").onclick = closeModal;
    $("#mOk").onclick = () => {
      const title = $("#mTaskTitle").value.trim();
      const cat = $("#mTaskCat").value || "mission";
      const dayInput = $("#mTaskDay");
      const day = dayInput ? (dayInput.value || todayKey()) : todayKey();

      if(!title){ toast("Escribe un título."); return; }

      if(cat === "mission" && day === todayKey()){
        const count = STATE.tasks.filter(t => t.pinnedDay===day && (t.category||"mission")!=="plan").slice(0,3).length;
        if(count >= 3){ toast("Máximo 3 misiones para hoy."); return; }
      }

      addTask(title, { pinnedDay: day, category: cat });
      closeModal();
    };
  }


  function openContentItemModal(sectionKey="stories", itemRef=null){
    const isEdit = !!itemRef;
    openModal(
      isEdit ? "Editar contenido" : "Agregar contenido",
      `
        <div class="row">
          <label class="label">Título corto</label>
          <input id="mContentTitle" class="input" value="${escapeAttr(itemRef?.title || "")}" placeholder="Ej: Marte entra a Piscis..." />
        </div>
        <div class="row">
          <label class="label">Sección</label>
          <select id="mContentSection" class="input">
            ${CONTENT_SECTIONS.map(([k,l]) => `<option value="${k}" ${k===sectionKey?"selected":""}>${l}</option>`).join("")}
          </select>
        </div>
        <div class="row">
          <label class="label">Copy / Notas</label>
          <textarea id="mContentNotes" class="input" rows="4" placeholder="Pega aquí el copy, CTA, hashtags o ideas.">${escapeHtml(itemRef?.notes || "")}</textarea>
        </div>
      `,
      `<button class="btn" id="mCancel">Cancelar</button><button class="btn primary" id="mSave">${isEdit ? "Guardar" : "Agregar"}</button>`
    );
    $("#mCancel").onclick = closeModal;
    $("#mSave").onclick = () => {
      const title = $("#mContentTitle").value.trim();
      const sec = $("#mContentSection").value;
      const notes = $("#mContentNotes").value.trim();
      const dayKey = STATE.contentTodo.activeDate || getTodayKey();
      if(!title){ toast("Escribe un título"); return; }
      if(isEdit){
        if(sec !== sectionKey){
          deleteContentItem(dayKey, sectionKey, itemRef.id);
          const moved = addContentItem(dayKey, sec, title);
          if(moved) editContentItem(dayKey, sec, moved.id, { notes });
        }else{
          editContentItem(dayKey, sectionKey, itemRef.id, { title, notes });
        }
      }else{
        const added = addContentItem(dayKey, sec, title);
        if(added) editContentItem(dayKey, sec, added.id, { notes });
      }
      closeModal();
    };
  }

  $("#btnStartSession").addEventListener("click", () => {
    const taskId = $("#sessionTaskSelect").value || null;
    const note = $("#sessionNote").value || "";
    startSession(taskId, note);
    $("#sessionNote").value = "";
  });

  $("#btnFinishSession").addEventListener("click", () => finishSession("done"));

  $("#btnPauseSession").addEventListener("click", () => {
    openModal(
      "Me pauso",
      `
        <div class="row">
          <label class="label">Razón (opcional)</label>
          <select id="mPauseReason" class="input">
            <option value="">(prefiero no decir)</option>
            <option>Ansiedad</option>
            <option>Cansancio</option>
            <option>Mente nublada</option>
            <option>Tristeza</option>
            <option>Dolor de cabeza</option>
            <option>Me drené</option>
            <option>Otra</option>
          </select>
        </div>
        <div class="row">
          <label class="label">Nota (opcional)</label>
          <input id="mPauseNote" class="input" placeholder="Ej: vuelvo en 20 min, necesito agua, respiración…" />
        </div>
      `,
      `
        <button class="btn" id="mCancel">Cancelar</button>
        <button class="btn warn" id="mOk">Guardar pausa</button>
      `
    );
    $("#mCancel").onclick = closeModal;
    $("#mOk").onclick = () => {
      const reason = $("#mPauseReason").value || null;
      const note = ($("#mPauseNote").value || "").trim();
      if(ACTIVE_SESSION && note){
        ACTIVE_SESSION.note = (ACTIVE_SESSION.note ? (ACTIVE_SESSION.note + " | ") : "") + note;
      }
      finishSession("paused", reason);
      closeModal();
    };
  });

  $("#btnAddClient").addEventListener("click", () => openClientModal());
  $("#btnAddIdea").addEventListener("click", () => openIdeaModal());

  $("#clientsList").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if(!btn) return;
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    if(act==="clientEdit") openClientModal(id);
    if(act==="clientDel"){
      openModal(
        "Eliminar cliente",
        `<div class="itemMeta">Esto borra el registro local (y se registra para sync).</div>`,
        `<button class="btn" id="mCancel">Cancelar</button><button class="btn warn" id="mOk">Eliminar</button>`
      );
      $("#mCancel").onclick = closeModal;
      $("#mOk").onclick = () => { deleteClient(id); closeModal(); };
    }
  });

  $("#ideasList").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if(!btn) return;
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    if(act==="ideaEdit") openIdeaModal(id);
    if(act==="ideaDel"){
      openModal(
        "Eliminar idea",
        `<div class="itemMeta">Se borra localmente y se marca para sync.</div>`,
        `<button class="btn" id="mCancel">Cancelar</button><button class="btn warn" id="mOk">Eliminar</button>`
      );
      $("#mCancel").onclick = closeModal;
      $("#mOk").onclick = () => { deleteIdea(id); closeModal(); };
    }
  });

  $("#contentTodoList").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if(!btn) return;
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    const section = btn.dataset.section;
    const dayKey = STATE.contentTodo.activeDate || getTodayKey();
    const day = ensureContentDay(dayKey);
    const item = (day.sections[section] || []).find(x => x.id === id);
    if(act==="contentToggle") toggleContentDone(dayKey, section, id);
    if(act==="contentMoveUp") moveContentItemByOffset(dayKey, section, id, -1);
    if(act==="contentMoveDown") moveContentItemByOffset(dayKey, section, id, 1);
    if(act==="contentDelete") deleteContentItem(dayKey, section, id);
    if(act==="contentTomorrow") duplicateContentToTomorrow(dayKey, section, id);
    if(act==="contentEdit" && item) openContentItemModal(section, item);
  });

  $("#contentTodoList").addEventListener("dragstart", (e) => {
    const row = e.target.closest(".contentRow");
    if(!row) return;
    CONTENT_DRAG = {
      id: row.dataset.contentId,
      fromSection: row.dataset.contentSection
    };
    row.classList.add("dragging");
    if(e.dataTransfer){
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", CONTENT_DRAG.id || "");
    }
  });

  $("#contentTodoList").addEventListener("dragover", (e) => {
    if(!CONTENT_DRAG) return;
    const sectionList = e.target.closest("[data-content-section-list]");
    if(!sectionList) return;
    e.preventDefault();
    if(e.dataTransfer) e.dataTransfer.dropEffect = "move";
  });

  $("#contentTodoList").addEventListener("drop", (e) => {
    if(!CONTENT_DRAG) return;
    const sectionList = e.target.closest("[data-content-section-list]");
    if(!sectionList) return;
    e.preventDefault();

    const toSection = sectionList.dataset.contentSectionList;
    const targetRow = e.target.closest(".contentRow");
    let targetIndex = null;

    if(targetRow && targetRow.dataset.contentSection === toSection){
      const sectionRows = Array.from(sectionList.querySelectorAll(".contentRow"));
      const rowIndex = sectionRows.findIndex(row => row.dataset.contentId === targetRow.dataset.contentId);
      if(rowIndex >= 0){
        const rect = targetRow.getBoundingClientRect();
        const insertAfter = e.clientY > rect.top + rect.height / 2;
        targetIndex = rowIndex + (insertAfter ? 1 : 0);
      }
    }

    const dayKey = STATE.contentTodo.activeDate || getTodayKey();
    moveContentItem(dayKey, CONTENT_DRAG.fromSection, toSection, CONTENT_DRAG.id, targetIndex);
    CONTENT_DRAG = null;
  });

  $("#contentTodoList").addEventListener("dragend", () => {
    document.querySelectorAll(".contentRow.dragging").forEach((el) => el.classList.remove("dragging"));
    CONTENT_DRAG = null;
  });

  $("#planList").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if(!btn) return;
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    if(act==="planToggle") toggleTaskDone(id);
    if(act==="planDelete") deleteTask(id);
    if(act==="planMoveUp") movePlanTaskByOffset(id, -1);
    if(act==="planMoveDown") movePlanTaskByOffset(id, 1);

    if(act==="planEdit"){
      const t = STATE.tasks.find(x => x.id===id);
      if(!t) return;
      openModal(
        "Editar tarea",
        `
          <div class="row">
            <label class="label">Título</label>
            <input id="mEditTitle" class="input" value="${escapeAttr(t.title)}" />
          </div>
        `,
        `
          <button class="btn" id="mCancel">Cancelar</button>
          <button class="btn primary" id="mSave">Guardar</button>
        `
      );
      $("#mCancel").onclick = closeModal;
      $("#mSave").onclick = () => {
        const title = $("#mEditTitle").value.trim();
        if(!title){ toast("Título vacío."); return; }
        t.title = title;
        enqueueEvent("task_update", { id: t.id, patch: { title, category: t.category || "plan" } });
        saveState();
        render();
        closeModal();
      };
    }
  });


  $("#btnAddSubscription")?.addEventListener("click", openSubscriptionModal);
  $("#btnAddOneToOneSession")?.addEventListener("click", openOneToOneSessionModal);
  $("#subscriptionYear")?.addEventListener("change", (e)=>{ STATE.subscriptions.viewYear = Number(e.target.value); saveState(); renderSubscriptions(); });
  $("#subscriptionMonth")?.addEventListener("change", (e)=>{ STATE.subscriptions.viewMonth = Number(e.target.value); saveState(); renderSubscriptions(); });
  $("#oneToOneYear")?.addEventListener("change", (e)=>{ STATE.oneToOneSessions.viewYear = Number(e.target.value); saveState(); renderOneToOneSessions(); });
  $("#oneToOneMonth")?.addEventListener("change", (e)=>{ STATE.oneToOneSessions.viewMonth = Number(e.target.value); saveState(); renderOneToOneSessions(); });
  $("#subscriptionBoards")?.addEventListener("change", async (e) => {
    const t = e.target;
    const id = t.dataset.id;
    if(!id) return;
    const row = STATE.subscriptions.entries.find(x=>x.id===id);
    if(!row) return;
    if(t.dataset.act === "subToggleSession"){
      const n = Number(t.dataset.session);
      row.sessionsDone = row.sessionsDone.includes(n) ? row.sessionsDone.filter(x=>x!==n) : [...row.sessionsDone, n].sort((a,b)=>a-b);
      enqueueEvent("subscription_session_toggle", { id, sessionsDone: row.sessionsDone });
      saveState();
      return;
    }
    if(t.dataset.act === "subInvoice"){
      const file = t.files?.[0];
      if(!file) return;
      const b64 = await new Promise((resolve,reject)=>{
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(file);
      }).catch(()=>null);
      if(!b64){ toast("No pude leer la imagen."); return; }
      row.invoiceImage = String(b64);
      row.invoiceImageName = file.name || "";
      enqueueEvent("subscription_invoice", { id, invoiceImageName: row.invoiceImageName });
      saveState();
      renderSubscriptions();
    }
  });
  $("#subscriptionBoards")?.addEventListener("input", (e) => {
    const t = e.target;
    if(t.dataset.act !== "subObservations") return;
    const row = STATE.subscriptions.entries.find(x=>x.id===t.dataset.id);
    if(!row) return;
    row.observations = t.value;
    saveState();
  });
  $("#subscriptionBoards")?.addEventListener("click", (e) => {
    const viewBtn = e.target.closest("button[data-act='subViewInvoice']");
    if(viewBtn){
      const row = STATE.subscriptions.entries.find(x=>x.id===viewBtn.dataset.id);
      if(row?.invoiceImage) openImagePreviewModal(row.invoiceImage, `Factura · ${row.name || "registro"}`);
      return;
    }
    const uploadBtn = e.target.closest("button[data-act='subUpload']");
    if(uploadBtn){
      const fileInput = document.querySelector(`input[data-act='subInvoice'][data-id='${uploadBtn.dataset.id}']`);
      fileInput?.click();
      return;
    }
    const btn = e.target.closest("button[data-act='subDelete']");
    if(!btn) return;
    STATE.subscriptions.entries = STATE.subscriptions.entries.filter(x=>x.id!==btn.dataset.id);
    enqueueEvent("subscription_delete", { id: btn.dataset.id });
    saveState();
    renderSubscriptions();
  });

  $("#oneToOneBoards")?.addEventListener("change", async (e) => {
    const t = e.target;
    const id = t.dataset.id;
    if(!id) return;
    const row = STATE.oneToOneSessions.entries.find(x=>x.id===id);
    if(!row) return;
    if(t.dataset.act === "s11Invoice"){
      const file = t.files?.[0];
      if(!file) return;
      const b64 = await new Promise((resolve,reject)=>{
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(file);
      }).catch(()=>null);
      if(!b64){ toast("No pude leer la imagen."); return; }
      row.invoiceImage = String(b64);
      row.invoiceImageName = file.name || "";
      enqueueEvent("session11_invoice", { id, invoiceImageName: row.invoiceImageName });
      saveState();
      renderOneToOneSessions();
    }
  });
  $("#oneToOneBoards")?.addEventListener("input", (e) => {
    const t = e.target;
    if(!["s11SessionType", "s11Modality"].includes(t.dataset.act)) return;
    const row = STATE.oneToOneSessions.entries.find(x=>x.id===t.dataset.id);
    if(!row) return;
    if(t.dataset.act === "s11SessionType") row.sessionType = t.value;
    if(t.dataset.act === "s11Modality") row.modality = t.value;
    saveState();
  });
  $("#oneToOneBoards")?.addEventListener("click", (e) => {
    const viewBtn = e.target.closest("button[data-act='s11ViewInvoice']");
    if(viewBtn){
      const row = STATE.oneToOneSessions.entries.find(x=>x.id===viewBtn.dataset.id);
      if(row?.invoiceImage) openImagePreviewModal(row.invoiceImage, `Factura · ${row.consultant || "sesión"}`);
      return;
    }
    const uploadBtn = e.target.closest("button[data-act='s11Upload']");
    if(uploadBtn){
      const fileInput = document.querySelector(`input[data-act='s11Invoice'][data-id='${uploadBtn.dataset.id}']`);
      fileInput?.click();
      return;
    }
    const delBtn = e.target.closest("button[data-act='s11Delete']");
    if(!delBtn) return;
    STATE.oneToOneSessions.entries = STATE.oneToOneSessions.entries.filter(x=>x.id!==delBtn.dataset.id);
    enqueueEvent("session11_delete", { id: delBtn.dataset.id });
    saveState();
    renderOneToOneSessions();
  });

  $("#clientFilter").addEventListener("change", renderClients);
  $("#clientSearch").addEventListener("input", renderClients);

  $("#btnSettings").addEventListener("click", openSettings);
  $("#btnSync").addEventListener("click", syncNow);

  $("#modalClose").addEventListener("click", closeModal);
  $("#modalOverlay").addEventListener("click", (e)=>{ if(e.target.id==="modalOverlay") closeModal(); });
  document.addEventListener("keydown", (e)=>{ if(e.key==="Escape" && !$("#modalOverlay").classList.contains("hidden")) closeModal(); });

  // Guardar si la app se oculta (sirve para "se cortó la sesión")
  document.addEventListener("visibilitychange", () => {
    if(document.visibilityState === "hidden" && ACTIVE_SESSION){
      // Registramos un evento de interrupción, pero NO cerramos sesión automáticamente.
      // Así queda a tu criterio: pausar manual o seguir luego.
      enqueueEvent("app_hidden_during_session", { sessionId: ACTIVE_SESSION.id, taskTitle: ACTIVE_SESSION.taskTitle });
      saveState();
      updateSyncUI();
    }
  });

  window.addEventListener("beforeunload", () => {
    // Best effort: registrar evento de salida
    if(ACTIVE_SESSION){
      enqueueEvent("app_unload_during_session", { sessionId: ACTIVE_SESSION.id, taskTitle: ACTIVE_SESSION.taskTitle });
      saveState();
    }
  });
}

function openClientModal(clientId=null){
  const isEdit = !!clientId;
  const c = isEdit ? STATE.clients.find(x=>x.id===clientId) : null;

  // Build client-linked session summary (only in edit mode)
  let sessBlock = "";
  if(isEdit && c){
    const now = Date.now();
    const pastStart = new Date(now - 120*86400000).toISOString();
    const futureEnd = new Date(now + 180*86400000).toISOString();
    const occ = occurrencesInRange(pastStart, futureEnd)
      .map(o => ({ o, b: STATE.bookings.find(x=>x.id===o.bookingId) }))
      .filter(x => x.b)
      .filter(({b}) => {
        if(b.clientId && String(b.clientId)===String(c.id)) return true;
        // fallback: try string match by handle/name
        if(!b.clientId && b.client){
          const fc = findClientByBookingClientString(b.client);
          return fc && String(fc.id)===String(c.id);
        }
        return false;
      })
      .sort((a,b)=> new Date(a.o.startAt) - new Date(b.o.startAt));

    const upcoming = occ.filter(x=> new Date(x.o.startAt).getTime() >= (now - 5*60000)).slice(0,6);
    const past = occ.filter(x=> new Date(x.o.startAt).getTime() < (now - 5*60000)).slice(-6).reverse();

    function row_(x){
      const dt = new Date(x.o.startAt);
      const when = dt.toLocaleString(undefined, { year:"numeric", month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" });
      const [lbl, cls] = bookingTypeLabel(x.b.type);
      const title = x.b.title ? escapeHtml(x.b.title) : lbl;
      const hasLog = (x.b.sessionRecords||[]).some(r=>r.occStartAt===x.o.startAt);
      const logPill = hasLog ? `<span class="pill">log</span>` : ``;
      return `<div class="item compact">
        <div class="itemLeft">
          <div>
            <div class="itemTitle">${title} ${logPill}</div>
            <div class="itemMeta">${escapeHtml(when)} • <span class="badge ${cls}">${lbl}</span></div>
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn ghost" data-act="cOpenSession" data-id="${x.b.id}" data-occ="${escapeHtml(x.o.startAt)}" title="Abrir sesión">📝</button>
          <button class="btn ghost" data-act="cEditBooking" data-id="${x.b.id}" title="Editar">✎</button>
        </div>
      </div>`;
    }

    sessBlock = `
      <div class="divider"></div>
      <div class="row">
        <label class="label">Sesiones (vinculadas al cliente)</label>
        <div class="itemMeta">Desde aquí puedes programar, abrir el log (notas + recomendaciones) o editar la sesión.</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">
          <button class="btn" id="mCBook">📅 Programar sesión</button>
        </div>
      </div>
      <div class="row">
        <div class="grid2">
          <div>
            <div class="itemMeta" style="margin-bottom:8px">Próximas</div>
            ${upcoming.length ? upcoming.map(row_).join("") : `<div class="itemMeta">Sin próximas sesiones.</div>`}
          </div>
          <div>
            <div class="itemMeta" style="margin-bottom:8px">Pasadas</div>
            ${past.length ? past.map(row_).join("") : `<div class="itemMeta">Sin historial aún.</div>`}
          </div>
        </div>
      </div>
    `;
  }

  openModal(
    isEdit ? "Editar cliente" : "Nuevo cliente",
    `
      <div class="row">
        <label class="label">Nombre</label>
        <input id="mCName" class="input" value="${escapeHtml(c?.name||"")}" placeholder="Ej: María" />
      </div>
      <div class="row">
        <label class="label">Handle (IG/TikTok)</label>
        <input id="mCHandle" class="input" value="${escapeHtml(c?.handle||"")}" placeholder="Ej: fergis_astrology" />
      </div>
      <div class="row">
        <label class="label">Estado</label>
        <select id="mCStatus" class="input">
          ${["lead","chat","booked","paid","delivered","followup"].map(s => {
            const lbl = badgeForStatus(s)[0] || s;
            const sel = (c?.status===s) ? "selected" : "";
            return `<option value="${s}" ${sel}>${lbl}</option>`;
          }).join("")}
        </select>
      </div>
      <div class="row">
        <label class="label">Fecha de nacimiento</label>
        <input id="mCDob" type="date" class="input" value="${escapeHtml(c?.dob||"")}" />
        <div class="itemMeta">Si lo pones, puedo calcular el signo automáticamente (o lo eliges tú).</div>
      </div>
      <div class="row">
        <label class="label">Signo</label>
        <select id="mCZodiac" class="input">
          <option value="">(sin definir)</option>
          ${ZODIAC_SIGNS.map(z => `<option value="${z}" ${(c?.zodiac===z)?"selected":""}>${z}</option>`).join("")}
        </select>
        <div class="itemMeta">Tip: si lo dejas vacío pero hay fecha, al guardar se autocompleta.</div>
      </div>

<div class="row">
        <label class="label">Próximo paso</label>
        <input id="mCNext" class="input" value="${escapeHtml(c?.nextStep||"")}" placeholder="Ej: enviar propuesta / pedir fecha de nacimiento" />
      </div>
      <div class="row">
        <label class="label">Notas</label>
        <textarea id="mCNotes" class="input" style="min-height:140px;resize:vertical" placeholder="Opcional">${escapeHtml(c?.notes||"")}</textarea>
      </div>
      ${sessBlock}
    `,
    `
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn primary" id="mOk">${isEdit ? "Guardar" : "Agregar"}</button>
    `,
    { size: "lg" }
  );

  $("#mCancel").onclick = closeModal;
  $("#mOk").onclick = () => {
    const obj = {
      name: $("#mCName").value,
      handle: $("#mCHandle").value,
      status: $("#mCStatus").value,
      nextStep: $("#mCNext").value,
      notes: $("#mCNotes").value,
      dob: $("#mCDob").value,
      zodiac: $("#mCZodiac").value
    };
    if(obj.dob && !obj.zodiac) obj.zodiac = zodiacFromDob(obj.dob);

    if(isEdit) updateClient(clientId, obj);
    else addClient(obj);
    closeModal();
  };

  // Client session actions (only in edit)
  if(isEdit && c){
    const bookBtn = $("#mCBook");
    if(bookBtn){
      bookBtn.onclick = ()=>{ closeModal(); openBookingModal(null, { clientId: c.id }); };
    }
    const body = $("#modalBody");
    body.addEventListener("click", (e)=>{
      const btn = e.target.closest("button[data-act]");
      if(!btn) return;
      const act = btn.dataset.act;
      const id = btn.dataset.id;
      const occ = btn.dataset.occ || null;
      if(act==="cEditBooking"){ closeModal(); openBookingModal(id); }
      if(act==="cOpenSession"){ closeModal(); openClientSessionModal(id, occ); }
    }, { once: true });
  }
}

function openIdeaModal(ideaId=null){
  const isEdit = !!ideaId;
  const i = isEdit ? STATE.ideas.find(x=>x.id===ideaId) : null;

  openModal(
    isEdit ? "Editar idea" : "Nueva idea",
    `
      <div class="row">
        <label class="label">Título</label>
        <input id="mITitle" class="input" value="${escapeHtml(i?.title||"")}" placeholder="Ej: 'Qué significa Marte en Casa 12' (gancho + ejemplo)" />
      </div>
      <div class="row">
        <label class="label">Tipo</label>
        <select id="mIKind" class="input">
          ${["idea","post","story","thread"].map(k => {
            const lbl = ({idea:"Idea",post:"Post",story:"Historia",thread:"Hilo"})[k];
            const sel = (i?.kind===k) ? "selected" : "";
            return `<option value="${k}" ${sel}>${lbl}</option>`;
          }).join("")}
        </select>
      </div>
      <div class="row">
        <label class="label">Tags</label>
        <input id="mITags" class="input" value="${escapeHtml(i?.tags||"")}" placeholder="Ej: luna, piscis, casa12, ritual" />
      </div>
      <div class="row">
        <label class="label">Notas</label>
        <input id="mINotes" class="input" value="${escapeHtml(i?.notes||"")}" placeholder="Bullet mental: gancho / estructura / CTA…" />
      </div>
    `,
    `
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn primary" id="mOk">${isEdit ? "Guardar" : "Agregar"}</button>
    `
  );

  $("#mCancel").onclick = closeModal;
  $("#mOk").onclick = () => {
    const patch = {
      title: $("#mITitle").value,
      kind: $("#mIKind").value,
      tags: $("#mITags").value,
      notes: $("#mINotes").value
    };
    if(isEdit) updateIdea(ideaId, patch);
    else addIdea(patch);
    closeModal();
  };
}


function openDayAgendaModal(day){
  const start = new Date(day + "T00:00:00").toISOString();
  const end = new Date(day + "T23:59:59").toISOString();
  const occ = occurrencesInRange(start, end)
    .map(o => ({ o, b: STATE.bookings.find(x=>x.id===o.bookingId) }))
    .filter(x => x.b)
    .sort((a,b)=> new Date(a.o.startAt) - new Date(b.o.startAt));

  const rows = occ.map(({o,b})=>{
    const dt = new Date(o.startAt);
    const when = dt.toLocaleTimeString(undefined, { hour:"2-digit", minute:"2-digit" });
    const [lbl, cls] = bookingTypeLabel(b.type);
    const title = b.title ? escapeHtml(b.title) : lbl;
    const info = getClientForBooking_(b);
    const client = info.display ? ` • ${escapeHtml(info.display)}` : (b.client ? ` • ${escapeHtml(b.client)}` : "");
    const hasLog = (b.sessionRecords||[]).some(r=>r.occStartAt===o.startAt);
    const logPill = hasLog ? `<span class="pill">log</span>` : ``;
    return `<div class="item">
      <div class="itemLeft">
        <div>
          <div class="itemTitle">${when} • ${title} ${logPill}</div>
          <div class="itemMeta"><span class="badge ${cls}">${lbl}</span>${client}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn ghost" data-act="daySession" data-id="${b.id}" data-occ="${escapeHtml(o.startAt)}" title="Abrir sesión">📝</button>
        <button class="btn ghost" data-act="dayEdit" data-id="${b.id}" title="Editar">✎</button>
      </div>
    </div>`;
  }).join("");

  openModal(
    `Agenda ${day}`,
    `
      <div class="itemMeta">Toca 📝 para abrir la sesión con notas y recomendaciones. (Los puntos del calendario son estas sesiones.)</div>
      <div class="divider"></div>
      ${rows || `<div class="itemMeta">Sin sesiones para este día.</div>`}
      <div class="divider"></div>
      <button class="btn" id="mAddNew">＋ Programar otra sesión</button>
    `,
    `
      <button class="btn" id="mCancel">Cerrar</button>
    `
  );

  $("#mCancel").onclick = closeModal;
  $("#mAddNew").onclick = ()=>{ closeModal(); openBookingModal(null,{day}); };

  const body = $("#modalBody");
  body.addEventListener("click", (e)=>{
    const btn = e.target.closest("button[data-act]");
    if(!btn) return;
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    if(act==="dayEdit"){ closeModal(); openBookingModal(id); }
    if(act==="daySession"){ closeModal(); openClientSessionModal(id, btn.dataset.occ || null); }
  }, { once:true });
}

function upsertBookingRecord_(bookingId, record){
  const b = STATE.bookings.find(x=>x.id===bookingId);
  if(!b) return;
  b.sessionRecords = Array.isArray(b.sessionRecords) ? b.sessionRecords : [];
  const idx = b.sessionRecords.findIndex(r => r.id === record.id);
  if(idx >= 0) b.sessionRecords[idx] = record;
  else{
    const idx2 = b.sessionRecords.findIndex(r => r.occStartAt === record.occStartAt);
    if(idx2 >= 0) b.sessionRecords[idx2] = record;
    else b.sessionRecords.unshift(record);
  }
  enqueueEvent("booking_session_record_upsert", { bookingId, record });
  saveState();
  renderBookings();
  renderCalendar();
  updateSyncUI();
}

function openClientSessionModal(bookingId, occStartAt=null){
  const b = STATE.bookings.find(x=>x.id===bookingId);
  if(!b){ toast("No encuentro esa sesión."); return; }

  const occIso = occStartAt || b.startAt;
  const dt = new Date(occIso);
  const whenFull = dt.toLocaleString(undefined, { weekday:"long", year:"numeric", month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" });

  const clientStr = b.client || "";
  const info = getClientForBooking_(b);
  const c = info.client;

  const zodiac = info.zodiac;
  const dob = c?.dob || "";
  const displayName = info.display || (clientStr || "(sin cliente)");
  const handleShow = info.handleShow || (clientStr||"");
  const headerPills = [
    zodiac ? `<span class="pill">♈ ${escapeHtml(zodiac)}</span>` : "",
    dob ? `<span class="pill">🎂 ${escapeHtml(dob)}</span>` : "",
    handleShow ? `<span class="pill">${escapeHtml(handleShow)}</span>` : ""
  ].filter(Boolean).join(" ");

  const recs = Array.isArray(b.sessionRecords) ? b.sessionRecords : [];
  let rec = recs.find(r => r.occStartAt === occIso) || null;
  if(!rec){
    rec = { id: uid("srec"), bookingId: b.id, occStartAt: occIso, createdAt: nowISO(), sessionNotes:"", recommendations:"", clientSnapshot: c ? { id:c.id, name:c.name, handle:c.handle, dob:c.dob, zodiac:c.zodiac } : { raw: clientStr } };
  }

  const statusBadge = b.status === "done" ? ["Hecha","ok"] : (b.status === "cancelled" ? ["Cancelada","warn"] : ["Programada","neutral"]);
  const [lbl, cls] = bookingTypeLabel(b.type);

  openModal(
    "Sesión con cliente",
    `
      <div class="sessTop">
        <div class="sessTitle">
          <div class="sessName">${escapeHtml(displayName)}</div>
          <div class="sessPills">${headerPills || ""}</div>
          <div class="sessWhen">${escapeHtml(whenFull)}</div>
        </div>
        <div class="sessBadges">
          <span class="badge ${cls}">${lbl}</span>
          <span class="badge ${statusBadge[1]}">${statusBadge[0]}</span>
        </div>
      </div>

      <div class="divider"></div>

      <div class="sessGrid">
        <div class="row">
          <label class="label">Notas en sesión</label>
          <textarea id="mSessNotes" class="input sessTextarea" placeholder="Puntos clave, cartas, interpretaciones, preguntas...">${escapeHtml(rec.sessionNotes||"")}</textarea>
        </div>

        <div class="row">
          <label class="label">Recomendaciones</label>
          <textarea id="mSessRecs" class="input sessTextarea" placeholder="Recomendaciones prácticas, rituales, hábitos, próximos pasos...">${escapeHtml(rec.recommendations||"")}</textarea>
          <div class="itemMeta">Esto queda guardado dentro de la sesión (log) para revisarlo después.</div>
        </div>
      </div>

      <div class="divider"></div>

      <div class="row">
        <label class="label">Acciones rápidas</label>
        <div class="sessActions">
          <button class="btn" id="mSessEditClient" ${c? "" : "disabled"}>Editar perfil</button>
          <button class="btn" id="mSessCopy" title="Copiar resumen">📋 Copiar</button>
        </div>
        ${c ? "" : `<div class="itemMeta">Tip: para ver fecha de nacimiento y signo aquí, crea el cliente en CRM y usa el mismo handle.</div>`}
      </div>
    `,
    `
      <button class="btn" id="mCancel">Cerrar</button>
      <button class="btn" id="mSave">Guardar</button>
      <button class="btn primary" id="mSaveDone">Guardar y marcar hecha</button>
    `,
    { size: "lg", variant: "session" }
  );

  $("#mCancel").onclick = closeModal;

  $("#mSessEditClient").onclick = ()=>{
    if(!c) return;
    rec.sessionNotes = $("#mSessNotes").value || "";
    rec.recommendations = $("#mSessRecs").value || "";
    upsertBookingRecord_(b.id, rec);
    closeModal();
    openClientModal(c.id);
  };

  $("#mSessCopy").onclick = async ()=>{
    try{
      const block = [
        `Cliente: ${displayName} ${handleShow?("(" + handleShow + ")"):""}`,
        `Fecha: ${whenFull}`,
        zodiac ? `Signo: ${zodiac}` : "",
        dob ? `Nacimiento: ${dob}` : "",
        `Tipo: ${lbl}`,
        `Notas: ${($("#mSessNotes").value||"").trim()}`,
        `Recomendaciones: ${($("#mSessRecs").value||"").trim()}`
      ].filter(Boolean).join("\n");
      await navigator.clipboard.writeText(block);
      toast("Copiado ✨");
    }catch(e){
      toast("No pude copiar (permiso del navegador).");
    }
  };

  function saveOnly(markDone=false){
    rec.sessionNotes = $("#mSessNotes").value || "";
    rec.recommendations = $("#mSessRecs").value || "";
    upsertBookingRecord_(b.id, rec);
    if(markDone){
      updateBooking(b.id, { ...b, status:"done" });
    }else{
      saveState();
      renderBookings();
      renderCalendar();
      updateSyncUI();
    }
  }

  $("#mSave").onclick = ()=>{ saveOnly(false); closeModal(); toast("Sesión guardada."); };
  $("#mSaveDone").onclick = ()=>{ saveOnly(true); closeModal(); toast("Guardado y marcada como hecha."); };
}

function openBookingModal(bookingId=null, opts={}){
  const isEdit = !!bookingId;
  const b = isEdit ? STATE.bookings.find(x=>x.id===bookingId) : null;

  const prefClientId = opts?.clientId || null;
  const currentClientId = (b?.clientId || prefClientId || "");

  const prefDay = opts?.day || null;
  const defaultStart = (()=>{
    if(b?.startAt) return b.startAt;
    if(prefDay){
      // hoy a las 10:00 por defecto
      return new Date(`${prefDay}T10:00:00`).toISOString();
    }
    const d = new Date();
    d.setMinutes(0,0,0);
    d.setHours(Math.min(20, d.getHours()+1));
    return d.toISOString();
  })();

  const rec = b?.recurrence || null;

  openModal(
    isEdit ? "Editar sesión" : "Programar sesión",
    `
      <div class="row">
        <label class="label">Tipo</label>
        <select id="mBType" class="input">
          <option value="tarot" ${(b?.type||"tarot")==="tarot"?"selected":""}>Tarot</option>
          <option value="astrologia" ${(b?.type||"tarot")==="astrologia"?"selected":""}>Astrología</option>
          <option value="suscripcion" ${(b?.type||"tarot")==="suscripcion"?"selected":""}>Suscripción</option>
        </select>
      </div>

      <div class="row">
        <label class="label">Cliente</label>
        <select id="mBClientId" class="input">
          <option value="">(manual)</option>
          ${STATE.clients.map(c=>{
            const handle = c.handle ? "@"+String(c.handle).replace(/^@/,"") : "";
            const lbl = (c.name || handle || "(sin nombre)") + (handle && c.name ? "  " + handle : "");
            const sel = (String(c.id)===String(currentClientId)) ? "selected" : "";
            return `<option value="${escapeHtml(c.id)}" ${sel}>${escapeHtml(lbl)}</option>`;
          }).join("")}
        </select>
        <input id="mBClient" class="input" value="${escapeHtml(b?.client||"")}" placeholder="Ej: @maria" />
        <div class="itemMeta">Tip: si eliges un cliente del CRM, queda vinculado (clientId). El texto es solo display.</div>
      </div>

      <div class="row">
        <label class="label">Título (opcional)</label>
        <input id="mBTitle" class="input" value="${escapeHtml(b?.title||"")}" placeholder="Ej: Lectura general / Carta natal" />
      </div>

      <div class="row">
        <label class="label">Fecha y hora</label>
        <input id="mBStart" type="datetime-local" class="input" value="${toInputDateTimeLocal(defaultStart)}" />
      </div>

      <div class="row">
        <label class="label">Duración (min)</label>
        <input id="mBDur" type="number" class="input" value="${escapeHtml(String(b?.durationMin ?? 60))}" min="15" step="15" />
      </div>

      <div class="row">
        <label class="label">Monto (S/)</label>
        <input id="mBAmt" type="number" class="input" value="${escapeHtml(String(b?.amount ?? 0))}" min="0" step="1" />
      </div>

      <div class="row">
        <label class="label">Estado</label>
        <select id="mBStatus" class="input">
          <option value="scheduled" ${(b?.status||"scheduled")==="scheduled"?"selected":""}>Programada</option>
          <option value="done" ${(b?.status||"scheduled")==="done"?"selected":""}>Hecha</option>
          <option value="cancelled" ${(b?.status||"scheduled")==="cancelled"?"selected":""}>Cancelada</option>
        </select>
      </div>

      <div class="divider"></div>

      <div class="row">
        <label class="label">Repetir semanalmente</label>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <input type="checkbox" id="mBRepeat" ${rec?.freq==="weekly"?"checked":""} />
          <span class="itemMeta">Útil para suscripciones.</span>
        </div>
      </div>

      <div class="row">
        <label class="label">Hasta (opcional)</label>
        <input id="mBUntil" type="date" class="input" value="${escapeHtml(rec?.until||"")}" />
        <div class="itemMeta">Si lo dejas vacío, seguirá apareciendo semanalmente (tú lo puedes cortar luego).</div>
      </div>

      <div class="row">
        <label class="label">Notas</label>
        <input id="mBNotes" class="input" value="${escapeHtml(b?.notes||"")}" placeholder="Ej: depósito, enlace de Zoom, tema a tocar…" />
      </div>
    `,
    `
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn primary" id="mOk">${isEdit ? "Guardar" : "Agregar"}</button>
    `
  );

  $("#mCancel").onclick = closeModal;
  $("#mOk").onclick = () => {
    const type = $("#mBType").value;
    const clientId = $("#mBClientId").value || null;
    const client = $("#mBClient").value;
    const title = $("#mBTitle").value;
    const startAt = parseInputDateTimeLocal($("#mBStart").value);
    const durationMin = Number($("#mBDur").value || 60) || 60;
    const amount = Number($("#mBAmt").value || 0) || 0;
    const status = $("#mBStatus").value || "scheduled";
    const notes = $("#mBNotes").value;

    if(!startAt){ toast("Fecha/hora inválida."); return; }

    const repeat = $("#mBRepeat").checked;
    const until = $("#mBUntil").value || null;
    const recurrence = repeat ? { freq:"weekly", interval:1, until } : null;

    const payload = { type, clientId, client, title, startAt, durationMin, amount, status, notes, recurrence };
    if(isEdit) updateBooking(bookingId, payload);
    else addBooking(payload);
    closeModal();
  };

  // Sync client selector -> text
  const sel = $("#mBClientId");
  const txt = $("#mBClient");
  function applyClientSelection_(){
    const id = sel.value || "";
    if(!id){
      txt.placeholder = "Ej: @maria";
      return;
    }
    const c = STATE.clients.find(x=>String(x.id)===String(id));
    if(!c) return;
    const handle = c.handle ? "@"+String(c.handle).replace(/^@/,"") : "";
    txt.value = handle || c.name || txt.value;
  }
  sel.addEventListener("change", applyClientSelection_);
  // initial
  if(currentClientId && !txt.value) applyClientSelection_();
}

function openReminderModal(reminderId=null){
  const isEdit = !!reminderId;
  const r = isEdit ? STATE.reminders.find(x=>x.id===reminderId) : null;

  openModal(
    isEdit ? "Editar recordatorio" : "Nuevo recordatorio",
    `
      <div class="row">
        <label class="label">Texto</label>
        <input id="mRText" class="input" value="${escapeHtml(r?.text||"")}" placeholder="Ej: escribir a @ana y ofrecer promo" />
      </div>
      <div class="row">
        <label class="label">Fecha y hora (opcional)</label>
        <input id="mRDue" type="datetime-local" class="input" value="${r?.dueAt ? toInputDateTimeLocal(r.dueAt) : ""}" />
      </div>
    `,
    `
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn primary" id="mOk">${isEdit ? "Guardar" : "Agregar"}</button>
    `
  );

  $("#mCancel").onclick = closeModal;
  $("#mOk").onclick = () => {
    const text = $("#mRText").value;
    const dueRaw = $("#mRDue").value;
    const dueAt = dueRaw ? parseInputDateTimeLocal(dueRaw) : null;
    if(isEdit){
      const rr = STATE.reminders.find(x=>x.id===reminderId);
      if(!rr) return;
      rr.text = (text||"").trim();
      rr.dueAt = dueAt;
      enqueueEvent("reminder_update", { id: rr.id, patch: { text: rr.text, dueAt: rr.dueAt } });
      saveState();
      renderReminders();
      renderMetrics();
    }else{
      addReminder({ text, dueAt });
    }
    closeModal();
  };
}

function openSettings(){
  openModal(
    "Ajustes",
    `
      <div class="row">
        <label class="label">Sync a Google Sheets</label>
        <div style="display:flex;gap:10px;align-items:center">
          <input type="checkbox" id="mSyncEnabled" ${SETTINGS.syncEnabled ? "checked":""} />
          <div class="itemMeta">Activa cuando tengamos el Apps Script listo.</div>
        </div>
      </div>

      <div class="row">
        <label class="label">Apps Script URL (exec)</label>
        <input id="mScriptUrl" class="input" value="${escapeHtml(SETTINGS.appsScriptUrl||"")}" placeholder="https://script.google.com/macros/s/XXXX/exec" />
        <div class="itemMeta">Debe aceptar POST JSON y devolver { ok:true, acked:[...] }.</div>
      </div>

      <div class="row">
        <label class="label">API Key (opcional)</label>
        <input id="mApiKey" class="input" value="${escapeHtml(SETTINGS.apiKey||"")}" placeholder="Si quieres validar llamadas" />
      </div>

      <div class="divider"></div>

      <div class="row">
        <label class="label">Exportar memoria completa (JSON)</label>
        <button class="btn" id="btnExport">⬇ Exportar</button>
        <div class="itemMeta">Incluye estado, ajustes y metadatos del respaldo.</div>
      </div>

      <div class="row">
        <label class="label">Importar memoria completa</label>
        <input type="file" id="fileImport" class="input" accept="application/json" />
        <div class="itemMeta">Restaura estado y ajustes locales. Sobrescribe lo actual.</div>
      </div>

      <div class="divider"></div>
      <div class="itemMeta">Tip: GitHub Pages funciona perfecto porque todo es estático y el estado vive en local.</div>
    `,
    `
      <button class="btn" id="mCancel">Cerrar</button>
      <button class="btn primary" id="mOk">Guardar</button>
    `
  );

  $("#mCancel").onclick = closeModal;
  $("#mOk").onclick = () => {
    SETTINGS.syncEnabled = $("#mSyncEnabled").checked;
    SETTINGS.appsScriptUrl = $("#mScriptUrl").value.trim();
    SETTINGS.apiKey = $("#mApiKey").value.trim();
    saveSettings();
    updateSyncUI();
    closeModal();
    toast("Ajustes guardados.");
  };

  $("#btnExport").onclick = () => {
    const backup = {
      format: "fergis_assistant_backup_v1",
      exportedAt: nowISO(),
      state: STATE,
      settings: SETTINGS
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type:"application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `fergis_assistant_backup_${todayKey()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  $("#fileImport").onchange = async (e) => {
    const file = e.target.files?.[0];
    if(!file) return;
    try{
      const txt = await file.text();
      const parsed = JSON.parse(txt);
      const isLegacyState = !!(parsed && parsed.v);
      const hasBundle = parsed && parsed.format === "fergis_assistant_backup_v1" && parsed.state;
      if(!isLegacyState && !hasBundle) throw new Error("Formato inválido");

      const nextState = hasBundle ? parsed.state : parsed;
      const nextSettings = hasBundle ? { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) } : null;

      STATE = normalizeState_(nextState);
      if(nextSettings){
        SETTINGS = nextSettings;
        saveSettings();
      }
      saveState();
      toast("Importado.");
      closeModal();
      render();
    }catch(err){
      toast("No se pudo importar.");
      console.warn(err);
    }
  };
}

// Register SW (optional)
if("serviceWorker" in navigator){
  window.addEventListener("load", async () => {
    try{
      await navigator.serviceWorker.register("./sw.js");
    }catch(e){
      // No pasa nada si falla en dev
    }
  });
}

wire();
recoverStateFromIDB();
render();

window.addEventListener("pagehide", () => saveState());
