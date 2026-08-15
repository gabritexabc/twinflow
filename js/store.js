// store.js — application state, workflow rules and localStorage persistence

const KEY = 'twinflow.v1';
const LEGACY_KEY = 'ifcflow.v1'; // pre-rename, single-project schema

export const ROLES = {
  admin:            { label: 'Administrator' },
  project_director: { label: 'Project Director' },
  site_director:    { label: 'Site Director' },
  foreman:          { label: 'Foreman' },
  quality:          { label: 'Quality Manager' },
  factory:          { label: 'Off-site Factory' },
  logistics:        { label: 'Logistics' },
  site:             { label: 'Site Assembly Team' },
};

// GC-side roles: they run the process on the general contractor's side.
// Admin manages accounts/access; project_director sees every project;
// site_director and foreman are restricted to the projects assigned to them.
export const GC_ROLES = ['admin', 'project_director', 'site_director', 'foreman'];
export const FULL_ACCESS_ROLES = ['admin', 'project_director', 'foreman']; // see & act on every project
// only these roles decide WHAT to order (create/resubmit a production request);
// foreman runs the on-site logistics tail (dispatch → transit → delivery → install)
export const CREATOR_ROLES = ['admin', 'project_director', 'site_director', 'foreman'];
// roles limited to their explicitly assigned projects (user.projectIds): the scoped
// GC roles plus the off-site factory and the on-site assembly team. quality (audit)
// and logistics stay unscoped — they work across every project.
// project_director is scoped too: a firm can run several sites with a director per
// site, so the administrator assigns which projects each one covers. The
// administrator alone stays unscoped and always sees everything.
export const PROJECT_SCOPED_ROLES = ['project_director', 'site_director', 'foreman', 'factory', 'site'];
export const isGcRole = (role) => GC_ROLES.includes(role);
export const hasFullAccess = (role) => FULL_ACCESS_ROLES.includes(role);
export const isProjectScoped = (role) => PROJECT_SCOPED_ROLES.includes(role);

// can this user (role + projectIds) act on/see the given project?
export function userCanAccessProject(user, projectId) {
  if (!user) return false;
  // scope is checked FIRST: a project director has full powers over the projects
  // assigned to them, but "full powers" is not the same as "every project"
  if (isProjectScoped(user.role)) return (user.projectIds || []).includes(projectId);
  if (hasFullAccess(user.role)) return true; // administrator
  return true; // quality (audit) and logistics work across every project
}

// Order workflow: status → who may act on it, and where it can go next.
// Mirrors the industrialized flow: BIM → factory → JIT transport → site assembly.
export const STATUSES = {
  // only project/site directors (+ admin) decide what gets ordered
  draft:      { label: 'Draft',         color: '#64748b', actor: CREATOR_ROLES, next: ['submitted'] },
  submitted:  { label: 'Submitted',     color: '#1666aa', actor: 'factory',   next: ['accepted', 'rejected'] },
  rejected:   { label: 'Rejected',      color: '#d64545', actor: CREATOR_ROLES, next: ['draft'] },
  accepted:   { label: 'Accepted',      color: '#7c5cd6', actor: 'factory',   next: ['production'] },
  production: { label: 'In Production', color: '#b96e14', actor: 'factory',   next: ['ready'] },
  // from here on, the foreman runs the on-site logistics tail: request dispatch,
  // confirm arrival, confirm installation — alongside the external parties involved.
  // requesting dispatch (ready → transit) belongs to the GC side — directors track
  // site progress and decide when the site can receive the load; logistics executes.
  // The factory's job ends at Ready — it does NOT request dispatch.
  ready:      { label: 'Ready (LOD400)',color: '#0090b1', actor: ['logistics', 'foreman', 'site_director'], next: ['transit'] },
  transit:    { label: 'Sent / Transit',color: '#c78b28', actor: ['logistics', 'foreman'], next: ['delivered'] },
  delivered:  { label: 'Delivered',     color: '#439458', actor: ['site', 'foreman'], next: ['installed'] },
  installed:  { label: 'Installed',     color: '#298646', actor: null,        next: [] },
};

export const STATUS_ORDER = Object.keys(STATUSES);

const defaultState = () => ({
  role: 'admin',
  seq: 1,
  projects: [], // [{ id, name, fileName, importedAt, groups, summary }]
  activeProjectId: null,
  parties: [
    { id: 'p-gc',   name: 'Site Preparation',          type: 'admin',     email: '', phone: '' },
    { id: 'p-fab',  name: 'Factory (off-site)',        type: 'factory',   email: '', phone: '' },
    { id: 'p-log',  name: 'Logistics Operator',        type: 'logistics', email: '', phone: '' },
    { id: 'p-site', name: 'Site Assembly Team',        type: 'site',      email: '', phone: '' },
  ],
  orders: [], // each order has a projectId
  components: [], // component catalog + stock balances (quantities are server-managed)
  stockMoves: [], // append-only stock ledger (in / send / consume / adjust)
  procurement: [], // purchase orders on suppliers: awarded → invoiced → delivered
});

// upgrade single-project schema (state.project) to multi-project (state.projects)
function migrate(old) {
  const s = { ...old };
  if (s.project) {
    const prj = { id: uid('prj'), ...s.project };
    s.projects = [prj];
    s.activeProjectId = prj.id;
    (s.orders || []).forEach(o => { if (!o.projectId) o.projectId = prj.id; });
    delete s.project;
  }
  return s;
}

export let state = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY) || localStorage.getItem(LEGACY_KEY);
    if (raw) {
      const s = { ...defaultState(), ...migrate(JSON.parse(raw)) };
      localStorage.setItem(KEY, JSON.stringify(s));
      localStorage.removeItem(LEGACY_KEY);
      return s;
    }
  } catch (e) { console.warn('Failed to load saved state:', e); }
  return defaultState();
}

