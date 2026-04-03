// Fergis Assistant v0.1
// Local-first + cola de eventos para sync a Google Sheets (Apps Script) cuando lo activemos.
// Importante: esto es un arranque estable, con estructura clara para crecer.

const LS_KEY = "fa_v01_state";
const SETTINGS_KEY = "fa_v01_settings";
const SYNC_META_KEY = "fa_v01_sync_meta";
const DB_NAME = "fergis_assistant_db";
const DB_VERSION = 1;
const STATE_STORE = "state_snapshots";
const STATE_SNAPSHOT_ID = "main";
const SYNC_META_IDB_ID  = "sync_meta";
const HERO_IMG_IDB_ID   = "hero_img";
const LS_QUOTA_WARN_DEBOUNCE_MS = 30000;

const DEFAULT_SETTINGS = {
  syncEnabled: false,
  appsScriptUrl: "",        // ejemplo: https://script.google.com/macros/s/XXXX/exec
  apiKey: "",               // opcional (si lo quieres validar en Apps Script)
  exchangeRate: 3.75,       // tipo de cambio USD → PEN (soles)
  heroBlur: 1.5,            // blur del banner en px (0 = sin blur, 10 = máximo)
  heroOverlay: 0.75         // opacidad del filtro blanco sobre la imagen (0 = sin filtro, 1 = blanco total)
};

// IMPORTANT:
// `STATE` is referenced by helper functions declared near the top of this file.
// Declare it here (without initialization) to avoid the Temporal Dead Zone error
// "Cannot access 'STATE' before initialization".
let STATE;
let CONTENT_DRAG = null;
let IDB_PROMISE = null;

const nowISO = () => new Date().toISOString();
const todayKey = ()=>{
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
};

// ---- Zodiac helpers ----
const ZODIAC_SIGNS = [
  "Aries","Tauro","Géminis","Cáncer","Leo","Virgo","Libra","Escorpio","Sagitario","Capricornio","Acuario","Piscis"
];

function normHandle(h){
  return (h||"").trim().replace(/^@/,"").toLowerCase();
}

