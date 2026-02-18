// Fergis Assistant v0.1
// Local-first + cola de eventos para sync a Google Sheets (Apps Script) cuando lo activemos.
// Importante: esto es un arranque estable, con estructura clara para crecer.

const LS_KEY = "fa_v01_state";
const SETTINGS_KEY = "fa_v01_settings";

const DEFAULT_SETTINGS = {
  syncEnabled: false,
  appsScriptUrl: "",        // ejemplo: https://script.google.com/macros/s/XXXX/exec
  apiKey: ""                // opcional (si lo quieres validar en Apps Script)
};

const nowISO = () => new Date().toISOString();
const todayKey = () => new Date().toISOString().slice(0,10);

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
    clients: [],
    ideas: [],
    eventQueue: [],  // para sync incremental
    planWeekId: null
  };
}
function saveState(){
  localStorage.setItem(LS_KEY, JSON.stringify(STATE));
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

// ---------- State normalization + Plan Girasol seeding ----------
function normalizeState_(st){
  st = st || {};
  st.v = st.v || "0.1";
  st.tasks = Array.isArray(st.tasks) ? st.tasks : [];
  st.sessions = Array.isArray(st.sessions) ? st.sessions : [];
  st.clients = Array.isArray(st.clients) ? st.clients : [];
  st.ideas = Array.isArray(st.ideas) ? st.ideas : [];
  st.eventQueue = Array.isArray(st.eventQueue) ? st.eventQueue : [];
  st.planWeekId = st.planWeekId || null;

  // Back-compat: tasks sin category -> mission
  for(const t of st.tasks){
    if(!t.category) t.category = "mission"; // mission | plan
    if(!t.pinnedDay) t.pinnedDay = todayKey();
  }
  return st;
}

function seedPlanGirasolIfNeeded_(){
  const currentWeek = weekIdISO(new Date());
  if(STATE.planWeekId === currentWeek) return;

  // Seed una vez por semana: Plan Girasol base
  const ws = weekStartMonday(new Date());
  const createdAt = nowISO();

  const daily = [
    "Historia: 1 story (presencia suave)",
    "Responder DMs pendientes (5-10 min)",
    "Engagement: 5 interacciones reales"
  ];

  const weeklyByDow = {
    0: ["Post educativo (autoridad)"],      // Monday
    2: ["Post emocional/relatable (conexión)"], // Wednesday
    4: ["CTA directo: agenda/servicio (conversión)"] // Friday
  };

  const extrasByDow = {
    6: ["Revisión semanal: ordenar leads + próximos pasos"] // Sunday
  };

  const newTasks = [];
  for(let i=0;i<7;i++){
    const d = addDays(ws, i);
    const dayKey = dateKey(d);
    // diarios
    for(const title of daily){
      newTasks.push(makeTask_(title, { pinnedDay: dayKey, category: "plan", createdAt }));
    }
    // semanales por día
    const dow = i; // 0..6 Mon..Sun
    const w = weeklyByDow[dow] || [];
    for(const title of w){
      newTasks.push(makeTask_(title, { pinnedDay: dayKey, category: "plan", createdAt }));
    }
    const ex = extrasByDow[dow] || [];
    for(const title of ex){
      newTasks.push(makeTask_(title, { pinnedDay: dayKey, category: "plan", createdAt }));
    }
  }

  // Insertamos al inicio (para que aparezcan arriba por día)
  STATE.tasks = [...newTasks.reverse(), ...STATE.tasks];

  // Registrar eventos para sync (solo si sync está habilitado o si quieres data completa)
  for(const t of newTasks){
    enqueueEvent("task_add", t);
  }

  STATE.planWeekId = currentWeek;
  saveState();
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
let STATE = normalizeState_(loadState());
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
  renderPlanDaySelect();
  renderPlan();
  renderTasks();
  renderSessionTaskSelect();
  renderSessions();
  renderClients();
  renderIdeas();
  renderMetrics();
  updateSyncUI();
}

function renderPlanDaySelect(){
  const sel = $("#planDaySelect");
  if(!sel) return;
  const ws = weekStartMonday(new Date());
  const today = todayKey();

  const opts = [];
  for(let i=0;i<7;i++){
    const d = addDays(ws, i);
    const key = dateKey(d);
    const label = d.toLocaleDateString(undefined, { weekday:"short", month:"short", day:"numeric" });
    const selected = (key === (sel.value || today)) ? "selected" : "";
    opts.push(`<option value="${key}" ${selected}>${label}</option>`);
  }
  // If current value not in this week, default to today
  sel.innerHTML = opts.join("");
  if(!sel.value) sel.value = today;
}

function renderPlan(){
  const list = $("#planList");
  const sel = $("#planDaySelect");
  if(!list || !sel) return;

  const dayKey = sel.value || todayKey();
  const items = STATE.tasks.filter(t => t.pinnedDay === dayKey && (t.category === "plan"));

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

  list.innerHTML = items.map(t => {
    const done = !!t.doneAt;
    return `<div class="item">
      <div class="itemLeft">
        <button class="btn ${done ? "primary":""}" data-act="planToggle" data-id="${t.id}" title="Marcar hecho">
          ${done ? "✓":"○"}
        </button>
        <div>
          <div class="itemTitle">${escapeHtml(t.title)}</div>
          <div class="itemMeta">${done ? "Hecho ✅" : "Por hacer"} • ${t.pinnedDay}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
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

  const tasksToday = STATE.tasks.filter(t => t.pinnedDay === day).slice(0,3);
  const pending = tasksToday.filter(t => !t.doneAt).length;
  $("#mPendingTasks").textContent = String(pending);
}

function renderTasks(){
  const day = todayKey();
  const list = $("#tasksList");
  const missionsToday = STATE.tasks
    .filter(t => t.pinnedDay === day && (t.category || "mission") !== "plan")
    .slice(0,3);

  if(!missionsToday.length){
    list.innerHTML = `<div class="item"><div class="itemLeft">
      <div>
        <div class="itemTitle">Sin misiones todavía</div>
        <div class="itemMeta">Agrega 1 o 2 cosas pequeñas. Máximo 3. 🧩</div>
      </div></div>
      <div><span class="pill">Tip: 5-10 min</span></div>
    </div>`;
    return;
  }

  list.innerHTML = missionsToday.map(t => {
    const done = !!t.doneAt;
    return `<div class="item">
      <div class="itemLeft">
        <button class="btn ${done ? "primary":""}" data-act="taskToggle" data-id="${t.id}" title="Marcar hecho">
          ${done ? "✓":"○"}
        </button>
        <div>
          <div class="itemTitle">${escapeHtml(t.title)}</div>
          <div class="itemMeta">${done ? "Hecho ✅" : "Pendiente"} • ${new Date(t.createdAt).toLocaleString()}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn ghost" data-act="taskDelete" data-id="${t.id}" title="Eliminar">🗑</button>
      </div>
    </div>`;
  }).join("");
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
    return `<div class="item">
      <div class="itemLeft">
        <div>
          <div class="itemTitle">${escapeHtml(name)} <span class="pill">${escapeHtml(handle)}</span></div>
          <div class="itemMeta"><b>Próximo:</b> ${next}</div>
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
function openModal(title, bodyHtml, footHtml=""){
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = bodyHtml;
  $("#modalFoot").innerHTML = footHtml;
  $("#modalOverlay").classList.remove("hidden");
}
function closeModal(){
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
  $("#btnAddTask").addEventListener("click", () => {
    openTaskModal_({ category: "mission", pinnedDay: todayKey() });
  });

  $("#btnAddPlanTask").addEventListener("click", () => {
    const day = $("#planDaySelect")?.value || todayKey();
    openTaskModal_({ category: "plan", pinnedDay: day });
  });

  $("#planDaySelect").addEventListener("change", () => {
    renderPlan();
  });

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

        <div class="row">
          <label class="label">Fecha</label>
          <input id="mTaskDay" type="date" class="input" value="${defDay}" />
          <div class="itemMeta">Puedes planear para otro día sin cargar el “hoy”.</div>
        </div>

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
      const day = $("#mTaskDay").value || todayKey();
      const cat = $("#mTaskCat").value || "mission";

      if(!title){ toast("Escribe un título."); return; }

      if(cat === "mission" && day === todayKey()){
        const count = STATE.tasks.filter(t => t.pinnedDay===day && (t.category||"mission")!=="plan").slice(0,3).length;
        if(count >= 3){ toast("Máximo 3 misiones para hoy."); return; }
      }

      addTask(title, { pinnedDay: day, category: cat });
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

  $("#tasksList").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if(!btn) return;
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    if(act==="taskToggle") toggleTaskDone(id);
    if(act==="taskDelete") deleteTask(id);
  });

  $("#planList").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if(!btn) return;
    const act = btn.dataset.act;
    const id = btn.dataset.id;

    if(act==="planToggle") toggleTaskDone(id);
    if(act==="planDelete") deleteTask(id);

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
          <div class="row">
            <label class="label">Fecha</label>
            <input id="mEditDay" type="date" class="input" value="${t.pinnedDay}" />
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
        const day = $("#mEditDay").value || t.pinnedDay;
        if(!title){ toast("Título vacío."); return; }
        t.title = title;
        t.pinnedDay = day;
        enqueueEvent("task_update", { id: t.id, patch: { title, pinnedDay: day, category: t.category || "plan" } });
        saveState();
        renderPlanDaySelect();
        render();
        closeModal();
      };
    }
  });


  $("#clientFilter").addEventListener("change", renderClients);
  $("#clientSearch").addEventListener("input", renderClients);

  $("#btnSettings").addEventListener("click", openSettings);
  $("#btnSync").addEventListener("click", syncNow);

  $("#modalClose").addEventListener("click", closeModal);
  $("#modalOverlay").addEventListener("click", (e)=>{ if(e.target.id==="modalOverlay") closeModal(); });

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
        <label class="label">Próximo paso</label>
        <input id="mCNext" class="input" value="${escapeHtml(c?.nextStep||"")}" placeholder="Ej: enviar propuesta / pedir fecha de nacimiento" />
      </div>
      <div class="row">
        <label class="label">Notas</label>
        <input id="mCNotes" class="input" value="${escapeHtml(c?.notes||"")}" placeholder="Opcional" />
      </div>
    `,
    `
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn primary" id="mOk">${isEdit ? "Guardar" : "Agregar"}</button>
    `
  );

  $("#mCancel").onclick = closeModal;
  $("#mOk").onclick = () => {
    const obj = {
      name: $("#mCName").value,
      handle: $("#mCHandle").value,
      status: $("#mCStatus").value,
      nextStep: $("#mCNext").value,
      notes: $("#mCNotes").value
    };
    if(isEdit) updateClient(clientId, obj);
    else addClient(obj);
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
        <label class="label">Exportar respaldo (JSON)</label>
        <button class="btn" id="btnExport">⬇ Exportar</button>
      </div>

      <div class="row">
        <label class="label">Importar respaldo</label>
        <input type="file" id="fileImport" class="input" accept="application/json" />
        <div class="itemMeta">Importa sobreescribiendo el estado local.</div>
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
    const blob = new Blob([JSON.stringify(STATE, null, 2)], { type:"application/json" });
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
      if(!parsed || !parsed.v) throw new Error("Formato inválido");
      STATE = parsed;
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

seedPlanGirasolIfNeeded_();
wire();
render();