// localStorage is now only an offline cache + device preferences (role, active project);
// the server (/api/state) is the source of truth shared by every device.
// Large models can push the full state past the ~5 MB localStorage quota — the cache
// must degrade gracefully instead of throwing mid-operation (e.g. during an IFC import).
export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return;
  } catch { /* quota exceeded — try a slimmer cache */ }
  try {
    // drop the heavy takeoff groups; the server re-hydrates them on the next load
    const slim = { ...state, projects: state.projects.map(p => ({ ...p, groups: [] })) };
    localStorage.setItem(KEY, JSON.stringify(slim));
    console.warn('[cache] localStorage quota exceeded — cached a slim copy without QTO groups');
  } catch {
    try { localStorage.removeItem(KEY); } catch { /* private mode / storage denied */ }
    console.warn('[cache] localStorage quota exceeded — offline cache disabled, using server data only');
  }
}

export async function resetAll() {
  localStorage.removeItem(KEY);
  localStorage.removeItem(LEGACY_KEY);
  state = defaultState();
  try { await fetch('api/state', { method: 'DELETE' }); } catch { /* offline */ }
}

// ---------- server sync ----------

let lastRev = 0;

// `rejected` distinguishes the two failures that used to look identical: the
// server REFUSED the write (400/403 — the local copy is now wrong and must go)
// versus the network being down (offline — the local copy is all we have, keep it).
let lastPushError = null;
async function apiPush(path, method, body) {
  let rejected = false;
  try {
    const r = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    serverReached(); // an answer of any kind — even a refusal — means we got through
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { rejected = true; throw new Error(d.error || 'HTTP ' + r.status); }
    if (d.rev) lastRev = d.rev;
    return d;
  } catch (e) {
    console.warn('[sync] push failed:', e.message);
    lastPushError = { rejected, message: e.message };
    return null;
  }
}

// A refused push used to be a console warning only: the local copy had already
// been written and saved, so the UI kept showing a value the server never
// accepted. Callers that change shared records go through this instead — on a
// refusal it reloads the authoritative state (dropping the local edit) and tells
// the UI, so a lost write is never silent. Offline is left alone by design.
let onPushRejected = null;
export function setPushRejectedHandler(fn) { onPushRejected = fn; }

async function apiPushOrRevert(path, method, body) {
  lastPushError = null;
  if (await apiPush(path, method, body)) return true;
  if (!lastPushError?.rejected) return false; // offline — the local copy stands
  const reason = lastPushError.message;
  try {
    applyServerState(await fetchServerState());
    save();
  } catch { /* server went away between the two calls — nothing better to do */ }
  onPushRejected?.(reason);
  return false;
}

function applyServerState(server) {
  lastRev = server.rev || 0;
  state.seq = server.seq ?? state.seq;
  state.projects = server.projects || [];
  // Requests still waiting to be CREATED survive this. The server cannot know about
  // them yet, so taking its list verbatim is exactly what made an offline creation
  // disappear from the screen minutes after the user was told it had been made.
  // Anything the server does list wins — once it exists there, the queued copy is stale.
  const serverOrders = server.orders || [];
  const awaitingCreate = readPendingNew().filter(q => !serverOrders.some(o => o.id === q.id));
  state.orders = [...serverOrders, ...awaitingCreate];
  state.parties = server.parties?.length ? server.parties : state.parties;
  state.components = server.components || [];
  state.stockMoves = server.stockMoves || [];
  state.procurement = server.procurement || [];
  // device-local prefs stay: role; active project must still exist
  if (!state.projects.find(p => p.id === state.activeProjectId)) {
    state.activeProjectId = state.projects[0]?.id || null;
  }
  save();
}

// Fetch api/state and validate the response before it can reach applyServerState:
// a 401 body ({ok:false}) has no projects/orders and would blank out the cached
// state. On session expiry redirect to login (same as ensureAuth in app.js);
// on any other error throw so callers keep the cached data.
async function fetchServerState() {
  const r = await fetch('api/state');
  serverReached();
  if (r.status === 401) { location.href = 'login.html'; throw new Error('unauthorized'); }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// Pull the shared state again, now. The polling loop would get there on its own,
// but an act that rewrites the whole catalogue in one call should not leave the
// screen showing the world as it was — and its result is far too large to hand
// back piecemeal the way a single component upsert does.
export async function refreshFromServer() {
  applyServerState(await fetchServerState());
}

// Load shared state from the server. If the server is empty but this device has
// data (pre-server versions), seed the server with it once — only for full-access
// roles, since a scoped user's "empty" filtered response must never be mistaken
// for a genuinely empty database and overwrite everyone else's projects. Then poll
// for changes made by other devices and notify the UI via onRemoteChange.
export async function initState(onRemoteChange, fullAccess = false) {
  try {
    const server = await fetchServerState();
    const serverEmpty = !(server.projects?.length || server.orders?.length);
    const localHasData = state.projects.length || state.orders.length;
    // `resetAt` says the server was emptied on purpose. An empty server is
    // otherwise indistinguishable from a pre-server installation waiting to be
    // migrated, and this device would helpfully upload the very data an
    // administrator had just erased — on whichever phone happened to open the
    // app next, minutes or days later.
    if (fullAccess && serverEmpty && localHasData && !server.resetAt) {
      await apiPush('api/state', 'PUT', {
        seq: state.seq, projects: state.projects, orders: state.orders, parties: state.parties,
        components: state.components, stockMoves: state.stockMoves, procurement: state.procurement,
      });
    } else {
      applyServerState(server);
    }
  } catch (e) { console.warn('[sync] server unreachable — using cached data:', e.message); }

  // primary channel: server-sent events (instant); fallback: slow polling
  const refresh = async () => {
    applyServerState(await fetchServerState());
    onRemoteChange?.();
  };
  try {
    const es = new EventSource('api/events');
    es.onmessage = (e) => { if (Number(e.data) !== lastRev) refresh().catch(() => {}); };
  } catch { /* EventSource unsupported — polling covers it */ }
  // The heartbeat, and the one that matters most for the notice: it keeps running
  // whether or not anything changed, so it is what tells the UI the server came back.
  const syncIfStale = async () => {
    try {
      const { rev } = await (await fetch('api/rev')).json();
      serverReached();
      if (rev !== lastRev) await refresh();
    } catch { /* offline — try again next tick */ }
  };
  setInterval(syncIfStale, 60000);

  // Coming back to the app is the moment that matters, and it was the one moment nothing
  // covered. Installed as a PWA on a phone, iOS suspends the timer above and drops the
  // EventSource while the app sits in the background; on reopening, the screen shows
  // whatever it held when it was put away, for up to a minute. Acting in that window sends
  // a stale version and the server refuses it — correctly, but the user did nothing wrong
  // and gets told to repeat themselves.
  //
  // So: re-check the moment the app becomes visible again, and once more when the radio
  // comes back. This does not replace the conflict guard — two people really can act at
  // the same second — it removes the case where the only other actor was the clock.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncIfStale();
  });
  window.addEventListener('online', syncIfStale);
}