function normalizeSearchText(value){
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function amountNum(v){
  if(v == null) return 0;
  if(typeof v === "number") return Number.isFinite(v) ? v : 0;
  const raw = String(v).trim();
  if(!raw) return 0;
  const clean = raw.replace(/\s/g, "").replace(/[^\d,.-]/g, "");
  if(!clean) return 0;

  const hasComma = clean.includes(",");
  const hasDot = clean.includes(".");
  let normalized = clean;

  if(hasComma && hasDot){
    if(clean.lastIndexOf(",") > clean.lastIndexOf(".")){
      normalized = clean.replace(/\./g, "").replace(",", ".");
    }else{
      normalized = clean.replace(/,/g, "");
    }
  }else if(hasComma){
    normalized = clean.replace(",", ".");
  }

  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
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

function formatDateDMY(ymd){
  if(!ymd) return "";
  const raw = String(ymd).trim();
  if(!raw) return "";

  const direct = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(direct){
    const [, y, m, d] = direct;
    return `${d}-${m}-${y}`;
  }

  const dt = new Date(raw);
  if(Number.isNaN(dt.getTime())) return "";
  return `${pad2(dt.getDate())}-${pad2(dt.getMonth()+1)}-${dt.getFullYear()}`;
}

function formatDateTimeDMYHM(isoLike){
  const d = new Date(isoLike);
  if(Number.isNaN(d.getTime())) return "";
  return `${pad2(d.getDate())}-${pad2(d.getMonth()+1)}-${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function getTodayBirthdays(st = STATE){
  const clients = (st && Array.isArray(st.clients)) ? st.clients : [];
  const now = new Date();
  const todayMonth = now.getMonth() + 1;
  const todayDay = now.getDate();

  return clients
    .filter((c) => {
      if(!c?.dob) return false;
      const parts = String(c.dob).split("-");
      if(parts.length < 3) return false;
      const month = Number(parts[1]);
      const day = Number(parts[2]);
      return month === todayMonth && day === todayDay;
    })
    .sort((a, b) => {
      const an = `${a.name || ""} ${a.handle || ""}`.trim().toLowerCase();
      const bn = `${b.name || ""} ${b.handle || ""}`.trim().toLowerCase();
      return an.localeCompare(bn, "es");
    });
}

// ---- Month helpers ----
function monthKey(d=new Date()){
  const x = new Date(d);
  return `${x.getFullYear()}-${pad2(x.getMonth()+1)}`;
}
function isValidMonthKey(ym){
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(ym || ""));
}
function startOfMonth(ym){
  const safeYm = isValidMonthKey(ym) ? ym : monthKey();
  const [y,m] = safeYm.split("-").map(Number);
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

const HOME_TIMEZONE = "America/Lima";
const HOME_TIMEZONE_LABEL = "Perú";
const RESIDENCE_TIMEZONE_HINTS = [
  { tz: "America/Lima", keys: ["peru","perú","lima","cusco","arequipa","trujillo","piura"] },
  { tz: "Europe/Paris", keys: ["francia","france","paris","lyon","marseille","toulouse"] },
  { tz: "Europe/Madrid", keys: ["espana","españa","spain","madrid","barcelona","sevilla","valencia"] }
];

function normalizePlaceText(v){
  return String(v || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function inferTimezoneFromResidence(place){
  const norm = normalizePlaceText(place);
  if(!norm) return HOME_TIMEZONE;
  for(const row of RESIDENCE_TIMEZONE_HINTS){
    if(row.keys.some(k => norm.includes(k))) return row.tz;
  }
  return HOME_TIMEZONE;
}

function timePartsInZone(dateInput, timeZone){
  const d = (dateInput instanceof Date) ? dateInput : new Date(dateInput);
  if(Number.isNaN(d.getTime())) return null;
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const parts = fmt.formatToParts(d);
  const get = (type) => Number(parts.find(p => p.type === type)?.value || 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second")
  };
}

function splitInputDateTime(val){
  const m = String(val || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if(!m) return null;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5])
  };
}

function utcIsoToZoneInput(iso, timeZone){
  const parts = timePartsInZone(iso, timeZone);
  if(!parts) return "";
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

function zoneInputToUtcISO(inputVal, timeZone){
  const target = splitInputDateTime(inputVal);
  if(!target) return null;
  let guessUtcMs = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, 0);
  const wantedAsUtc = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, 0);

  for(let i=0; i<5; i++){
    const zoned = timePartsInZone(new Date(guessUtcMs), timeZone);
    if(!zoned) return null;
    const seenAsUtc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, 0);
    const diff = wantedAsUtc - seenAsUtc;
    guessUtcMs += diff;
    if(diff === 0) break;
  }
  const out = new Date(guessUtcMs);
  return Number.isNaN(out.getTime()) ? null : out.toISOString();
}

const CONTENT_SECTIONS = [
  ["stories", "🌻 Stories"],
  ["entreDiosas", "🌻 Entre Diosas"],
  ["threads", "🌻 Threads"],
  ["postVideo", "🌻 Post / Video"],
  ["pinterest", "🌻 Pinterest"],
  ["youtube", "🌻 YouTube"],
  ["youtubeShort", "🌻 YouTube Short"]
];

const APP_TABS = ["plan","contenido","investigacion","clientes","sesiones11","suscripcion","lecturasPreguntas","finanzas","archivo"];
const TAB_SYNC_IDS = {
  plan: "plan_girasol",
  contenido: "contenido_hoy",
  investigacion: "ideas_investigacion",
  clientes: "clientes_calendario",
  sesiones11: "sesiones_1_1",
  suscripcion: "suscripcion_diosa_guia",
  lecturasPreguntas: "lecturas_preguntas",
  finanzas: "finanzas",
  archivo: "archivo"
};
const TAB_SYNC_DEFAULTS = {
  plan_girasol: { tasks: [], planWeekId: null },
  contenido_hoy: { contentTodo: { activeDate: todayKey(), days: {}, historyOrder: [] }, reminders: [] },
  ideas_investigacion: { ideas: [] },
  clientes_calendario: { clients: [], nextSteps: [], bookings: [], calMonth: monthKey() },
  sesiones_1_1: { oneToOneSessions: { viewYear: new Date().getFullYear(), viewMonth: new Date().getMonth()+1, entries: [] } },
  suscripcion_diosa_guia: { subscriptions: { viewYear: new Date().getFullYear(), viewMonth: new Date().getMonth()+1, entries: [] } },
  lecturas_preguntas: { questionReadings: { viewYear: new Date().getFullYear(), viewMonth: new Date().getMonth()+1, entries: [] } },
  finanzas: { financeRange: "1M" },
  archivo: { sessions: [] }
};
const SUBSCRIPTION_TYPES = [
  { key:"oneToOne", label:"Suscripciones · 1:1", sessions:4 },
  { key:"preguntas", label:"Suscripciones · Preguntas", sessions:10 }
];
const MONTHS_ES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

function getTodayKey(){ return todayKey(); }

function formatContentDateLabel(dayKey){
  const base = formatDateDMY(dayKey) || dayKey;
  return dayKey === getTodayKey() ? `Hoy · ${base}` : base;
}

function defaultContentSections(){
  return {
    stories: [],
    entreDiosas: [],
    threads: [],
    postVideo: [],
    pinterest: [],
    youtube: [],
    youtubeShort: []
  };
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
  if(active === today) return false;
  if(!STATE.contentTodo.historyOrder.includes(active)){
    STATE.contentTodo.historyOrder.unshift(active);
    return true;
  }
  return false;
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
    nextSteps: [],
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
    },
    questionReadings: {
      viewYear: new Date().getFullYear(),
      viewMonth: new Date().getMonth()+1,
      entries: []
    },
    financeRange: "1M"
  };
}

function safeLocalStorageSetItem(key, value, contextLabel = "LocalStorage write"){
  try{
    localStorage.setItem(key, value);
    return true;
  }catch(e){
    if(e?.name === "QuotaExceededError"){
      console.warn(`${contextLabel}: cuota de localStorage excedida`, e);
    }else{
      console.warn(`${contextLabel}: error al guardar en localStorage`, e);
    }
    return false;
  }
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
  // Use strict less-than: when timestamps are equal, prefer IDB (which holds the full
  // state including invoice images stripped from the compact localStorage version).
  if(backupUpdated < currentUpdated) return;

  const isNewer = backupUpdated > currentUpdated;
  STATE = snapshot;
  // Save compact version back to localStorage (avoid re-introducing quota issues).
  safeLocalStorageSetItem(LS_KEY, JSON.stringify(stripLargeDataForSync_(snapshot)), "State restore");
  render();
  if(isNewer) toast("Recuperé una copia guardada localmente 💾");
}

async function saveSyncMetaToIDB(){
  const db = await openStateDB();
  if(!db) return;
  await new Promise((resolve) => {
    try{
      const tx = db.transaction(STATE_STORE, "readwrite");
      tx.objectStore(STATE_STORE).put({ id: SYNC_META_IDB_ID, meta: SYNC_META, savedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => { console.warn("IndexedDB sync meta save error", tx.error); resolve(); };
    }catch(e){ console.warn("IndexedDB sync meta tx error", e); resolve(); }
  });
}

async function recoverSyncMetaFromIDB(){
  if(Object.keys(SYNC_META).length > 0) return;
  const db = await openStateDB();
  if(!db) return;
  const row = await new Promise((resolve) => {
    try{
      const tx = db.transaction(STATE_STORE, "readonly");
      const req = tx.objectStore(STATE_STORE).get(SYNC_META_IDB_ID);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => { console.warn("IndexedDB sync meta read error", req.error); resolve(null); };
    }catch(e){ console.warn("IndexedDB sync meta tx error", e); resolve(null); }
  });
  if(row?.meta && typeof row.meta === "object"){
    SYNC_META = row.meta;
  }
}

async function saveHeroImgToIDB(src){
  const db = await openStateDB();
  if(!db) return;
  await new Promise((resolve) => {
    try{
      const tx = db.transaction(STATE_STORE, "readwrite");
      tx.objectStore(STATE_STORE).put({ id: HERO_IMG_IDB_ID, src, savedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => { console.warn("IndexedDB hero img save error", tx.error); resolve(); };
    }catch(e){ console.warn("IndexedDB hero img tx error", e); resolve(); }
  });
}

async function loadHeroImgFromIDB(){
  const db = await openStateDB();
  if(!db) return null;
  return new Promise((resolve) => {
    try{
      const tx = db.transaction(STATE_STORE, "readonly");
      const req = tx.objectStore(STATE_STORE).get(HERO_IMG_IDB_ID);
      req.onsuccess = () => resolve(req.result?.src || null);
      req.onerror = () => { console.warn("IndexedDB hero img read error", req.error); resolve(null); };
    }catch(e){ console.warn("IndexedDB hero img tx error", e); resolve(null); }
  });
}

async function clearHeroImgFromIDB(){
  const db = await openStateDB();
  if(!db) return;
  await new Promise((resolve) => {
    try{
      const tx = db.transaction(STATE_STORE, "readwrite");
      tx.objectStore(STATE_STORE).delete(HERO_IMG_IDB_ID);
      tx.oncomplete = () => resolve();
      tx.onerror = () => { resolve(); };
    }catch(e){ resolve(); }
  });
}

let _lsQuotaWarnedMs = 0;

function saveState(opts = {}){
  STATE.updatedAtMs = Date.now();
  const snapshot = JSON.stringify(STATE);
  saveStateSnapshotToIDB(JSON.parse(snapshot));
  // Save a compact version (no large binary data like invoice images) to localStorage
  // to avoid QuotaExceededError. Full state is always preserved in IndexedDB.
  const compact = JSON.stringify(stripLargeDataForSync_(JSON.parse(snapshot)));
  const savedToLocalStorage = safeLocalStorageSetItem(LS_KEY, compact, "State save");
  if(!savedToLocalStorage){
    const now = Date.now();
    if(now - _lsQuotaWarnedMs > LS_QUOTA_WARN_DEBOUNCE_MS){
      _lsQuotaWarnedMs = now;
      toast("Guardado local lleno: seguiré guardando una copia en respaldo 💾");
    }
  }

  if(opts.trackLocalTabUpdate !== false){
    markActiveTabLocalUpdated_();
  }
}

function loadSettings(){
  try{
    const raw = localStorage.getItem(SETTINGS_KEY);
    if(raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  }catch(e){ console.warn("Settings parse error", e); }
  return { ...DEFAULT_SETTINGS };
}
function saveSettings(){
  safeLocalStorageSetItem(SETTINGS_KEY, JSON.stringify(SETTINGS), "Settings save");
}

function loadSyncMeta(){
  try{
    const raw = localStorage.getItem(SYNC_META_KEY);
    if(raw && typeof raw === "string"){
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    }
  }catch(e){ console.warn("Sync meta parse error", e); }
  return {};
}

function saveSyncMeta(){
  try{
    safeLocalStorageSetItem(SYNC_META_KEY, JSON.stringify(SYNC_META), "Sync meta save");
  }catch(e){
    console.warn("Sync meta save error", e);
  }
  saveSyncMetaToIDB();
}

function ensureSyncMetaTab(tabId){
  if(!SYNC_META[tabId] || typeof SYNC_META[tabId] !== "object"){
    SYNC_META[tabId] = {
      lastLocalUpdatedAt: null,
      lastRemoteUpdatedAt: null,
      lastPushAt: null,
      lastPullAt: null,
      status: "idle"
    };
  }
  return SYNC_META[tabId];
}

function markTabLocalUpdated_(tabId, iso = nowISO()){
  if(!tabId || !SYNC_META || typeof SYNC_META !== "object") return;
  const meta = ensureSyncMetaTab(tabId);
  const currentTs = Date.parse(meta.lastLocalUpdatedAt || "") || 0;
  const nextTs = Date.parse(iso || "") || Date.now();
  if(nextTs >= currentTs){
    meta.lastLocalUpdatedAt = iso || nowISO();
  }
  if(meta.status !== "syncing"){
    meta.status = "pending";
  }
  saveSyncMeta();
}

function markActiveTabLocalUpdated_(){
  if(!STATE || typeof STATE !== "object") return;
  const tabId = getTabIdFromActiveTab(STATE.activeTab);
  markTabLocalUpdated_(tabId);
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
  st.nextSteps = Array.isArray(st.nextSteps) ? st.nextSteps : [];
  st.ideas = Array.isArray(st.ideas) ? st.ideas : [];
  st.eventQueue = Array.isArray(st.eventQueue) ? st.eventQueue : [];
  st.planWeekId = st.planWeekId || null;
  st.calMonth = isValidMonthKey(st.calMonth) ? st.calMonth : monthKey();
  st.updatedAtMs = Number(st.updatedAtMs || Date.now());

  st.contentTodo = st.contentTodo || {};
  st.contentTodo.activeDate = st.contentTodo.activeDate || todayKey();
  st.contentTodo.days = st.contentTodo.days && typeof st.contentTodo.days === "object" ? st.contentTodo.days : {};
  st.contentTodo.historyOrder = Array.isArray(st.contentTodo.historyOrder) ? st.contentTodo.historyOrder : [];

  st.activeTab = APP_TABS.includes(st.activeTab) ? st.activeTab : "plan";
  st.financeRange = ["1M","3M","6M","1Y"].includes(st.financeRange) ? st.financeRange : "1M";
  st.subscriptions = st.subscriptions || {};
  st.subscriptions.viewYear = Number(st.subscriptions.viewYear || new Date().getFullYear());
  st.subscriptions.viewMonth = Number(st.subscriptions.viewMonth || (new Date().getMonth()+1));
  st.subscriptions.entries = Array.isArray(st.subscriptions.entries) ? st.subscriptions.entries : [];
  for(const sub of st.subscriptions.entries){
    if(!sub.id) sub.id = uid("sub");
    sub.type = sub.type || "oneToOne";
    sub.paymentDate = sub.paymentDate || todayKey();
    sub.name = (sub.name || "").trim();
    sub.costSoles = amountNum(sub.costSoles);
    sub.costDolares = amountNum(sub.costDolares);
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
    sess.costSoles = amountNum(sess.costSoles);
    sess.costDolares = amountNum(sess.costDolares);
    sess.invoiceImage = sess.invoiceImage || "";
    sess.invoiceImageName = sess.invoiceImageName || "";
  }

  st.questionReadings = st.questionReadings || {};
  st.questionReadings.viewYear = Number(st.questionReadings.viewYear || new Date().getFullYear());
  st.questionReadings.viewMonth = Number(st.questionReadings.viewMonth || (new Date().getMonth()+1));
  st.questionReadings.entries = Array.isArray(st.questionReadings.entries) ? st.questionReadings.entries : [];
  for(const reading of st.questionReadings.entries){
    if(!reading.id) reading.id = uid("qr");
    reading.date = reading.date || todayKey();
    reading.consultant = (reading.consultant || "").trim();
    reading.birthDate = reading.birthDate || "";
    reading.questionsCount = Number(reading.questionsCount || 0) || 0;
    const legacyCost = amountNum(reading.cost);
    reading.costSoles = amountNum(reading.costSoles ?? legacyCost);
    reading.costDolares = amountNum(reading.costDolares);
    reading.cost = reading.costSoles;
    reading.notes = reading.notes || "";
    reading.invoiceImage = reading.invoiceImage || "";
    reading.invoiceImageName = reading.invoiceImageName || "";
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
    if(!c.birthTime) c.birthTime = c.birthTime || "";
    if(!c.birthPlace) c.birthPlace = c.birthPlace || "";
    if(!c.residencePlace) c.residencePlace = c.residencePlace || "";
    if(!c.phone) c.phone = c.phone || "";
    if(!c.zodiac) c.zodiac = c.zodiac || "";   // opcional (si no, se puede calcular)
    c.paidSolesManual = amountNum(c.paidSolesManual);
    c.paidDolaresManual = amountNum(c.paidDolaresManual);
    c.sessionInsights = Array.isArray(c.sessionInsights) ? c.sessionInsights : [];
  }


  for(const step of st.nextSteps){
    if(!step.id) step.id = uid("nstep");
    step.clientId = step.clientId || "";
    step.clientName = (step.clientName || "").trim();
    step.kind = step.kind || "seguimiento";
    step.nextStep = (step.nextStep || "").trim();
    step.notes = (step.notes || "").trim();
    step.createdAt = step.createdAt || nowISO();
  }

  // Back-compat: bookings + reminders
  for(const b of st.bookings){
    if(!b.type) b.type = "tarot";
    if(!b.status) b.status = "scheduled";
    if(!b.startAt) b.startAt = nowISO();
    if(!b.durationMin) b.durationMin = 60;
    if(typeof b.amount !== "number") b.amount = Number(b.amount || 0) || 0;
    if(typeof b.amountUsd !== "number") b.amountUsd = Number(b.amountUsd || 0) || 0;
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

  // Gamify levels state
  if(!st.gamify){
    st.gamify = { monthKey: monthKey(), history: [] };
  } else {
    if(!st.gamify.monthKey) st.gamify.monthKey = monthKey();
    if(!Array.isArray(st.gamify.history)) st.gamify.history = [];
    if(st.gamify.history.length > 12) st.gamify.history = st.gamify.history.slice(-12);
  }

  return st;
}

// ---------- Gamify: income-based levels ----------
const LEVEL_THRESHOLDS = [
  { level: 1,  xp: 0 },
  { level: 2,  xp: 200 },
  { level: 3,  xp: 400 },
  { level: 4,  xp: 600 },
  { level: 5,  xp: 800 },
  { level: 6,  xp: 1000 },
  { level: 7,  xp: 1200 },
  { level: 8,  xp: 1400 },
  { level: 9,  xp: 1600 },
  { level: 10, xp: 1800 },
  { level: 11, xp: 3000 }
];

function getExchangeRate(){
  return Number(SETTINGS.exchangeRate) > 0 ? Number(SETTINGS.exchangeRate) : 3.75;
}

function calcMonthlyIncomeSoles(){
  const mk = monthKey();
  const rate = getExchangeRate();
  const entries = buildFinanceEntries ? buildFinanceEntries() : [];
  return entries
    .filter(e => (e.date || "").startsWith(mk))
    .reduce((sum, e) => sum + (e.soles || 0) + (e.dolares || 0) * rate, 0);
}

function calcLevelFromSoles(soles){
  let level = 1;
  for(let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--){
    if(soles >= LEVEL_THRESHOLDS[i].xp){ level = LEVEL_THRESHOLDS[i].level; break; }
  }
  return level;
}

function getLevelProgress(){
  const soles = calcMonthlyIncomeSoles();
  const level = calcLevelFromSoles(soles);
  const maxThreshold = LEVEL_THRESHOLDS[LEVEL_THRESHOLDS.length - 1].xp;
  if(level >= 11){
    return { level: 11, soles, nextXP: maxThreshold, progressPercent: 100, solesLeft: 0, isMax: true };
  }
  const currentThreshold = LEVEL_THRESHOLDS[level - 1].xp;
  const nextThreshold = LEVEL_THRESHOLDS[level].xp;
  const progressPercent = Math.min(100, Math.floor(((soles - currentThreshold) / (nextThreshold - currentThreshold)) * 100));
  return { level, soles, nextXP: nextThreshold, progressPercent, solesLeft: nextThreshold - soles, isMax: false };
}

function getSunflowerSVG(level){
  // Each level is a stage of a sunflower's growth, rendered as SVG
  const svgs = {
    // Nivel 1: Semilla bajo tierra
    1: `<svg viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="26" cy="36" rx="14" ry="8" fill="#5c3d1e" opacity="0.5"/>
      <ellipse cx="26" cy="36" rx="7" ry="4.5" fill="#8B6040"/>
      <ellipse cx="24" cy="35" rx="2.5" ry="3.5" fill="#6B4A2A" transform="rotate(-10 24 35)"/>
      <line x1="26" y1="32" x2="26" y2="26" stroke="#6B9E3A" stroke-width="2" stroke-linecap="round"/>
      <path d="M26 26 Q22 22 23 18" stroke="#6B9E3A" stroke-width="1.5" stroke-linecap="round" fill="none"/>
    </svg>`,
    // Nivel 2: Brote asomando
    2: `<svg viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="26" y1="44" x2="26" y2="24" stroke="#5a8a2a" stroke-width="2.5" stroke-linecap="round"/>
      <ellipse cx="26" cy="44" rx="10" ry="5" fill="#5c3d1e" opacity="0.4"/>
      <path d="M26 30 Q20 26 21 20 Q26 23 26 30Z" fill="#7ab83a"/>
      <path d="M26 30 Q32 26 31 20 Q26 23 26 30Z" fill="#6aa82a"/>
      <circle cx="26" cy="20" r="3" fill="#8dc63f"/>
    </svg>`,
    // Nivel 3: Tallo con hojitas
    3: `<svg viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="26" y1="46" x2="26" y2="18" stroke="#5a8a2a" stroke-width="3" stroke-linecap="round"/>
      <path d="M26 38 Q18 33 17 26 Q24 29 26 38Z" fill="#7ab83a"/>
      <path d="M26 32 Q34 27 35 20 Q28 23 26 32Z" fill="#6aa82a"/>
      <path d="M26 18 Q22 13 23 8 Q28 12 26 18Z" fill="#8dc63f"/>
      <path d="M26 18 Q30 13 29 8 Q24 12 26 18Z" fill="#7ab83a"/>
      <circle cx="26" cy="16" r="3.5" fill="#a0c840"/>
    </svg>`,
    // Nivel 4: Capullo verde cerrado
    4: `<svg viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="26" y1="48" x2="26" y2="24" stroke="#5a8a2a" stroke-width="3" stroke-linecap="round"/>
      <path d="M26 38 Q16 33 15 24 Q23 27 26 38Z" fill="#7ab83a"/>
      <path d="M26 34 Q36 29 37 20 Q29 23 26 34Z" fill="#6aa82a"/>
      <ellipse cx="26" cy="18" rx="7" ry="9" fill="#4a7a20"/>
      <ellipse cx="26" cy="17" rx="5" ry="7" fill="#5a9a28"/>
      <ellipse cx="25" cy="15" rx="2.5" ry="4" fill="#6ab030" transform="rotate(-5 25 15)"/>
    </svg>`,
    // Nivel 5: Capullo amarillo abriendo
    5: `<svg viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="26" y1="48" x2="26" y2="22" stroke="#5a8a2a" stroke-width="3" stroke-linecap="round"/>
      <path d="M26 36 Q15 31 14 22 Q23 25 26 36Z" fill="#7ab83a"/>
      <path d="M26 32 Q37 27 38 18 Q29 21 26 32Z" fill="#6aa82a"/>
      <ellipse cx="26" cy="16" rx="8" ry="8" fill="#4a7a20"/>
      <path d="M26 8 Q19 12 20 18 Q26 14 26 8Z" fill="#f0c020" opacity="0.9"/>
      <path d="M26 8 Q33 12 32 18 Q26 14 26 8Z" fill="#e8b818" opacity="0.9"/>
      <path d="M18 14 Q16 21 22 22 Q21 16 18 14Z" fill="#f0c020" opacity="0.7"/>
      <path d="M34 14 Q36 21 30 22 Q31 16 34 14Z" fill="#e8b818" opacity="0.7"/>
      <circle cx="26" cy="17" r="5" fill="#5c3d1e"/>
    </svg>`,
    // Nivel 6: Girasol pequeño abierto
    6: `<svg viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="26" y1="50" x2="26" y2="28" stroke="#5a8a2a" stroke-width="3" stroke-linecap="round"/>
      <path d="M26 40 Q14 34 13 24 Q23 28 26 40Z" fill="#7ab83a"/>
      <path d="M26 36 Q38 30 39 20 Q29 24 26 36Z" fill="#6aa82a"/>
      ${[0,45,90,135,180,225,270,315].map(a=>`<ellipse cx="${26+Math.cos(a*Math.PI/180)*10}" cy="${18+Math.sin(a*Math.PI/180)*10}" rx="4" ry="6.5" fill="#f6c000" transform="rotate(${a} ${26+Math.cos(a*Math.PI/180)*10} ${18+Math.sin(a*Math.PI/180)*10})"/>`).join("")}
      <circle cx="26" cy="18" r="7" fill="#5c3d1e"/>
      <circle cx="24" cy="16" r="1.2" fill="#3a2010" opacity="0.6"/>
      <circle cx="27" cy="16" r="1.2" fill="#3a2010" opacity="0.6"/>
      <circle cx="25.5" cy="19" r="1.2" fill="#3a2010" opacity="0.6"/>
    </svg>`,
    // Nivel 7: Girasol mediano
    7: `<svg viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="26" y1="50" x2="26" y2="26" stroke="#4a7a20" stroke-width="3.5" stroke-linecap="round"/>
      <path d="M26 40 Q12 33 11 22 Q23 27 26 40Z" fill="#7ab83a"/>
      <path d="M26 36 Q40 29 41 18 Q29 23 26 36Z" fill="#6aa82a"/>
      ${[0,30,60,90,120,150,180,210,240,270,300,330].map(a=>`<ellipse cx="${26+Math.cos(a*Math.PI/180)*11}" cy="${19+Math.sin(a*Math.PI/180)*11}" rx="3.5" ry="6" fill="${a%60===0?'#f6c000':'#e8b000'}" transform="rotate(${a} ${26+Math.cos(a*Math.PI/180)*11} ${19+Math.sin(a*Math.PI/180)*11})"/>`).join("")}
      <circle cx="26" cy="19" r="8" fill="#4a2e10"/>
      <circle cx="23" cy="17" r="1.3" fill="#2a1a08" opacity="0.7"/>
      <circle cx="27" cy="17" r="1.3" fill="#2a1a08" opacity="0.7"/>
      <circle cx="25" cy="20" r="1.3" fill="#2a1a08" opacity="0.7"/>
      <circle cx="29" cy="20" r="1.1" fill="#2a1a08" opacity="0.6"/>
    </svg>`,
    // Nivel 8: Girasol grande
    8: `<svg viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="26" y1="52" x2="26" y2="24" stroke="#3d6b18" stroke-width="4" stroke-linecap="round"/>
      <path d="M26 42 Q10 34 9 20 Q23 26 26 42Z" fill="#6aab30"/>
      <path d="M26 38 Q42 30 43 16 Q29 22 26 38Z" fill="#5a9a28"/>
      ${[0,22,45,68,90,112,135,158,180,202,225,248,270,292,315,338].map(a=>`<ellipse cx="${26+Math.cos(a*Math.PI/180)*12}" cy="${18+Math.sin(a*Math.PI/180)*12}" rx="3" ry="6.5" fill="${a%45===0?'#f8c800':'#f0b800'}" transform="rotate(${a} ${26+Math.cos(a*Math.PI/180)*12} ${18+Math.sin(a*Math.PI/180)*12})"/>`).join("")}
      <circle cx="26" cy="18" r="9" fill="#3d2008"/>
      <circle cx="22" cy="16" r="1.4" fill="#1e1004" opacity="0.8"/>
      <circle cx="26" cy="15" r="1.4" fill="#1e1004" opacity="0.8"/>
      <circle cx="30" cy="16" r="1.4" fill="#1e1004" opacity="0.8"/>
      <circle cx="24" cy="20" r="1.4" fill="#1e1004" opacity="0.8"/>
      <circle cx="28" cy="20" r="1.4" fill="#1e1004" opacity="0.8"/>
    </svg>`,
    // Nivel 9: Girasol radiante
    9: `<svg viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="26" cy="16" r="16" fill="rgba(248,200,0,0.12)"/>
      <line x1="26" y1="52" x2="26" y2="22" stroke="#3d6b18" stroke-width="4" stroke-linecap="round"/>
      <path d="M26 42 Q9 33 8 18 Q23 25 26 42Z" fill="#6aab30"/>
      <path d="M26 38 Q43 29 44 14 Q29 21 26 38Z" fill="#5a9a28"/>
      ${[0,20,40,60,80,100,120,140,160,180,200,220,240,260,280,300,320,340].map(a=>`<ellipse cx="${26+Math.cos(a*Math.PI/180)*13}" cy="${16+Math.sin(a*Math.PI/180)*13}" rx="3" ry="7" fill="${a%40===0?'#fad000':'#f2b800'}" transform="rotate(${a} ${26+Math.cos(a*Math.PI/180)*13} ${16+Math.sin(a*Math.PI/180)*13})"/>`).join("")}
      <circle cx="26" cy="16" r="8.5" fill="#3d2008"/>
      <circle cx="22" cy="13" r="1.5" fill="#1e1004" opacity="0.9"/>
      <circle cx="26" cy="13" r="1.5" fill="#1e1004" opacity="0.9"/>
      <circle cx="30" cy="13" r="1.5" fill="#1e1004" opacity="0.9"/>
      <circle cx="23" cy="17" r="1.5" fill="#1e1004" opacity="0.9"/>
      <circle cx="27" cy="17" r="1.5" fill="#1e1004" opacity="0.9"/>
      <circle cx="31" cy="17" r="1.5" fill="#1e1004" opacity="0.9"/>
    </svg>`,
    // Nivel 10: Girasol glorioso con destellos
    10: `<svg viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="26" cy="15" r="18" fill="rgba(255,210,0,0.15)"/>
      <circle cx="26" cy="15" r="13" fill="rgba(255,220,0,0.1)"/>
      <line x1="26" y1="52" x2="26" y2="22" stroke="#3d6b18" stroke-width="4.5" stroke-linecap="round"/>
      <path d="M26 42 Q8 32 7 16 Q23 24 26 42Z" fill="#6aab30"/>
      <path d="M26 38 Q44 28 45 12 Q29 20 26 38Z" fill="#5a9a28"/>
      ${[0,18,36,54,72,90,108,126,144,162,180,198,216,234,252,270,288,306,324,342].map(a=>`<ellipse cx="${26+Math.cos(a*Math.PI/180)*13.5}" cy="${15+Math.sin(a*Math.PI/180)*13.5}" rx="2.8" ry="7.5" fill="${a%36===0?'#ffe000':'#f8c800'}" transform="rotate(${a} ${26+Math.cos(a*Math.PI/180)*13.5} ${15+Math.sin(a*Math.PI/180)*13.5})"/>`).join("")}
      <circle cx="26" cy="15" r="9" fill="#3d2008"/>
      <circle cx="22" cy="12" r="1.5" fill="#1a0e04" opacity="0.9"/>
      <circle cx="26" cy="12" r="1.5" fill="#1a0e04" opacity="0.9"/>
      <circle cx="30" cy="12" r="1.5" fill="#1a0e04" opacity="0.9"/>
      <circle cx="23" cy="16" r="1.5" fill="#1a0e04" opacity="0.9"/>
      <circle cx="27" cy="16" r="1.5" fill="#1a0e04" opacity="0.9"/>
      <circle cx="31" cy="16" r="1.5" fill="#1a0e04" opacity="0.9"/>
      <circle cx="25" cy="19" r="1.3" fill="#1a0e04" opacity="0.8"/>
      <circle cx="29" cy="19" r="1.3" fill="#1a0e04" opacity="0.8"/>
      <line x1="6" y1="4" x2="8" y2="7" stroke="#ffe000" stroke-width="1.5" stroke-linecap="round" opacity="0.8"/>
      <line x1="46" y1="4" x2="44" y2="7" stroke="#ffe000" stroke-width="1.5" stroke-linecap="round" opacity="0.8"/>
      <line x1="4" y1="15" x2="7" y2="15" stroke="#ffe000" stroke-width="1.5" stroke-linecap="round" opacity="0.7"/>
      <line x1="48" y1="15" x2="45" y2="15" stroke="#ffe000" stroke-width="1.5" stroke-linecap="round" opacity="0.7"/>
    </svg>`,
    // Nivel 11: Girasol resplandeciente máximo con rayos de luz
    11: `<svg viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="26" cy="14" r="20" fill="rgba(255,220,0,0.2)"/>
      <circle cx="26" cy="14" r="15" fill="rgba(255,230,0,0.15)"/>
      <circle cx="26" cy="14" r="10" fill="rgba(255,240,0,0.1)"/>
      ${[0,45,90,135,180,225,270,315].map(a=>`<line x1="${26+Math.cos(a*Math.PI/180)*16}" y1="${14+Math.sin(a*Math.PI/180)*16}" x2="${26+Math.cos(a*Math.PI/180)*22}" y2="${14+Math.sin(a*Math.PI/180)*22}" stroke="#ffe000" stroke-width="1.8" stroke-linecap="round" opacity="0.6"/>`).join("")}
      <line x1="26" y1="50" x2="26" y2="22" stroke="#3d6b18" stroke-width="4.5" stroke-linecap="round"/>
      <path d="M26 42 Q7 31 6 14 Q23 23 26 42Z" fill="#6aab30"/>
      <path d="M26 38 Q45 27 46 10 Q29 19 26 38Z" fill="#5a9a28"/>
      ${[0,16,32,48,64,80,96,112,128,144,160,176,192,208,224,240,256,272,288,304,320,336].map(a=>`<ellipse cx="${26+Math.cos(a*Math.PI/180)*14}" cy="${14+Math.sin(a*Math.PI/180)*14}" rx="2.8" ry="8" fill="${a%32===0?'#ffe800':'#ffd000'}" transform="rotate(${a} ${26+Math.cos(a*Math.PI/180)*14} ${14+Math.sin(a*Math.PI/180)*14})" opacity="0.97"/>`).join("")}
      <circle cx="26" cy="14" r="9.5" fill="#3d2008"/>
      <circle cx="22" cy="11" r="1.6" fill="#1a0e04" opacity="0.95"/>
      <circle cx="26" cy="11" r="1.6" fill="#1a0e04" opacity="0.95"/>
      <circle cx="30" cy="11" r="1.6" fill="#1a0e04" opacity="0.95"/>
      <circle cx="23" cy="15" r="1.6" fill="#1a0e04" opacity="0.95"/>
      <circle cx="27" cy="15" r="1.6" fill="#1a0e04" opacity="0.95"/>
      <circle cx="31" cy="15" r="1.6" fill="#1a0e04" opacity="0.95"/>
      <circle cx="24" cy="19" r="1.4" fill="#1a0e04" opacity="0.9"/>
      <circle cx="28" cy="19" r="1.4" fill="#1a0e04" opacity="0.9"/>
      <circle cx="5" cy="3" r="1.2" fill="#ffe000" opacity="0.9"/>
      <circle cx="47" cy="3" r="1.2" fill="#ffe000" opacity="0.9"/>
      <circle cx="3" cy="14" r="1" fill="#ffe000" opacity="0.8"/>
      <circle cx="49" cy="14" r="1" fill="#ffe000" opacity="0.8"/>
      <circle cx="8" cy="26" r="0.9" fill="#ffe000" opacity="0.7"/>
      <circle cx="44" cy="26" r="0.9" fill="#ffe000" opacity="0.7"/>
    </svg>`
  };
  return svgs[level] || svgs[1];
}

function renderLevelDisplay(){
  const el = document.getElementById("heroLevelDisplay");
  if(!el) return;
  const p = getLevelProgress();
  const birthdays = getTodayBirthdays();
  const levelNames = [
    "","Semilla","Germinando","Primer brote","Creciendo","Casi flor",
    "Abriendo","Girasol joven","Floreciendo","Radiante","Gloriosa","¡Girasol de luz! ✨"
  ];
  const name = levelNames[p.level] || `Nivel ${p.level}`;
  const svg = getSunflowerSVG(p.level);
  const isMax = p.isMax;

  const birthdayRows = birthdays.length
    ? birthdays.map((c) => {
        const safeName = escapeHtml(c.name || c.handle || "Cliente");
        const handle = c.handle ? ` <span class="birthdayHandle">@${escapeHtml(String(c.handle).replace(/^@/, ""))}</span>` : "";
        const zodiac = c.zodiac || (c.dob ? zodiacFromDob(c.dob) : "");
        const zodiacPill = zodiac ? `<span class="pill birthdayZodiac">♈ ${escapeHtml(zodiac)}</span>` : "";
        return `<div class="birthdayRow">🎉 <strong>${safeName}</strong>${handle} ${zodiacPill}</div>`;
      }).join("")
    : `<div class="birthdayEmpty">No hay cumpleaños hoy.</div>`;

  el.innerHTML = `
    <div class="heroMetricStack">
      <div class="level-display${isMax ? " max-level" : ""}">
        <div class="level-svg-wrap${isMax ? " max-glow" : ""}">${svg}</div>
        <div class="level-info">
          <div class="level-header">
            <span class="level-badge-num">${p.level}</span>
            <span class="level-name">${name}</span>
          </div>
          ${isMax
            ? `<div class="level-soles">S/ ${p.soles.toFixed(0)} este mes ✨</div>
               <div class="level-max-text">¡Meta del mes alcanzada!</div>`
            : `<div class="level-progress-wrap">
                 <div class="level-progress-bar">
                   <div class="level-progress-fill" style="width:${p.progressPercent}%"></div>
                 </div>
                 <span class="level-progress-pct">${p.progressPercent}%</span>
               </div>
               <div class="level-soles">S/ ${p.soles.toFixed(0)} · Faltan S/ ${p.solesLeft.toFixed(0)} para nivel ${p.level + 1}</div>`
          }
        </div>
      </div>
      <div class="birthday-display">
        <div class="birthdayTitle">🎂 Cumpleaños de hoy</div>
        <div class="birthdayList">${birthdayRows}</div>
      </div>
    </div>`;
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
    amountUsd: Number(obj.amountUsd || 0) || 0,
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
  renderArchiveBookings();
  renderFinance();
}

function updateBooking(id, patch){
  const b = STATE.bookings.find(x => x.id === id);
  if(!b) return;
  Object.assign(b, patch);
  enqueueEvent("booking_update", { id, patch });
  saveState();
  renderCalendar();
  renderBookings();
  renderArchiveBookings();
  renderFinance();
}

function deleteBooking(id){
  STATE.bookings = STATE.bookings.filter(x => x.id !== id);
  enqueueEvent("booking_delete", { id });
  saveState();
  renderCalendar();
  renderBookings();
  renderArchiveBookings();
  renderFinance();
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
    category: opts.category || "mission", // mission | plan
    assignee: opts.assignee || "",        // fergis | carlos
    frequency: opts.frequency || "",       // dia | semana
    frequencyDay: opts.frequencyDay || ""  // lunes | martes | miércoles | jueves | viernes | sábado | domingo
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
    createdAt: opts.createdAt || nowISO(),
    assignee: opts.assignee || "",
    frequency: opts.frequency || "",
    frequencyDay: opts.frequencyDay || ""
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
  const targetTask = STATE.tasks.find(x => x.id === taskId);
  if(!targetTask || targetTask.category !== "plan") return;

  const planIndexes = [];
  for(let i=0;i<STATE.tasks.length;i++){
    const task = STATE.tasks[i];
    if(task.category === "plan" && (task.assignee || "") === (targetTask.assignee || "")) planIndexes.push(i);
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
    handle: String(obj.handle || "").trim().replace(/^@+/, ""),
    name: (obj.name || "").trim(),
    status: obj.status || "lead",
    nextStep: (obj.nextStep || "").trim(),
    lastContactAt: obj.lastContactAt || null,
    notes: (obj.notes || "").trim(),
    dob: obj.dob || "",
    birthTime: obj.birthTime || "",
    birthPlace: (obj.birthPlace || "").trim(),
    residencePlace: (obj.residencePlace || "").trim(),
    phone: (obj.phone || "").trim(),
    zodiac: obj.zodiac || "",
    paidSolesManual: amountNum(obj.paidSolesManual),
    paidDolaresManual: amountNum(obj.paidDolaresManual),
    sessionInsights: Array.isArray(obj.sessionInsights) ? obj.sessionInsights : [],
    createdAt: nowISO()
  };
  STATE.clients.unshift(c);
  enqueueEvent("client_add", c);
  saveState();
  renderClients();
  renderNextSteps();
  renderFinance();
  renderMetrics();
}
function updateClient(id, patch){
  const c = STATE.clients.find(x => x.id === id);
  if(!c) return;
  if("handle" in patch) patch.handle = String(patch.handle || "").trim().replace(/^@+/, "");
  Object.assign(c, patch);
  enqueueEvent("client_update", { id, patch });
  saveState();
  renderClients();
  renderNextSteps();
  renderFinance();
  renderMetrics();
}
function deleteClient(id){
  STATE.clients = STATE.clients.filter(x => x.id !== id);
  STATE.nextSteps = STATE.nextSteps.filter(x => x.clientId !== id);
  enqueueEvent("client_delete", { id });
  saveState();
  renderClients();
  renderNextSteps();
  renderFinance();
  renderMetrics();
}

function addNextStep(obj){
  const c = STATE.clients.find(x => x.id === obj.clientId);
  const row = {
    id: uid("nstep"),
    clientId: obj.clientId || "",
    clientName: c?.name || c?.handle || obj.clientName || "(sin cliente)",
    kind: obj.kind || "seguimiento",
    nextStep: (obj.nextStep || "").trim(),
    notes: (obj.notes || "").trim(),
    createdAt: nowISO()
  };
  STATE.nextSteps.unshift(row);
  enqueueEvent("next_step_add", row);
  saveState();
  renderNextSteps();
}
function updateNextStep(id, patch){
  const row = STATE.nextSteps.find(x => x.id === id);
  if(!row) return;
  if("clientId" in patch){
    const c = STATE.clients.find(x => x.id === patch.clientId);
    patch.clientName = c?.name || c?.handle || row.clientName;
  }
  Object.assign(row, patch);
  enqueueEvent("next_step_update", { id, patch });
  saveState();
  renderNextSteps();
}
function deleteNextStep(id){
  STATE.nextSteps = STATE.nextSteps.filter(x => x.id !== id);
  enqueueEvent("next_step_delete", { id });
  saveState();
  renderNextSteps();
}

function addIdea(obj){
  const i = {
    id: uid("idea"),
    title: (obj.title || "").trim(),
    kind: obj.kind || "idea", // idea | post | story | thread | investigacion
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
  await pushCurrentTabToSheet();
}

function buildAppsScriptUrl_(params={}){
  const base = String(SETTINGS.appsScriptUrl || "").trim();
  if(!base) return "";
  const url = new URL(base, window.location.href);
  Object.entries(params || {}).forEach(([k,v]) => {
    if(v == null || v === "") return;
    url.searchParams.set(k, String(v));
  });
  return url.toString();
}

function loadJsonp_(url, timeoutMs=15000){
  return new Promise((resolve, reject) => {
    const cbName = `faJsonp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    let settled = false;

    const cleanup = () => {
      try{ delete window[cbName]; }catch(_e){ window[cbName] = undefined; }
      script.remove();
    };

    const timer = window.setTimeout(() => {
      if(settled) return;
      settled = true;
      cleanup();
      reject(new Error("Tiempo de espera agotado al leer desde Google Sheets"));
    }, timeoutMs);

    window[cbName] = (data) => {
      if(settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(data);
    };

    script.onerror = () => {
      if(settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error("No pude cargar el export desde Apps Script"));
    };

    script.src = `${url}${url.includes("?") ? "&" : "?"}callback=${encodeURIComponent(cbName)}`;
    document.head.appendChild(script);
  });
}

function stripLargeDataForSync_(value, depth=0){
  if(depth > 12) return null;
  if(value == null) return value;
  if(typeof value === "string"){
    const looksBinary = value.startsWith("data:") || value.length > 12000;
    return looksBinary ? "" : value;
  }
  if(Array.isArray(value)) return value.map(v => stripLargeDataForSync_(v, depth+1));
  if(typeof value === "object"){
    const out = {};
    for(const [k,v] of Object.entries(value)){
      if(k === "eventQueue") continue;
      out[k] = stripLargeDataForSync_(v, depth+1);
    }
    return out;
  }
  return value;
}

function buildStateSnapshotPayload_(){
  const base = normalizeState_(JSON.parse(JSON.stringify(STATE || {})));
  const snapshot = {
    v: base.v || "0.1",
    createdAt: base.createdAt || nowISO(),
    updatedAtMs: Date.now(),
    activeTab: base.activeTab || "plan",
    planWeekId: base.planWeekId || null,
    calMonth: base.calMonth || monthKey(),
    financeRange: base.financeRange || "1M",
    tasks: base.tasks || [],
    sessions: base.sessions || [],
    bookings: base.bookings || [],
    reminders: base.reminders || [],
    clients: base.clients || [],
    nextSteps: base.nextSteps || [],
    ideas: base.ideas || [],
    contentTodo: base.contentTodo || { activeDate: todayKey(), days: {}, historyOrder: [] },
    subscriptions: base.subscriptions || { viewYear: new Date().getFullYear(), viewMonth: new Date().getMonth()+1, entries: [] },
    oneToOneSessions: base.oneToOneSessions || { viewYear: new Date().getFullYear(), viewMonth: new Date().getMonth()+1, entries: [] },
    questionReadings: base.questionReadings || { viewYear: new Date().getFullYear(), viewMonth: new Date().getMonth()+1, entries: [] }
  };
  return stripLargeDataForSync_(snapshot);
}

function applySheetStateSnapshot_(sheetState){
  const incoming = normalizeState_(sheetState || {});
  const nextState = normalizeState_({
    ...STATE,
    v: incoming.v || STATE.v,
    createdAt: incoming.createdAt || STATE.createdAt,
    tasks: Array.isArray(incoming.tasks) ? incoming.tasks : STATE.tasks,
    sessions: Array.isArray(incoming.sessions) ? incoming.sessions : STATE.sessions,
    clients: Array.isArray(incoming.clients) ? incoming.clients : STATE.clients,
    nextSteps: Array.isArray(incoming.nextSteps) ? incoming.nextSteps : STATE.nextSteps,
    ideas: Array.isArray(incoming.ideas) ? incoming.ideas : STATE.ideas,
    reminders: Array.isArray(incoming.reminders) ? incoming.reminders : STATE.reminders,
    bookings: Array.isArray(incoming.bookings) ? incoming.bookings : STATE.bookings,
    contentTodo: incoming.contentTodo || STATE.contentTodo,
    activeTab: incoming.activeTab || STATE.activeTab,
    planWeekId: incoming.planWeekId ?? STATE.planWeekId,
    calMonth: incoming.calMonth || STATE.calMonth,
    financeRange: incoming.financeRange || STATE.financeRange,
    subscriptions: incoming.subscriptions || STATE.subscriptions,
    oneToOneSessions: incoming.oneToOneSessions || STATE.oneToOneSessions,
    questionReadings: incoming.questionReadings || STATE.questionReadings,
    eventQueue: Array.isArray(STATE.eventQueue) ? STATE.eventQueue : [],
    updatedAtMs: Math.max(Number(incoming.updatedAtMs || 0), Date.now())
  });

  STATE = nextState;
  saveState({ trackLocalTabUpdate: false });
  render();
}

async function syncFromSheet(){
  await pullCurrentTabFromSheet();
}


function sanitizeTabPayload(tabId, data){
  return stripLargeDataForSync_(data || TAB_SYNC_DEFAULTS[tabId] || {});
}

function getTabIdFromActiveTab(activeTab){
  return TAB_SYNC_IDS[activeTab] || "plan_girasol";
}

function getTabSyncPayload(tabId, state){
  const st = normalizeState_(JSON.parse(JSON.stringify(state || {})));
  const updatedAt = nowISO();
  let data = {};
  if(tabId === "plan_girasol") data = { tasks: st.tasks || [], planWeekId: st.planWeekId || null };
  else if(tabId === "contenido_hoy") data = { contentTodo: st.contentTodo || TAB_SYNC_DEFAULTS[tabId].contentTodo, reminders: st.reminders || [] };
  else if(tabId === "ideas_investigacion") data = { ideas: st.ideas || [] };
  else if(tabId === "clientes_calendario") data = { clients: st.clients || [], nextSteps: st.nextSteps || [], bookings: st.bookings || [], calMonth: st.calMonth || monthKey() };
  else if(tabId === "sesiones_1_1") data = { oneToOneSessions: st.oneToOneSessions || TAB_SYNC_DEFAULTS[tabId].oneToOneSessions };
  else if(tabId === "suscripcion_diosa_guia") data = { subscriptions: st.subscriptions || TAB_SYNC_DEFAULTS[tabId].subscriptions };
  else if(tabId === "lecturas_preguntas") data = { questionReadings: st.questionReadings || TAB_SYNC_DEFAULTS[tabId].questionReadings };
  else if(tabId === "finanzas") data = { financeRange: st.financeRange || "1M" };
  else if(tabId === "archivo") data = { sessions: st.sessions || [] };
  else data = TAB_SYNC_DEFAULTS[tabId] || {};
  return { tabId, updatedAt, data: sanitizeTabPayload(tabId, data) };
}

function applyTabSyncPayload(tabId, payload, state){
  const st = normalizeState_(JSON.parse(JSON.stringify(state || {})));
  const incoming = payload?.data || TAB_SYNC_DEFAULTS[tabId] || {};
  if(tabId === "plan_girasol"){
    st.tasks = Array.isArray(incoming.tasks) ? incoming.tasks : st.tasks;
    st.planWeekId = incoming.planWeekId ?? st.planWeekId;
  }else if(tabId === "contenido_hoy"){
    st.contentTodo = incoming.contentTodo || st.contentTodo;
    st.reminders = Array.isArray(incoming.reminders) ? incoming.reminders : st.reminders;
  }else if(tabId === "ideas_investigacion"){
    st.ideas = Array.isArray(incoming.ideas) ? incoming.ideas : st.ideas;
  }else if(tabId === "clientes_calendario"){
    st.clients = Array.isArray(incoming.clients) ? incoming.clients : st.clients;
    st.nextSteps = Array.isArray(incoming.nextSteps) ? incoming.nextSteps : st.nextSteps;
    st.bookings = Array.isArray(incoming.bookings) ? incoming.bookings : st.bookings;
    st.calMonth = incoming.calMonth || st.calMonth;
  }else if(tabId === "sesiones_1_1"){
    st.oneToOneSessions = incoming.oneToOneSessions || st.oneToOneSessions;
  }else if(tabId === "suscripcion_diosa_guia"){
    st.subscriptions = incoming.subscriptions || st.subscriptions;
  }else if(tabId === "lecturas_preguntas"){
    st.questionReadings = incoming.questionReadings || st.questionReadings;
  }else if(tabId === "finanzas"){
    st.financeRange = incoming.financeRange || st.financeRange;
  }else if(tabId === "archivo"){
    st.sessions = Array.isArray(incoming.sessions) ? incoming.sessions : st.sessions;
  }
  st.updatedAtMs = Date.now();
  return normalizeState_(st);
}

function getAllTabSyncPayloads(state){
  return Object.values(TAB_SYNC_IDS).map((tabId) => getTabSyncPayload(tabId, state));
}

function mergeRemoteTabIntoState(tabId, remotePayload, currentState){
  const meta = ensureSyncMetaTab(tabId);
  const localUpdatedAt = Date.parse(meta.lastLocalUpdatedAt || "") || 0;
  const remoteUpdatedAt = Date.parse(remotePayload?.updatedAt || "") || 0;

  if(remoteUpdatedAt > localUpdatedAt){
    console.info(`[SheetSync] pullTab applied remote tab: ${tabId}`);
    meta.status = "synced";
    meta.lastLocalUpdatedAt = remotePayload.updatedAt || nowISO();
    meta.lastRemoteUpdatedAt = remotePayload.updatedAt || nowISO();
    meta.lastPullAt = nowISO();
    saveSyncMeta();
    return applyTabSyncPayload(tabId, remotePayload, currentState);
  }

  if(localUpdatedAt > remoteUpdatedAt){
    meta.status = "conflict";
    meta.lastRemoteUpdatedAt = remotePayload?.updatedAt || meta.lastRemoteUpdatedAt;
    meta.lastPullAt = nowISO();
    saveSyncMeta();
    console.warn(`[SheetSync] conflict detected on ${tabId}`);
    return currentState;
  }

  meta.status = "synced";
  meta.lastLocalUpdatedAt = remotePayload?.updatedAt || nowISO();
  meta.lastPullAt = nowISO();
  saveSyncMeta();
  return applyTabSyncPayload(tabId, remotePayload, currentState);
}

async function sheetSyncGet_(action, tabId=""){
  const url = buildAppsScriptUrl_({ action, tabId, app: "FergisAssistant", v: "1.0", apiKey: SETTINGS.apiKey || "" });
  const res = await loadJsonp_(url, 20000);
  if(!res || res.ok !== true) throw new Error(res?.error || "Respuesta inválida de Apps Script");
  return res;
}

async function sheetSyncPost_(body){
  const url = String(SETTINGS.appsScriptUrl || "").trim();
  let res;
  try{
    // NOTE: usamos text/plain para evitar preflight CORS en Apps Script Web Apps.
    // Apps Script sigue recibiendo el payload en e.postData.contents.
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body)
    });
  }catch(err){
    const reason = err?.message ? ` ${err.message}` : "";
    throw new Error(`No se pudo conectar con Apps Script. Revisa que la URL sea /exec y esté desplegada para "Anyone".${reason}`);
  }
  const text = await res.text();
  if(!text) return { ok: true };
  try{ return JSON.parse(text); }catch(_e){ return { ok: true, raw: text }; }
}