export async function importFullState(data) {
  const d = await apiPush('api/state', 'PUT', {
    seq: data.seq, projects: data.projects, orders: data.orders, parties: data.parties,
    components: data.components, stockMoves: data.stockMoves, procurement: data.procurement,
  });
  if (d) applyServerState(await fetchServerState());
  return !!d;
}

// ---------- offline queue ----------
// Site connectivity is unreliable: when an order update can't reach the server
// (e.g. a QR scan in a basement), the LATEST snapshot of that order is kept in
// localStorage and re-sent when the connection returns.
//
// Two hard-won rules make this safe:
//  1. ONLY genuine network failures are queued. A server REJECTION (403/400 — a
//     role acting out of turn) must never be queued: the write is invalid and
//     re-sending it forever would corrupt state.
//  2. A queued snapshot never overwrites a NEWER server copy. Every mutation
//     appends a timeline event, so events.length is a monotonic version: if the
//     server's copy has >= events, our queued one is stale and is dropped instead
//     of reverting someone else's change.
// (v2 key: abandons any poisoned queue written by the earlier blind version.)
const PENDING_KEY = 'twinflow.pendingOrders.v2';
try { localStorage.removeItem('twinflow.pendingOrders'); } catch { /* ignore */ }

function readPending() {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY)) || {}; } catch { return {}; }
}
function writePending(map) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(map)); } catch { /* storage full */ }
}

// A SECOND queue, for requests that were never created on the server at all.
//
// The queue above replays PUTs — changes to a request the server already knows. A
// creation cannot go through it: PUT /api/orders/<id> answers "Order not found" for an
// id the server has never seen, so a queued create would be retried forever and dropped.
// It has to be replayed as a POST, and it has to go out BEFORE the PUT queue, or the
// updates to a request arrive before the request does.
//
// An array, not a map: creations are replayed in the order they were made, so two
// requests made offline keep their sequence when the codes are finally assigned.
const PENDING_NEW_KEY = 'twinflow.pendingNewOrders.v1';
function readPendingNew() {
  try { const v = JSON.parse(localStorage.getItem(PENDING_NEW_KEY)); return Array.isArray(v) ? v : []; } catch { return []; }
}
function writePendingNew(list) {
  try { localStorage.setItem(PENDING_NEW_KEY, JSON.stringify(list)); } catch { /* storage full */ }
}

export function pendingSyncCount() { return Object.keys(readPending()).length + readPendingNew().length; }

async function putOrder(order) {
  // returns 'ok' | 'conflict' | 'rejected' | 'offline' so callers can react correctly
  try {
    const r = await fetch('api/orders/' + order.id, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(order),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      if (d.rev) lastRev = d.rev;
      if (d.orderRev !== undefined) order.orderRev = d.orderRev; // keep editing from the new version
      return 'ok';
    }
    // someone else changed this request between our load and our save
    if (r.status === 409 || d.conflict) { console.warn('[sync] order conflict:', d.error); return 'conflict'; }
    console.warn('[sync] order rejected by server:', d.error || ('HTTP ' + r.status));
    return 'rejected';
  } catch { return 'offline'; }
}

// surfaced to the UI so a lost write is never silent
let onOrderConflict = null;
export function setOrderConflictHandler(fn) { onOrderConflict = fn; }

// The UI shows a notice while the app is running on the copy cached on this device.
// Only this module knows when something actually REACHED the server, so it reports the
// fact and app.js decides what to say about it — the same seam as the two handlers above.
//
// This exists because the notice could outlive the outage that caused it. It was raised
// at boot (api/me answering 503 during a server restart is treated as unreachable, not as
// signed out) and lowered in exactly one place: the browser's own `online` event. That
// event fires when the DEVICE regains its connection, which never happens when it was the
// server that went away and came back. The sixty-second poll below kept succeeding, the
// data on screen was fresh, and the bar went on saying it was not.
let onServerReached = null;
export function setServerReachedHandler(fn) { onServerReached = fn; }
// never let a cosmetic notice break a sync
const serverReached = () => { try { onServerReached?.(); } catch { /* ignore */ } };

export async function flushPendingOrders() {
  const pending = readPending();
  const ids = Object.keys(pending);
  if (!ids.length) return 0;
  let serverOrders;
  try { serverOrders = (await (await fetch('api/state')).json()).orders || []; }
  catch { return 0; } // still offline — try again next time
  let flushed = 0;
  for (const id of ids) {
    const local = pending[id];
    const server = serverOrders.find(o => o.id === id);
    // stale-guard: server copy is newer or equal → drop, never revert it
    if (server && (server.events || []).length >= (local.events || []).length) { delete pending[id]; continue; }
    // an offline snapshot carries the version from when it was captured, which is
    // stale by definition — flag it so the server applies the events-count heuristic
    // instead of hard-rejecting field work recorded without coverage
    const res = await putOrder({ ...local, offlineReplay: true });
    if (res === 'offline') break;        // lost connection again — keep the rest
    delete pending[id];                  // 'ok' or 'rejected' both leave the queue
    if (res === 'ok') flushed++;
  }
  writePending(pending);
  return flushed;
}

async function syncOrder(order) {
  const res = await putOrder(order);
  const pending = readPending();
  if (res === 'offline') {
    pending[order.id] = order;           // queue the latest snapshot for retry
    writePending(pending);
  } else {
    if (pending[order.id]) { delete pending[order.id]; writePending(pending); }
    if (res === 'rejected' || res === 'conflict') {
      // the server refused this change — pull authoritative state so the optimistic
      // local edit is undone instead of lingering and being re-pushed
      try { applyServerState(await (await fetch('api/state')).json()); } catch { /* offline */ }
      // a conflict means someone else's edit won: the user must be told, because
      // their action did NOT take effect (this used to overwrite the other person)
      if (res === 'conflict') onOrderConflict?.(order.id);
    }
  }
}

if (typeof window !== 'undefined') {
  // creations first, then the updates to them — the other order fails by definition
  window.addEventListener('online', () => {
    flushPendingNewOrders().then(() => flushPendingOrders()).catch(() => {});
  });
}

export function uid(prefix = 'id') {
  return prefix + '-' + Math.random().toString(36).slice(2, 9);
}

export function nowIso() {
  return new Date().toISOString();
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function fmtNum(n, dec = 2) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: dec });
}

// ---------- Projects ----------

export function activeProject() {
  return state.projects.find(p => p.id === state.activeProjectId) || null;
}

export function getProject(id) {
  return state.projects.find(p => p.id === id) || null;
}

// create an empty project (no IFC yet) — filled in later from the dashboard
export function createProjectShell({ name, address }) {
  const prj = {
    id: uid('prj'),
    name,
    address: address || '',
    lat: null, lon: null,
    fileName: null,
    importedAt: null,
    groups: [],
    summary: { elementCount: 0, totalVolume: 0, totalWeight: 0 },
  };
  state.projects.push(prj);
  state.activeProjectId = prj.id;
  save();
  apiPush('api/projects', 'POST', prj);
  return prj;
}

// attach/replace the parsed IFC data on an existing project, keeping its name/address
export function attachIfcData(id, data) {
  const prj = state.projects.find(p => p.id === id);
  if (!prj) return null;
  Object.assign(prj, data);
  state.activeProjectId = id;
  save();
  apiPush('api/projects', 'POST', prj);
  return prj;
}

// insert or refresh (matched by fileName) a project and make it active
export function upsertProject(data) {
  let prj = state.projects.find(p => p.fileName === data.fileName);
  if (prj) {
    Object.assign(prj, data);
  } else {
    prj = { id: uid('prj'), ...data };
    state.projects.push(prj);
  }
  state.activeProjectId = prj.id;
  save();
  apiPush('api/projects', 'POST', prj);
  return prj;
}

// push project edits (name, address, …) to the server
export function syncProject(prj) {
  save();
  return apiPushOrRevert('api/projects', 'POST', prj);
}

export function deleteProject(id) {
  state.projects = state.projects.filter(p => p.id !== id);
  state.orders = state.orders.filter(o => o.projectId !== id);
  if (state.activeProjectId === id) state.activeProjectId = state.projects[0]?.id || null;
  save();
  return apiPushOrRevert('api/projects/' + id, 'DELETE');
}

// ---------- Parties ----------

export function upsertParty(party) {
  const i = state.parties.findIndex(x => x.id === party.id);
  if (i >= 0) state.parties[i] = party; else state.parties.push(party);
  save();
  return apiPushOrRevert('api/parties', 'POST', party);
}

export function deleteParty(id) {
  state.parties = state.parties.filter(x => x.id !== id);
  save();
  return apiPushOrRevert('api/parties/' + id, 'DELETE');
}

// ---------- Components & warehouse stock ----------
// The catalog is editable client-side, but every QUANTITY is server-managed:
// balances only change via api/stock/move or the automatic consumption applied
// by the server when elements are produced (order PUT). Stock moves are director
// desk actions, so unlike field scans they are NOT offline-queued — a failed call
// simply reports and the user retries.

export const UNITS = ['un', 'kg', 'm', 'm2', 'm3', 'L'];

// like apiPush, but surfaces the server's error message to the caller — stock
// operations need precise feedback (insufficient stock, delete guards, RBAC)
async function apiCall(path, method, body) {
  try {
    const r = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const d = await r.json().catch(() => ({}));
    if (d.rev) lastRev = d.rev;
    // keep whatever else the server sent with the refusal — a rejection often carries
    // the useful part (which component it collided with, which line was short), and
    // rebuilding the object from scratch threw all of that away
    if (!r.ok) return { ...d, ok: false, error: d.error || 'HTTP ' + r.status };
    return d;
  } catch {
    return { ok: false, error: 'offline' };
  }
}

export async function upsertComponent(c) {
  const d = await apiCall('api/components', 'POST', c);
  if (d.ok) { // adopt the server-normalized copy (authoritative balances)
    const i = state.components.findIndex(x => x.id === d.component.id);
    if (i >= 0) state.components[i] = d.component; else state.components.push(d.component);
    save();
  }
  return d;
}

export async function deleteComponent(id) {
  // only remove locally on success — the server refuses components with history
  const d = await apiCall('api/components/' + id, 'DELETE');
  if (d.ok) {
    state.components = state.components.filter(c => c.id !== id);
    save();
  }
  return d;
}

export async function stockMove(m) { // { componentId, type: 'in'|'send'|'adjust', qty, factoryId?, note? }
  const d = await apiCall('api/stock/move', 'POST', m);
  if (d.ok) {
    const i = state.components.findIndex(c => c.id === d.component.id);
    if (i >= 0) state.components[i] = d.component;
    state.stockMoves.push(d.move);
    save();
  }
  return d;
}