async function pushCurrentTabToSheet(){
  const tabId = getTabIdFromActiveTab(STATE.activeTab);
  const statusEl = $("#syncStatus");
  const meta = ensureSyncMetaTab(tabId);
  meta.status = "syncing";
  saveSyncMeta();
  statusEl.textContent = `Sync: enviando ${tabId}…`;
  const tab = getTabSyncPayload(tabId, STATE);
  await sheetSyncPost_({ app: "FergisAssistant", v: "1.0", action: "pushTab", deviceTs: nowISO(), tab });
  meta.lastLocalUpdatedAt = tab.updatedAt;
  meta.lastRemoteUpdatedAt = tab.updatedAt;
  meta.lastPushAt = nowISO();
  meta.status = "synced";
  saveSyncMeta();
  console.info(`[SheetSync] pushTab success: ${tabId}`);
  statusEl.textContent = `Sync: ${tabId} ✅`;
}

async function pullCurrentTabFromSheet(){
  const tabId = getTabIdFromActiveTab(STATE.activeTab);
  const statusEl = $("#syncStatus");
  const meta = ensureSyncMetaTab(tabId);
  meta.status = "syncing";
  saveSyncMeta();
  statusEl.textContent = `Sync: trayendo ${tabId}…`;
  const res = await sheetSyncGet_("pullTab", tabId);
  if(res?.tab){
    STATE = mergeRemoteTabIntoState(tabId, res.tab, STATE);
    saveState({ trackLocalTabUpdate: false });
    render();
    meta.lastRemoteUpdatedAt = res.tab.updatedAt || meta.lastRemoteUpdatedAt;
    meta.lastPullAt = nowISO();
    if(meta.status !== "conflict") meta.status = "synced";
    saveSyncMeta();
  }
  statusEl.textContent = `Sync: ${tabId} ↓`;
}