// Many references to one factory in a single act. The server applies all of it or
// none of it, so this returns either every updated component or an untouched
// warehouse and the line that failed.
// `shipment` is forwarded whole rather than picked apart field by field. The previous
// version destructured {factoryId, note, lines} and rebuilt the body, so the vehicle
// plate and departure time added later were silently dropped on the way out — the same
// shape of bug as an error handler that keeps only {ok, error}.
export async function stockSendBatch(shipment) {
  const d = await apiCall('api/stock/send-batch', 'POST', shipment);
  if (d.ok) {
    for (const comp of d.components) {
      const i = state.components.findIndex(c => c.id === comp.id);
      if (i >= 0) state.components[i] = comp;
    }
    state.stockMoves.push(...d.moves);
    save();
  }
  return d;
}

// Same contract as the guia email: the client names the LOAD and the document type, and
// the server rebuilds the document from its own ledger. Nothing about the contents, the
// recipient or the numbering comes from here.
export async function atCommunicateShipment({ ts, factoryId, movementType }) {
  const d = await apiCall('api/stock/at-communicate', 'POST', { ts, factoryId, movementType });
  if (d.ok && Array.isArray(d.moves)) {
    // adopt the stamped lines, so the document reopens showing the Código AT
    for (const m of d.moves) {
      const i = state.stockMoves.findIndex(x => x.id === m.id);
      if (i >= 0) state.stockMoves[i] = m;
    }
    save();
  }
  return d;
}

// The client names the LOAD, never the recipient or the body — the server reads both
// from its own records. Nothing here can be turned into a way to mail arbitrary text.
export async function sendGuiaEmail({ ts, factoryId }) {
  return apiCall('api/stock/guia-email', 'POST', { ts, factoryId });
}

export async function stockReverse(moveId) {
  const d = await apiCall('api/stock/reverse', 'POST', { moveId });
  if (d.ok) {
    const i = state.components.findIndex(c => c.id === d.component.id);
    if (i >= 0) state.components[i] = d.component;
    const orig = state.stockMoves.find(m => m.id === moveId);
    if (orig) orig.reversedBy = d.move.id; // strike it through locally right away
    state.stockMoves.push(d.move);
    save();
  }
  return d;
}

export function lowStockComponents() {
  // a withheld warehouse balance (null) can never be "below minimum" — the account
  // bound to a factory is not being told what the warehouse holds, so it must not
  // be shown a shortage it cannot see, act on, or verify
  return activeComponents().filter(c => c.minQty != null && c.warehouseQty != null && c.warehouseQty < c.minQty);
}

// The catalogue minus what has been retired. Everything that offers a component for a
// NEW act reads this; anything looking BACKWARDS (the movement ledger, an existing
// purchase order, a recipe already written) must keep reading `state.components`, or
// archiving would erase the past instead of closing the future.
export function activeComponents() {
  return state.components.filter(c => !c.archivedAt);
}

export async function archiveComponent(id, archived) {
  const d = await apiCall('api/components/' + id + '/archive', 'POST', { archived });
  if (d.ok) {
    const i = state.components.findIndex(c => c.id === id);
    if (i >= 0) state.components[i] = d.component;
    save();
  }
  return d;
}

// ---------- procurement (encomendas a fornecedores) ----------
// adjudicado → faturado → entregue; the delivery step is server-side and records
// the warehouse 'in' movement itself, so procurement and the ledger stay in step

// 'partial' is derived on the server from the lines and never sent by the client — it
// is here so the UI can label and colour it, not so anything can set it.
export const PROCUREMENT_STATUSES = ['awarded', 'invoiced', 'partial', 'delivered'];

// what a line still owes; the whole order view is built from this one number
export const poOutstanding = (line) => Math.max(0, (Number(line.qty) || 0) - (Number(line.qtyReceived) || 0));
export const poLines = (po) => po?.lines || [];

export async function createProcurement({ supplierId, note, lines }) {
  const d = await apiCall('api/procurement', 'POST', { supplierId, note, lines });
  if (d.ok) { state.procurement.push(d.po); save(); }
  return d;
}

// marks the invoice — delivery is per line, see receiveProcurementLine
export async function advanceProcurement(id) {
  const d = await apiCall('api/procurement/advance', 'POST', { id });
  if (d.ok) {
    const i = state.procurement.findIndex(x => x.id === id);
    if (i >= 0) state.procurement[i] = d.po;
    save();
  }
  return d;
}

// Receiving a line books a warehouse entry, so the response carries the component back
// and we adopt it — the same rule every stock write follows, and the reason the balance
// on screen never disagrees with the ledger. qty omitted means "everything still owed".
export async function receiveProcurementLine({ id, lineId, qty }) {
  const d = await apiCall('api/procurement/receive', 'POST', { id, lineId, qty });
  if (d.ok) {
    const i = state.procurement.findIndex(x => x.id === id);
    if (i >= 0) state.procurement[i] = d.po;
    if (d.component) {
      const ci = state.components.findIndex(c => c.id === d.component.id);
      if (ci >= 0) state.components[ci] = d.component;
    }
    if (d.move) state.stockMoves.push(d.move);
    save();
  }
  return d;
}

export async function deleteProcurement(id) {
  const d = await apiCall('api/procurement/' + id, 'DELETE');
  if (d.ok) { state.procurement = state.procurement.filter(x => x.id !== id); save(); }
  return d;
}

// element recipes live on the project keyed by the stable QTO group key
// ('Type|Name'), so they survive IFC model replacement
export function getRecipe(project, groupKey) {
  return project?.recipes?.[groupKey] || [];
}

export function setRecipe(project, groupKey, rows) {
  if (!project.recipes) project.recipes = {};
  if (rows && rows.length) project.recipes[groupKey] = rows;
  else delete project.recipes[groupKey];
  save();
  syncProject(project); // rides POST api/projects (CREATOR_ROLES + project access enforced)
}

// apply the same component lines to MANY group recipes in one shot (one save +
// one server sync). merge (default): add each line, updating qtyPer when the
// component is already in a recipe. replace: the lines become the whole recipe —
// replacing with zero lines clears the recipes of every targeted group.
export function applyRecipeBulk(project, groupKeys, lines, replace = false) {
  if (!project.recipes) project.recipes = {};
  for (const key of groupKeys) {
    if (replace) {
      if (lines.length) project.recipes[key] = lines.map(l => ({ ...l }));
      else delete project.recipes[key];
    } else {
      const cur = (project.recipes[key] || []).map(r => ({ ...r }));
      for (const l of lines) {
        const i = cur.findIndex(r => r.componentId === l.componentId);
        if (i >= 0) cur[i].qtyPer = l.qtyPer; else cur.push({ ...l });
      }
      project.recipes[key] = cur;
    }
  }
  save();
  syncProject(project);
}

// ---------- Orders ----------

export async function createOrder({ projectId, supplierId, needBy, notes, items, zoneId }) {
  const order = {
    id: uid('ord'),
    code: null, // assigned by the server (avoids duplicate codes across devices)
    projectId,
    supplierId,
    needBy: needBy || null,
    zoneId: zoneId || null, // takt zone (optional)
    notes: notes || '',
    items, // [{ key, type, name, unit, qty, volume, area, weight, globalIds }]
    status: 'draft',
    createdAt: nowIso(),
    events: [{ ts: nowIso(), actor: state.role, action: 'Created', note: '' }],
    nonConformities: [],
  };
  // Returns { ok, order, queued, error } — the caller has to be able to tell the three
  // outcomes apart, because they used to be one.
  //
  // apiPush answers null for BOTH a dead network and a server refusal, and this used to
  // treat every null as "offline": it invented a local code, pushed the request into
  // state.orders and the UI said "created". On the next sync applyServerState replaced
  // state.orders with the server's list and the request vanished without a word. The
  // refusal case was the worse of the two — a scoped director posting to a project they
  // cannot reach, or the 503 while the server is still booting, was told the request had
  // been created when it had never existed at all.
  lastPushError = null;
  const resp = await apiPush('api/orders', 'POST', order);
  if (resp?.order) {
    order.code = resp.order.code;
    if (resp.order.orderRev !== undefined) order.orderRev = resp.order.orderRev;
    state.orders.push(order);
    save();
    return { ok: true, order };
  }
  // REFUSED: it never existed, so nothing is kept locally. Saying so is the whole fix.
  if (lastPushError?.rejected) return { ok: false, error: lastPushError.message };
  // Genuinely offline: keep it AND queue it, so it is really created when the radio
  // comes back rather than living on one device until the next sync deletes it.
  order.code = 'PR-' + String(state.seq).padStart(4, '0');
  state.seq += 1;
  state.orders.push(order);
  writePendingNew([...readPendingNew(), order]);
  save();
  return { ok: true, order, queued: true };
}

// Replays the creations recorded without coverage. Runs BEFORE flushPendingOrders so a
// request exists on the server before its updates are pushed at it.
export async function flushPendingNewOrders() {
  const queue = readPendingNew();
  if (!queue.length) return 0;
  let created = 0;
  let i = 0;
  for (; i < queue.length; i++) {
    const order = queue[i];
    lastPushError = null;
    const resp = await apiPush('api/orders', 'POST', order);
    if (resp?.order) {
      // adopt the server's code — the local one was provisional, and two devices
      // offline at once both invented the same number
      const local = state.orders.find(o => o.id === order.id);
      if (local) {
        local.code = resp.order.code;
        if (resp.order.orderRev !== undefined) local.orderRev = resp.order.orderRev;
      }
      created++;
      continue;
    }
    if (lastPushError?.rejected) {
      // refused for good — drop it from the queue AND from the screen, and say why.
      // Keeping it would show a request that no server will ever accept.
      state.orders = state.orders.filter(o => o.id !== order.id);
      onPushRejected?.(lastPushError.message);
      continue;
    }
    break; // still offline — keep this one and everything after it, in order
  }
  writePendingNew(queue.slice(i));
  save();
  return created;
}

export function deleteOrder(id) {
  state.orders = state.orders.filter(o => o.id !== id);
  save();
  // the server refuses to delete a request the factory already accepted; without
  // the revert it vanished from the board and silently came back on the next sync
  return apiPushOrRevert('api/orders/' + id, 'DELETE');
}

// user = { role, projectIds } — the signed-in account, not just its role string.
export function canAdvance(order, user) {
  const st = STATUSES[order.status];
  if (!st || !st.next.length || !user) return [];
  // full access (admin/project director) can always act; otherwise only the
  // designated actor(s) for the current status, and — for GC roles — only
  // within their assigned projects.
  if (hasFullAccess(user.role)) return st.next;
  const actors = Array.isArray(st.actor) ? st.actor : [st.actor];
  if (!actors.includes(user.role)) return [];
  // project-scoped roles (GC + factory + site) may only act within assigned projects
  if (isProjectScoped(user.role) && !userCanAccessProject(user, order.projectId)) return [];
  return st.next;
}

export function advanceOrder(order, toStatus, note = '') {
  const from = order.status;
  order.status = toStatus;
  order.events.push({
    ts: nowIso(),
    actor: state.role,
    action: `${STATUSES[from].label} → ${STATUSES[toStatus].label}`,
    note,
  });
  save();
  syncOrder(order);
}

export function addEvent(order, action, note = '') {
  order.events.push({ ts: nowIso(), actor: state.role, action, note });
  save();
  syncOrder(order);
}

// ---------- non-conformities ----------
// Lifecycle from the site's control table: raising the defect, repairing it and
// VALIDATING the repair are three separate acts — the last one belongs to site
// management, so whoever did the repair never signs it off.
//   open → repaired → validated
// Legacy records (before the lifecycle) carry no status and are treated as open.