async function pushAllTabsToSheet(){
  const statusEl = $("#syncStatus");
  statusEl.textContent = "Sync: enviando todas…";
  const tabs = getAllTabSyncPayloads(STATE);
  await sheetSyncPost_({ app: "FergisAssistant", v: "1.0", action: "pushAll", deviceTs: nowISO(), tabs });
  const ts = nowISO();
  for(const tab of tabs){
    const meta = ensureSyncMetaTab(tab.tabId);
    meta.lastLocalUpdatedAt = tab.updatedAt;
    meta.lastRemoteUpdatedAt = tab.updatedAt;
    meta.lastPushAt = ts;
    meta.status = "synced";
    console.info(`[SheetSync] pushTab success: ${tab.tabId}`);
  }
  saveSyncMeta();
  statusEl.textContent = "Sync: todo enviado ✅";
}

async function pullAllTabsFromSheet(){
  const statusEl = $("#syncStatus");
  statusEl.textContent = "Sync: trayendo todas…";
  const res = await sheetSyncGet_("pullAll");
  let next = STATE;
  for(const tab of (res.tabs || [])){
    if(!tab?.tabId) continue;
    next = mergeRemoteTabIntoState(tab.tabId, tab, next);
  }
  STATE = normalizeState_(next);
  saveState({ trackLocalTabUpdate: false });
  render();
  console.info("[SheetSync] pullAll completed");
  statusEl.textContent = "Sync: pullAll ✅";
}

// ---------- UI ----------
STATE = normalizeState_(loadState());
let SETTINGS = loadSettings();
let SYNC_META = loadSyncMeta();

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
  renderArchiveBookings();
  renderReminders();
  renderClients();
  renderNextSteps();
  renderFinance();
  renderIdeas();
  renderMetrics();
  renderTabs();
  renderSubscriptions();
  renderOneToOneSessions();
  renderQuestionReadings();
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

    const totalS = byType.reduce((a,x)=>a + amountNum(x.costSoles), 0);
    const totalD = byType.reduce((a,x)=>a + amountNum(x.costDolares), 0);
    const headers = cols.map(n=>`<th>${type.key === "preguntas" ? "Pregunta" : "Sesión"} ${n}</th>`).join("");
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
    costSoles: amountNum(obj.costSoles),
    costDolares: amountNum(obj.costDolares),
    sessionsDone: [],
    observations: (obj.observations || "").trim(),
    invoiceImage: obj.invoiceImage || "",
    invoiceImageName: obj.invoiceImageName || "",
    createdAt: nowISO()
  };
  STATE.subscriptions.entries.unshift(entry);
  enqueueEvent("subscription_add", entry);
  saveState();
  renderSubscriptions();
  renderFinance();
}