export const NC_STATUSES = ['open', 'repaired', 'validated'];
export const ncStatus = (nc) => nc.status || 'open';
// who raises a defect: quality + foremen + the factory (self-reporting a defect on
// the line), plus the directors
export const canRecordNc = (role) => ['quality', 'foreman', 'factory', ...CREATOR_ROLES].includes(role);
// who records the repair itself — per the site's control table, encarregados/qualidade
export const canRepairNc = (role) => ['quality', 'foreman', ...CREATOR_ROLES].includes(role);
// who signs the repair off: site management only (segregation of duties)
export const canValidateNc = (role) => ['admin', 'project_director', 'site_director', 'foreman'].includes(role);

export function addNonConformity(order, note) {
  order.nonConformities.push({
    id: uid('nc'), ts: nowIso(), actor: state.role, note, status: 'open',
  });
  order.events.push({ ts: nowIso(), actor: state.role, action: '⚠ Non-conformity recorded', note });
  save();
  syncOrder(order);
}

// index-addressed: legacy entries have no id, and the list is append-only
export function markNcRepaired(order, index, note = '') {
  const nc = order.nonConformities?.[index];
  if (!nc || ncStatus(nc) !== 'open') return;
  nc.status = 'repaired';
  nc.repairedAt = nowIso();
  nc.repairedBy = state.role;
  if (note) nc.repairNote = note;
  order.events.push({ ts: nowIso(), actor: state.role, action: '🔧 Non-conformity repaired', note: note || nc.note || '' });
  save();
  syncOrder(order);
}

export function markNcValidated(order, index, note = '') {
  const nc = order.nonConformities?.[index];
  if (!nc || ncStatus(nc) !== 'repaired') return;
  nc.status = 'validated';
  nc.validatedAt = nowIso();
  nc.validatedBy = state.role;
  if (note) nc.validationNote = note;
  order.events.push({ ts: nowIso(), actor: state.role, action: '✅ Repair validated by site management', note: note || nc.note || '' });
  save();
  syncOrder(order);
}

// a repair that was signed off is closed; anything else still needs attention
export function openNcCount(order) {
  return (order.nonConformities || []).filter(nc => ncStatus(nc) !== 'validated').length;
}

// ---------- shop drawings / validação para fabricação ----------
// Engineering phase between Accepted and In Production, from the site's control
// table: the factory submits the shop drawings, the Project Director validates
// them, and only then may fabrication start. Modelled as a record on the order
// (like the JIT gate) rather than extra kanban columns.
//   pending → submitted → validated

export const sdStatus = (o) => o.shopDrawings?.status || 'pending';
export const canSubmitShopDrawings = (role) => role === 'factory' || hasFullAccess(role);
// the control table assigns this validation to the Project Director specifically
export const canValidateShopDrawings = (role) => ['admin', 'project_director', 'foreman'].includes(role);

export function submitShopDrawings(order, ref = '') {
  order.shopDrawings = {
    status: 'submitted', ref: ref || '',
    submittedAt: nowIso(), submittedBy: state.role,
  };
  order.events.push({ ts: nowIso(), actor: state.role, action: '📐 Shop drawings submitted', note: ref });
  save();
  syncOrder(order);
}

export function validateShopDrawings(order, note = '') {
  if (sdStatus(order) !== 'submitted') return;
  Object.assign(order.shopDrawings, {
    status: 'validated', validatedAt: nowIso(), validatedBy: state.role,
    ...(note ? { validationNote: note } : {}),
  });
  order.events.push({ ts: nowIso(), actor: state.role, action: '✅ Validated for fabrication', note });
  save();
  syncOrder(order);
}

export function orderItemCount(order) {
  return order.items.reduce((s, it) => s + (Number(it.qty) || 0), 0);
}

// ---------- per-element tracking (QR scans, as-built) ----------
// order.tracking = { [globalId]: { built, loaded, lifted, fixed } } — ISO timestamps

export function orderGlobalIds(order) {
  return order.items.flatMap(it => it.globalIds || []);
}

export function markTracking(order, gid, phase, label) {
  order.tracking = order.tracking || {};
  const t = order.tracking[gid] = order.tracking[gid] || {};
  t[phase] = nowIso();
  order.events.push({ ts: nowIso(), actor: state.role, action: `📷 ${label}: ${gid}`, note: '' });
  save();
  syncOrder(order);
}

// factory records several elements as built in one action
export function markBuiltBatch(order, gids) {
  markPhaseBatch(order, gids, 'built', 'As built');
}

// site work happens in batches (a whole floor is grouted in one go), so every
// per-element phase can be ticked off for many elements at once
export function markPhaseBatch(order, gids, phase, label) {
  if (!gids.length) return;
  order.tracking = order.tracking || {};
  const ts = nowIso();
  for (const g of gids) (order.tracking[g] = order.tracking[g] || {})[phase] = ts;
  order.events.push({ ts, actor: state.role, action: `${label}: ${gids.length} element(s)`, note: '' });
  save();
  syncOrder(order);
}

export function trackingCount(order, phase) {
  return Object.values(order.tracking || {}).filter(t => t[phase]).length;
}

// ---------- embodied carbon (indicative estimate) ----------
// Coarse cradle-to-gate factors in the spirit of ICE-style databases: weight-based
// when the takeoff carries weight (steel structures), volume-based otherwise
// (precast concrete). Replace with product EPDs for anything contractual.
const CO2_PER_KG_STEEL = 1.9; // kg CO2e / kg structural steel
const CO2_PER_M3_CONCRETE = 300; // kg CO2e / m³ reinforced precast concrete

export function itemCarbon(it) {
  if (it.weight) return it.weight * CO2_PER_KG_STEEL;
  if (it.volume) return it.volume * CO2_PER_M3_CONCRETE;
  return 0;
}
export function orderCarbon(order) { return (order.items || []).reduce((s, it) => s + itemCarbon(it), 0); }
export function projectCarbon(p) { return (p.groups || []).reduce((s, g) => s + itemCarbon(g), 0); }