function openSubscriptionModal(){
  const clientOptions = STATE.clients
    .map(c => ({ id: c.id, name: (c.name || c.handle || "").trim() }))
    .filter(c => c.name)
    .sort((a,b)=>a.name.localeCompare(b.name, "es", { sensitivity: "base" }));

  openModal(
    "Nuevo registro de suscripción",
    `<div class="row"><label class="label">Tipo</label><select id="mSubType" class="input">${SUBSCRIPTION_TYPES.map(t=>`<option value="${t.key}">${t.label}</option>`).join("")}</select></div>
    <div class="row"><label class="label">Fecha de pago</label><input id="mSubDate" type="date" class="input" value="${todayKey()}" /></div>
    <div class="row"><label class="label">Nombre</label>
      <select id="mSubName" class="input">
        <option value="">Selecciona cliente</option>
        ${clientOptions.map(c=>`<option value="${escapeAttr(c.id)}">${escapeHtml(c.name)}</option>`).join("")}
      </select>
    </div>
    <div class="row"><label class="label">Costo soles</label><input id="mSubSoles" type="number" class="input" min="0" step="0.01" /></div>
    <div class="row"><label class="label">Costo dólares</label><input id="mSubDol" type="number" class="input" min="0" step="0.01" /></div>
    <div class="row"><label class="label">Observaciones</label><input id="mSubObs" class="input" /></div>
    <div class="row"><label class="label">Factura (imagen)</label><input id="mSubInvoice" type="file" class="input" accept="image/*" /></div>`,
    `<button class="btn" id="mCancel">Cancelar</button><button class="btn primary" id="mSave">Guardar</button>`
  );
  $("#mCancel").onclick = closeModal;
  const subNameEl = $("#mSubName");
  $("#mSave").onclick = async () => {
    const file = $("#mSubInvoice")?.files?.[0];
    let invoiceImage = "";
    let invoiceImageName = "";
    if(file){
      const b64 = await new Promise((resolve,reject)=>{
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(file);
      }).catch(()=>null);
      if(!b64){ toast("No pude leer la imagen."); return; }
      invoiceImage = String(b64);
      invoiceImageName = file.name || "";
    }
    const selectedClient = STATE.clients.find(c => String(c.id) === String(subNameEl?.value || ""));
    const selectedClientName = (selectedClient?.name || selectedClient?.handle || "").trim();
    addSubscription({
      type: $("#mSubType").value,
      paymentDate: $("#mSubDate").value || todayKey(),
      name: selectedClientName,
      costSoles: $("#mSubSoles").value,
      costDolares: $("#mSubDol").value,
      observations: $("#mSubObs").value,
      invoiceImage,
      invoiceImageName
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

  const totalS = rows.reduce((a,x)=>a + amountNum(x.costSoles), 0);
  const totalD = rows.reduce((a,x)=>a + amountNum(x.costDolares), 0);

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
    costSoles: amountNum(obj.costSoles),
    costDolares: amountNum(obj.costDolares),
    invoiceImage: obj.invoiceImage || "",
    invoiceImageName: obj.invoiceImageName || "",
    createdAt: nowISO()
  };
  STATE.oneToOneSessions.entries.unshift(entry);
  enqueueEvent("session11_add", entry);
  saveState();
  renderOneToOneSessions();
  renderFinance();
}

function openOneToOneSessionModal(){
  const clientOptions = STATE.clients
    .map(c => ({ id: c.id, name: (c.name || c.handle || "").trim() }))
    .filter(c => c.name)
    .sort((a,b)=>a.name.localeCompare(b.name, "es", { sensitivity: "base" }));

  openModal(
    "Nueva sesión 1:1",
    `<div class="row"><label class="label">Fecha</label><input id="mS11Date" type="date" class="input" value="${todayKey()}" /></div>
    <div class="row"><label class="label">Consultante</label>
      <select id="mS11Consultant" class="input">
        <option value="">Selecciona cliente</option>
        ${clientOptions.map(c=>`<option value="${escapeAttr(c.id)}">${escapeHtml(c.name)}</option>`).join("")}
      </select>
    </div>
    <div class="row"><label class="label">Contacto</label><input id="mS11Contact" class="input" /></div>
    <div class="row"><label class="label">Fecha de nacimiento</label><input id="mS11BirthDate" type="date" class="input" /></div>
    <div class="row"><label class="label">Tipo de sesión</label><input id="mS11SessionType" class="input" placeholder="Escribe libremente" /></div>
    <div class="row"><label class="label">Modalidad</label><input id="mS11Modality" class="input" placeholder="Escribe libremente" /></div>
    <div class="row"><label class="label">Costo en soles</label><input id="mS11Soles" type="number" class="input" min="0" step="0.01" /></div>
    <div class="row"><label class="label">Costo en dólares</label><input id="mS11Dol" type="number" class="input" min="0" step="0.01" /></div>
    <div class="row"><label class="label">Factura (imagen)</label><input id="mS11Invoice" type="file" class="input" accept="image/*" /></div>`,
    `<button class="btn" id="mCancel">Cancelar</button><button class="btn primary" id="mSave">Guardar</button>`
  );
  $("#mCancel").onclick = closeModal;
  const s11ConsultantEl = $("#mS11Consultant");
  const s11ContactEl = $("#mS11Contact");
  const s11BirthDateEl = $("#mS11BirthDate");
  const syncOneToOneClientData = () => {
    const selected = STATE.clients.find(c => String(c.id) === String(s11ConsultantEl?.value || ""));
    if(!selected){
      s11ContactEl.value = "";
      s11BirthDateEl.value = "";
      return;
    }
    s11ContactEl.value = selected.phone || "";
    s11BirthDateEl.value = selected.dob || "";
  };
  s11ConsultantEl?.addEventListener("change", syncOneToOneClientData);
  $("#mSave").onclick = async () => {
    const file = $("#mS11Invoice")?.files?.[0];
    let invoiceImage = "";
    let invoiceImageName = "";
    if(file){
      const b64 = await new Promise((resolve,reject)=>{
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(file);
      }).catch(()=>null);
      if(!b64){ toast("No pude leer la imagen."); return; }
      invoiceImage = String(b64);
      invoiceImageName = file.name || "";
    }
    const selectedClient = STATE.clients.find(c => String(c.id) === String(s11ConsultantEl?.value || ""));
    const selectedClientName = (selectedClient?.name || selectedClient?.handle || "").trim();
    addOneToOneSession({
      date: $("#mS11Date").value || todayKey(),
      consultant: selectedClientName,
      contact: $("#mS11Contact").value,
      birthDate: $("#mS11BirthDate").value,
      sessionType: $("#mS11SessionType").value,
      modality: $("#mS11Modality").value,
      costSoles: $("#mS11Soles").value,
      costDolares: $("#mS11Dol").value,
      invoiceImage,
      invoiceImageName
    });
    closeModal();
  };
}

function renderQuestionReadings(){
  const ySel = $("#questionReadingsYear");
  const mSel = $("#questionReadingsMonth");
  const board = $("#questionReadingsBoard");
  if(!ySel || !mSel || !board) return;

  const years = new Set([STATE.questionReadings.viewYear, ...STATE.questionReadings.entries.map(e => new Date(`${e.date}T00:00:00`).getFullYear())]);
  const sortedYears = [...years].filter(Boolean).sort((a,b)=>b-a);
  ySel.innerHTML = sortedYears.map(y=>`<option value="${y}" ${Number(y)===Number(STATE.questionReadings.viewYear)?"selected":""}>${y}</option>`).join("");
  mSel.innerHTML = MONTHS_ES.map((m,idx)=>`<option value="${idx+1}" ${(idx+1)===Number(STATE.questionReadings.viewMonth)?"selected":""}>${m}</option>`).join("");

  const vY = Number(STATE.questionReadings.viewYear);
  const vM = Number(STATE.questionReadings.viewMonth);
  const rows = STATE.questionReadings.entries.filter(e=>{
    const d = new Date(`${e.date}T00:00:00`);
    return d.getFullYear()===vY && (d.getMonth()+1)===vM;
  });

  const body = rows.length ? rows.map((e)=>`<tr>
      <td>${escapeHtml(new Date(`${e.date}T00:00:00`).toLocaleDateString('es-PE', { day:'numeric', month:'long', year:'numeric' }))}</td>
      <td>${escapeHtml(e.consultant || "")}</td>
      <td>${e.birthDate ? escapeHtml(new Date(`${e.birthDate}T00:00:00`).toLocaleDateString('es-PE', { day:'2-digit', month:'2-digit', year:'numeric' })) : ""}</td>
      <td><input class="input small" type="number" min="0" data-act="qrQuestionsCount" data-id="${e.id}" value="${Number(e.questionsCount || 0)}" /></td>
      <td><input class="input small" type="number" min="0" step="0.01" data-act="qrCostSoles" data-id="${e.id}" value="${Number(e.costSoles || e.cost || 0)}" /></td>
      <td><input class="input small" type="number" min="0" step="0.01" data-act="qrCostDolares" data-id="${e.id}" value="${Number(e.costDolares || 0)}" /></td>
      <td><input class="input small" data-act="qrNotes" data-id="${e.id}" value="${escapeAttr(e.notes || "")}" placeholder="Notas" /></td>
      <td>
        <div class="invoiceActions">
          <input type="file" data-act="qrInvoice" data-id="${e.id}" accept="image/*" style="display:none" />
          <button class="btn ghost" data-act="qrUpload" data-id="${e.id}">${e.invoiceImage ? "Cambiar" : "Subir"}</button>
          ${e.invoiceImage ? `<button class="btn ghost" data-act="qrViewInvoice" data-id="${e.id}">Ver</button>` : `<span class="subEmpty">Sin imagen</span>`}
        </div>
      </td>
      <td><button class="btn ghost" data-act="qrDelete" data-id="${e.id}">🗑</button></td>
    </tr>`).join("") : `<tr><td colspan="99" class="subEmpty">No hay registros para este mes.</td></tr>`;

  const totalSoles = rows.reduce((a,x)=>a + amountNum(x.costSoles ?? x.cost), 0);
  const totalDolares = rows.reduce((a,x)=>a + amountNum(x.costDolares), 0);

  board.innerHTML = `<div class="subBoard">
    <h4>Lecturas por preguntas</h4>
    <div class="subTableWrap">
      <table class="subTable">
        <thead>
          <tr>
            <th>Fecha</th><th>Nombre de consultante</th><th>Fecha de nacimiento</th><th>Cantidad de preguntas</th><th>Costo en soles</th><th>Costo en dólares</th><th>Notas</th><th>Factura</th><th></th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
        <tfoot><tr><td colspan="4">Totales</td><td>${totalSoles}</td><td>${totalDolares}</td><td colspan="3"></td></tr></tfoot>
      </table>
    </div>
  </div>`;
}

function addQuestionReading(obj={}){
  const entry = {
    id: uid("qr"),
    date: obj.date || todayKey(),
    consultant: (obj.consultant || "").trim(),
    birthDate: obj.birthDate || "",
    questionsCount: Number(obj.questionsCount || 0) || 0,
    costSoles: amountNum(obj.costSoles),
    costDolares: amountNum(obj.costDolares),
    notes: obj.notes || "",
    invoiceImage: obj.invoiceImage || "",
    invoiceImageName: obj.invoiceImageName || "",
    createdAt: nowISO()
  };
  entry.cost = entry.costSoles;
  STATE.questionReadings.entries.unshift(entry);
  enqueueEvent("question_reading_add", entry);
  saveState();
  renderQuestionReadings();
  renderFinance();
}

function openQuestionReadingModal(){
  const clientOptions = STATE.clients
    .map(c => ({ id: c.id, name: (c.name || c.handle || "").trim() }))
    .filter(c => c.name)
    .sort((a,b)=>a.name.localeCompare(b.name, "es", { sensitivity: "base" }));

  openModal(
    "Nueva lectura por preguntas",
    `<div class="row"><label class="label">Fecha</label><input id="mQrDate" type="date" class="input" value="${todayKey()}" /></div>
    <div class="row"><label class="label">Nombre de consultante</label>
      <select id="mQrConsultant" class="input">
        <option value="">Selecciona cliente</option>
        ${clientOptions.map(c=>`<option value="${escapeAttr(c.id)}">${escapeHtml(c.name)}</option>`).join("")}
      </select>
    </div>
    <div class="row"><label class="label">Fecha de nacimiento</label><input id="mQrBirthDate" type="date" class="input" /></div>
    <div class="row"><label class="label">Cantidad de preguntas</label><input id="mQrQuestionsCount" type="number" class="input" min="0" step="1" /></div>
    <div class="row"><label class="label">Costo en soles</label><input id="mQrCostSoles" type="number" class="input" min="0" step="0.01" /></div>
    <div class="row"><label class="label">Costo en dólares</label><input id="mQrCostDolares" type="number" class="input" min="0" step="0.01" /></div>
    <div class="row"><label class="label">Imagen de factura</label><input id="mQrInvoice" type="file" class="input" accept="image/*" /></div>
    <div class="row"><label class="label">Notas</label><textarea id="mQrNotes" class="input" rows="3" placeholder="Apunta info adicional"></textarea></div>`,
    `<button class="btn" id="mCancel">Cancelar</button><button class="btn primary" id="mSave">Guardar</button>`
  );
  $("#mCancel").onclick = closeModal;
  const qrConsultantEl = $("#mQrConsultant");
  const qrBirthDateEl = $("#mQrBirthDate");
  const syncQuestionReadingClientData = () => {
    const selected = STATE.clients.find(c => String(c.id) === String(qrConsultantEl?.value || ""));
    qrBirthDateEl.value = selected?.dob || "";
  };
  qrConsultantEl?.addEventListener("change", syncQuestionReadingClientData);
  $("#mSave").onclick = async () => {
    const file = $("#mQrInvoice")?.files?.[0];
    let invoiceImage = "";
    let invoiceImageName = "";
    if(file){
      const b64 = await new Promise((resolve,reject)=>{
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(file);
      }).catch(()=>null);
      if(!b64){ toast("No pude leer la imagen."); return; }
      invoiceImage = String(b64);
      invoiceImageName = file.name || "";
    }
    const selectedClient = STATE.clients.find(c => String(c.id) === String(qrConsultantEl?.value || ""));
    const selectedClientName = (selectedClient?.name || selectedClient?.handle || "").trim();
    addQuestionReading({
      date: $("#mQrDate").value || todayKey(),
      consultant: selectedClientName,
      birthDate: $("#mQrBirthDate").value,
      questionsCount: $("#mQrQuestionsCount").value,
      costSoles: $("#mQrCostSoles").value,
      costDolares: $("#mQrCostDolares").value,
      notes: $("#mQrNotes").value,
      invoiceImage,
      invoiceImageName
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

  const groups = [
    { key: "fergis", label: "Asignado a Fergis" },
    { key: "carlos", label: "Asignado a Carlos" },
    { key: "ambos", label: "Asignado a Ambos" }
  ];

  function renderPlanTaskRow(t, idx, total){
    const done = !!t.doneAt;
    const isFirst = idx === 0;
    const isLast = idx === total - 1;
    const metaParts = [];
    if(t.assignee) metaParts.push(t.assignee.charAt(0).toUpperCase() + t.assignee.slice(1));
    if(t.frequency === "dia") metaParts.push("Diaria");
    else if(t.frequency === "semana") metaParts.push("Semanal" + (t.frequencyDay ? " · " + t.frequencyDay.charAt(0).toUpperCase() + t.frequencyDay.slice(1) : ""));
    const metaStatus = done ? "Hecho ✅" : "Por hacer";
    const metaInfo = metaParts.length ? " · " + metaParts.join(" · ") : "";
    return `<div class="item">
      <div class="itemLeft">
        <button class="btn ${done ? "primary":""}" data-act="planToggle" data-id="${t.id}" title="Marcar hecho">
          ${done ? "✓":"○"}
        </button>
        <div>
          <div class="itemTitle">${escapeHtml(t.title)}</div>
          <div class="itemMeta">${metaStatus}${metaInfo}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn ghost" data-act="planMoveUp" data-id="${t.id}" title="Subir" ${isFirst ? "disabled" : ""}>↑</button>
        <button class="btn ghost" data-act="planMoveDown" data-id="${t.id}" title="Bajar" ${isLast ? "disabled" : ""}>↓</button>
        <button class="btn ghost" data-act="planEdit" data-id="${t.id}" title="Editar">✎</button>
        <button class="btn ghost" data-act="planDelete" data-id="${t.id}" title="Eliminar">🗑</button>
      </div>
    </div>`;
  }

  list.innerHTML = `<div class="planAssigneeGrid">${groups.map((group) => {
    const groupItems = items.filter(t => (t.assignee || "") === group.key);
    const rows = groupItems.length
      ? groupItems.map((t, idx) => renderPlanTaskRow(t, idx, groupItems.length)).join("")
      : `<div class="item compact"><div class="itemMeta">Sin tareas en esta sección.</div></div>`;
    return `
      <div class="sectionBlock">
        <div class="sectionTitle">${group.label}</div>
        ${rows}
      </div>
    `;
  }).join("")}</div>`;
}

function renderMetrics(){
  renderLevelDisplay();
}

function renderContentTodo(){
  const autoArchived = archiveContentIfDayChanged();
  if(autoArchived) saveState();
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
  if(!sel) return;
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
  if(!list) return;
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
  const zodiacFilter = $("#clientZodiacFilter")?.value || "all";
  const q = normalizeSearchText(($("#clientSearch").value || "").trim());

  let items = [...STATE.clients];
  if(filter !== "all") items = items.filter(c => c.status === filter);
  if(zodiacFilter !== "all"){
    items = items.filter(c => (c.zodiac || (c.dob ? zodiacFromDob(c.dob) : "")) === zodiacFilter);
  }
  if(q){
    items = items.filter(c => {
      const zodiac = c.zodiac || (c.dob ? zodiacFromDob(c.dob) : "");
      const blob = `${c.name || ""} ${c.handle || ""} ${c.phone || ""} ${c.nextStep || ""} ${zodiac}`;
      return normalizeSearchText(blob).includes(q);
    });
  }

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

  list.innerHTML = items.slice(0,10).map(c => {
    const name = c.name || c.handle || "(sin nombre)";
    const phone = (c.phone || "").trim();
    const phoneLabel = phone || "Sin teléfono";
    const dob = c.dob ? escapeHtml(c.dob) : "";
    const zodiac = (c.zodiac || (c.dob ? zodiacFromDob(c.dob) : "")) || "";
    const zPill = zodiac ? ` <span class="pill">♈ ${escapeHtml(zodiac)}</span>` : "";
    return `<div class="item">
      <div class="itemLeft">
        <div>
          <div class="itemTitle">${escapeHtml(name)} <span class="pill">${escapeHtml(phoneLabel)}</span>${zPill}</div>
          <div class="itemMeta">${dob ? `Nacimiento: ${dob}` : "Sin fecha de nacimiento registrada"}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn ghost" data-act="clientEdit" data-id="${c.id}" title="Editar">✎</button>
        <button class="btn ghost" data-act="clientDel" data-id="${c.id}" title="Eliminar">🗑</button>
      </div>
    </div>`;
  }).join("");
}

function renderNextSteps(){
  const list = $("#nextStepsList");
  const sel = $("#nextStepClientFilter");
  if(!list || !sel) return;

  const selected = sel.value || "all";
  sel.innerHTML = [
    '<option value="all">Todos los clientes</option>',
    ...STATE.clients.map(c=>{
      const name = c.name || c.handle || "(sin nombre)";
      return `<option value="${c.id}" ${selected===c.id?"selected":""}>${escapeHtml(name)}</option>`;
    })
  ].join("");

  let rows = [...STATE.nextSteps];
  const filterVal = sel.value || "all";
  const q = ($("#nextStepSearch")?.value || "").trim().toLowerCase();
  if(filterVal !== "all") rows = rows.filter(x => x.clientId === filterVal);
  if(q) rows = rows.filter(x => (`${x.clientName} ${x.nextStep} ${x.notes}`).toLowerCase().includes(q));

  if(!rows.length){
    list.innerHTML = `<div class="item"><div class="itemLeft"><div><div class="itemTitle">Sin próximos pasos</div><div class="itemMeta">Registra un seguimiento para que aparezca aquí.</div></div></div></div>`;
    return;
  }

  list.innerHTML = rows.map(r => {
    const dt = new Date(r.createdAt).toLocaleDateString();
    const next = r.nextStep || "—";
    const notes = r.notes ? `<div class="itemMeta">Notas: ${escapeHtml(r.notes)}</div>` : "";
    return `<div class="item">
      <div class="itemLeft">
        <div>
          <div class="itemTitle">${escapeHtml(r.clientName || "(sin cliente)")}</div>
          <div class="itemMeta"><b>${escapeHtml(r.kind || "paso")}</b> • ${escapeHtml(next)} • ${escapeHtml(dt)}</div>
          ${notes}
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn ghost" data-act="nextStepEdit" data-id="${r.id}" title="Editar">✎</button>
        <button class="btn ghost" data-act="nextStepDel" data-id="${r.id}" title="Eliminar">🗑</button>
      </div>
    </div>`;
  }).join("");
}

function financeDateFromEntry(entry){
  const raw = entry.date || entry.paymentDate || entry.startAt || todayKey();
  if(typeof raw !== "string") return todayKey();
  const match = raw.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : todayKey();
}

function buildFinanceEntries(){
  const entries = [];

  for(const sub of STATE.subscriptions.entries){
    const c = findClientByBookingClientString(sub.name || "");
    entries.push({
      source: "subscription",
      clientId: c?.id || null,
      clientName: sub.name || "",
      date: sub.paymentDate || todayKey(),
      soles: amountNum(sub.costSoles),
      dolares: amountNum(sub.costDolares)
    });
  }

  for(const sess of STATE.oneToOneSessions.entries){
    const c = findClientByBookingClientString(sess.consultant || sess.contact || "");
    entries.push({
      source: "oneToOne",
      clientId: c?.id || null,
      clientName: sess.consultant || sess.contact || "",
      date: sess.date || todayKey(),
      soles: amountNum(sess.costSoles),
      dolares: amountNum(sess.costDolares)
    });
  }

  for(const qr of STATE.questionReadings.entries){
    const c = findClientByBookingClientString(qr.consultant || "");
    entries.push({
      source: "questionReading",
      clientId: c?.id || null,
      clientName: qr.consultant || "",
      date: qr.date || todayKey(),
      soles: amountNum(qr.costSoles ?? qr.cost),
      dolares: amountNum(qr.costDolares)
    });
  }

  return entries.filter(x => x.soles > 0 || x.dolares > 0);
}

function totalsByClient(clientId){
  const entries = buildFinanceEntries().filter(x => String(x.clientId) === String(clientId));
  return {
    soles: entries.reduce((a,x)=>a + Number(x.soles || 0), 0),
    dolares: entries.reduce((a,x)=>a + Number(x.dolares || 0), 0)
  };
}

function renderFinance(){
  renderLevelDisplay();
  const totalsEl = $("#financeTotals");
  const chartEl = $("#financeChart");
  const rangeWrap = $("#financeRangeFilters");
  if(!totalsEl || !chartEl || !rangeWrap) return;

  const months = { "1M": 1, "3M": 3, "6M": 6, "1Y": 12 };
  const monthsBack = months[STATE.financeRange] || 1;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - (monthsBack - 1), 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  const rows = buildFinanceEntries().filter((x) => {
    const d = new Date(`${financeDateFromEntry(x)}T00:00:00`);
    return d >= start && d <= end;
  }).sort((a,b)=> new Date(financeDateFromEntry(a)) - new Date(financeDateFromEntry(b)));

  const totalS = rows.reduce((a,x)=>a + x.soles, 0);
  const totalD = rows.reduce((a,x)=>a + x.dolares, 0);

  totalsEl.innerHTML = `
    <div class="metric"><div class="metricLabel">Total en soles</div><div class="metricValue">S/ ${totalS.toFixed(2)}</div></div>
    <div class="metric"><div class="metricLabel">Total en dólares</div><div class="metricValue">US$ ${totalD.toFixed(2)}</div></div>
    <div class="metric"><div class="metricLabel">Movimientos</div><div class="metricValue">${rows.length}</div></div>
  `;

  rangeWrap.querySelectorAll("button[data-range]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.range === STATE.financeRange);
  });

  if(!rows.length){
    chartEl.innerHTML = `<div class="item"><div class="itemMeta">Sin ingresos en el periodo seleccionado.</div></div>`;
    return;
  }

  const byDay = new Map();
  rows.forEach((r)=>{
    const key = financeDateFromEntry(r);
    if(!byDay.has(key)) byDay.set(key, { soles: 0, dolares: 0 });
    const day = byDay.get(key);
    day.soles += r.soles;
    day.dolares += r.dolares;
  });

  const dayKeys = [...byDay.keys()].sort();
  let accS = 0;
  let accD = 0;
  const series = dayKeys.map((k)=>{
    const row = byDay.get(k);
    accS += row.soles;
    accD += row.dolares;
    return { key: k, soles: accS, dolares: accD };
  });

  const maxY = Math.max(...series.map(x => Math.max(x.soles, x.dolares)), 1);
  const w = 760;
  const h = 260;
  const pl = 54; // left padding for y-axis labels
  const pr = 16; // right padding
  const pt = 20; // top padding
  const pb = 34; // bottom padding for x-axis labels
  const xFor = (idx) => pl + (idx * ((w - pl - pr) / Math.max(series.length - 1, 1)));
  const yFor = (v) => pt + ((1 - v / maxY) * (h - pt - pb));
  const solesPath = series.map((v,i)=>`${xFor(i)},${yFor(v.soles)}`).join(" ");
  const usdPath = series.map((v,i)=>`${xFor(i)},${yFor(v.dolares)}`).join(" ");

  // Y-axis: grid lines + value labels on the left
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((r)=>{
    const val = maxY * r;
    const y = yFor(val);
    const fmt = val >= 1000 ? `${(val / 1000).toFixed(1)}k` : val >= 10 ? val.toFixed(0) : val > 0 ? val.toFixed(1) : "0";
    return `<line x1="${pl}" y1="${y}" x2="${w - pr}" y2="${y}" class="chartGrid" /><text x="${pl - 6}" y="${y + 4}" class="chartLabel" text-anchor="end">${fmt}</text>`;
  }).join("");

  // X-axis: show all date labels if ≤ 15 data points, otherwise sample ~8 evenly
  const MAX_X_LABELS = 8;
  let xLabelIndices;
  if(series.length <= 15){
    xLabelIndices = series.map((_, i) => i);
  }else{
    const step = Math.ceil(series.length / (MAX_X_LABELS - 1));
    xLabelIndices = [];
    for(let i = 0; i < series.length; i += step) xLabelIndices.push(i);
    if(xLabelIndices[xLabelIndices.length - 1] !== series.length - 1) xLabelIndices.push(series.length - 1);
  }
  const labels = xLabelIndices.map((idx)=>{
    const d = new Date(`${series[idx].key}T00:00:00`);
    return `<text x="${xFor(idx)}" y="${h - 10}" class="chartLabel" text-anchor="middle">${d.toLocaleDateString('es-PE', { day:'2-digit', month:'2-digit' })}</text>`;
  }).join("");

  // Dots at each data point
  const solesDots = series.map((v,i)=>`<circle cx="${xFor(i)}" cy="${yFor(v.soles)}" r="3" class="chartDot soles" />`).join("");
  const usdDots = series.map((v,i)=>`<circle cx="${xFor(i)}" cy="${yFor(v.dolares)}" r="3" class="chartDot dolares" />`).join("");

  chartEl.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" class="financeSvg" role="img" aria-label="Ingresos por fecha">
      ${ticks}
      <line x1="${pl}" y1="${pt}" x2="${pl}" y2="${h - pb}" class="chartGrid" />
      <polyline points="${solesPath}" class="chartLine soles" />
      <polyline points="${usdPath}" class="chartLine dolares" />
      ${solesDots}
      ${usdDots}
      ${labels}
    </svg>
    <div class="financeLegend">
      <span><i class="legendDot soles"></i>Soles</span>
      <span><i class="legendDot dolares"></i>Dólares</span>
    </div>
  `;
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
    const kindMap = { idea:["Idea","neutral"], post:["Post","ok"], story:["Historia","ok"], thread:["Hilo","neutral"], investigacion:["Investigación","warn"] };
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

function firstNameFromBooking_(booking){
  const info = getClientForBooking_(booking);
  const source = info.client?.name || info.display || "";
  const cleaned = String(source).trim().replace(/^@/, "");
  if(!cleaned) return "Cliente";
  const first = cleaned.split(/\s+/).find(Boolean) || "";
  return first || "Cliente";
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
  if(!isValidMonthKey(STATE.calMonth)) STATE.calMonth = monthKey(new Date());

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
    const clients = items.slice(0,3).map(o => {
      const b = STATE.bookings.find(x=>x.id===o.bookingId);
      const cls = bookingDotClass(b?.type);
      const info = getClientForBooking_(b);
      const zcls = info.element ? `z-${info.element}` : "";
      const firstName = firstNameFromBooking_(b);
      return `<span class="calClientChip ${cls} ${zcls}" title="${escapeHtml(info.display || '')}">${escapeHtml(firstName)}</span>`;
    }).join("");
    const more = items.length > 3 ? `<span class="pill">+${items.length-3}</span>` : "";
    const cls = ["calCell", inMonth?"":"muted", (k===today)?"calToday":""].join(" ").trim();
    cells.push(`<div class="${cls}" data-act="calDay" data-day="${k}">
      <div class="calNum">${d.getDate()}</div>
      <div class="calMeta">${clients}${more}</div>
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
    .filter(x => x.b && (x.b.status||"scheduled") === "scheduled")
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

  list.innerHTML = occ.map(({o,b}) => {
    const dt = new Date(o.startAt);
    const when = dt.toLocaleString(undefined, { weekday:"short", month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" });
    const [lbl, cls] = bookingTypeLabel(b.type);
    const amount = b.amount ? ` • S/ ${b.amount}` : "";
    const amountUsd = b.amountUsd ? ` • $ ${b.amountUsd}` : "";
    const info = getClientForBooking_(b);
    const clientMain = escapeHtml(info.display || b.client || "(sin cliente)");
    const statusBadge = b.status === "done" ? ["Hecha","ok"] : (b.status === "cancelled" ? ["Cancelada","warn"] : ["Programada","neutral"]);
    const title = escapeHtml(b.title || lbl);
    const rep = b.recurrence?.freq ? " • semanal" : "";
    return `<div class="item">
      <div class="itemLeft">
        <div class="bookingMain">
          <div class="itemTitle">${clientMain}</div>
          <div class="itemMeta bookingWhen">${when}</div>
          <div class="itemMeta bookingSub">${title}${amount}${amountUsd}${rep}</div>
        </div>
      </div>
      <div class="bookingRight">
        <div class="bookingTags">
          <span class="badge tiny ${cls}">${lbl}</span>
          <span class="badge tiny ${statusBadge[1]}">${statusBadge[0]}</span>
        </div>
        <div class="bookingActions">
        <button class="btn" data-act="bookDone" data-id="${b.id}" title="Marcar como hecha">Hecho</button>
        <button class="btn ghost" data-act="bookSession" data-id="${b.id}" data-occ="${escapeHtml(o.startAt)}" title="Abrir sesión">📝</button>
        <button class="btn ghost" data-act="bookEdit" data-id="${b.id}" title="Editar">✎</button>
        <button class="btn ghost" data-act="bookDel" data-id="${b.id}" title="Eliminar">🗑</button>
        </div>
      </div>
    </div>`;
  }).join("");
}

function renderArchiveBookings(){
  const list = $("#archiveBookingsList");
  if(!list) return;

  const typeFilter = $("#archiveTypeFilter")?.value || "all";
  const q = ($("#archiveSearch")?.value || "").trim().toLowerCase();

  let rows = STATE.bookings
    .filter(b => ["done","cancelled"].includes(b.status||"scheduled"))
    .slice()
    .sort((a,b)=> new Date(b.startAt) - new Date(a.startAt));

  if(typeFilter !== "all") rows = rows.filter(b => b.type === typeFilter);
  if(q){
    rows = rows.filter((b)=>{
      const info = getClientForBooking_(b);
      const bucket = [b.title, b.client, info.display, info.handleShow].join(" ").toLowerCase();
      return bucket.includes(q);
    });
  }

  if(!rows.length){
    list.innerHTML = `<div class="item">
      <div class="itemLeft"><div>
        <div class="itemTitle">Sin sesiones archivadas</div>
        <div class="itemMeta">Cuando marques una sesión como hecha/cancelada aparecerá aquí.</div>
      </div></div>
    </div>`;
    return;
  }

  list.innerHTML = rows.map((b)=>{
    const dt = new Date(b.startAt);
    const when = dt.toLocaleString(undefined, { weekday:"short", month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" });
    const [lbl, cls] = bookingTypeLabel(b.type);
    const info = getClientForBooking_(b);
    const clientName = info.display || b.client || "(sin cliente)";
    const sessionTitle = b.title || lbl;
    const amountPen = b.amount ? ` • S/ ${b.amount}` : "";
    const amountUsd = b.amountUsd ? ` • $ ${b.amountUsd}` : "";
    const statusBadge = b.status === "done" ? ["Hecha","ok"] : ["Cancelada","warn"];
    return `<div class="item">
      <div class="itemLeft">
        <div>
          <div class="itemTitle">${escapeHtml(clientName)}</div>
          <div class="itemMeta">${escapeHtml(when)} • ${escapeHtml(sessionTitle)}${amountPen}${amountUsd}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <span class="badge ${cls}">${lbl}</span>
        <span class="badge ${statusBadge[1]}">${statusBadge[0]}</span>
        <button class="btn ghost" data-act="bookEdit" data-id="${b.id}" title="Editar">✎</button>
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
  const tabId = getTabIdFromActiveTab(STATE.activeTab);
  const meta = ensureSyncMetaTab(tabId);
  const pending = STATE.eventQueue.filter(e => !e.syncedAt).length;
  const status = meta.status || "idle";
  el.textContent = `Sync(${tabId}): ${status}${pending ? ` · ${pending} evt pendientes` : ""}`;
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
    if(STATE.activeTab === "finanzas") renderFinance();
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
      if(act === "bookDone"){
        updateBooking(id, { status:"done" });
        if(STATE.activeTab !== "archivo"){
          STATE.activeTab = "archivo";
          saveState();
          renderTabs();
        }
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

  const archiveTypeFilter = $("#archiveTypeFilter");
  const archiveSearch = $("#archiveSearch");
  const archiveList = $("#archiveBookingsList");
  if(archiveTypeFilter) archiveTypeFilter.addEventListener("change", renderArchiveBookings);
  if(archiveSearch) archiveSearch.addEventListener("input", renderArchiveBookings);
  if(archiveList){
    archiveList.addEventListener("click", (e)=>{
      const btn = e.target.closest("button[data-act]");
      if(!btn) return;
      const act = btn.dataset.act;
      const id = btn.dataset.id;
      if(act === "bookEdit") openBookingModal(id);
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

        ${isPlan ? `
        <div class="row">
          <label class="label">¿Quién lo hace?</label>
          <select id="mTaskAssignee" class="input">
            <option value="">-- Seleccionar --</option>
            <option value="fergis">Fergis</option>
            <option value="carlos">Carlos</option>
            <option value="ambos">Ambos</option>
          </select>
        </div>

        <div class="row">
          <label class="label">Frecuencia</label>
          <select id="mTaskFrequency" class="input">
            <option value="">-- Seleccionar --</option>
            <option value="dia">Día</option>
            <option value="semana">Semana</option>
          </select>
        </div>
        <div class="row" id="mTaskFrequencyDayRow" style="display:none">
          <label class="label">Día de la semana</label>
          <select id="mTaskFrequencyDay" class="input">
            <option value="">-- Seleccionar --</option>
            <option value="lunes">Lunes</option>
            <option value="martes">Martes</option>
            <option value="miércoles">Miércoles</option>
            <option value="jueves">Jueves</option>
            <option value="viernes">Viernes</option>
            <option value="sábado">Sábado</option>
            <option value="domingo">Domingo</option>
          </select>
        </div>
        ` : ""}

        <div class="divider"></div>
        <div class="itemMeta">Tip: si está pesado, hazlo micro (5-10 min). Esto es estructura suave.</div>
      `,
      `
        <button class="btn" id="mCancel">Cancelar</button>
        <button class="btn primary" id="mOk">Agregar</button>
      `
    );

    $("#mCancel").onclick = closeModal;

    const freqEl = $("#mTaskFrequency");
    if(freqEl){
      freqEl.onchange = () => {
        const dayRow = $("#mTaskFrequencyDayRow");
        if(dayRow) dayRow.style.display = freqEl.value === "semana" ? "" : "none";
      };
    }

    $("#mOk").onclick = () => {
      const title = $("#mTaskTitle").value.trim();
      const cat = $("#mTaskCat").value || "mission";
      const dayInput = $("#mTaskDay");
      const day = dayInput ? (dayInput.value || todayKey()) : todayKey();
      const assigneeEl = $("#mTaskAssignee");
      const frequencyEl = $("#mTaskFrequency");
      const frequencyDayEl = $("#mTaskFrequencyDay");
      const assignee = assigneeEl ? assigneeEl.value : "";
      const frequency = frequencyEl ? frequencyEl.value : "";
      const frequencyDay = frequencyDayEl ? frequencyDayEl.value : "";

      if(!title){ toast("Escribe un título."); return; }
      if(frequency === "semana" && !frequencyDay){ toast("Selecciona el día de la semana."); return; }

      if(cat === "mission" && day === todayKey()){
        const count = STATE.tasks.filter(t => t.pinnedDay===day && (t.category||"mission")!=="plan").slice(0,3).length;
        if(count >= 3){ toast("Máximo 3 misiones para hoy."); return; }
      }

      addTask(title, { pinnedDay: day, category: cat, assignee, frequency, frequencyDay });
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

  $("#btnStartSession")?.addEventListener("click", () => {
    const taskId = $("#sessionTaskSelect")?.value || null;
    const note = $("#sessionNote")?.value || "";
    startSession(taskId, note);
    if($("#sessionNote")) $("#sessionNote").value = "";
  });

  $("#btnFinishSession")?.addEventListener("click", () => finishSession("done"));

  $("#btnPauseSession")?.addEventListener("click", () => {
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
  $("#btnAddNextStep")?.addEventListener("click", () => openNextStepModal());
  $("#nextStepClientFilter")?.addEventListener("change", renderNextSteps);
  $("#nextStepSearch")?.addEventListener("input", renderNextSteps);
  $("#financeRangeFilters")?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-range]");
    if(!btn) return;
    STATE.financeRange = btn.dataset.range;
    saveState();
    renderFinance();
  });
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



  $("#nextStepsList")?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if(!btn) return;
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    if(act==="nextStepEdit") openNextStepModal(id);
    if(act==="nextStepDel"){
      openModal(
        "Eliminar próximo paso",
        `<div class="itemMeta">Se borrará este registro de seguimiento.</div>`,
        `<button class="btn" id="mCancel">Cancelar</button><button class="btn warn" id="mOk">Eliminar</button>`
      );
      $("#mCancel").onclick = closeModal;
      $("#mOk").onclick = () => { deleteNextStep(id); closeModal(); };
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
  $("#btnAddQuestionReading")?.addEventListener("click", openQuestionReadingModal);
  $("#subscriptionYear")?.addEventListener("change", (e)=>{ STATE.subscriptions.viewYear = Number(e.target.value); saveState(); renderSubscriptions(); });
  $("#subscriptionMonth")?.addEventListener("change", (e)=>{ STATE.subscriptions.viewMonth = Number(e.target.value); saveState(); renderSubscriptions(); });
  $("#oneToOneYear")?.addEventListener("change", (e)=>{ STATE.oneToOneSessions.viewYear = Number(e.target.value); saveState(); renderOneToOneSessions(); });
  $("#oneToOneMonth")?.addEventListener("change", (e)=>{ STATE.oneToOneSessions.viewMonth = Number(e.target.value); saveState(); renderOneToOneSessions(); });
  $("#questionReadingsYear")?.addEventListener("change", (e)=>{ STATE.questionReadings.viewYear = Number(e.target.value); saveState(); renderQuestionReadings(); });
  $("#questionReadingsMonth")?.addEventListener("change", (e)=>{ STATE.questionReadings.viewMonth = Number(e.target.value); saveState(); renderQuestionReadings(); });
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
      renderFinance();
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
    renderFinance();
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
    renderFinance();
  });

  $("#questionReadingsBoard")?.addEventListener("change", async (e) => {
    const t = e.target;
    if(t.dataset.act !== "qrInvoice") return;
    const id = t.dataset.id;
    const row = STATE.questionReadings.entries.find(x=>x.id===id);
    if(!row) return;
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
    enqueueEvent("question_reading_invoice", { id, invoiceImageName: row.invoiceImageName });
    saveState();
    renderQuestionReadings();
  });

  $("#questionReadingsBoard")?.addEventListener("input", (e) => {
    const t = e.target;
    if(!["qrQuestionsCount", "qrCostSoles", "qrCostDolares", "qrNotes"].includes(t.dataset.act)) return;
    const row = STATE.questionReadings.entries.find(x=>x.id===t.dataset.id);
    if(!row) return;
    if(t.dataset.act === "qrQuestionsCount") row.questionsCount = Number(t.value || 0) || 0;
    if(t.dataset.act === "qrCostSoles"){
      row.costSoles = amountNum(t.value);
      row.cost = row.costSoles;
    }
    if(t.dataset.act === "qrCostDolares") row.costDolares = amountNum(t.value);
    if(t.dataset.act === "qrNotes") row.notes = t.value;
    saveState();
    if(["qrCostSoles", "qrCostDolares"].includes(t.dataset.act)){
      renderQuestionReadings();
      renderFinance();
    }
  });
  $("#questionReadingsBoard")?.addEventListener("click", (e) => {
    const viewBtn = e.target.closest("button[data-act='qrViewInvoice']");
    if(viewBtn){
      const row = STATE.questionReadings.entries.find(x=>x.id===viewBtn.dataset.id);
      if(row?.invoiceImage) openImagePreviewModal(row.invoiceImage, `Factura · ${row.consultant || "lectura"}`);
      return;
    }
    const uploadBtn = e.target.closest("button[data-act='qrUpload']");
    if(uploadBtn){
      const fileInput = document.querySelector(`input[data-act='qrInvoice'][data-id='${uploadBtn.dataset.id}']`);
      fileInput?.click();
      return;
    }
    const delBtn = e.target.closest("button[data-act='qrDelete']");
    if(!delBtn) return;
    STATE.questionReadings.entries = STATE.questionReadings.entries.filter(x=>x.id!==delBtn.dataset.id);
    enqueueEvent("question_reading_delete", { id: delBtn.dataset.id });
    saveState();
    renderQuestionReadings();
    renderFinance();
  });

  $("#clientFilter").addEventListener("change", renderClients);
  $("#clientZodiacFilter")?.addEventListener("change", renderClients);
  $("#clientSearch").addEventListener("input", renderClients);

  $("#btnSettings").addEventListener("click", openSettings);
  $("#btnSync").addEventListener("click", async () => {
    if(!SETTINGS.syncEnabled || !SETTINGS.appsScriptUrl){
      toast("Sync desactivado. Actívalo en Ajustes.");
      updateSyncUI();
      return;
    }
    const btn = $("#btnSync");
    btn.disabled = true;
    try{
      await syncNow();
      toast("Pestaña actual sincronizada.");
    }catch(err){
      console.warn("[SheetSync] pushTab error", err);
      toast(err?.message || "No pude sincronizar la pestaña actual.");
    }finally{
      btn.disabled = false;
      updateSyncUI();
    }
  });
  $("#btnSheetPull")?.addEventListener("click", async () => {
    if(!SETTINGS.appsScriptUrl){
      toast("Falta la URL del Apps Script en Ajustes.");
      updateSyncUI();
      return;
    }
    const btn = $("#btnSheetPull");
    btn.disabled = true;
    try{
      await syncFromSheet();
      toast("Pestaña actual actualizada desde Sheets.");
    }catch(err){
      console.warn("[SheetSync] pullTab error", err);
      toast(err?.message || "No pude traer la pestaña actual.");
    }finally{
      btn.disabled = false;
      updateSyncUI();
    }
  });
  $("#btnSyncAll")?.addEventListener("click", async () => {
    if(!SETTINGS.syncEnabled || !SETTINGS.appsScriptUrl){
      toast("Sync desactivado. Actívalo en Ajustes.");
      updateSyncUI();
      return;
    }
    const btn = $("#btnSyncAll");
    btn.disabled = true;
    try{
      await pushAllTabsToSheet();
      toast("Todas las pestañas sincronizadas.");
    }catch(err){
      console.warn("[SheetSync] pushAll error", err);
      toast(err?.message || "No pude sincronizar todas las pestañas.");
    }finally{
      btn.disabled = false;
      updateSyncUI();
    }
  });
  $("#btnSheetPullAll")?.addEventListener("click", async () => {
    if(!SETTINGS.appsScriptUrl){
      toast("Falta la URL del Apps Script en Ajustes.");
      updateSyncUI();
      return;
    }
    const btn = $("#btnSheetPullAll");
    btn.disabled = true;
    try{
      await pullAllTabsFromSheet();
      toast("Todas las pestañas actualizadas desde Sheets.");
    }catch(err){
      console.warn("[SheetSync] pullAll error", err);
      toast(err?.message || "No pude traer todas las pestañas.");
    }finally{
      btn.disabled = false;
      updateSyncUI();
    }
  });

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
      return `<div class="item compact">
        <div class="itemLeft">
          <div>
            <div class="itemTitle">${title}</div>
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
        <label class="label">Hora de nacimiento</label>
        <input id="mCBirthTime" type="time" class="input" value="${escapeHtml(c?.birthTime||"")}" />
      </div>
      <div class="row">
        <label class="label">Lugar de nacimiento</label>
        <input id="mCBirthPlace" class="input" value="${escapeHtml(c?.birthPlace||"")}" placeholder="Ej: Lima, Perú" />
      </div>
      <div class="row">
        <label class="label">Lugar de residencia</label>
        <input id="mCResidencePlace" class="input" value="${escapeHtml(c?.residencePlace||"")}" placeholder="Ej: Cusco, Perú" />
      </div>
      <div class="row">
        <label class="label">Teléfono</label>
        <input id="mCPhone" class="input" value="${escapeHtml(c?.phone||"")}" placeholder="Ej: +51 999 999 999" />
      </div>

      <div class="financeMiniCard">
        ${(() => {
          const totals = c ? totalsByClient(c.id) : { soles: 0, dolares: 0 };
          const manualS = amountNum(c?.paidSolesManual);
          const manualD = amountNum(c?.paidDolaresManual);
          return `<div class="itemTitle">Pagado por cliente</div>
            <div class="itemMeta">Automático: <b>S/ ${(totals.soles).toFixed(2)}</b> • <b>US$ ${(totals.dolares).toFixed(2)}</b></div>
            <div class="itemMeta">Manual extra: S/ ${manualS.toFixed(2)} • US$ ${manualD.toFixed(2)}</div>`;
        })()}
      </div>
      <div class="row">
        <label class="label">Pago manual extra (soles)</label>
        <input id="mCPaidSolesManual" type="number" step="0.01" min="0" class="input" value="${escapeHtml(String(c?.paidSolesManual || ""))}" />
      </div>
      <div class="row">
        <label class="label">Pago manual extra (dólares)</label>
        <input id="mCPaidDolaresManual" type="number" step="0.01" min="0" class="input" value="${escapeHtml(String(c?.paidDolaresManual || ""))}" />
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
      notes: $("#mCNotes").value,
      dob: $("#mCDob").value,
      birthTime: $("#mCBirthTime").value,
      birthPlace: $("#mCBirthPlace").value,
      residencePlace: $("#mCResidencePlace").value,
      phone: $("#mCPhone").value,
      zodiac: $("#mCZodiac").value,
      paidSolesManual: amountNum($("#mCPaidSolesManual")?.value),
      paidDolaresManual: amountNum($("#mCPaidDolaresManual")?.value)
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

function openNextStepModal(stepId=null){
  const isEdit = !!stepId;
  const step = isEdit ? STATE.nextSteps.find(x=>x.id===stepId) : null;

  openModal(
    isEdit ? "Editar próximo paso" : "Registrar próximo paso",
    `
      <div class="row">
        <label class="label">Cliente</label>
        <select id="mNSClient" class="input">
          <option value="">Selecciona cliente</option>
          ${STATE.clients.map(c=>{
            const name = c.name || c.handle || "(sin nombre)";
            return `<option value="${c.id}" ${(step?.clientId===c.id)?"selected":""}>${escapeHtml(name)}</option>`;
          }).join("")}
        </select>
      </div>
      <div class="row">
        <label class="label">Tipo</label>
        <select id="mNSKind" class="input">
          ${["seguimiento","lead","cotización","pago","sesión"].map(k=>`<option value="${k}" ${(step?.kind===k)?"selected":""}>${k}</option>`).join("")}
        </select>
      </div>
      <div class="row">
        <label class="label">Próximo paso</label>
        <input id="mNSStep" class="input" value="${escapeHtml(step?.nextStep||"")}" placeholder="Ej: enviar audio resumen mañana" />
      </div>
      <div class="row">
        <label class="label">Notas</label>
        <textarea id="mNSNotes" class="input" style="min-height:140px;resize:vertical" placeholder="Detalles de seguimiento, contexto, acuerdos...">${escapeHtml(step?.notes||"")}</textarea>
      </div>
    `,
    `
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn primary" id="mOk">${isEdit ? "Guardar" : "Registrar"}</button>
    `
  );

  $("#mCancel").onclick = closeModal;
  $("#mOk").onclick = () => {
    const clientId = $("#mNSClient").value || "";
    if(!clientId){ toast("Selecciona un cliente"); return; }
    const payload = {
      clientId,
      kind: $("#mNSKind").value,
      nextStep: $("#mNSStep").value,
      notes: $("#mNSNotes").value
    };
    if(!payload.nextStep.trim()){ toast("Escribe el próximo paso"); return; }
    if(isEdit) updateNextStep(stepId, payload);
    else addNextStep(payload);
    closeModal();
  };
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
          ${["idea","post","story","thread","investigacion"].map(k => {
            const lbl = ({idea:"Idea",post:"Post",story:"Historia",thread:"Hilo",investigacion:"Investigación"})[k];
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
        <textarea id="mINotes" class="input" style="min-height:130px;resize:vertical" placeholder="Bullet mental: gancho / estructura / CTA…">${escapeHtml(i?.notes||"")}</textarea>
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
    return `<div class="item">
      <div class="itemLeft">
        <div>
          <div class="itemTitle">${when} • ${title}</div>
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

function deleteBookingRecord_(bookingId, record){
  const b = STATE.bookings.find(x=>x.id===bookingId);
  if(!b) return false;

  const before = Array.isArray(b.sessionRecords) ? b.sessionRecords.length : 0;
  b.sessionRecords = (Array.isArray(b.sessionRecords) ? b.sessionRecords : []).filter(r => {
    const sameId = record?.id && r.id === record.id;
    const sameOcc = record?.occStartAt && r.occStartAt === record.occStartAt;
    return !(sameId || sameOcc);
  });

  if(b.sessionRecords.length === before) return false;

  enqueueEvent("booking_session_record_delete", { bookingId, recordId: record?.id || null, occStartAt: record?.occStartAt || null });
  saveState();
  renderBookings();
  renderCalendar();
  updateSyncUI();
  return true;
}

function upsertClientSessionInsight_(booking, record){
  if(!booking || !record) return;
  let client = booking.clientId ? STATE.clients.find(x => String(x.id) === String(booking.clientId)) : null;
  if(!client && booking.client){
    client = findClientByBookingClientString(booking.client);
  }
  if(!client) return;

  const notes = (record.sessionNotes || "").trim();
  const recommendations = (record.recommendations || "").trim();
  if(!notes && !recommendations) return;

  client.sessionInsights = Array.isArray(client.sessionInsights) ? client.sessionInsights : [];
  const insight = {
    id: uid("sins"),
    bookingId: booking.id,
    occStartAt: record.occStartAt || booking.startAt || nowISO(),
    sessionNotes: notes,
    recommendations,
    createdAt: nowISO(),
    sessionType: booking.type || "tarot"
  };

  const existingIdx = client.sessionInsights.findIndex(x => x.bookingId === insight.bookingId && x.occStartAt === insight.occStartAt);
  if(existingIdx >= 0){
    client.sessionInsights[existingIdx] = { ...client.sessionInsights[existingIdx], ...insight, id: client.sessionInsights[existingIdx].id || insight.id };
  }else{
    client.sessionInsights.push(insight);
  }

  client.sessionInsights.sort((a,b) => new Date(b.occStartAt || b.createdAt || 0) - new Date(a.occStartAt || a.createdAt || 0));
}

function deleteClientSessionInsight_(booking, record){
  if(!booking || !record) return false;
  let client = booking.clientId ? STATE.clients.find(x => String(x.id) === String(booking.clientId)) : null;
  if(!client && booking.client){
    client = findClientByBookingClientString(booking.client);
  }
  if(!client) return false;

  const before = Array.isArray(client.sessionInsights) ? client.sessionInsights.length : 0;
  client.sessionInsights = (Array.isArray(client.sessionInsights) ? client.sessionInsights : []).filter(x => {
    const sameBooking = x.bookingId === booking.id;
    const sameOcc = record.occStartAt && x.occStartAt === record.occStartAt;
    return !(sameBooking && sameOcc);
  });
  return client.sessionInsights.length !== before;
}

function renderSessionInsightCards_(client){
  const items = Array.isArray(client?.sessionInsights) ? [...client.sessionInsights] : [];
  items.sort((a,b) => new Date(b.occStartAt || b.createdAt || 0) - new Date(a.occStartAt || a.createdAt || 0));
  if(!items.length){
    return `<div class="itemMeta">Aún no hay recomendaciones previas guardadas para este cliente.</div>`;
  }
  return items.map((ins, idx) => {
    const [lbl, cls] = bookingTypeLabel(ins.sessionType || "tarot");
    const when = formatDateTimeDMYHM(ins.occStartAt || ins.createdAt || "") || "Fecha no disponible";
    return `<article class="sessHistoryCard">
      <div class="sessHistoryHead">
        <div class="sessHistoryHeadMeta">
          <div class="itemMeta">Sesión ${items.length - idx} · ${escapeHtml(when)}</div>
          <span class="badge ${cls}">${lbl}</span>
        </div>
        <button class="btn ghost tiny" data-act="deleteInsight" data-insight-id="${escapeHtml(ins.id || "")}" data-booking-id="${escapeHtml(ins.bookingId || "")}" data-occ="${escapeHtml(ins.occStartAt || "")}" title="Borrar esta recomendación">🗑️</button>
      </div>
      <div class="sessHistoryBody">
        ${ins.recommendations ? `<div><div class="itemMeta">Recomendaciones</div><div>${escapeHtml(ins.recommendations).replace(/\n/g, "<br>")}</div></div>` : ""}
        ${ins.sessionNotes ? `<div><div class="itemMeta">Notas previas</div><div>${escapeHtml(ins.sessionNotes).replace(/\n/g, "<br>")}</div></div>` : ""}
      </div>
    </article>`;
  }).join("");
}

function openClientSessionModal(bookingId, occStartAt=null){
  const b = STATE.bookings.find(x=>x.id===bookingId);
  if(!b){ toast("No encuentro esa sesión."); return; }

  const occIso = occStartAt || b.startAt;
  const dt = new Date(occIso);
  const whenFull = formatDateTimeDMYHM(occIso) || dt.toLocaleString(undefined, { weekday:"long", year:"numeric", month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" });
  const sessionDate = formatDateDMY(occIso) || dt.toLocaleDateString();
  const sessionTime = dt.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });

  const clientStr = b.client || "";
  const info = getClientForBooking_(b);
  const c = info.client;
  const recs = Array.isArray(b.sessionRecords) ? b.sessionRecords : [];
  const recFromLog = recs.find(r => r.occStartAt === occIso) || null;
  const snap = recFromLog?.clientSnapshot || {};

  const zodiac = info.zodiac || snap.zodiac || "";
  const dob = formatDateDMY(c?.dob || snap.dob || "");
  const birthTime = c?.birthTime || snap.birthTime || "";
  const birthPlace = c?.birthPlace || snap.birthPlace || "";
  const phone = c?.phone || snap.phone || "";
  const displayName = info.display || snap.name || (clientStr || "(sin cliente)");
  const handleShow = info.handleShow || snap.handle || (clientStr||"");
  const historyCards = c ? renderSessionInsightCards_(c) : `<div class="itemMeta">Vincula esta sesión a un cliente para ver historial de recomendaciones.</div>`;
  const headerPills = [
    sessionDate ? `<span class="pill">📅 ${escapeHtml(sessionDate)}</span>` : "",
    sessionTime ? `<span class="pill">🕘 Sesión ${escapeHtml(sessionTime)}</span>` : "",
    zodiac ? `<span class="pill">♈ ${escapeHtml(zodiac)}</span>` : "",
    dob ? `<span class="pill">🎂 ${escapeHtml(dob)}</span>` : "",
    birthTime ? `<span class="pill">🕒 Nacimiento ${escapeHtml(birthTime)}</span>` : "",
    birthPlace ? `<span class="pill">📍 ${escapeHtml(birthPlace)}</span>` : "",
    phone ? `<span class="pill">📞 ${escapeHtml(phone)}</span>` : "",
    handleShow ? `<span class="pill">${escapeHtml(handleShow)}</span>` : ""
  ].filter(Boolean).join(" ");

  let rec = recFromLog;
  if(!rec){
    rec = { id: uid("srec"), bookingId: b.id, occStartAt: occIso, createdAt: nowISO(), sessionNotes:"", recommendations:"", clientSnapshot: c ? { id:c.id, name:c.name, handle:c.handle, dob:c.dob, zodiac:c.zodiac, birthTime:c.birthTime, birthPlace:c.birthPlace, phone:c.phone } : { raw: clientStr } };
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
          <div class="itemMeta">Al guardar, estas notas quedan en la sesión y también en el perfil del cliente.</div>
        </div>

        <div class="row">
          <label class="label">Recomendaciones anteriores (solo lectura)</label>
          <div class="sessHistoryViewer">${historyCards}</div>
        </div>
      </div>

      <div class="divider"></div>

      <div class="row">
        <label class="label">Acciones rápidas</label>
        <div class="sessActions">
          <button class="btn" id="mSessEditClient" ${c? "" : "disabled"}>Editar perfil</button>
          <button class="btn" id="mSessCopy" title="Copiar resumen">📋 Copiar</button>
          <button class="btn warn" id="mSessDelete">🗑️ Borrar registro</button>
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
        birthTime ? `Hora de nacimiento: ${birthTime}` : "",
        birthPlace ? `Lugar de nacimiento: ${birthPlace}` : "",
        phone ? `Teléfono: ${phone}` : "",
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

  $("#mSessDelete").onclick = ()=>{
    const hasContent = (($("#mSessNotes").value || "").trim() || ($("#mSessRecs").value || "").trim());
    const hasLogRecord = recs.some(r => (rec.id && r.id === rec.id) || (rec.occStartAt && r.occStartAt === rec.occStartAt));
    if(!hasContent && !hasLogRecord){
      toast("No hay registro guardado para borrar.");
      return;
    }

    if(!window.confirm("¿Seguro que quieres borrar este registro de sesión? Esta acción no se puede deshacer.")) return;

    const removedRecord = deleteBookingRecord_(b.id, rec);
    const removedInsight = deleteClientSessionInsight_(b, rec);
    if(removedInsight && !removedRecord){
      saveState();
      renderBookings();
      renderCalendar();
      updateSyncUI();
    }

    if(removedRecord || removedInsight){
      closeModal();
      toast("Registro de sesión borrado.");
    }else{
      toast("No encontré un registro para borrar.");
    }
  };

  const historyViewerEl = $(".sessHistoryViewer");
  if(historyViewerEl){
    historyViewerEl.addEventListener("click", (e)=>{
      const btn = e.target.closest("button[data-act='deleteInsight']");
      if(!btn || !c) return;

      const insightId = btn.dataset.insightId || "";
      const insightBookingId = btn.dataset.bookingId || "";
      const insightOcc = btn.dataset.occ || "";
      const insight = (Array.isArray(c.sessionInsights) ? c.sessionInsights : []).find(x => {
        if(insightId && x.id === insightId) return true;
        return (!!insightOcc && x.occStartAt === insightOcc && x.bookingId === insightBookingId);
      });
      if(!insight){ toast("No encontré esa recomendación."); return; }

      if(!window.confirm("¿Quieres borrar esta recomendación guardada?")) return;

      const ownerBooking = STATE.bookings.find(x => x.id === insight.bookingId) || null;
      const recordLike = { id: insight.id || null, occStartAt: insight.occStartAt || null };
      let removedRecord = false;
      if(ownerBooking){
        removedRecord = deleteBookingRecord_(ownerBooking.id, recordLike);
      }

      const before = Array.isArray(c.sessionInsights) ? c.sessionInsights.length : 0;
      c.sessionInsights = (Array.isArray(c.sessionInsights) ? c.sessionInsights : []).filter(x => {
        if(insight.id && x.id === insight.id) return false;
        const sameBooking = x.bookingId === insight.bookingId;
        const sameOcc = insight.occStartAt && x.occStartAt === insight.occStartAt;
        return !(sameBooking && sameOcc);
      });
      const removedInsight = c.sessionInsights.length !== before;

      if(removedInsight && !removedRecord){
        saveState();
        renderBookings();
        renderCalendar();
        updateSyncUI();
      }

      if(!removedInsight && !removedRecord){
        toast("No encontré un registro para borrar.");
        return;
      }

      closeModal();
      openClientSessionModal(b.id, occIso);
      toast("Recomendación borrada.");
    });
  }

  function saveOnly(markDone=false){
    rec.sessionNotes = $("#mSessNotes").value || "";
    rec.recommendations = $("#mSessRecs").value || "";
    upsertBookingRecord_(b.id, rec);
    upsertClientSessionInsight_(b, rec);
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
  const getCurrentClientTz = ()=>{
    const selectedId = b?.clientId || prefClientId || "";
    const c = STATE.clients.find(x => String(x.id) === String(selectedId));
    return inferTimezoneFromResidence(c?.residencePlace || "");
  };
  const initialClientTz = getCurrentClientTz();
  const defaultStartHome = utcIsoToZoneInput(defaultStart, HOME_TIMEZONE);
  const defaultStartClient = utcIsoToZoneInput(defaultStart, initialClientTz);

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
        <label class="label">Fecha y hora (${HOME_TIMEZONE_LABEL})</label>
        <input id="mBStartHome" type="datetime-local" class="input" value="${defaultStartHome}" />
        <div id="mBHomeMeta" class="itemMeta">Zona fija: ${HOME_TIMEZONE}.</div>
      </div>

      <div class="row">
        <label class="label">Fecha y hora (cliente)</label>
        <input id="mBStartClient" type="datetime-local" class="input" value="${defaultStartClient}" />
        <div id="mBClientTzMeta" class="itemMeta">Zona cliente: ${initialClientTz} (según residencia).</div>
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
        <label class="label">Costo en dólares ($)</label>
        <input id="mBAmtUsd" type="number" class="input" value="${escapeHtml(String(b?.amountUsd ?? 0))}" min="0" step="0.01" />
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
    const startAt = zoneInputToUtcISO($("#mBStartHome").value, HOME_TIMEZONE);
    const durationMin = Number($("#mBDur").value || 60) || 60;
    const amount = Number($("#mBAmt").value || 0) || 0;
    const amountUsd = Number($("#mBAmtUsd").value || 0) || 0;
    const status = $("#mBStatus").value || "scheduled";
    const notes = $("#mBNotes").value;

    if(!startAt){ toast("Fecha/hora inválida."); return; }

    const repeat = $("#mBRepeat").checked;
    const until = $("#mBUntil").value || null;
    const recurrence = repeat ? { freq:"weekly", interval:1, until } : null;

    const payload = { type, clientId, client, title, startAt, durationMin, amount, amountUsd, status, notes, recurrence };
    if(isEdit) updateBooking(bookingId, payload);
    else addBooking(payload);
    closeModal();
  };

  // Sync client selector -> text
  const sel = $("#mBClientId");
  const txt = $("#mBClient");
  const homeInput = $("#mBStartHome");
  const clientInput = $("#mBStartClient");
  const clientTzMeta = $("#mBClientTzMeta");
  let syncingTz = false;

  function selectedClientTimezone_(){
    const id = sel.value || "";
    const c = STATE.clients.find(x=>String(x.id)===String(id));
    return inferTimezoneFromResidence(c?.residencePlace || "");
  }

  function syncClientFromHome_(){
    if(syncingTz) return;
    const homeIso = zoneInputToUtcISO(homeInput.value, HOME_TIMEZONE);
    if(!homeIso) return;
    const clientTz = selectedClientTimezone_();
    syncingTz = true;
    clientInput.value = utcIsoToZoneInput(homeIso, clientTz);
    syncingTz = false;
  }

  function syncHomeFromClient_(){
    if(syncingTz) return;
    const clientTz = selectedClientTimezone_();
    const iso = zoneInputToUtcISO(clientInput.value, clientTz);
    if(!iso) return;
    syncingTz = true;
    homeInput.value = utcIsoToZoneInput(iso, HOME_TIMEZONE);
    syncingTz = false;
  }

  function refreshClientTimezoneMeta_(){
    const tz = selectedClientTimezone_();
    clientTzMeta.textContent = `Zona cliente: ${tz} (según residencia).`;
  }

  function applyClientSelection_(){
    const id = sel.value || "";
    if(!id){
      txt.placeholder = "Ej: @maria";
      refreshClientTimezoneMeta_();
      syncClientFromHome_();
      return;
    }
    const c = STATE.clients.find(x=>String(x.id)===String(id));
    if(!c) return;
    const handle = c.handle ? "@"+String(c.handle).replace(/^@/,"") : "";
    txt.value = handle || c.name || txt.value;
    refreshClientTimezoneMeta_();
    syncClientFromHome_();
  }
  sel.addEventListener("change", applyClientSelection_);
  homeInput.addEventListener("input", syncClientFromHome_);
  clientInput.addEventListener("input", syncHomeFromClient_);
  // initial
  if(currentClientId && !txt.value) applyClientSelection_();
  refreshClientTimezoneMeta_();
  syncClientFromHome_();
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
        <label class="label">Tipo de cambio (USD → Soles)</label>
        <input id="mExchangeRate" class="input" type="number" min="0.01" step="0.01" value="${escapeHtml(String(SETTINGS.exchangeRate || 3.75))}" placeholder="3.75" style="max-width:120px" />
        <div class="itemMeta">Se usa para convertir ingresos en dólares al calcular tu nivel mensual.</div>
      </div>

      <div class="divider"></div>

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
        <div class="itemMeta">Para enviar usa POST JSON. Para traer datos al asistente, el mismo endpoint debe aceptar ?action=export y devolver JSON/JSONP.</div>
      </div>

      <div class="row">
        <label class="label">API Key (opcional)</label>
        <input id="mApiKey" class="input" value="${escapeHtml(SETTINGS.apiKey||"")}" placeholder="Si quieres validar llamadas" />
      </div>

      <div class="divider"></div>

      <div class="row">
        <label class="label">Imagen de fondo del banner</label>
        <div style="display:flex;align-items:center;gap:12px;margin-top:4px">
          <span class="itemMeta" style="min-width:60px">Sin blur</span>
          <input type="range" id="mHeroBlur" min="0" max="10" step="0.5"
            value="${SETTINGS.heroBlur ?? 1.5}"
            style="flex:1;accent-color:#F4C430" />
          <span class="itemMeta" style="min-width:60px">Máximo</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:6px">
          <span class="itemMeta">Blur actual:</span>
          <strong id="mHeroBlurVal" style="font-size:13px;color:#3A2318">${SETTINGS.heroBlur ?? 1.5}px</strong>
        </div>
        <div class="itemMeta" style="margin-top:4px">Controla el desenfoque de la imagen que pones en el hero.</div>
      </div>

      <div class="row">
        <label class="label">Opacidad del filtro blanco</label>
        <div style="display:flex;align-items:center;gap:12px;margin-top:4px">
          <span class="itemMeta" style="min-width:60px">Sin filtro</span>
          <input type="range" id="mHeroOverlay" min="0" max="1" step="0.05"
            value="${SETTINGS.heroOverlay ?? 0.75}"
            style="flex:1;accent-color:#F4C430" />
          <span class="itemMeta" style="min-width:60px">Total</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:6px">
          <span class="itemMeta">Filtro actual:</span>
          <strong id="mHeroOverlayVal" style="font-size:13px;color:#3A2318">${Math.round((SETTINGS.heroOverlay ?? 0.75)*100)}%</strong>
        </div>
        <div class="itemMeta" style="margin-top:4px">A 0% la imagen se ve directa. Sube para que el texto quede más legible.</div>
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

  // Live blur preview
  const blurSlider = $("#mHeroBlur");
  const blurVal = $("#mHeroBlurVal");
  const bgImgEl = document.getElementById("heroBgImage");
  const bgOvlEl = document.getElementById("heroBgOverlay");
  if(blurSlider){
    blurSlider.addEventListener("input", () => {
      const v = parseFloat(blurSlider.value);
      blurVal.textContent = v + "px";
      if(bgImgEl) bgImgEl.style.filter = "blur(" + v + "px)";
    });
  }

  // Live overlay preview
  const ovlSlider = $("#mHeroOverlay");
  const ovlVal = $("#mHeroOverlayVal");
  function applyOverlayOpacity(opacity){
    if(!bgOvlEl) return;
    bgOvlEl.style.background =
      "linear-gradient(to right," +
      "rgba(254,250,244," + opacity + ") 0%," +
      "rgba(254,250,244," + (opacity * 0.85) + ") 45%," +
      "rgba(254,250,244," + (opacity * 0.95) + ") 65%," +
      "rgba(254,250,244," + Math.min(opacity + 0.08, 1) + ") 100%)";
  }
  if(ovlSlider){
    ovlSlider.addEventListener("input", () => {
      const v = parseFloat(ovlSlider.value);
      ovlVal.textContent = Math.round(v * 100) + "%";
      applyOverlayOpacity(v);
    });
  }

  $("#mOk").onclick = () => {
    SETTINGS.syncEnabled = $("#mSyncEnabled").checked;
    SETTINGS.appsScriptUrl = $("#mScriptUrl").value.trim();
    SETTINGS.apiKey = $("#mApiKey").value.trim();
    const newRate = parseFloat($("#mExchangeRate").value);
    if(!isNaN(newRate) && newRate > 0) SETTINGS.exchangeRate = newRate;
    const newBlur = parseFloat(blurSlider ? blurSlider.value : 1.5);
    if(!isNaN(newBlur)) {
      SETTINGS.heroBlur = newBlur;
      if(bgImgEl) bgImgEl.style.filter = "blur(" + newBlur + "px)";
    }
    const newOverlay = parseFloat(ovlSlider ? ovlSlider.value : 0.75);
    if(!isNaN(newOverlay)) {
      SETTINGS.heroOverlay = newOverlay;
      applyOverlayOpacity(newOverlay);
    }
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
      settings: SETTINGS,
      syncMeta: SYNC_META
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
      const nextSyncMeta = hasBundle && parsed.syncMeta && typeof parsed.syncMeta === "object" ? parsed.syncMeta : null;

      STATE = normalizeState_(nextState);
      if(nextSettings){
        SETTINGS = nextSettings;
        saveSettings();
      }
      if(nextSyncMeta){
        SYNC_META = nextSyncMeta;
        saveSyncMeta();
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
recoverSyncMetaFromIDB();
render();

window.addEventListener("pagehide", () => saveState());

/* ── Hero editable + image picker ── */
(function(){
  const input   = document.getElementById('heroImageInput');
  const ph      = document.getElementById('heroImagePlaceholder');
  const rmBtn   = document.getElementById('heroImageRemove');
  const bgImg   = document.getElementById('heroBgImage');
  const bgOvl   = document.getElementById('heroBgOverlay');
  const heroCard = document.getElementById('heroCard');

  function applyBlur(){
    const blur = (SETTINGS && SETTINGS.heroBlur != null) ? SETTINGS.heroBlur : 1.5;
    bgImg.style.filter = 'blur(' + blur + 'px)';
  }
  function applyOverlay(){
    if(!bgOvl) return;
    const opacity = (SETTINGS && SETTINGS.heroOverlay != null) ? SETTINGS.heroOverlay : 0.75;
    bgOvl.style.background =
      'linear-gradient(to right,' +
      'rgba(254,250,244,' + opacity + ') 0%,' +
      'rgba(254,250,244,' + (opacity * 0.85) + ') 45%,' +
      'rgba(254,250,244,' + (opacity * 0.95) + ') 65%,' +
      'rgba(254,250,244,' + Math.min(opacity + 0.08, 1) + ') 100%)';
  }
  function showImage(src){
    bgImg.style.backgroundImage = 'url(' + src + ')';
    applyBlur();
    applyOverlay();
    bgImg.classList.remove('hidden');
    bgOvl.classList.remove('hidden');
    heroCard.classList.add('has-bg-image');
    rmBtn.classList.remove('hidden');
    ph.classList.add('hidden');
    saveHeroImgToIDB(src);
  }
  function clearImage(){
    bgImg.style.backgroundImage = '';
    bgImg.classList.add('hidden');
    bgOvl.classList.add('hidden');
    heroCard.classList.remove('has-bg-image');
    rmBtn.classList.add('hidden');
    ph.classList.remove('hidden');
    clearHeroImgFromIDB();
    localStorage.removeItem('fergis_hero_img');
  }

  // Restore saved image: try IDB first, migrate from localStorage if needed
  loadHeroImgFromIDB().then(async src => {
    if(src){
      showImage(src);
    } else {
      const lsSrc = localStorage.getItem('fergis_hero_img');
      if(lsSrc){
        await saveHeroImgToIDB(lsSrc);
        localStorage.removeItem('fergis_hero_img');
        showImage(lsSrc);
      }
    }
  });

  input.addEventListener('change', () => {
    const file = input.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = e => showImage(e.target.result);
    reader.readAsDataURL(file);
  });

  rmBtn.addEventListener('click', clearImage);

  // Persist editable text
  ['heroTitle','heroText'].forEach(id => {
    const el = document.getElementById(id);
    if(!el) return;
    const sv = localStorage.getItem('fergis_'+id);
    if(sv) el.textContent = sv;
    el.addEventListener('blur', () => safeLocalStorageSetItem('fergis_'+id, el.textContent, 'Hero text save'));
  });
})();