// ---------- inspection gates ----------
// Quality checkpoints at the two physical hand-offs (factory exit → 'ready',
// site reception → 'delivered'), as in RFID/BIM precast tracking literature.
// insp: { gate, pass, checks: {k: bool}, note, photo (dataURL | null) }
export function recordInspection(order, insp) {
  order.inspections = order.inspections || [];
  order.inspections.push({ ts: nowIso(), actor: state.role, ...insp });
  order.events.push({
    ts: nowIso(), actor: state.role,
    action: `🔍 Inspection (${insp.gate}): ${insp.pass ? 'passed' : 'FAILED'}`,
    note: insp.note || '',
  });
  if (!insp.pass) {
    order.nonConformities = order.nonConformities || [];
    order.nonConformities.push({ ts: nowIso(), actor: state.role, note: insp.note || 'Inspection failed' });
  }
  save();
  syncOrder(order);
}

// ---------- partial shipments (loads) ----------
// A request with many elements rarely travels in one truck: logistics sends it
// to site in several loads, each tracked transit → delivered on its own.

// key -> qty already put on a load
export function shipmentShipped(order) {
  const m = new Map();
  for (const s of order.shipments || []) {
    for (const it of s.items) m.set(it.key, (m.get(it.key) || 0) + it.qty);
  }
  return m;
}

// key -> qty still waiting at the factory
export function shipmentRemaining(order) {
  const shipped = shipmentShipped(order);
  const m = new Map();
  for (const it of order.items) {
    const rem = it.qty - (shipped.get(it.key) || 0);
    if (rem > 0) m.set(it.key, rem);
  }
  return m;
}

// items: [{key, name, qty}] — only what this load carries
export function createShipment(order, items) {
  order.shipments = order.shipments || [];
  const num = order.shipments.length + 1;
  const ship = { id: uid('shp'), num, items, status: 'transit', createdAt: nowIso(), by: state.role };
  order.shipments.push(ship);
  const n = items.reduce((s, i) => s + i.qty, 0);
  order.events.push({
    ts: nowIso(), actor: state.role,
    action: `🚚 Load ${num} sent: ${n} element(s)`,
    note: items.map(i => `${i.qty}× ${i.name}`).join(', '),
  });
  if (order.status === 'ready') {
    order.status = 'transit';
    order.events.push({ ts: nowIso(), actor: state.role, action: 'Ready (LOD400) → Sent / Transit', note: `Partial load ${num}` });
  }
  save();
  syncOrder(order);
  return ship;
}

export function markShipmentDelivered(order, shipmentId) {
  const s = (order.shipments || []).find(x => x.id === shipmentId);
  if (!s || s.status === 'delivered') return;
  s.status = 'delivered';
  s.deliveredAt = nowIso();
  order.events.push({ ts: nowIso(), actor: state.role, action: `📦 Load ${s.num} delivered`, note: '' });
  // the whole request is only Delivered when nothing is left at the factory
  // and every load that left has arrived
  const allArrived = order.shipments.every(x => x.status === 'delivered');
  if (allArrived && shipmentRemaining(order).size === 0 && order.status === 'transit') {
    order.status = 'delivered';
    order.events.push({ ts: nowIso(), actor: state.role, action: 'Sent / Transit → Delivered', note: 'All loads delivered' });
  }
  save();
  syncOrder(order);
}

// ---------- KPIs ----------

// pass a projectId to scope the KPIs to one project; omit for the whole portfolio
export function computeKpis(projectId = null) {
  const orders = projectId ? state.orders.filter(o => o.projectId === projectId) : state.orders;
  const perStatus = {};
  STATUS_ORDER.forEach(s => perStatus[s] = { orders: 0, elements: 0 });
  let totalElements = 0;
  for (const o of orders) {
    const n = orderItemCount(o);
    perStatus[o.status].orders += 1;
    perStatus[o.status].elements += n;
    totalElements += n;
  }
  const installed = perStatus.installed.elements;
  const delivered = installed + perStatus.delivered.elements;

  // productivity: installed elements per distinct day with an "→ Installed" event
  const installDays = new Set();
  let cycleSumMs = 0, cycleCount = 0;
  let ncCount = 0, ncOpen = 0;
  // PPC (Last Planner System): requests with a JIT date that were delivered on time
  const today = new Date().toISOString().slice(0, 10);
  let dueCount = 0, onTimeCount = 0;
  for (const o of orders) {
    // orders can arrive from the API/import without every optional field
    ncCount += (o.nonConformities || []).length;
    ncOpen += openNcCount(o); // still awaiting repair or sign-off
    if (o.needBy) {
      // imported events may lack action/ts — treat them as empty strings
      const doneEvt = (o.events || []).find(e => (e.action || '').includes('→ Delivered') || (e.action || '').includes('→ Installed'));
      if (doneEvt) {
        dueCount++;
        if ((doneEvt.ts || '').slice(0, 10) <= o.needBy) onTimeCount++;
      } else if (o.needBy < today) {
        dueCount++; // overdue and still not delivered
      }
    }
    let deliveredTs = null;
    for (const e of o.events || []) {
      if ((e.action || '').includes('→ Delivered')) deliveredTs = e.ts;
      if ((e.action || '').includes('→ Installed')) {
        installDays.add((e.ts || '').slice(0, 10));
        if (deliveredTs) {
          cycleSumMs += new Date(e.ts) - new Date(deliveredTs);
          cycleCount++;
        }
      }
    }
  }
  return {
    totalOrders: orders.length,
    totalElements,
    installed,
    delivered,
    perStatus,
    installedPerDay: installDays.size ? installed / installDays.size : null,
    avgCycleHours: cycleCount ? cycleSumMs / cycleCount / 3.6e6 : null,
    ncCount,
    ncOpen,
    ncRate: installed ? (ncCount / installed) * 100 : null,
    ppc: dueCount ? (onTimeCount / dueCount) * 100 : null,
    dueCount,
  };
}
