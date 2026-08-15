// app.js — UI orchestration for TwinFlow

import {
  state, save, resetAll, uid, nowIso, fmtDate, fmtNum,
  ROLES, STATUSES, STATUS_ORDER, CREATOR_ROLES, PROJECT_SCOPED_ROLES, hasFullAccess, isGcRole,
  activeProject, getProject, upsertProject, syncProject, deleteProject, createProjectShell, attachIfcData,
  upsertParty, deleteParty, initState, importFullState,
  UNITS, upsertComponent, deleteComponent, stockMove, stockReverse, lowStockComponents, getRecipe, setRecipe, applyRecipeBulk, refreshFromServer,
  activeComponents, archiveComponent, stockSendBatch, sendGuiaEmail, atCommunicateShipment,
  createProcurement, advanceProcurement, receiveProcurementLine, deleteProcurement, poLines, poOutstanding,
  createOrder, deleteOrder, canAdvance, advanceOrder, addEvent, addNonConformity, orderItemCount, computeKpis,
  setOrderConflictHandler, setPushRejectedHandler, setServerReachedHandler,
  ncStatus, canRecordNc, canRepairNc, canValidateNc, markNcRepaired, markNcValidated, openNcCount,
  sdStatus, canSubmitShopDrawings, canValidateShopDrawings, submitShopDrawings, validateShopDrawings,
  orderGlobalIds, markTracking, markBuiltBatch, markPhaseBatch, trackingCount,
  shipmentRemaining, createShipment, markShipmentDelivered, flushPendingOrders, flushPendingNewOrders, recordInspection,
  orderCarbon, projectCarbon,
} from './store.js';
// The 3D viewer (three.js) and the IFC reader (web-ifc) are 6.4 MB of JavaScript
// uncompressed — 94% of everything this app ships to the browser. They used to be
// static imports, so an encarregado opening the Activity Log on a phone downloaded
// and PARSED the whole 3D stack just to look at a table. They now load on first
// entry to the Model view, which is the only place they are needed.
//
// V and I hold the module namespaces once loaded. Everywhere outside the model
// workflow uses `V?.` — before the first visit those calls are no-ops, which is
// exactly right: there is no viewer to update yet.
let V = null; // viewer.js
let I = null; // ifc.js
let viewerStack = null;
function loadViewerStack() {
  if (!viewerStack) {
    viewerStack = Promise.all([import('./viewer.js'), import('./ifc.js')]).then(([v, i]) => {
      V = v; I = i;
      V.initViewer($('#viewer-canvas'));
      // selection callback lived at module top level before; it has to be registered
      // here now, or it would be lost when the module arrives late
      V.onSelect((expressID, selection) => renderElementPanel(expressID, selection));
      V.setViewerActive(currentView() === 'model' && modelTab === 'model');
    }).catch((e) => {
      viewerStack = null; // let a later attempt retry instead of failing forever
      console.error('[viewer] failed to load the 3D stack:', e);
      toast(t('model.loadFailed'));
      throw e;
    });
  }
  return viewerStack;
}
const currentView = () => document.querySelector('.view.active')?.id.replace('view-', '') || '';
import { saveIfcFile, getIfcFile, deleteIfcFile, clearIfcFiles } from './files.js';
import { LANGS, setLang, getLang, t } from './i18n.js';

let currentModelID = null;
let currentElements = [];   // per-element rows of the model currently in the 3D viewer
let currentStoreys = [];    // building storeys of the model currently in the 3D viewer
let loadedProjectId = null; // which project's model is currently in the viewer
// a big IFC parses for seconds; if the user switches project meanwhile, the slow
// in-flight load must NOT land in the viewer on top of the new project. Every load
// captures this token and aborts applying its results once it's been superseded.
let modelLoadToken = 0;

// progress overlay on the 3D viewer. The bar animates on the compositor, so it
// keeps moving during the main-thread block of parsing/mesh-building.
function showViewerLoading(label) {
  const el = document.querySelector('#viewer-loading');
  if (!el) return;
  document.querySelector('#viewer-loading-label').textContent = label;
  el.classList.remove('hidden');
}
function hideViewerLoading() {
  document.querySelector('#viewer-loading')?.classList.add('hidden');
}
// yield so the browser paints the overlay before we block the thread. Uses a
// timeout, not requestAnimationFrame — rAF never fires in a backgrounded tab and
// would hang the whole load if the user switched tabs mid-parse.
const paintYield = () => new Promise(r => setTimeout(r, 40));

// global busy indicator — a top bar + centered pill visible in EVERY view, so a
// dashboard "Replace IFC" (viewer not on screen) still tells the user work is
// happening. Indeterminate by default; call busyProgress(frac) for a real %.
function busyStart(label) {
  const el = document.querySelector('#busy');
  if (!el) return;
  document.querySelector('#busy-label').textContent = label;
  el.classList.add('indet');
  document.querySelector('#busy-fill').style.width = '';
  el.classList.remove('hidden');
}
function busyLabel(label) {
  const l = document.querySelector('#busy-label');
  if (l) l.textContent = label;
}
function busyProgress(frac) { // 0..1 — switches the bar to determinate
  const el = document.querySelector('#busy');
  if (!el) return;
  el.classList.remove('indet');
  document.querySelector('#busy-fill').style.width = Math.max(3, Math.min(100, frac * 100)) + '%';
}
function busyDone() { document.querySelector('#busy')?.classList.add('hidden'); }

// upload an IFC with a real progress bar (XHR exposes upload progress; fetch doesn't)
function uploadIfc(projectId, buffer) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', 'api/ifc/' + projectId);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) busyProgress(e.loaded / e.total);
    };
    xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({ ok: xhr.status < 300 }); } };
    xhr.onerror = () => resolve(null);
    xhr.send(buffer);
  });
}
let modelFilter = null;     // { types: Set, storeys: Set } from the viewer checkboxes; null = show all
let qtoGroups = null;       // groups currently displayed in the QTO table (may be filtered)
const qtoSelection = new Map(); // groupKey -> qty to order (scoped to the active project)

// Registered after load so it never competes with the app's own first paint for bandwidth.
// The worker is network-first (see sw.js), so this changes nothing while there is signal —
// it is what makes the app open at all when there is none.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => {
      // A worker that fails to register must never take the app with it: the site works
      // exactly as before without one. Most often this is an unsupported context (http on
      // a LAN address, or private browsing), which is not worth troubling the user about.
      console.warn('[pwa] service worker não registado:', e.message);
    });
  });
}

// A <label> that opens a file picker is not a button: it never enters the tab order, so
// the Model view's primary action ("Open IFC file…") could be reached with a mouse only.
// The markup marks it role="button" tabindex="0"; this forwards the two keys a button
// answers to. Clicking the label is what already opens the picker, so this changes
// nothing for a mouse user.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest?.('label[role="button"][tabindex]');
  if (!el) return;
  e.preventDefault();
  el.click();
});

// ---------------------------------------------------------------- helpers

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// translated labels for the ROLES / STATUSES keys defined in store.js
const roleLabel = (role) => t('role.' + role) || ROLES[role]?.label || role;
const statusLabel = (status) => t('status.' + status) || STATUSES[status]?.label || status;

// JIT display: before production starts, o.needBy is only a planning estimate;
// openJitModal() sets needByTime once production locks in the binding slot
const jitLabel = (o) => !o.needBy ? null
  : o.needByTime ? `JIT ${o.needBy} ${o.needByTime}` : `~${o.needBy} (${t('order.jit.estimate')})`;

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  // long messages (a conflict warning the user must act on) need longer than a
  // short confirmation — roughly reading speed, capped so it never lingers
  const ms = Math.min(9000, Math.max(2600, msg.length * 55));
  el._timer = setTimeout(() => el.classList.add('hidden'), ms);
}

function openModal(html) {
  const body = $('#modal-body');
  body.innerHTML = html;
  delete body.dataset.kind; // openers that support live refresh re-set this
  $('#modal-backdrop').classList.remove('hidden');
}
function closeModal() {
  $('#modal-backdrop').classList.add('hidden');
  $('#modal-body').innerHTML = '';
}
// deliberately no backdrop-click-to-close: forms lose unsaved input to a stray
// misclick otherwise — closing is only via Cancel/confirm/✕ inside the modal

// human-readable description of who can act next on an order status
function actorLabel(actorField) {
  if (!actorField) return '—';
  const actors = Array.isArray(actorField) ? actorField : [actorField];
  if (actors.length === CREATOR_ROLES.length && CREATOR_ROLES.every(r => actors.includes(r))) return t('actor.creators');
  return actors.map(roleLabel).join(' / ');
}

function statusBadge(status) {
  const st = STATUSES[status];
  return `<span class="badge" style="background:${st.color}22;color:var(--st-${status}-ink);border:1px solid ${st.color}55">${statusLabel(status)}</span>`;
}

function partyName(id) {
  return state.parties.find(p => p.id === id)?.name || '—';
}
const compName = (id) => state.components.find(c => c.id === id)?.name || '—';
const compUnit = (id) => state.components.find(c => c.id === id)?.unit || '';

// ---------------------------------------------------------------- navigation

const VIEW_TITLE_KEYS = {
  dashboard: 'view.dashboard',
  model: 'view.model',
  orders: 'view.orders',
  planning: 'view.planning',
  stock: 'view.stock',
  parties: 'view.partners',
  users: 'view.users',
  assembly: 'view.assembly',
  activity: 'view.activity',
  scan: 'view.scan',
};

// the open view is a device preference: a refresh (or a dropped connection on
// site) should not throw the user back to the dashboard
const VIEW_PREF_KEY = 'twinflow.view';

function showView(name) {
  // the Activity view is the administrator's window onto the decision log. The nav
  // button is hidden for everyone else at boot; this catches the other ways in —
  // a restored view preference, or a direct call.
  if (name === 'activity' && !isAdmin(state.role)) name = 'dashboard';
  try { localStorage.setItem(VIEW_PREF_KEY, name); } catch { /* private mode */ }
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  $('#view-title').textContent = t(VIEW_TITLE_KEYS[name]);
  V?.setViewerActive(name === 'model' && modelTab === 'model'); // don't render 3D frames while hidden
  if (name === 'dashboard') renderDashboard();
  // the 3D stack is fetched here, on first entry — the saved IFC is parsed after it
  if (name === 'model') { loadViewerStack().then(restoreModel).catch(() => {}); renderQto(); }
  if (name === 'orders') renderOrders();
  if (name === 'planning') renderTaktPlanning();
  if (name === 'stock') renderStock();
  if (name === 'parties') renderParties();
  if (name === 'users') renderUsers();
  if (name === 'assembly') renderAssembly();
  // rebuild on entry: the cache must never outlive a change made elsewhere in the app
  if (name === 'activity') { invalidateActivityCache(); renderActivity(); }
  if (name === 'scan') renderScanManual();
  if (name !== 'scan') stopScan();
  if (name !== 'model') fourDStop(); // nothing to watch: don't keep repainting a hidden canvas
}

document.querySelectorAll('.nav-btn').forEach(b =>
  b.addEventListener('click', () => showView(b.dataset.view)));

// tabs inside the Model & Quantities view: 3D model | quantities takeoff
let modelTab = 'model';
function showModelTab(tab) {
  modelTab = tab;
  // scoped to [data-mtab]: the Stock view reuses the .vtab styling with its own tabs
  document.querySelectorAll('[data-mtab]').forEach(b => b.classList.toggle('active', b.dataset.mtab === tab));
  $('#mtab-model').classList.toggle('hidden', tab !== 'model');
  $('#mtab-qto').classList.toggle('hidden', tab !== 'qto');
  V?.setViewerActive(tab === 'model');
  if (tab !== 'model') fourDStop();
  if (tab === 'qto') { qtoWin = [-1, -1]; updateQtoWindow(); } // it had no height while hidden
}
document.querySelectorAll('[data-mtab]').forEach(b =>
  b.addEventListener('click', () => showModelTab(b.dataset.mtab)));

// ---------------------------------------------------------------- auth & profile

let currentUser = null;

const USER_CACHE_KEY = 'twinflow.user';
let offlineSession = false; // running on a remembered account, server unreachable

// The notice stays up while the server is unreachable and comes down the moment anything
// reaches it again — see setServerReachedHandler below, which is what makes that second
// half true. It is deliberately not a toast: the statement it makes is about the data on
// screen right now, so it has to live as long as that data does.
function setOfflineNotice(on) {
  const el = $('#offline-bar');
  if (!el) return;
  if (on) el.textContent = t('offline.lastKnown');
  el.classList.toggle('hidden', !on);
}

// "The server says you are not signed in" and "I could not reach the server" are different
// answers, and this used to treat them the same: any failure cleared the session hint and
// bounced to the sign-in page. On site that meant a lost signal SIGNED YOU OUT — and the
// cleared hint kept sending you to the login page after the signal came back.
//
// Now only a real 401 ends the session. A network failure falls back to the account this
// device last used, so the app opens and paints from the offline state store.js keeps.
// That cached account is a RENDERING hint, never a permission: every API call still gets a
// 401 from the server, exactly as before — the same reasoning as the signedIn flag.
async function ensureAuth() {
  try {
    const r = await fetch('api/me');
    if (r.ok) {
      const d = await r.json();
      if (d.ok) {
        currentUser = d.user;
        offlineSession = false;
        try {
          localStorage.setItem('twinflow.signedIn', '1');
          localStorage.setItem(USER_CACHE_KEY, JSON.stringify(d.user));
        } catch { /* private mode */ }
        return true;
      }
    }
    if (r.status !== 401) throw new Error('server unavailable'); // 503 while booting, 5xx
  } catch {
    // unreachable, not refused: keep the session and run from what this device remembers
    try {
      const cached = JSON.parse(localStorage.getItem(USER_CACHE_KEY) || 'null');
      if (cached && localStorage.getItem('twinflow.signedIn')) {
        currentUser = cached;
        offlineSession = true;
        return true;
      }
    } catch { /* private mode, or nothing remembered — fall through to the login page */ }
  }
  // the session is gone (expired, revoked, signed out elsewhere): clear the hint so
  // the next load goes straight to the sign-in page instead of flashing the shell
  try {
    localStorage.removeItem('twinflow.signedIn');
    localStorage.removeItem(USER_CACHE_KEY);
  } catch { /* private mode */ }
  location.href = 'login.html';
  return false;
}

function renderUserChip() {
  const initials = (currentUser.name || currentUser.username)
    .split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  $('#user-avatar').textContent = initials;
  $('#user-name').textContent = currentUser.name || currentUser.username;
  $('#user-role').textContent = roleLabel(currentUser.role);
}

// The remembered account goes with the session: signing out has to mean signed out,
// including the copy this device keeps in order to open with no signal. Shared by the
// profile modal and the forced password change — two doors, one act, and the localStorage
// half is the part that is quietly wrong if a second copy forgets it.
async function signOut() {
  await fetch('api/logout', { method: 'POST' }).catch(() => {});
  try {
    localStorage.removeItem('twinflow.signedIn');
    localStorage.removeItem(USER_CACHE_KEY);
  } catch { /* private mode */ }
  location.href = 'login.html';
}

function openProfileModal() {
  openModal(`
    <h2>👤 ${esc(currentUser.name || currentUser.username)}</h2>
    <div class="prop-row"><span class="k">${t('profile.username')}</span><span class="v">${esc(currentUser.username)}</span></div>
    <div class="prop-row"><span class="k">${t('profile.role')}</span><span class="v">${esc(roleLabel(currentUser.role))}</span></div>
    <div class="form-row" style="margin-top:14px"><label>${t('profile.email')}</label>
      <input type="email" id="pf-email" value="${esc(currentUser.email || '')}" placeholder="${esc(t('profile.emailPlaceholder'))}">
      <div class="muted" style="font-size:var(--fs-200);margin-top:var(--sp-1)">${t('profile.emailHint')}</div>
    </div>
    <div class="form-row"><label>${t('profile.language')}</label>
      <select id="pf-lang">
        ${Object.entries(LANGS).map(([code, name]) => `<option value="${code}" ${getLang() === code ? 'selected' : ''}>${name}</option>`).join('')}
      </select>
    </div>
    <h3 class="section-title section-title-spaced">${t('profile.at.title')}</h3>
    <p class="muted" style="font-size:var(--fs-200);margin:0 0 var(--sp-2)">${t('profile.at.hint')}</p>
    <div class="form-row">
      <div class="prop-row"><span class="k">${t('profile.at.state')}</span><span class="v">
        ${currentUser.canCommunicateAt
          ? `<span class="type-chip" style="background:var(--green);color:#fff">✓ ${t('profile.at.ready')}</span>`
          : `<span class="type-chip">${t('profile.at.notSet')}</span>`}</span></div>
    </div>
    <div class="form-row"><label>${t('profile.at.user')}</label>
      <input type="text" id="at-user" value="${esc(currentUser.atUsername || '')}" placeholder="599999993/37" autocomplete="off">
      <div class="muted" style="font-size:var(--fs-200);margin-top:var(--sp-1)">${t('profile.at.userHint')}</div></div>
    <div class="form-row"><label>${t('profile.at.password')}</label>
      <input type="password" id="at-pass" autocomplete="new-password" placeholder="${esc(currentUser.canCommunicateAt ? t('profile.at.passwordKeep') : '')}">
      <div class="muted" style="font-size:var(--fs-200);margin-top:var(--sp-1)">${t('profile.at.passwordHint')}</div></div>
    <div class="form-row" style="display:flex;gap:var(--sp-2)">
      <button class="btn small primary" id="at-save">${t('profile.at.save')}</button>
      ${currentUser.canCommunicateAt || currentUser.atUsername
        ? `<button class="btn small" id="at-clear" style="border-color:var(--red-text);color:var(--red-text)">${t('profile.at.clear')}</button>` : ''}
    </div>
    <h3 class="section-title section-title-spaced">${t('profile.changePassword')}</h3>
    <div class="form-row"><label>${t('profile.currentPassword')}</label><input type="password" id="pw-current" autocomplete="current-password"></div>
    <div class="form-row"><label>${t('profile.newPassword')}</label><input type="password" id="pw-next" autocomplete="new-password"></div>
    <div class="modal-actions" style="justify-content:space-between">
      <button class="btn" id="pf-logout" style="border-color:var(--red-text);color:var(--red-text)">${t('profile.signout')}</button>
      <span>
        <button class="btn" id="pf-close">${t('common.close')}</button>
        <button class="btn primary" id="pf-save">${t('profile.changePasswordBtn')}</button>
      </span>
    </div>`);
  $('#pf-close').addEventListener('click', closeModal);
  $('#pf-logout').addEventListener('click', signOut);
  // The Portal das Finanças password is write-only from here on: it is sent once and
  // never comes back, so leaving the field blank on a later save keeps the stored one
  // rather than wiping it. The alternative — an empty box that silently clears the
  // credentials — is how somebody loses the ability to communicate without noticing.
  $('#at-save')?.addEventListener('click', async () => {
    const atUsername = $('#at-user').value.trim();
    const atPassword = $('#at-pass').value;
    if (!atPassword) { toast(t('profile.at.needPassword')); return; }
    const btn = $('#at-save');
    btn.disabled = true;
    const r = await fetch('api/at-credentials', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ atUsername, atPassword }),
    });
    const d = await r.json().catch(() => ({}));
    if (d.ok) {
      currentUser = d.user;
      toast(t('profile.at.saved'));
      closeModal();
      openProfileModal();
    } else { toast(d.error || t('profile.at.failed')); btn.disabled = false; }
  });
  $('#at-clear')?.addEventListener('click', async () => {
    if (!confirm(t('profile.at.clearConfirm'))) return;
    const r = await fetch('api/at-credentials', { method: 'DELETE' });
    const d = await r.json().catch(() => ({}));
    if (d.ok) { currentUser = d.user; toast(t('profile.at.cleared')); closeModal(); openProfileModal(); }
    else toast(d.error || t('profile.at.failed'));
  });
  $('#pf-lang').addEventListener('change', async (e) => {
    const lang = e.target.value;
    const r = await fetch('api/preferences', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang }),
    });
    const d = await r.json().catch(() => ({}));
    if (d.ok) {
      currentUser.lang = lang;
      await setLang(lang);
      applyStaticTranslations();
      renderUserChip();
      const view = document.querySelector('.view.active').id.replace('view-', '');
      showView(view);
      closeModal();
    }
  });
  $('#pf-email').addEventListener('change', async (e) => {
    const email = e.target.value.trim();
    const r = await fetch('api/preferences', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const d = await r.json().catch(() => ({}));
    if (d.ok) { currentUser.email = d.user.email; toast(t('profile.emailSaved')); }
  });
  $('#pf-save').addEventListener('click', async () => {
    const r = await fetch('api/password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current: $('#pw-current').value, next: $('#pw-next').value }),
    });
    const d = await r.json().catch(() => ({}));
    if (d.ok) {
      currentUser.mustChangePassword = false;
      toast(t('profile.passwordChanged')); closeModal();
    } else toast(d.error || t('profile.passwordChangeFailed'));
  });
}

$('#user-chip').addEventListener('click', openProfileModal);

// Shown when the account still uses the seeded default password (admin/admin).
//
// This used to be a dismissable strip across the top, and the server never checked the
// flag at all — so the answer to "change your password" was a click on ✕, and the
// session kept full authority. The server now refuses every route except this one while
// the flag is set, so the notice has to be the whole screen: there is nothing behind it
// to go back to. No Close button, deliberately — the only ways out are changing the
// password or signing out.
function forcePasswordChange() {
  openModal(`
    <h2>⚠ ${t('security.weakPasswordFix')}</h2>
    <p class="view-intro">${esc(t('security.weakPassword'))}</p>
    <p class="muted">${esc(t('security.mustChangePassword'))}</p>
    <div class="form-row"><label>${t('profile.currentPassword')}</label><input type="password" id="fp-current" autocomplete="current-password"></div>
    <div class="form-row"><label>${t('profile.newPassword')}</label><input type="password" id="fp-next" autocomplete="new-password"></div>
    <div class="modal-actions" style="justify-content:space-between">
      <button class="btn" id="fp-logout" style="border-color:var(--red-text);color:var(--red-text)">${t('profile.signout')}</button>
      <button class="btn primary" id="fp-save">${t('profile.changePasswordBtn')}</button>
    </div>`);
  $('#fp-current').focus();
  $('#fp-logout').addEventListener('click', signOut);
  $('#fp-save').addEventListener('click', async () => {
    const btn = $('#fp-save');
    btn.disabled = true;
    const r = await fetch('api/password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current: $('#fp-current').value, next: $('#fp-next').value }),
    }).catch(() => null);
    const d = await r?.json().catch(() => ({})) || {};
    // A reload rather than carrying on in place: everything this session skipped at boot
    // (the state fetch, the nav gating, the remembered view) was refused by the server,
    // so the app has never been in a usable state and starting it over is the honest move.
    if (d.ok) location.reload();
    else { toast(d.error || t('profile.passwordChangeFailed')); btn.disabled = false; }
  });
}

// ---------------------------------------------------------------- QR scanning (per-element digital thread)

// per-element lifecycle. The tail (diaphragms → grout prep → grouted) mirrors the
// site's control table: fixing an element in place is not the end of it — the
// structural connection is only complete once it has been grouted, and each step
// is signed off by the site foremen.
const SCAN_PHASES = [
  ['built',      ['factory']],
  ['loaded',     ['logistics', 'factory']],
  ['lifted',     ['site', 'foreman']],
  ['fixed',      ['site', 'foreman']],
  ['diaphragms', ['site', 'foreman']],
  ['groutPrep',  ['site', 'foreman']],
  ['grouted',    ['site', 'foreman']],
];
// the steps that happen on site, recorded per element in the Assembly view
const SITE_PHASES = ['lifted', 'fixed', 'diaphragms', 'groutPrep', 'grouted'];
// a request may only be deleted while it never materially started (mirrors the server)
const DELETABLE_STATUSES = ['draft', 'submitted', 'rejected'];
// the administrator overrides the process gates; every other role, project director
// included, is held to them. Mirrors isAdmin() in serve.mjs.
const isAdmin = (role) => role === 'admin';
// …and only from production onwards do physical pieces exist to inspect or fault
const STARTED_STATUSES = ['production', 'ready', 'transit', 'delivered', 'installed'];

let scanStream = null, scanTimer = null;

async function startScan() {
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const v = $('#scan-video');
    v.srcObject = scanStream;
    await v.play();
    $('#btn-scan-start').disabled = true;
    $('#btn-scan-stop').disabled = false;
    if ('BarcodeDetector' in window) {
      const det = new BarcodeDetector({ formats: ['qr_code'] });
      scanTimer = setInterval(async () => {
        try {
          const codes = await det.detect(v);
          if (codes.length) { renderScanResult(codes[0].rawValue.trim()); stopScan(); }
        } catch { /* frame not ready */ }
      }, 400);
    } else {
      toast(t('scan.noDetector'));
    }
  } catch (e) {
    toast(t('scan.cameraUnavailable', { err: e.message }));
  }
}

function stopScan() {
  clearInterval(scanTimer);
  scanTimer = null;
  scanStream?.getTracks().forEach(t => t.stop());
  scanStream = null;
  const start = $('#btn-scan-start'), stop = $('#btn-scan-stop');
  if (start) { start.disabled = false; stop.disabled = true; }
}

// find which order and project an element GUID belongs to
function findByGid(gid) {
  for (const o of state.orders) {
    if (orderGlobalIds(o).includes(gid)) return { order: o, project: getProject(o.projectId) };
  }
  for (const p of state.projects) {
    const g = p.groups.find(x => (x.globalIds || []).includes(gid));
    if (g) return { order: null, project: p, group: g };
  }
  return null;
}

function renderScanResult(gid) {
  const box = $('#scan-info');
  const hit = findByGid(gid);
  if (!hit) {
    box.innerHTML = `<span class="muted">${t('scan.notFound', { gid: esc(gid) })}</span>`;
    return;
  }
  const { order, project, group } = hit;
  const track = order?.tracking?.[gid] || {};
  const rows = [
    [t('scan.guid'), gid],
    [t('scan.project'), project?.name],
    [t('scan.request'), order ? `${order.code} — ${statusLabel(order.status)}` : t('scan.notOrderedYet')],
    [t('scan.typology'), order ? order.items.find(it => (it.globalIds || []).includes(gid))?.name : group?.name],
  ];
  const phases = SCAN_PHASES.map(([key, roles]) => {
    const label = t('scan.phase.' + key);
    const allowed = order && (hasFullAccess(state.role) || roles.includes(state.role));
    const done = track[key];
    return `<div class="scan-phase">
      <span>${label}</span>
      ${done ? `<span class="muted">${fmtDate(done)}</span>`
             : allowed ? `<button class="btn small primary" data-phase="${key}" data-label="${esc(label)}">${t('scan.recordNow')}</button>`
                       : '<span class="muted">—</span>'}
    </div>`;
  }).join('');
  box.innerHTML = rows.filter(([, v]) => v).map(([k, v]) =>
    `<div class="prop-row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('')
    + `<h3 style="margin:14px 0 8px">${t('scan.lifecycle')}</h3>` + phases;
  box.classList.remove('muted');
  box.querySelectorAll('[data-phase]').forEach(b => b.addEventListener('click', () => {
    markTracking(order, gid, b.dataset.phase, b.dataset.label);
    toast(t('scan.recordedToast', { label: b.dataset.label, gid }));
    renderScanResult(gid);
  }));
}

$('#btn-scan-start').addEventListener('click', startScan);
$('#btn-scan-stop').addEventListener('click', stopScan);
$('#btn-scan-lookup').addEventListener('click', () => {
  const gid = $('#scan-manual').value.trim();
  if (gid) renderScanResult(gid);
});

// ---------------------------------------------------------------- Assembly (site progress)
// Site work is done in series — a crew lifts a whole row of panels, then grouts a
// whole floor — so the per-element phases live here, across every delivered
// request of the project, rather than one request at a time inside an order modal.

let assemblyOrderFilter = '';  // '' = every delivered request of the active project
let assemblyPhaseFilter = '';  // '' = all; otherwise show elements still missing it
let assemblyStorey = '';       // building storey (from the QTO group)
let assemblyZone = '';         // takt zone of the request
let assemblyType = '';         // IFC class (Wall, Slab, …)
let assemblySearch = '';       // typology name / GUID
let assemblySelection = new Set();
let assemblyFocusId = null;    // keep the caret in the search box across re-renders

// every trackable element of the active project that has physically shipped,
// enriched with the dimensions a site crew actually works by: storey, takt zone
// and class. Storeys come from the QTO group the item was ordered from.
function assemblyRows(applyFilters = true) {
  const p = activeProject();
  if (!p) return [];
  const groupByKey = new Map((p.groups || []).map(g => [g.key, g]));
  const zoneName = (id) => (p.takt?.zones || []).find(z => z.id === id)?.name || '';
  const q = assemblySearch.trim().toLowerCase();
  const rows = [];
  for (const o of state.orders) {
    if (o.projectId !== p.id) continue;
    if (!['transit', 'delivered', 'installed'].includes(o.status)) continue;
    if (applyFilters && assemblyOrderFilter && o.id !== assemblyOrderFilter) continue;
    if (applyFilters && assemblyZone && o.zoneId !== assemblyZone) continue;
    for (const it of o.items || []) {
      if (applyFilters && assemblyType && it.type !== assemblyType) continue;
      const storeys = groupByKey.get(it.key)?.storeys || [];
      if (applyFilters && assemblyStorey && !storeys.includes(assemblyStorey)) continue;
      for (const gid of it.globalIds || []) {
        if (applyFilters && q && !(`${it.name} ${gid}`.toLowerCase().includes(q))) continue;
        rows.push({
          gid, name: it.name, type: it.type, order: o,
          storeys, zone: zoneName(o.zoneId),
          track: o.tracking?.[gid] || {},
        });
      }
    }
  }
  return rows;
}

function renderAssembly() {
  const box = $('#assembly-content');
  const p = activeProject();
  if (!p) { box.innerHTML = `<div class="empty-state"><div class="big">🏗️</div>${t('assembly.noProject')}</div>`; return; }

  const canRecord = hasFullAccess(state.role) || ['site', 'foreman'].includes(state.role);
  const universe = assemblyRows(false); // everything on site — drives the filter options
  const filtered = assemblyRows();
  // the phase filter narrows to what still needs doing for that step, which is how
  // a crew actually works ("show me everything not yet grouted")
  const rows = assemblyPhaseFilter ? filtered.filter(r => !r.track[assemblyPhaseFilter]) : filtered;
  // the progress bars follow the current filter, so "Piso 1" shows Piso 1's progress
  const all = filtered;
  const shipped = state.orders.filter(o => o.projectId === p.id && ['transit', 'delivered', 'installed'].includes(o.status));
  const sel = (v, cur) => (v === cur ? 'selected' : '');
  const storeyOpts = [...new Set(universe.flatMap(r => r.storeys))].sort();
  const zoneOpts = (p.takt?.zones || []).filter(z => universe.some(r => r.order.zoneId === z.id));
  const typeOpts = [...new Set(universe.map(r => r.type))].sort();
  // prune selections that the current filter no longer shows
  const visible = new Set(rows.map(r => r.gid));
  for (const gid of [...assemblySelection]) if (!visible.has(gid)) assemblySelection.delete(gid);

  const totals = SITE_PHASES.map(ph => ({ ph, n: all.filter(r => r.track[ph]).length }));

  box.innerHTML = `
    <p class="view-intro">${t('assembly.hint')}</p>
    ${!universe.length ? `<div class="empty-state">${t('assembly.none')}</div>` : `
    <div class="card" style="margin-bottom:var(--sp-4)">
      <h3 style="margin:0 0 10px">${t('assembly.overview', { name: esc(p.name) })}</h3>
      ${totals.map(({ ph, n }) => `<div class="bar-row">
        <div class="bar-label" style="width:210px;text-align:left">${t('scan.phase.' + ph)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${all.length ? n / all.length * 100 : 0}%;background:${all.length && n === all.length ? 'var(--green)' : 'var(--accent)'}"></div></div>
        <div class="bar-value">${n}/${all.length}</div>
      </div>`).join('')}
    </div>

    <div style="display:flex;gap:var(--sp-2);align-items:center;flex-wrap:wrap;margin-bottom:var(--sp-3)">
      ${storeyOpts.length ? `<select id="asm-storey">
        <option value="">${t('assembly.allStoreys')}</option>
        ${storeyOpts.map(s => `<option value="${esc(s)}" ${sel(s, assemblyStorey)}>${esc(s)}</option>`).join('')}
      </select>` : ''}
      ${zoneOpts.length ? `<select id="asm-zone">
        <option value="">${t('assembly.allZones')}</option>
        ${zoneOpts.map(z => `<option value="${z.id}" ${sel(z.id, assemblyZone)}>${esc(z.name)}</option>`).join('')}
      </select>` : ''}
      <select id="asm-type">
        <option value="">${t('assembly.allTypes')}</option>
        ${typeOpts.map(ty => `<option value="${esc(ty)}" ${sel(ty, assemblyType)}>${esc(ty)}</option>`).join('')}
      </select>
      <select id="asm-order">
        <option value="">${t('assembly.allRequests')}</option>
        ${shipped.map(o => `<option value="${o.id}" ${sel(o.id, assemblyOrderFilter)}>${esc(o.code)}</option>`).join('')}
      </select>
      <select id="asm-phase">
        <option value="">${t('assembly.allElements')}</option>
        ${SITE_PHASES.map(ph => `<option value="${ph}" ${sel(ph, assemblyPhaseFilter)}>${t('assembly.pending', { phase: t('scan.phase.' + ph) })}</option>`).join('')}
      </select>
      <input type="text" id="asm-search" placeholder="${esc(t('assembly.search'))}" value="${esc(assemblySearch)}" style="min-width:150px">
      <button class="ghost small" id="asm-clear" title="${esc(t('common.clearFilters'))}">✕</button>
      <button class="ghost small" id="asm-csv" title="${esc(t('stock.csvTitle'))}">${t('stock.csv')}</button>
      <span class="muted" style="font-size:var(--fs-300)">${t('assembly.count', { a: rows.length, b: universe.length })}</span>
    </div>

    ${canRecord ? `<div style="display:flex;gap:var(--sp-2);align-items:center;flex-wrap:wrap;margin-bottom:var(--sp-3)">
      <button class="ghost small" id="asm-all">${t('asbuilt.selectAll')}</button>
      <button class="ghost small" id="asm-none">${t('asbuilt.selectNone')}</button>
      <span class="muted" style="font-size:var(--fs-300)">${t('assembly.selected', { n: assemblySelection.size })}</span>
      <span style="flex:1"></span>
      ${SITE_PHASES.map(ph => `<button class="btn small ${assemblySelection.size ? 'primary' : ''}" data-asmphase="${ph}"
        ${assemblySelection.size ? '' : 'disabled'}>${t('scan.phase.' + ph)}</button>`).join('')}
    </div>` : ''}

    <div class="card" style="padding:0;overflow-x:auto">
      ${rows.length ? `<table><thead><tr>
        ${canRecord ? '<th style="width:32px"></th>' : ''}
        <th>${t('assembly.element')}</th><th>${t('assembly.storey')}</th><th class="asm-wide">${t('stock.order')}</th>
        <th class="asm-narrow" style="text-align:center">${t('assembly.phases')}</th>
        ${SITE_PHASES.map(ph => `<th class="asm-wide" style="font-size:var(--fs-100)">${t('scan.phase.' + ph)}</th>`).join('')}
      </tr></thead><tbody>
        ${rows.map(r => {
          const done = SITE_PHASES.filter(ph => r.track[ph]).length;
          return `<tr>
          ${canRecord ? `<td><input type="checkbox" class="asm-check" value="${esc(r.gid)}" ${assemblySelection.has(r.gid) ? 'checked' : ''}></td>` : ''}
          <td>${esc(r.name)} <span class="muted" style="font-size:var(--fs-100)">${esc(r.gid)}</span></td>
          <td class="muted" style="font-size:var(--fs-200)">${esc(r.storeys.join(', ') || '—')}${r.zone ? ` · ${esc(r.zone)}` : ''}
            <span class="asm-narrow muted" style="font-size:var(--fs-100)">· ${esc(r.order.code)}</span></td>
          <td class="asm-wide muted" style="font-size:var(--fs-200)">${esc(r.order.code)}</td>
          <td class="asm-narrow" style="text-align:center;white-space:nowrap"
              title="${esc(SITE_PHASES.filter(ph => r.track[ph]).map(ph => t('scan.phase.' + ph)).join(', '))}">
            <span style="color:${done === SITE_PHASES.length ? 'var(--green)' : 'var(--accent)'};letter-spacing:1px">${'●'.repeat(done)}${'○'.repeat(SITE_PHASES.length - done)}</span>
            <div class="muted" style="font-size:var(--fs-100)">${done}/${SITE_PHASES.length}</div>
          </td>
          ${SITE_PHASES.map(ph => `<td class="asm-wide" style="text-align:center">${r.track[ph]
            ? `<span title="${esc(fmtDate(r.track[ph]))}" style="color:var(--green-text)">✓</span>`
            : '<span class="muted">—</span>'}</td>`).join('')}
        </tr>`;
        }).join('')}
      </tbody></table>`
      : `<div class="empty-state">${t('assembly.noMatches')}</div>`}
    </div>`}`;

  // a re-render mid-typing would steal focus — restore the caret like the Stock view
  if (assemblyFocusId) {
    const el = $('#' + assemblyFocusId);
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    assemblyFocusId = null;
  }

  const wire = (id, fn) => $('#' + id)?.addEventListener('change', (e) => { fn(e.target.value); renderAssembly(); });
  wire('asm-order', (v) => { assemblyOrderFilter = v; });
  wire('asm-phase', (v) => { assemblyPhaseFilter = v; });
  wire('asm-storey', (v) => { assemblyStorey = v; });
  wire('asm-zone', (v) => { assemblyZone = v; });
  wire('asm-type', (v) => { assemblyType = v; });
  let asmSearchTimer;
  $('#asm-search')?.addEventListener('input', (e) => {
    clearTimeout(asmSearchTimer);
    asmSearchTimer = setTimeout(() => {
      assemblySearch = e.target.value;
      assemblyFocusId = 'asm-search';
      renderAssembly();
    }, 200);
  });
  $('#asm-clear')?.addEventListener('click', () => {
    assemblyOrderFilter = ''; assemblyPhaseFilter = ''; assemblyStorey = '';
    assemblyZone = ''; assemblyType = ''; assemblySearch = '';
    assemblySelection.clear();
    renderAssembly();
  });
  $('#asm-csv')?.addEventListener('click', () => downloadCsv('twinflow-assembly.csv',
    [t('assembly.element'), 'GUID', t('assembly.storey'), t('takt.zone'), t('stock.order'),
      ...SITE_PHASES.map(ph => t('scan.phase.' + ph))],
    rows.map(r => [r.name, r.gid, r.storeys.join(' / '), r.zone, r.order.code,
      ...SITE_PHASES.map(ph => r.track[ph] || '')])));
  box.querySelectorAll('.asm-check').forEach(c => c.addEventListener('change', () => {
    if (c.checked) assemblySelection.add(c.value); else assemblySelection.delete(c.value);
    renderAssembly();
  }));
  $('#asm-all')?.addEventListener('click', () => { rows.forEach(r => assemblySelection.add(r.gid)); renderAssembly(); });
  $('#asm-none')?.addEventListener('click', () => { assemblySelection.clear(); renderAssembly(); });

  // record one phase for the whole selection — grouped per request, since tracking
  // lives on the order and each one syncs separately
  box.querySelectorAll('[data-asmphase]').forEach(b => b.addEventListener('click', () => {
    const phase = b.dataset.asmphase;
    const chosen = rows.filter(r => assemblySelection.has(r.gid));
    const idx = SITE_PHASES.indexOf(phase);
    const prev = idx > 0 ? SITE_PHASES[idx - 1] : null;
    const blocked = prev ? chosen.filter(r => !r.track[prev]) : [];
    if (blocked.length) { toast(t('assembly.needsPrev', { n: blocked.length, phase: t('scan.phase.' + prev) })); return; }
    const todo = chosen.filter(r => !r.track[phase]);
    if (!todo.length) { toast(t('assembly.alreadyDone')); return; }
    const byOrder = new Map();
    for (const r of todo) {
      if (!byOrder.has(r.order.id)) byOrder.set(r.order.id, { order: r.order, gids: [] });
      byOrder.get(r.order.id).gids.push(r.gid);
    }
    for (const { order, gids } of byOrder.values()) markPhaseBatch(order, gids, phase, t('scan.phase.' + phase));
    toast(t('assembly.recorded', { n: todo.length, phase: t('scan.phase.' + phase) }));
    assemblySelection.clear();
    renderAssembly();
    renderOrders();
    renderDashboard();
  }));
}

// manual selection: request → element, for phones without camera/QR at hand
function renderScanManual() {
  const orderSel = $('#scan-order');
  const elSel = $('#scan-element');
  const orders = state.orders.filter(o => orderGlobalIds(o).length);
  orderSel.innerHTML = `<option value="">${esc(t('scan.pickOrder'))}</option>` +
    orders.map(o => `<option value="${o.id}">${esc(o.code)} — ${esc(getProject(o.projectId)?.name || '')} (${esc(statusLabel(o.status))})</option>`).join('');
  elSel.innerHTML = '';
  elSel.disabled = true;
}
$('#scan-order').addEventListener('change', () => {
  const o = state.orders.find(x => x.id === $('#scan-order').value);
  const elSel = $('#scan-element');
  if (!o) { elSel.innerHTML = ''; elSel.disabled = true; return; }
  const rows = o.items.flatMap(it => (it.globalIds || []).filter(Boolean).map(gid => ({ gid, name: it.name })));
  elSel.innerHTML = `<option value="">${esc(t('scan.pickElement', { n: rows.length }))}</option>` +
    rows.map(r => `<option value="${esc(r.gid)}">${esc(r.name)}</option>`).join('');
  elSel.disabled = false;
});
$('#scan-element').addEventListener('change', () => {
  const gid = $('#scan-element').value;
  if (gid) renderScanResult(gid);
});

// ---------------------------------------------------------------- users (admin)

async function renderUsers() {
  const box = $('#users-content');
  const d = await (await fetch('api/users')).json().catch(() => ({}));
  if (!d.ok) { box.innerHTML = `<div class="empty-state">${t('users.adminOnly')}</div>`; return; }
  box.innerHTML = `
    <div style="margin-bottom:var(--sp-4)"><button class="btn primary" id="btn-add-user">${t('users.createAccount')}</button></div>
    <div class="card" style="padding:0">
      <table><thead><tr><th>${t('common.name')}</th><th>${t('common.username')}</th><th>${t('common.role')}</th><th>${t('common.created')}</th><th></th></tr></thead>
      <tbody>${d.users.map(u => `<tr>
        <td>${esc(u.name)}</td>
        <td class="muted">${esc(u.username)}</td>
        <td><span class="type-chip">${esc(roleLabel(u.role))}</span>
          ${SCOPED_ROLES.includes(u.role) ? `<span class="muted" style="font-size:var(--fs-200)">${t('users.projectsCount', { n: (u.projectIds || []).length })}</span>` : ''}</td>
        <td class="muted">${fmtDate(u.createdAt)}</td>
        <td style="white-space:nowrap">
          <button class="ghost small" data-edituser="${u.id}">${t('common.edit')}</button>
          ${u.id === currentUser.id ? `<span class="muted">${t('common.you')}</span>`
              : `<button class="ghost small danger" data-deluser="${u.id}">${t('common.delete')}</button>`}
        </td>
      </tr>`).join('')}</tbody></table>
    </div>`;
  $('#btn-add-user').addEventListener('click', () => openUserModal());
  box.querySelectorAll('[data-edituser]').forEach(b => b.addEventListener('click', () => {
    openUserModal(d.users.find(x => x.id === b.dataset.edituser));
  }));
  box.querySelectorAll('[data-deluser]').forEach(b => b.addEventListener('click', async () => {
    const u = d.users.find(x => x.id === b.dataset.deluser);
    if (!confirm(t('users.confirmDelete', { u: u.username }))) return;
    const r = await (await fetch('api/users/' + u.id, { method: 'DELETE' })).json();
    if (r.ok) { toast(t('users.deleted')); renderUsers(); } else toast(r.error || t('users.deleteFailed'));
  }));
}

// roles restricted to specific assigned projects — the admin gets a project-access
// picker for these (as opposed to the administrator, who sees everything, and
// quality/logistics, which audit across every project). Includes the project
// director, the off-site factory and the site assembly team.
const SCOPED_ROLES = PROJECT_SCOPED_ROLES;

// used for both "+ Create account" (no arg) and "Edit" (pass the existing user)
function openUserModal(existing) {
  const isSelf = existing && existing.id === currentUser.id;
  const existingProjectIds = new Set(existing?.projectIds || []);
  openModal(`
    <h2>${existing ? t('users.editAccount') : t('users.createAccount').replace('+ ', '')}</h2>
    <div class="form-row"><label>${t('users.fullName')}</label><input type="text" id="us-name" value="${esc(existing?.name || '')}"></div>
    <div class="form-row"><label>${t('common.username')}</label><input type="text" id="us-username" autocomplete="off" value="${esc(existing?.username || '')}"></div>
    <div class="form-row"><label>${t('users.email')}</label><input type="email" id="us-email" autocomplete="off" value="${esc(existing?.email || '')}" placeholder="${esc(t('profile.emailPlaceholder'))}"></div>
    <div class="form-row"><label>${existing ? t('users.newPasswordOptional') : t('users.tempPassword')}</label>
      <input type="text" id="us-password" autocomplete="off"></div>
    <div class="form-row"><label>${t('common.role')}</label>
      <select id="us-role" ${isSelf ? 'disabled title="' + esc(t('users.selfRoleHint')) + '"' : ''}>
        ${Object.entries(ROLES).map(([k]) => `<option value="${k}" ${existing?.role === k ? 'selected' : ''}>${roleLabel(k)}</option>`).join('')}
      </select>
      ${isSelf ? `<div class="muted" style="font-size:var(--fs-200);margin-top:var(--sp-1)">${t('users.selfRoleHint')}</div>` : ''}
    </div>
    <div class="form-row" id="us-factory-row" style="display:none">
      <label>${t('users.factory')} <span class="muted">${t('users.factoryHint')}</span></label>
      ${state.parties.some(p => p.type === 'factory') ? `
      <select id="us-factory">
        <option value="">${t('users.factoryNone')}</option>
        ${state.parties.filter(p => p.type === 'factory').map(f =>
          `<option value="${f.id}" ${existing?.partyId === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}
      </select>`
      // an empty dropdown reads as "not built yet" — say what is actually missing.
      // Stock only ever belongs to a party of type factory, so with none registered
      // there is nothing to link an account to, and nowhere to send stock either.
      : `<div class="muted" style="font-size:var(--fs-300)">${t('users.factoryNoneRegistered')}</div>`}
    </div>
    <div class="form-row" id="us-access-row" style="display:none">
      <label>${t('users.projectAccess')} <span class="muted">${t('users.projectAccessHint')}</span></label>
      <div class="card" style="padding:10px;max-height:180px;overflow:auto">
        ${state.projects.length ? state.projects.map(p => `
          <label class="filter-item"><input type="checkbox" class="us-project" value="${p.id}" ${existingProjectIds.has(p.id) ? 'checked' : ''}> ${esc(p.name)}</label>
        `).join('') : `<span class="muted">${t('users.noProjectsYet')}</span>`}
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="us-cancel">${t('common.cancel')}</button>
      <button class="btn primary" id="us-save">${existing ? t('users.saveChanges') : t('common.create')}</button>
    </div>`);

  const accessRow = $('#us-access-row');
  const factoryRow = $('#us-factory-row');
  const roleSelect = $('#us-role');
  // the link is offered to every role that can be scoped by it — that is, everyone
  // except the three who run the warehouse and are never restricted by it
  const syncAccessVisibility = () => {
    accessRow.style.display = SCOPED_ROLES.includes(roleSelect.value) ? '' : 'none';
    factoryRow.style.display = ['admin', 'project_director', 'site_director', 'foreman'].includes(roleSelect.value) ? 'none' : '';
  };
  syncAccessVisibility();
  roleSelect.addEventListener('change', syncAccessVisibility);

  $('#us-cancel').addEventListener('click', closeModal);
  $('#us-save').addEventListener('click', async () => {
    const name = $('#us-name').value.trim();
    const username = $('#us-username').value.trim();
    const password = $('#us-password').value;
    if (!name || !username) { toast(t('users.nameUsernameRequired')); return; }
    if (!existing && !password) { toast(t('users.tempPasswordRequired')); return; }
    const projectIds = [...document.querySelectorAll('.us-project:checked')].map(c => c.value);

    const r = await fetch(existing ? 'api/users/' + existing.id : 'api/users', {
      method: existing ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name, username, email: $('#us-email').value.trim(), projectIds,
        partyId: $('#us-factory')?.value || '',
        ...(password ? { password } : {}),
        ...(isSelf ? {} : { role: roleSelect.value }),
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (d.ok) {
      toast(existing ? t('users.accountUpdated', { u: d.user.username }) : t('users.accountCreated', { u: d.user.username }));
      closeModal(); renderUsers();
    } else toast(d.error || t('users.saveFailed'));
  });
}

// project switcher
const projectSelect = $('#project-select');
function renderProjectSelect() {
  if (!state.projects.length) {
    projectSelect.innerHTML = `<option value="">${t('topbar.noProjects')}</option>`;
    projectSelect.disabled = true;
    return;
  }
  projectSelect.disabled = false;
  projectSelect.innerHTML = state.projects.map(p =>
    `<option value="${p.id}" ${p.id === state.activeProjectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
}
projectSelect.addEventListener('change', () => {
  state.activeProjectId = projectSelect.value;
  save();
  qtoSelection.clear();
  fourDReset(); // another project, another history
  const view = document.querySelector('.view.active').id.replace('view-', '');
  showView(view); // restores the model only if the Model view is the one open
  toast(t('toast.activeProject', { name: activeProject()?.name || '—' }));
});

// ---------------------------------------------------------------- IFC loading

// parse a buffer (metadata + quantities — no geometry yet). The heavy element/quantity
// walk runs in a worker (ifc-worker.js) so a large model doesn't freeze the UI; progress
// ticks drive the top busy bar. The main thread then opens its own model handle from the
// same buffer — cheap (no JS-side element walk) — so the viewer can stream geometry from it.
async function parseOnly(buffer) {
  await loadViewerStack(); // every path into here needs both modules
  if (currentModelID !== null) { I.closeModel(currentModelID); V.clearModel(); }
  const parsed = await I.parseIfcMetadata(buffer, (pct) => busyProgress(pct / 100));
  const ifcApi = await I.getApi();
  currentModelID = ifcApi.OpenModel(new Uint8Array(buffer));
  currentElements = parsed.elements;
  currentStoreys = parsed.storeys;
  return parsed;
}

// stream 3D meshes for the selected element types only — quantities always
// cover the whole model; the type choice just controls what the viewer builds
async function showGeometry(includeTypes = null) {
  const ids = includeTypes
    ? new Set(currentElements.filter(e => includeTypes.has(e.type)).map(e => e.id))
    : null;
  const meshCount = await V.loadModelGeometry(currentModelID, ids);
  renderModelFilters();
  fourDReset(); // fresh meshes and possibly another project: rebuild the time axis
  applyStatusColors();
  if (fourD.on && fourD.hideFuture) applyModelVisibility();
  $('#viewer-empty').style.display = meshCount ? 'none' : 'flex';
  return meshCount;
}

// per-project 3D type choice, remembered on this device
function getGeomPrefs(prjId) {
  try {
    const a = JSON.parse(localStorage.getItem('twinflow.geom3d.' + prjId));
    return Array.isArray(a) ? new Set(a) : null;
  } catch { return null; }
}

function openGeometrySelectModal(prjId, onDone) {
  const counts = new Map();
  for (const el of currentElements) counts.set(el.type, (counts.get(el.type) || 0) + 1);
  const saved = getGeomPrefs(prjId);
  openModal(`
    <h2>🧩 ${t('geom.title')}</h2>
    <p class="view-intro">${t('geom.hint')}</p>
    <div class="filter-group">
      ${[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([ty, n]) => `
        <label class="filter-item"><input type="checkbox" class="geom-type" value="${esc(ty)}"
          ${!saved || saved.has(ty) ? 'checked' : ''}> ${esc(ty)} <span class="muted">(${fmtNum(n, 0)})</span></label>`).join('')}
    </div>
    <div class="modal-actions">
      <button class="btn" id="geom-cancel">${t('common.cancel')}</button>
      <button class="btn" id="geom-all">${t('model.all')}</button>
      <button class="btn primary" id="geom-ok">${t('geom.load')}</button>
    </div>`);
  $('#geom-cancel').addEventListener('click', closeModal);
  $('#geom-all').addEventListener('click', () =>
    document.querySelectorAll('.geom-type').forEach(c => { c.checked = true; }));
  $('#geom-ok').addEventListener('click', () => {
    const sel = new Set([...document.querySelectorAll('.geom-type:checked')].map(c => c.value));
    localStorage.setItem('twinflow.geom3d.' + prjId, JSON.stringify([...sel]));
    closeModal();
    onDone(sel.size === counts.size ? null : sel); // all types selected = no filter
  });
}

async function loadIfcFromBuffer(buffer, fileName) {
  ++modelLoadToken; // a fresh import wins the viewer over any in-flight restore
  $('#model-status').textContent = t('model.parsing', { file: fileName });
  busyStart(t('model.loadingParse', { file: fileName }));
  showViewerLoading(t('model.loadingParse', { file: fileName }));
  await paintYield();
  try {
    const parsed = await parseOnly(buffer);
    hideViewerLoading(); // geometry types are picked next via a modal
    const { elements, groups } = parsed;
    const ifcData = {
      fileName,
      importedAt: nowIso(),
      groups,
      summary: {
        elementCount: elements.length,
        totalVolume: groups.reduce((s, g) => s + g.volume, 0),
        totalWeight: groups.reduce((s, g) => s + g.weight, 0),
      },
    };
    // filling in the active project's model (created empty from the dashboard) takes
    // priority over the old filename-matching behavior, which would create a duplicate
    const active = activeProject();
    const prj = (active && !active.fileName)
      ? attachIfcData(active.id, ifcData)
      : upsertProject({ name: fileName.replace(/\.ifc$/i, ''), ...ifcData });
    loadedProjectId = prj.id;
    qtoSelection.clear();
    renderProjectSelect();

    $('#model-status').textContent =
      t('model.loaded', { file: fileName, n: elements.length, g: groups.length });
    renderQto();
    renderDashboard();

    // persist the model with a real upload progress bar, THEN pick geometry types
    busyLabel(t('model.uploading', { file: fileName }));
    const d = await uploadIfc(prj.id, buffer);
    saveIfcFile(prj.id, buffer).catch(e => console.warn('Could not store IFC file locally:', e));
    busyDone();
    toast(d?.ok ? t('model.loadedSavedToast', { n: elements.length, g: groups.length })
                : t('model.savedLocalOnly'));

    // let the user pick which element types get 3D geometry (fewer types = faster)
    openGeometrySelectModal(prj.id, async (sel) => {
      showViewerLoading(t('model.loadingGeom'));
      await paintYield();
      const meshCount = await showGeometry(sel);
      hideViewerLoading();
      if (!meshCount) $('#model-status').textContent += t('model.loadedNoGeom');
    });
  } catch (err) {
    busyDone();
    hideViewerLoading();
    console.error(err);
    $('#model-status').textContent = t('model.failedParse', { err: err.message });
    toast(t('model.failedParseToast'));
  }
}

// bring the active project's saved IFC back into the viewer (no re-import needed)
async function restoreModel() {
  const prj = activeProject();
  if (!prj) return;
  // this load owns the viewer only while it stays the newest; a later switch bumps
  // the token and any awaits below bail out instead of clobbering the new project
  const myToken = ++modelLoadToken;
  const stale = () => myToken !== modelLoadToken;
  if (!prj.fileName) {
    hideViewerLoading(); busyDone();
    $('#model-status').textContent = t('model.noModelYet', { name: prj.name });
    $('#viewer-empty').style.display = 'flex';
    return;
  }
  if (prj.id === loadedProjectId) {
    hideViewerLoading(); busyDone();
    $('#model-status').textContent = t('model.loadedAlready', { file: prj.fileName, n: currentElements.length });
    return;
  }
  // global top-bar indicator too — the viewer overlay alone is easy to miss when
  // switching projects, so show an unmistakable signal from the very first tick
  busyStart(t('model.loadingParse', { file: prj.fileName }));
  let buffer = null, source = '';
  try {
    const r = await fetch('api/ifc/' + prj.id);
    if (r.ok) { buffer = await r.arrayBuffer(); source = t('model.serverFolder'); }
  } catch { /* offline */ }
  if (stale()) return; // user switched project while we were fetching
  if (!buffer) {
    try { buffer = await getIfcFile(prj.id); source = t('model.deviceCopy'); } catch { buffer = null; }
  }
  if (stale()) return;
  if (!buffer) {
    // don't keep showing another project's model in the viewer
    if (currentModelID !== null) {
      I?.closeModel(currentModelID);
      V?.clearModel();
      currentModelID = null;
      currentElements = [];
      currentStoreys = [];
      renderModelFilters();
    }
    loadedProjectId = null;
    hideViewerLoading(); busyDone();
    $('#viewer-empty').style.display = 'flex';
    $('#model-status').textContent = t('model.noSavedCopy', { name: prj.name, file: prj.fileName });
    return;
  }
  $('#model-status').textContent = t('model.restoring', { file: prj.fileName, source });
  showViewerLoading(t('model.loadingParse', { file: prj.fileName }));
  await paintYield();
  try {
    const parsed = await parseOnly(buffer);
    if (stale()) return; // a newer switch took over — don't paint this model
    showViewerLoading(t('model.loadingGeom'));
    busyLabel(t('model.loadingGeom'));
    await paintYield();
    // reuse the type choice saved for this project — no modal on every reopen
    const meshCount = await showGeometry(getGeomPrefs(prj.id));
    if (stale()) return;
    loadedProjectId = prj.id;
    $('#model-status').textContent =
      t('model.restoredFrom', { file: prj.fileName, n: parsed.elements.length, source }) +
      (meshCount ? '' : t('model.loadedNoGeom'));
    renderQto(); // the quantities tab mirrors the loaded model
  } catch (err) {
    if (stale()) return;
    console.error(err);
    $('#model-status').textContent = t('model.failedRestore', { err: err.message });
  } finally {
    if (!stale()) { hideViewerLoading(); busyDone(); } // a newer load keeps the indicators
  }
}

$('#ifc-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  loadIfcFromBuffer(await file.arrayBuffer(), file.name);
  e.target.value = '';
});

// change which element types have 3D geometry — reuses the already-open model,
// so no re-upload and no re-parse, only the mesh streaming runs again
$('#btn-geom').addEventListener('click', () => {
  if (currentModelID === null || !currentElements.length || !loadedProjectId) {
    toast(t('geom.noModel'));
    return;
  }
  openGeometrySelectModal(loadedProjectId, async (sel) => {
    showViewerLoading(t('model.loadingGeom'));
    await paintYield();
    await showGeometry(sel);
    hideViewerLoading();
  });
});

// ---------------------------------------------------------------- Status colors (digital twin view)

const NOT_ORDERED_COLOR = 0x4a5568; // gray for elements without a production request

// map each element GUID of the active project to the status of its request
function statusByGlobalId() {
  const map = new Map();
  const prj = activeProject();
  if (!prj) return map;
  for (const o of state.orders) {
    if (o.projectId !== prj.id) continue;
    for (const it of o.items) {
      let gids = it.globalIds;
      if (!gids || !gids.length) { // orders created before GUID snapshots
        const g = prj.groups.find(x => x.key === it.key);
        gids = g?.globalIds?.slice(0, it.qty) || [];
      }
      for (const gid of gids) if (gid) map.set(gid, o.status);
    }
  }
  return map;
}

function applyStatusColors() {
  if (!V) return; // called from the order flow too — nothing to recolour before the viewer exists
  const on = $('#status-colors').checked;
  const legend = $('#status-legend');
  if (!on) {
    V.colorByStatus(() => null); // restore IFC material colors
    legend.classList.add('hidden');
    return;
  }
  // 4D on: every element wears the status it held at the instant on the slider.
  // 4D off: the status it holds now. Same painting, two sources.
  const four = fourD.on ? fourDTimeline() : null;
  const T = four ? fourDInstant() : 0;
  const byGid = four ? null : statusByGlobalId();
  const byId = new Map(currentElements.map(e => [e.id, e]));
  const used = new Set();
  const counts = new Map();
  V.colorByStatus((id) => {
    const el = byId.get(id);
    const st = !el ? null
      : four ? fourDStatusAt(four.byGid.get(el.globalId), T)
             : byGid.get(el.globalId);
    used.add(st || 'none');
    counts.set(st || 'none', (counts.get(st || 'none') || 0) + 1);
    return st ? parseInt(STATUSES[st].color.slice(1), 16) : NOT_ORDERED_COLOR;
  });
  legend.classList.remove('hidden');
  // While 4D plays, the legend lists every status the project ever reaches, including
  // the ones empty at this instant: a legend rebuilt from what is on screen right now
  // would add and drop chips on every tick, and the whole row would shuffle sideways
  // under the reader. Off 4D it stays as it was — only what is actually painted.
  const shown = four ? four.statuses : STATUS_ORDER.filter(s => used.has(s));
  const n = (k) => four ? ` <b>${counts.get(k) || 0}</b>` : '';
  // "not ordered" has nothing to label while those elements are hidden from the view
  const withNone = four ? !fourD.hideFuture : used.has('none');
  legend.innerHTML = [...shown.map(s =>
    `<span class="legend-chip"><span class="status-dot" style="background:${STATUSES[s].color}"></span>${statusLabel(s)}${n(s)}</span>`),
    ...(withNone ? [`<span class="legend-chip"><span class="status-dot" style="background:#4a5568"></span>${t('model.notOrdered')}${n('none')}</span>`] : []),
  ].join('');
}

$('#status-colors').addEventListener('change', () => {
  // 4D is a way of reading the status colors; without them it has nothing to say
  if (!$('#status-colors').checked && fourD.on) setFourD(false);
  else applyStatusColors();
});

// ---------------------------------------------------------------- 4D (the model over time)
//
// The 3D view paints the status each element holds NOW. 4D replays how it got there:
// at an instant T every element wears the status it actually held on that date. It
// writes nothing — it reads the trails the app already keeps, which have two very
// different resolutions:
//
//   * `order.events` — one entry per status transition, worded `${from} → ${to}` by
//     advanceOrder(). It moves every element of that request at once.
//   * `order.tracking[gid]` — the per-element scans (built, loaded, lifted, fixed, …).
//     This is the only place where two elements of the same request part ways: one
//     panel is fixed on Tuesday and its neighbour on Friday, on a request that says
//     "delivered" for both.
//
// So an element's status at T is the FURTHEST of the two, not the most recent. Taking
// the most recent would step an element that is already fixed back to "delivered" the
// day the request as a whole catches up.
const STATUS_RANK = new Map(STATUS_ORDER.map((s, i) => [s, i]));
// The transition events store the English labels from STATUSES — they are written at
// push time and never translated — so the label is what maps back to a status key.
// STATUS_BY_LABEL (declared with the takt analytics, which reads the same trail) is
// that map; the cycle-time charts have been reading it this way for a while.
// what a scan proves about that element on its own: built = it exists (LOD400),
// loaded = it left the factory, lifted = it is on the structure, fixed and everything
// after it = installed.
const PHASE_IMPLIES = {
  built: 'ready', loaded: 'transit', lifted: 'delivered',
  fixed: 'installed', diaphragms: 'installed', groutPrep: 'installed', grouted: 'installed',
};

const HOUR_MS = 3600e3;
const DAY_MS = 24 * HOUR_MS;
const fourD = {
  on: false, playing: false, timer: null, speed: 1, hideFuture: false,
  t0: 0, stepMs: DAY_MS, steps: 0, idx: 0, // the time axis, rebuilt from the timeline
  tl: null, sig: '',                       // cached timeline + the signature it was built from
};

// Requests only ever gain events (store.js pushes one for every status change, every
// scan, every non-conformity), so counting them is a version number for the whole
// project — the same reasoning the offline queue uses to spot a stale order.
function fourDSignature() {
  const prj = activeProject();
  if (!prj) return '';
  let orders = 0, events = 0;
  for (const o of state.orders) {
    if (o.projectId !== prj.id) continue;
    orders++;
    events += (o.events || []).length;
  }
  return `${prj.id}:${orders}:${events}`;
}

function buildFourDTimeline() {
  const prj = activeProject();
  const byGid = new Map();   // globalId -> { steps (shared per request), scans (per element) }
  const marks = [];          // { t, text } — what changed, for the strip under the slider
  const statuses = new Set();
  let min = Infinity, max = -Infinity;
  if (!prj) return { byGid, marks, statuses: [], min: null, max: null };

  for (const o of state.orders) {
    if (o.projectId !== prj.id) continue;
    const steps = [];
    for (const ev of o.events || []) {
      const at = Date.parse(ev.ts);
      if (isNaN(at)) continue;
      const parts = String(ev.action || '').split(' → ');
      const to = parts.length === 2 ? STATUS_BY_LABEL[parts[1].trim()]
               : ev.action === 'Created' ? 'draft' : null;
      if (to) steps.push({ t: at, status: to });
      marks.push({ t: at, text: `${o.code || ''} ${ev.action || ''}`.trim() });
    }
    // a request imported without a readable trail still has to appear somewhere:
    // place it at its creation date wearing the status it holds today
    if (!steps.length) {
      const at = Date.parse(o.createdAt || o.events?.[0]?.ts || '');
      if (!isNaN(at)) steps.push({ t: at, status: o.status });
    }
    if (!steps.length) continue;
    steps.sort((a, b) => a.t - b.t);
    for (const s of steps) {
      statuses.add(s.status);
      if (s.t < min) min = s.t;
      if (s.t > max) max = s.t;
    }
    // every element of this request shares ONE step array — a 5 000-element model
    // must not build 5 000 copies of the same eight entries
    for (const it of o.items || []) {
      let gids = it.globalIds;
      if (!gids || !gids.length) { // requests created before GUID snapshots
        const g = prj.groups.find(x => x.key === it.key);
        gids = g?.globalIds?.slice(0, it.qty) || [];
      }
      for (const gid of gids) {
        if (!gid) continue;
        const scans = [];
        for (const [phase, iso] of Object.entries(o.tracking?.[gid] || {})) {
          const status = PHASE_IMPLIES[phase];
          const at = Date.parse(iso);
          if (!status || isNaN(at)) continue;
          scans.push({ t: at, status });
          statuses.add(status);
          if (at < min) min = at;
          if (at > max) max = at;
        }
        byGid.set(gid, { steps, scans });
      }
    }
  }
  marks.sort((a, b) => a.t - b.t);
  return {
    byGid, marks,
    statuses: STATUS_ORDER.filter(s => statuses.has(s)),
    min: min === Infinity ? null : min,
    max: max === -Infinity ? null : max,
  };
}

function fourDTimeline() {
  const sig = fourDSignature();
  if (!fourD.tl || fourD.sig !== sig) { fourD.tl = buildFourDTimeline(); fourD.sig = sig; }
  return fourD.tl;
}

// null = this element had no production request yet at T
function fourDStatusAt(entry, T) {
  if (!entry) return null;
  let status = null;
  for (const s of entry.steps) { if (s.t > T) break; status = s.status; } // sorted
  let rank = status == null ? -1 : STATUS_RANK.get(status);
  for (const s of entry.scans) {
    if (s.t > T) continue;
    const r = STATUS_RANK.get(s.status);
    if (r > rank) { rank = r; status = s.status; }
  }
  return status;
}

// the instant the slider currently points at: the END of the step, so a step labelled
// "12/03" includes everything that happened on the 12th
const fourDInstant = () => fourD.t0 + (fourD.idx + 1) * fourD.stepMs - 1;

// local midnight, not UTC: the dates on the slider are the dates on site
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

// Lay the time axis over the project's own history. A project that ran for months
// steps a day at a time; test data where everything happened this afternoon would
// otherwise be a single step, so anything under three days steps by the hour.
// Returns false when there is nothing to replay.
function fourDSetRange() {
  const tl = fourDTimeline();
  const atEnd = fourD.steps === 0 || fourD.idx >= fourD.steps - 1;
  if (tl.min == null) { fourD.steps = 0; fourD.idx = 0; return false; }
  const span = tl.max - tl.min;
  if (span > 3 * DAY_MS) {
    fourD.stepMs = DAY_MS;
    fourD.t0 = startOfDay(tl.min);
    fourD.steps = Math.max(1, Math.round((startOfDay(tl.max) - fourD.t0) / DAY_MS) + 1);
  } else {
    fourD.stepMs = HOUR_MS;
    fourD.t0 = Math.floor(tl.min / HOUR_MS) * HOUR_MS;
    fourD.steps = Math.max(1, Math.ceil((tl.max - fourD.t0) / HOUR_MS) + 1);
  }
  // a request added while the bar is open extends the axis; if the slider was parked
  // at the present it should stay at the present, not fall behind the new end
  fourD.idx = atEnd ? fourD.steps - 1 : Math.min(fourD.idx, fourD.steps - 1);
  return true;
}

// A six-month project is 180 steps and a week is 7: one fixed tick rate would make one
// of them unwatchable. Aim for roughly 20 seconds end to end, whatever the length.
const fourDInterval = () =>
  Math.min(700, Math.max(80, 20000 / Math.max(1, fourD.steps))) / fourD.speed;

function fourDRepaint() {
  applyStatusColors();
  if (fourD.hideFuture) applyModelVisibility();
  renderFourDBar();
}

function renderFourDBar() {
  const bar = $('#fourd-bar');
  const strip = $('#fourd-changes');
  bar.classList.toggle('hidden', !fourD.on);
  strip.classList.toggle('hidden', !fourD.on);
  $('#btn-4d').classList.toggle('primary', fourD.on);
  if (!fourD.on) return;
  fourDSetRange();
  const range = $('#fourd-range');
  range.max = String(Math.max(0, fourD.steps - 1));
  range.value = String(fourD.idx);
  range.setAttribute('aria-label', t('fourd.rangeLabel'));
  const at = fourD.t0 + fourD.idx * fourD.stepMs;
  $('#fourd-date').textContent = fourD.stepMs >= DAY_MS
    ? new Date(at).toLocaleDateString()
    : fmtDate(new Date(at).toISOString());
  const play = $('#fourd-play');
  play.textContent = fourD.playing ? '⏸' : '▶';
  play.title = t(fourD.playing ? 'fourd.pause' : 'fourd.play');
  // what changed inside this step — the reason the colours moved
  const tl = fourDTimeline();
  const from = at, to = fourDInstant();
  const hits = tl.marks.filter(m => m.t >= from && m.t <= to);
  strip.textContent = hits.length
    ? hits.slice(0, 3).map(m => m.text).join(' · ') + (hits.length > 3 ? ' · ' + t('fourd.more', { n: hits.length - 3 }) : '')
    : '';
}

function fourDStop() { // stop the clock, keep the date
  if (fourD.timer) { clearTimeout(fourD.timer); fourD.timer = null; }
  fourD.playing = false;
}

function fourDTick() {
  fourD.timer = setTimeout(() => {
    if (!fourD.playing) return;
    if (fourD.idx >= fourD.steps - 1) { fourDStop(); fourDRepaint(); return; }
    fourD.idx++;
    fourDRepaint();
    fourDTick();
  }, fourDInterval());
}

function fourDPlay() {
  if (fourD.steps < 2) return;
  // pressing play at the end replays from the beginning rather than doing nothing
  if (fourD.idx >= fourD.steps - 1) fourD.idx = 0;
  fourD.playing = true;
  fourDRepaint();
  fourDTick();
}

function setFourD(on) {
  fourDStop();
  if (on) {
    if (!fourDSetRange()) { toast(t('fourd.noHistory')); return; }
    // 4D speaks in status colours; turning it on turns them on
    if (!$('#status-colors').checked) $('#status-colors').checked = true;
    fourD.on = true;
    fourD.idx = fourD.steps - 1; // open at the present — the model already on screen
  } else {
    fourD.on = false;
  }
  fourDRepaint();
  applyModelVisibility(); // hideFuture may have been hiding elements
}

// called when the model or the project changes under the bar
function fourDReset() {
  fourDStop();
  fourD.tl = null;
  fourD.sig = '';
  if (fourD.on && !fourDSetRange()) fourD.on = false; // the new project may have no history
  renderFourDBar();
}

$('#btn-4d').addEventListener('click', () => setFourD(!fourD.on));
$('#fourd-play').addEventListener('click', () => (fourD.playing ? (fourDStop(), fourDRepaint()) : fourDPlay()));
$('#fourd-range').addEventListener('input', () => {
  fourDStop(); // dragging takes over from the playback
  fourD.idx = Number($('#fourd-range').value);
  fourDRepaint();
});
$('#fourd-speed').addEventListener('change', () => { fourD.speed = Number($('#fourd-speed').value) || 1; });
$('#fourd-hide-future').addEventListener('change', () => {
  fourD.hideFuture = $('#fourd-hide-future').checked;
  applyModelVisibility();
  applyStatusColors(); // the "not ordered" chip has nothing to label while they are hidden
});

// One predicate for everything that can hide a mesh: the category/level checkboxes
// and, while 4D runs with "hide not yet ordered" on, the elements that had no request
// yet on that date. They used to be two independent calls to applyVisibility(), and
// the second one silently undid the first.
//
// The QTO deliberately does NOT follow the 4D part of this: visibleElements() reads
// modelFilter alone, so the quantities of the model stay the quantities of the model
// whatever date the slider is on.
function applyModelVisibility() {
  if (!V || !currentElements.length) return;
  const byId = new Map(currentElements.map(e => [e.id, e]));
  const four = fourD.on && fourD.hideFuture ? fourDTimeline() : null;
  const T = four ? fourDInstant() : 0;
  V.applyVisibility((id) => {
    const el = byId.get(id);
    if (!el) return true; // geometry not classified (rare) — keep visible
    if (modelFilter) {
      if (!modelFilter.types.has(el.type)) return false;
      if (el.storeyId != null && currentStoreys.length && !modelFilter.storeys.has(el.storeyId)) return false;
    }
    if (four && fourDStatusAt(four.byGid.get(el.globalId), T) == null) return false;
    return true;
  });
}

// Visibility filters: element categories (walls, slabs, …) and building levels
function renderModelFilters() {
  const box = $('#model-filters');
  modelFilter = null; // fresh model → everything visible
  if (!currentElements.length) { box.innerHTML = ''; return; }
  const types = [...new Set(currentElements.map(e => e.type))].sort();

  box.innerHTML = `
    <h3>${t('model.showHide')}
      <span style="float:right;font-weight:400;text-transform:none">
        <a href="#" id="flt-all">${t('model.all')}</a> · <a href="#" id="flt-none">${t('model.none')}</a>
      </span>
    </h3>
    <div class="filter-group">
      ${types.map(ty => {
        const n = currentElements.filter(e => e.type === ty).length;
        return `<label class="filter-item"><input type="checkbox" class="flt-type" value="${esc(ty)}" checked> ${esc(ty)} <span class="muted">(${n})</span></label>`;
      }).join('')}
    </div>
    ${currentStoreys.length ? `
    <h3 style="margin-top:var(--sp-3)">${t('model.levels')}</h3>
    <div class="filter-group">
      ${currentStoreys.map(s => `<label class="filter-item"><input type="checkbox" class="flt-storey" value="${s.id}" checked> ${esc(s.name)} <span class="muted">(${fmtNum(s.elevation, 2)} m)</span></label>`).join('')}
    </div>` : ''}
    <hr style="border:none;border-top:1px solid var(--line);margin:12px 0">`;

  const update = () => {
    const shownTypes = new Set([...box.querySelectorAll('.flt-type:checked')].map(c => c.value));
    const shownStoreys = new Set([...box.querySelectorAll('.flt-storey:checked')].map(c => Number(c.value)));
    modelFilter = { types: shownTypes, storeys: shownStoreys };
    qtoSelection.clear(); // QTO follows the visible elements, so old selections may be stale
    applyModelVisibility();
    renderQto(); // keep the quantities table in sync with what the 3D view shows
  };
  box.querySelectorAll('input').forEach(c => c.addEventListener('change', update));
  box.querySelector('#flt-all').addEventListener('click', (e) => {
    e.preventDefault();
    box.querySelectorAll('.flt-type, .flt-storey').forEach(c => c.checked = true);
    update();
  });
  box.querySelector('#flt-none').addEventListener('click', (e) => {
    e.preventDefault();
    box.querySelectorAll('.flt-type').forEach(c => c.checked = false);
    update();
  });
}

// onSelect is registered inside loadViewerStack() — registering it here would run
// before viewer.js exists

function renderElementPanel(expressID, selection = V?.getSelection()) {
  const box = $('#element-info');
  let infoHtml = `<span class="muted">${t('element.clickHint')}</span>`;
  if (expressID != null) {
    const info = I?.getElementInfo(currentModelID, expressID);
    const el = currentElements.find(x => x.id === expressID);
    if (info) {
      const rows = [
        [t('element.name'), info.name], [t('element.class'), el?.ifcClass || info.class], [t('element.guid'), info.globalId],
        [t('element.tag'), info.tag], [t('element.expressId'), expressID],
        [t('element.volume'), el?.volume != null ? fmtNum(el.volume) : null],
        [t('element.area'), el?.area != null ? fmtNum(el.area) : null],
      ].filter(([, v]) => v !== null && v !== undefined && v !== '');
      infoHtml = rows.map(([k, v]) =>
        `<div class="prop-row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('');
    }
  }
  const sel = currentElements.filter(e => selection.includes(e.id));
  const canCreate = CREATOR_ROLES.includes(state.role);
  box.innerHTML = infoHtml + (sel.length ? `
    <h3 style="margin:14px 0 6px">${t('element.selection', { n: sel.length })}</h3>
    <div class="muted" style="font-size:var(--fs-200);max-height:110px;overflow:auto;margin-bottom:var(--sp-3)">
      ${sel.map(e => esc(e.name)).join('<br>')}
    </div>
    <div style="display:flex;flex-direction:column;gap:var(--sp-2)">
      ${canCreate ? `<button class="btn primary" id="btn-order-selection">${t('element.createRequest', { n: sel.length })}</button>` : ''}
      <button class="btn small" id="btn-clear-selection">${t('element.clearSelection')}</button>
    </div>` : '');
  box.classList.toggle('muted', !sel.length && expressID == null);
  $('#btn-order-selection')?.addEventListener('click', () => {
    const groups = aggregateGroups(sel);
    openCreateOrderModal(groups.map(g => ({
      key: g.key, type: g.type, name: g.name, unit: 'un', qty: g.count,
      volume: g.volume, area: g.area, weight: g.weight, globalIds: g.globalIds,
    })));
  });
  $('#btn-clear-selection')?.addEventListener('click', () => V?.clearSelection());
}

// ---------------------------------------------------------------- Dashboard charts
// Small inline-SVG/HTML chart builders shared by the dashboard. Bars keep the
// existing div-track approach (already accessible, native tooltips via title=);
// the donut and trend are real SVG since they need arcs/paths. Colors: status
// bars use the app's existing STATUSES palette (already reserved/semantic);
// identity-by-project uses the fixed categorical order below — never cycled,
// never reassigned when the filtered set changes.
const CHART_CATEGORICAL = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834'];

function svgBarChart(rows) {
  // rows: [{ label, value, color, display? }]
  if (!rows.length) return '';
  const max = Math.max(1, ...rows.map(r => r.value));
  return `<div class="chart-bars">${rows.map(r => {
    const pct = r.value > 0 ? Math.max(2, r.value / max * 100) : 0;
    const shown = r.display ?? fmtNum(r.value, 0);
    return `<div class="bar-row" title="${esc(r.label)}: ${esc(shown)}">
      <div class="bar-label" title="${esc(r.label)}">${esc(r.label)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${r.color}"></div></div>
      <div class="bar-value">${esc(shown)}</div>
    </div>`;
  }).join('')}</div>`;
}

// thin ring donut (stroke-dasharray trick) + hero total + direct-labeled legend
function svgDonut(rows, caption, { size = 116, thickness = 16 } = {}) {
  const total = rows.reduce((s, r) => s + r.value, 0);
  if (!total) return `<div class="muted" style="font-size:var(--fs-400)">${t('dashboard.noData')}</div>`;
  const r = (size - thickness) / 2;
  const cx = size / 2, cy = size / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const gapPx = 2; // surface gap between adjacent segments
  const arcs = rows.filter(row => row.value > 0).map(row => {
    const dash = Math.max(0, (row.value / total) * circ - gapPx);
    const el = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${row.color}" stroke-width="${thickness}"
        stroke-dasharray="${dash.toFixed(1)} ${(circ - dash).toFixed(1)}" stroke-dashoffset="${(-offset).toFixed(1)}"
        transform="rotate(-90 ${cx} ${cy})"><title>${esc(row.label)}: ${fmtNum(row.value, 0)} (${fmtNum(row.value / total * 100, 0)}%)</title></circle>`;
    offset += (row.value / total) * circ;
    return el;
  }).join('');
  return `
    <div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="flex:none">
        ${arcs}
        <text x="${cx}" y="${cy - 3}" text-anchor="middle" style="font-size:20px;font-weight:700;fill:var(--text)">${fmtNum(total, 0)}</text>
        <text x="${cx}" y="${cy + 14}" text-anchor="middle" style="font-size:var(--fs-100);fill:var(--muted)">${esc(caption)}</text>
      </svg>
      <div style="display:flex;flex-direction:column;gap:5px">
        ${rows.map(row => `<span class="legend-chip"><span class="status-dot" style="background:${row.color}"></span>${esc(row.label)}
          <b style="margin-left:4px">${fmtNum(row.value, 0)}</b> <span class="muted">(${fmtNum(total ? row.value / total * 100 : 0, 0)}%)</span></span>`).join('')}
      </div>
    </div>`;
}

// line + area trend with a hover crosshair — the only "change over time" chart
// on the dashboard, so it earns its own SVG (bars/donut don't need an axis)
function svgTrendChart(points, { width = 520, height = 130 } = {}) {
  if (points.length < 2) return `<div class="muted" style="font-size:var(--fs-400)">${t('dashboard.trend.none')}</div>`;
  const pad = { l: 34, r: 10, t: 10, b: 20 };
  const innerW = width - pad.l - pad.r, innerH = height - pad.t - pad.b;
  const maxV = Math.max(1, ...points.map(p => p.value));
  const n = points.length;
  const x = (i) => pad.l + (n === 1 ? 0 : (i / (n - 1)) * innerW);
  const y = (v) => pad.t + innerH - (v / maxV) * innerH;
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
  const area = `${line} L ${x(n - 1).toFixed(1)} ${(pad.t + innerH).toFixed(1)} L ${x(0).toFixed(1)} ${(pad.t + innerH).toFixed(1)} Z`;
  const tickVals = [0, 0.5, 1].map(f => Math.round(maxV * f));
  const id = 'trend' + Math.random().toString(36).slice(2, 8);
  return `
    <div class="chart-trend-wrap" style="position:relative">
      <svg width="100%" viewBox="0 0 ${width} ${height}" id="${id}"
        data-points='${JSON.stringify(points).replace(/'/g, '&#39;')}' data-max="${maxV}"
        data-padl="${pad.l}" data-padt="${pad.t}" data-innerw="${innerW}" data-innerh="${innerH}">
        ${tickVals.map(v => `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"
            stroke="var(--line)" stroke-width="1"/>
          <text x="${pad.l - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" style="font-size:9px;fill:var(--muted)">${fmtNum(v, 0)}</text>`).join('')}
        <path d="${area}" fill="var(--accent)" opacity="0.12"/>
        <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <g class="chart-hover" style="display:none">
          <line class="chart-crosshair" y1="${pad.t}" y2="${pad.t + innerH}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3"/>
          <circle r="4" fill="var(--accent)" stroke="#fff" stroke-width="1.5"/>
        </g>
      </svg>
      <div class="chart-tooltip hidden" id="${id}-tip"></div>
    </div>`;
}

function wireTrendHover(svgId) {
  const svg = document.getElementById(svgId);
  if (!svg) return;
  const points = JSON.parse(svg.dataset.points);
  const maxV = Number(svg.dataset.max);
  const padl = Number(svg.dataset.padl), padt = Number(svg.dataset.padt);
  const innerw = Number(svg.dataset.innerw), innerh = Number(svg.dataset.innerh);
  const n = points.length;
  const hoverG = svg.querySelector('.chart-hover');
  const crosshair = svg.querySelector('.chart-crosshair');
  const dot = svg.querySelector('.chart-hover circle');
  const tip = document.getElementById(svgId + '-tip');
  const wrap = svg.parentElement;
  const move = (e) => {
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const mx = (e.clientX - rect.left) * (vb.width / rect.width);
    const idx = Math.max(0, Math.min(n - 1, Math.round(((mx - padl) / innerw) * (n - 1))));
    const p = points[idx];
    const px = padl + (n === 1 ? 0 : (idx / (n - 1)) * innerw);
    const py = padt + innerh - (p.value / maxV) * innerh;
    crosshair.setAttribute('x1', px); crosshair.setAttribute('x2', px);
    dot.setAttribute('cx', px); dot.setAttribute('cy', py);
    hoverG.style.display = '';
    tip.textContent = `${new Date(p.date + 'T12:00').toLocaleDateString()} — ${fmtNum(p.value, 0)}`;
    tip.classList.remove('hidden');
    const wrapRect = wrap.getBoundingClientRect();
    tip.style.left = Math.max(0, Math.min(wrapRect.width - 96, (e.clientX - wrapRect.left) + 10)) + 'px';
    tip.style.top = Math.max(0, (e.clientY - wrapRect.top) - 30) + 'px';
  };
  svg.addEventListener('mousemove', move);
  svg.addEventListener('mouseleave', () => { hoverG.style.display = 'none'; tip.classList.add('hidden'); });
}

// cumulative installed elements per day across the whole portfolio (same event-text
// matching computeKpis uses, so it stays consistent with the productivity KPI)
function installTrendData() {
  const daily = new Map();
  for (const o of state.orders) {
    const n = orderItemCount(o);
    for (const e of o.events || []) {
      if ((e.action || '').includes('→ Installed')) {
        const d = (e.ts || '').slice(0, 10);
        daily.set(d, (daily.get(d) || 0) + n);
      }
    }
  }
  const days = [...daily.keys()].sort();
  let cum = 0;
  return days.map(d => { cum += daily.get(d); return { date: d, value: cum }; });
}

function renderDashboard() {
  const k = computeKpis(); // whole portfolio (KPI cards)
  const box = $('#dashboard-content');
  const active = activeProject();
  const canCreateProjects = hasFullAccess(currentUser.role); // only admin/project director create or delete projects
  const canManageModels = CREATOR_ROLES.includes(state.role); // directors edit projects and upload/replace IFC — foremen and externals don't

  // status chart follows the selected project
  const ka = active ? computeKpis(active.id) : k;
  const statusBars = STATUS_ORDER
    .map(s => ({ s, ...ka.perStatus[s] }))
    .filter(r => r.orders > 0)
    .map(r => ({ label: statusLabel(r.s), value: r.elements, color: STATUSES[r.s].color }));

  const classBars = (() => {
    if (!active?.groups?.length) return null;
    const byClass = new Map();
    for (const g of active.groups) byClass.set(g.type, (byClass.get(g.type) || 0) + g.count);
    return [...byClass.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([type, count], i) => ({ label: type, value: count, color: CHART_CATEGORICAL[i % CHART_CATEGORICAL.length] }));
  })();

  const portfolioDonut = state.projects
    .map((p, i) => ({ label: p.name, value: p.summary.elementCount, color: CHART_CATEGORICAL[i % CHART_CATEGORICAL.length] }));
  const trendPoints = installTrendData();

  box.innerHTML = `
    <div class="kpi-grid">
      <div class="card"><div class="kpi-label">${t('dashboard.kpi.projects')}</div>
        <div class="kpi-value">${state.projects.length}</div>
        <div class="kpi-sub">${t('dashboard.kpi.modelElements', { n: fmtNum(state.projects.reduce((s, p) => s + p.summary.elementCount, 0), 0) })}</div></div>
      <div class="card"><div class="kpi-label">${t('dashboard.kpi.productionRequests')}</div>
        <div class="kpi-value">${k.totalOrders}</div>
        <div class="kpi-sub">${t('dashboard.kpi.elementsRequested', { n: fmtNum(k.totalElements, 0) })}</div></div>
      <div class="card"><div class="kpi-label">${t('dashboard.kpi.elementsInstalled')}</div>
        <div class="kpi-value">${fmtNum(k.installed, 0)}</div>
        <div class="kpi-sub">${k.totalElements ? t('dashboard.kpi.ofRequested', { pct: fmtNum(k.installed / k.totalElements * 100, 1) }) : ''}</div></div>
      <div class="card"><div class="kpi-label">${t('dashboard.kpi.productivity')}</div>
        <div class="kpi-value">${k.installedPerDay != null ? fmtNum(k.installedPerDay, 1) : '—'}</div>
        <div class="kpi-sub">${t('dashboard.kpi.elementsPerDay')}</div></div>
      <div class="card"><div class="kpi-label">${t('dashboard.kpi.onTimePpc')}</div>
        <div class="kpi-value">${k.ppc != null ? fmtNum(k.ppc, 0) + '%' : '—'}</div>
        <div class="kpi-sub">${k.dueCount ? t('dashboard.kpi.requestsWithJit', { n: k.dueCount }) : t('dashboard.kpi.noJitDue')}</div></div>
      <div class="card"><div class="kpi-label">${t('dashboard.kpi.nonConformities')}</div>
        <div class="kpi-value" ${k.ncOpen ? 'style="color:var(--red-text)"' : ''}>${k.ncOpen}</div>
        <div class="kpi-sub">${t('dashboard.kpi.ncOpenSub', { total: k.ncCount })}${k.ncRate != null ? ' · ' + t('dashboard.kpi.ofInstalled', { pct: fmtNum(k.ncRate, 2) }) : ''}</div></div>
      <div class="card"><div class="kpi-label">${t('dashboard.kpi.carbon')}</div>
        <div class="kpi-value">${(() => { const c = state.projects.reduce((s, p) => s + projectCarbon(p), 0); return c ? fmtNum(c / 1000, 0) : '—'; })()}</div>
        <div class="kpi-sub">${t('dashboard.kpi.carbonSub')}</div></div>
      ${state.role !== 'site' ? `<div class="card"><div class="kpi-label">${t('dashboard.kpi.lowStock')}</div>
        <div class="kpi-value" ${lowStockComponents().length ? 'style="color:var(--red-text)"' : ''}>${lowStockComponents().length}</div>
        <div class="kpi-sub">${t('dashboard.kpi.lowStockSub', { n: state.components.length })}</div></div>` : ''}
    </div>

    <div class="card" style="margin-bottom:var(--sp-4)">
      <div class="card-head-row">
        <h3>${t('dashboard.projects.title')}</h3>
        ${canCreateProjects ? `<button class="btn small primary" id="btn-new-project">${t('dashboard.projects.new')}</button>` : ''}
      </div>
      ${state.projects.length ? `<div class="project-grid">
        ${state.projects.map(p => {
          const pk = computeKpis(p.id);
          const pct = pk.totalElements ? pk.installed / pk.totalElements * 100 : 0;
          const hasModel = !!p.fileName;
          return `<div class="project-card ${p.id === state.activeProjectId ? 'active' : ''} ${hasModel ? '' : 'no-model'}" data-prj="${p.id}">
            <div class="project-head">
              <div>
                <div class="project-name">${esc(p.name)}</div>
                <div class="muted" style="font-size:var(--fs-200)">${hasModel ? t('dashboard.projects.imported', { file: esc(p.fileName), date: fmtDate(p.importedAt) }) : t('dashboard.projects.noModel')}</div>
              </div>
              ${p.id === state.activeProjectId ? `<span class="badge badge-active">${t('dashboard.projects.active')}</span>` : ''}
            </div>
            <div class="muted" style="font-size:var(--fs-200)">📍 ${p.address ? esc(p.address) : `<i>${t('dashboard.projects.noAddress')}</i>`}</div>
            <div class="project-stats">
              <span>${t('dashboard.projects.elements', { n: fmtNum(p.summary.elementCount, 0) })}</span>
              <span>${t('dashboard.projects.requests', { n: pk.totalOrders })}</span>
              <span>${t('dashboard.projects.installed', { a: fmtNum(pk.installed, 0), b: fmtNum(pk.totalElements, 0) })}</span>
            </div>
            <div class="bar-track" style="height:8px"><div class="bar-fill" style="width:${pct}%;background:var(--green)"></div></div>
            <div class="project-actions">
              ${hasModel ? `<button class="btn small" data-open="${p.id}">${t('dashboard.projects.openQto')}</button>` : ''}
              ${canManageModels ? `<button class="btn small ${hasModel ? '' : 'primary'}" data-uploadprj="${p.id}" title="${hasModel ? esc(t('dashboard.projects.replaceIfcTitle')) : esc(t('dashboard.projects.uploadIfcTitle'))}">${hasModel ? t('dashboard.projects.replaceIfc') : t('dashboard.projects.uploadIfc')}</button>
              <button class="ghost small" data-editprj="${p.id}">✎ ${t('common.edit')}</button>` : ''}
              ${canCreateProjects ? `<button class="ghost small danger" data-delprj="${p.id}">${t('common.delete')}</button>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>` : `<div class="empty-state"><div class="big">🏗️</div>
        ${t('dashboard.projects.noneYet')}${canCreateProjects
          ? `<br><button class="btn primary" id="btn-new-project-empty" style="margin-top:var(--sp-3)">${t('dashboard.projects.createFirst')}</button>`
          : `<br><span class="muted">${t('dashboard.projects.askAdmin')}</span>`}</div>`}
    </div>

    <div class="grid-2">
      <div class="card">
        <h3>${t('dashboard.portfolio.title')}</h3>
        ${svgDonut(portfolioDonut, t('dashboard.elements'))}
      </div>
      <div class="card">
        <h3>${t('dashboard.trend.title')}</h3>
        ${svgTrendChart(trendPoints)}
        <div class="muted" style="font-size:var(--fs-200);margin-top:var(--sp-2)">${t('dashboard.trend.hint')}</div>
      </div>
    </div>

    <div class="grid-2" style="margin-top:14px">
      <div class="card">
        <h3>${t('dashboard.byStatus.title', { scope: active ? esc(active.name) : t('dashboard.byStatus.allProjects') })}</h3>
        ${statusBars.length ? svgBarChart(statusBars) : `<div class="muted">${t('dashboard.byStatus.none')}</div>`}
      </div>
      <div class="card">
        <h3>${t('dashboard.typologies.title', { scope: active ? esc(active.name) : t('dashboard.typologies.none') })}</h3>
        ${classBars ? svgBarChart(classBars) : `<div class="muted">${t('dashboard.typologies.loadModel')}</div>`}
      </div>
    </div>

    <div class="grid-2" style="margin-top:14px">
      <div class="card">
        <h3>${t('dashboard.lookahead.title')}</h3>
        <div id="lookahead-body" class="muted">${t('dashboard.lookahead.loading')}</div>
      </div>
      <div class="card">
        <h3>${t('dashboard.forecast.title')}</h3>
        <div id="forecast-body" class="muted">${t('dashboard.lookahead.loading')}</div>
      </div>
    </div>`;

  box.querySelectorAll('svg[data-points]').forEach(svg => wireTrendHover(svg.id));
  box.querySelectorAll('.project-card').forEach(c => c.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    state.activeProjectId = c.dataset.prj;
    save();
    qtoSelection.clear();
    renderProjectSelect();
    renderDashboard();
  }));
  box.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => {
    state.activeProjectId = b.dataset.open;
    save();
    qtoSelection.clear();
    renderProjectSelect();
    showView('model');
  }));
  box.querySelectorAll('[data-editprj]').forEach(b => b.addEventListener('click', () => openProjectModal(b.dataset.editprj)));
  box.querySelectorAll('[data-uploadprj]').forEach(b => b.addEventListener('click', () => {
    dashUploadTargetId = b.dataset.uploadprj;
    $('#dash-ifc-input').click();
  }));
  box.querySelectorAll('[data-delprj]').forEach(b => b.addEventListener('click', () => {
    const p = getProject(b.dataset.delprj);
    const n = state.orders.filter(o => o.projectId === p.id).length;
    if (!confirm(t('project.deleteConfirm', { name: p.name, n: n ? t('project.deleteConfirmOrders', { n }) : '' }))) return;
    deleteProject(p.id);
    deleteIfcFile(p.id).catch(() => {});
    fetch('api/ifc/' + p.id, { method: 'DELETE' }).catch(() => {});
    if (loadedProjectId === p.id) loadedProjectId = null;
    renderProjectSelect();
    renderDashboard();
  }));
  $('#btn-new-project')?.addEventListener('click', openNewProjectModal);
  $('#btn-new-project-empty')?.addEventListener('click', openNewProjectModal);

  renderWeather();
}

// ---------------------------------------------------------------- create project / upload IFC (from dashboard)

let dashUploadTargetId = null;
$('#dash-ifc-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  const targetId = dashUploadTargetId;
  dashUploadTargetId = null;
  e.target.value = '';
  if (!file || !targetId) return;
  await uploadIfcToProject(targetId, await file.arrayBuffer(), file.name);
});

// parses an IFC and attaches it to an EXISTING project (create or replace), keeping its name/address
async function uploadIfcToProject(projectId, buffer, fileName) {
  ++modelLoadToken;
  busyStart(t('model.loadingParse', { file: fileName }));
  await paintYield();
  try {
    const parsed = await parseOnly(buffer);
    const { elements, groups } = parsed;
    const prj = attachIfcData(projectId, {
      fileName,
      importedAt: nowIso(),
      groups,
      summary: {
        elementCount: elements.length,
        totalVolume: groups.reduce((s, g) => s + g.volume, 0),
        totalWeight: groups.reduce((s, g) => s + g.weight, 0),
      },
    });
    loadedProjectId = prj.id;
    qtoSelection.clear();
    renderProjectSelect();
    renderQto();
    renderDashboard();
    // upload to the server with a real progress bar — this is the slow part when
    // replacing a big model, so the user sees the % climb instead of a frozen UI
    busyLabel(t('model.uploading', { file: fileName }));
    const d = await uploadIfc(prj.id, buffer);
    saveIfcFile(prj.id, buffer).catch(e => console.warn('Could not store IFC file locally:', e));
    busyDone();
    toast(d?.ok ? t('model.loadedSavedToast', { n: elements.length, g: groups.length })
                : t('model.savedLocalOnly'));
    // let the user pick which element types get 3D geometry (fewer types = faster)
    openGeometrySelectModal(prj.id, async (sel) => {
      showViewerLoading(t('model.loadingGeom'));
      await paintYield();
      const meshCount = await showGeometry(sel);
      hideViewerLoading();
      if (!meshCount) toast(t('model.noGeometryToast'));
    });
  } catch (err) {
    busyDone();
    console.error(err);
    toast(t('model.failedParse', { err: err.message }));
  }
}

function openNewProjectModal() {
  openModal(`
    <h2>${t('project.new')}</h2>
    <div class="form-row"><label>${t('project.name')}</label>
      <input type="text" id="np-name" placeholder="${esc(t('project.namePlaceholder'))}"></div>
    <div class="form-row"><label>${t('project.address')}</label>
      <input type="text" id="np-address" placeholder="${esc(t('project.addressPlaceholder'))}"></div>
    <div class="form-row"><label>${t('project.ifcOptional')}</label>
      <input type="file" id="np-file" accept=".ifc"></div>
    <div class="modal-actions">
      <button class="btn" id="np-cancel">${t('common.cancel')}</button>
      <button class="btn primary" id="np-save">${t('project.create')}</button>
    </div>`);
  $('#np-cancel').addEventListener('click', closeModal);
  $('#np-save').addEventListener('click', async () => {
    const name = $('#np-name').value.trim();
    if (!name) { toast(t('project.nameRequired')); return; }
    const address = $('#np-address').value.trim();
    const file = $('#np-file').files[0];
    const btn = $('#np-save');
    btn.disabled = true;

    const prj = createProjectShell({ name, address });
    if (address) {
      const geo = await geocodeAddress(address);
      if (geo) { prj.lat = geo.lat; prj.lon = geo.lon; syncProject(prj); }
    }
    closeModal();
    renderProjectSelect();
    renderDashboard();
    toast(t('project.created', { name }));
    if (file) await uploadIfcToProject(prj.id, await file.arrayBuffer(), file.name);
  });
}

function openProjectModal(id) {
  const p = getProject(id);
  if (!p) return;
  openModal(`
    <h2>${t('project.edit')}</h2>
    <div class="form-row"><label>${t('project.name')}</label>
      <input type="text" id="prj-name" value="${esc(p.name)}"></div>
    <div class="form-row"><label>${t('project.addressStreetCity')}</label>
      <input type="text" id="prj-address" placeholder="${esc(t('project.addressPlaceholder'))}" value="${esc(p.address || '')}"></div>
    ${p.fileName ? `<div class="muted" id="prj-versions" style="font-size:var(--fs-300);margin-bottom:var(--sp-3)">${t('project.versionsLoading')}</div>` : ''}
    <div class="modal-actions">
      <button class="btn" id="prj-cancel">${t('common.cancel')}</button>
      <button class="btn primary" id="prj-save">${t('project.save')}</button>
    </div>`);
  if (p.fileName) {
    fetch('api/ifc/' + p.id + '/versions').then(r => r.json()).then(d => {
      const el = $('#prj-versions');
      if (!el || !d.ok) return;
      el.textContent = d.versions.length
        ? t('project.versionsKept', { n: d.versions.length, last: d.versions[0].slice(0, 10) })
        : t('project.versionsNone');
    }).catch(() => {});
  }
  $('#prj-cancel').addEventListener('click', closeModal);
  $('#prj-save').addEventListener('click', async () => {
    const name = $('#prj-name').value.trim();
    if (!name) { toast(t('common.nameRequired')); return; }
    const address = $('#prj-address').value.trim();
    p.name = name;
    const addressChanged = address !== (p.address || '');
    p.address = address;
    if (addressChanged) {
      p.lat = null; p.lon = null;
      if (address) {
        const geo = await geocodeAddress(address);
        if (geo) {
          p.lat = geo.lat; p.lon = geo.lon;
          toast(t('project.siteLocated', { label: geo.label }));
        } else {
          toast(t('project.couldNotLocate'));
        }
      }
    }
    syncProject(p);
    closeModal();
    renderProjectSelect();
    renderDashboard();
  });
}

// Free geocoding (Open-Meteo). Works best with "locality" or "street, locality".
async function geocodeAddress(q) {
  try {
    // try the full text first, then just the part after the last comma (the locality)
    const attempts = [q, q.split(',').pop().trim()].filter((v, i, a) => v && a.indexOf(v) === i);
    for (const attempt of attempts) {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(attempt)}&count=1&language=pt&format=json`;
      const d = await (await fetch(url)).json();
      const r = d.results?.[0];
      if (r) return { lat: r.latitude, lon: r.longitude, label: [r.name, r.admin1, r.country_code].filter(Boolean).join(', ') };
    }
  } catch { /* offline or API down */ }
  return null;
}

// ---------------------------------------------------------------- Weather (crane window)

// Default site (Coimbra) when the project has no geocoded address.
// Manufacturer crane limits per the internship report: 45–50 km/h.
const SITE_COORDS = { lat: 40.2033, lon: -8.4103 };
const WIND_STOP = 45;  // km/h gusts → lifting suspended
const WIND_WARN = 30;  // km/h → monitor conditions

const weatherCacheByCoords = new Map(); // "lat,lon" -> { ts, days }

async function fetchWeather(lat = SITE_COORDS.lat, lon = SITE_COORDS.lon) {
  const cacheKey = lat.toFixed(3) + ',' + lon.toFixed(3);
  const cached = weatherCacheByCoords.get(cacheKey);
  if (cached && Date.now() - cached.ts < 30 * 60 * 1000) return cached.days;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&daily=wind_speed_10m_max,wind_gusts_10m_max,precipitation_sum&timezone=Europe%2FLisbon&forecast_days=7&wind_speed_unit=kmh';
  const d = await (await fetch(url)).json();
  const days = d.daily.time.map((t, i) => ({
    date: t,
    wind: d.daily.wind_speed_10m_max[i],
    gust: d.daily.wind_gusts_10m_max[i],
    rain: d.daily.precipitation_sum[i],
  }));
  weatherCacheByCoords.set(cacheKey, { ts: Date.now(), days });
  return days;
}

// weather is no longer shown as its own panel — it still feeds the lookahead
// wind-risk chips and the weather-adjusted install-capacity forecast
async function renderWeather() {
  try {
    const active = activeProject();
    const days = (active?.lat != null && active?.lon != null)
      ? await fetchWeather(active.lat, active.lon)
      : await fetchWeather();
    renderPlanning(days);
  } catch {
    renderPlanning([]);
  }
}

// Lookahead constraint screening (Last Planner) + plan-vs-actual + weather-informed forecast
function renderPlanning(weatherDays) {
  const lookBox = document.querySelector('#lookahead-body');
  const foreBox = document.querySelector('#forecast-body');
  if (!lookBox || !foreBox) return;
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
  const riskDates = new Set(weatherDays.filter(d => d.gust >= WIND_STOP).map(d => d.date));
  const open = state.orders.filter(o => !['installed', 'rejected'].includes(o.status));

  // --- lookahead: is each upcoming request ready to happen? ---
  const upcoming = open.filter(o => o.needBy && o.needBy >= today && o.needBy <= horizon)
    .sort((a, b) => a.needBy.localeCompare(b.needBy));
  const chip = (ok, okTxt, badTxt) =>
    `<span class="type-chip" style="color:${ok ? 'var(--green-text)' : 'var(--amber-text)'}">${ok ? '✓ ' + okTxt : '⚠ ' + badTxt}</span>`;
  lookBox.classList.remove('muted');
  lookBox.innerHTML = upcoming.length ? upcoming.map(o => {
    const prj = getProject(o.projectId);
    const accepted = STATUS_ORDER.indexOf(o.status) >= STATUS_ORDER.indexOf('accepted');
    const built = trackingCount(o, 'built');
    const total = orderGlobalIds(o).length;
    return `<div class="look-row">
      <div><b>${o.code}</b> <span class="muted">JIT ${o.needBy} · ${esc(prj?.name || '')}</span></div>
      <div class="look-chips">
        ${chip(accepted, t('dashboard.lookahead.factoryCommitted'), t('dashboard.lookahead.awaitingFactory'))}
        ${total ? chip(built >= total, t('dashboard.lookahead.allBuilt'), t('dashboard.lookahead.builtOf', { a: built, b: total })) : ''}
        ${chip(!riskDates.has(o.needBy), t('dashboard.lookahead.weatherOk'), t('dashboard.lookahead.windRisk'))}
        ${chip(!!prj?.address, t('dashboard.lookahead.siteAddressSet'), t('dashboard.lookahead.noSiteAddress'))}
      </div>
    </div>`;
  }).join('') : `<span class="muted">${t('dashboard.lookahead.none')}</span>`;

  // --- plan vs actual: overdue requests ---
  const overdue = open.filter(o => o.needBy && o.needBy < today);
  const k = computeKpis();
  const base = k.installedPerDay || 9.0; // fallback: report average for this construction system
  // forecast: capacity scaled by crane weather (stop day = 0, warn day = 70%)
  const days = weatherDays.map(d => ({
    date: d.date,
    cap: d.gust >= WIND_STOP ? 0 : d.gust >= WIND_WARN ? base * 0.7 : base,
  }));
  const weekTotal = days.reduce((s, d) => s + d.cap, 0);
  foreBox.classList.remove('muted');
  foreBox.innerHTML = `
    ${overdue.length ? `<div style="margin-bottom:var(--sp-3)">${overdue.map(o => {
      const late = Math.round((new Date(today) - new Date(o.needBy)) / 864e5);
      return `<div class="look-row" style="border-color:var(--red-text)"><b>${o.code}</b>
        <span style="color:var(--red-text)">${t('dashboard.forecast.daysLate', { n: late })}</span>
        <span class="muted">(${statusLabel(o.status)}) — ${t('dashboard.forecast.chase', { who: actorLabel(STATUSES[o.status].actor) })}</span></div>`;
    }).join('')}</div>` : `<div class="muted" style="margin-bottom:var(--sp-3)">${t('dashboard.forecast.noneBehind')}</div>`}
    <div class="muted" style="font-size:var(--fs-300);margin-bottom:6px">${t('dashboard.forecast.predictedCapacity', { base: fmtNum(base, 1) })}</div>
    ${days.map(d => `<div class="bar-row">
      <div class="bar-label">${new Date(d.date + 'T12:00').toLocaleDateString(getLang() === 'pt' ? 'pt-PT' : 'en-GB', { weekday: 'short', day: '2-digit' })}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${base ? d.cap / base * 100 : 0}%;background:${d.cap === 0 ? 'var(--red)' : d.cap < base ? 'var(--amber)' : 'var(--green)'}"></div></div>
      <div class="bar-value">${fmtNum(d.cap, 1)}</div>
    </div>`).join('')}
    <div style="margin-top:var(--sp-2);font-size:var(--fs-400)">${t('dashboard.forecast.weekCapacity', { n: fmtNum(weekTotal, 0) })}
      <span class="muted">${t('dashboard.forecast.estimateNote')}</span></div>`;
}

// ---------------------------------------------------------------- Takt planning + cycle analytics

// DAY_MS is declared with the 4D playback clock above — takt planning and the
// timeline share the same day
const addDays = (isoDate, n) => new Date(new Date(isoDate + 'T12:00').getTime() + n * DAY_MS).toISOString().slice(0, 10);

// timeline actions store the (English) status labels — map them back to keys
const STATUS_BY_LABEL = Object.fromEntries(Object.entries(STATUSES).map(([k, v]) => [v.label, k]));

// first time each status was entered, read from the order's timeline
function statusEntryTimes(o) {
  const entered = {};
  for (const e of o.events || []) {
    const parts = String(e.action || '').split(' → ');
    if (parts.length === 2) {
      const st = STATUS_BY_LABEL[parts[1].trim()];
      if (st && !entered[st]) entered[st] = e.ts;
    }
  }
  return entered;
}

const CYCLE_PHASES = [
  ['approval', 'submitted', 'accepted'],
  ['production', 'accepted', 'ready'],
  ['logistics', 'ready', 'delivered'],
  ['installation', 'delivered', 'installed'],
];

// aggregate component needs for one project's in-flight orders (mirrors stockNeeds()
// in the Stock view, scoped to a project) plus which orders share a short component —
// lets the takt board flag production that stock can't currently cover
function projectStockNeeds(projectId) {
  const agg = new Map(); // 'componentId|factoryId' -> { need, orderIds }
  for (const o of state.orders) {
    if (o.projectId !== projectId || !NEEDS_STATUSES.has(o.status)) continue;
    const recipes = getProject(o.projectId)?.recipes || {};
    for (const it of o.items || []) {
      const remaining = Math.max(0, (Number(it.qty) || 0) - (Number(o.stockConsumed?.[it.key]) || 0));
      if (!remaining) continue;
      for (const r of recipes[it.key] || []) {
        if (!(Number(r.qtyPer) > 0)) continue;
        const k = r.componentId + '|' + (o.supplierId || '');
        let g = agg.get(k);
        if (!g) agg.set(k, g = { need: 0, orderIds: new Set() });
        g.need += remaining * Number(r.qtyPer);
        g.orderIds.add(o.id);
      }
    }
  }
  const lines = [...agg].map(([k, g]) => {
    const [componentId, factoryId] = k.split('|');
    const comp = state.components.find(c => c.id === componentId);
    const have = comp?.factoryQty?.[factoryId] || 0;
    return { comp, factoryId, need: g.need, have, short: Math.max(0, g.need - have), orderIds: g.orderIds };
  }).filter(l => l.comp);
  const shortOrderIds = new Set();
  for (const l of lines) if (l.short > 0) for (const id of l.orderIds) shortOrderIds.add(id);
  return { lines: lines.sort((a, b) => b.short - a.short || a.comp.name.localeCompare(b.comp.name)), shortOrderIds };
}

function renderTaktPlanning() {
  const box = $('#planning-content');
  const p = activeProject();
  if (!p) {
    box.innerHTML = `<div class="empty-state"><div class="big">📅</div>${t('takt.noProject')}</div>`;
    return;
  }
  const takt = p.takt || { zones: [], startDate: '', periodDays: 7 };
  const canEdit = CREATOR_ROLES.includes(state.role);
  const orders = state.orders.filter(o => o.projectId === p.id && o.status !== 'rejected');
  const stockInfo = projectStockNeeds(p.id);

  // --- takt grid ---
  const today = new Date().toISOString().slice(0, 10);
  const rawPeriod = (needBy) => (!takt.startDate || !needBy) ? null
    : Math.floor((new Date(needBy) - new Date(takt.startDate)) / (takt.periodDays * DAY_MS));
  const todayRaw = takt.startDate ? rawPeriod(today) : null;
  // grow the horizon to cover the latest JIT date and today (min 6, capped at 16 columns)
  const rawIdxs = orders.map(o => rawPeriod(o.needBy)).filter(i => i != null && i >= 0);
  const periods = Math.min(16, Math.max(6, (todayRaw ?? 0) + 1, ...rawIdxs.map(i => i + 1)));
  const todayPeriod = todayRaw == null ? null : Math.max(0, Math.min(periods - 1, todayRaw));
  const periodStart = (i) => addDays(takt.startDate, i * takt.periodDays);
  const periodOf = (needBy) => {
    const i = rawPeriod(needBy);
    return i == null ? null : i < 0 ? 0 : i >= periods ? periods - 1 : i;
  };
  const isOverdue = (o) => o.needBy && o.needBy < today && !['delivered', 'installed'].includes(o.status);
  const chip = (o) => {
    const st = STATUSES[o.status];
    const over = isOverdue(o);
    const short = stockInfo.shortOrderIds.has(o.id);
    const tip = `${o.code} · ${statusLabel(o.status)} · ${jitLabel(o) || t('takt.jit') + ': —'} · ${fmtNum(orderItemCount(o), 0)} ${t('takt.elements')}${short ? ' · ' + t('takt.stockShort') : ''}`;
    const marks = `${over ? '⚠' : ''}${short ? '📦' : ''}`;
    return `<span class="takt-chip${over ? ' takt-overdue' : ''}" data-ord="${o.id}" title="${esc(tip)}"
      style="background:${st.color}22;color:var(--st-${o.status}-ink);border:1px solid ${over ? 'var(--red)' : st.color + '55'}">${marks}${marks ? ' ' : ''}${o.code}</span>`;
  };
  const unzoned = orders.filter(o => !o.zoneId || !takt.zones.find(z => z.id === o.zoneId));
  // per-zone install progress (elements) and per-period load (elements) for capacity
  const zoneStats = (zid) => {
    const zos = orders.filter(o => o.zoneId === zid);
    const total = zos.reduce((s, o) => s + orderItemCount(o), 0);
    const inst = zos.filter(o => o.status === 'installed').reduce((s, o) => s + orderItemCount(o), 0);
    return { total, inst, pct: total ? inst / total * 100 : 0 };
  };
  const periodLoad = [...Array(periods)].map((_, i) =>
    orders.filter(o => periodOf(o.needBy) === i).reduce((s, o) => s + orderItemCount(o), 0));
  const legendStatuses = STATUS_ORDER.filter(s => orders.some(o => o.status === s));

  // --- average cycle time per phase (from timeline transitions) ---
  const sums = {}, counts = {};
  for (const o of orders) {
    const en = statusEntryTimes(o);
    for (const [key, from, to] of CYCLE_PHASES) {
      if (en[from] && en[to]) {
        sums[key] = (sums[key] || 0) + (new Date(en[to]) - new Date(en[from]));
        counts[key] = (counts[key] || 0) + 1;
      }
    }
  }
  const phaseDays = CYCLE_PHASES.map(([key]) => ({
    key, days: counts[key] ? sums[key] / counts[key] / DAY_MS : null, n: counts[key] || 0,
  }));
  const maxDays = Math.max(1, ...phaseDays.map(x => x.days || 0));

  // --- weekly PPC trend: orders grouped by the Monday of their JIT week ---
  const weeks = new Map();
  for (const o of orders) {
    if (!o.needBy) continue;
    const monday = addDays(o.needBy, -((new Date(o.needBy + 'T12:00').getDay() + 6) % 7));
    const en = statusEntryTimes(o);
    const doneTs = en.delivered || en.installed;
    let bucket = weeks.get(monday);
    if (!bucket) weeks.set(monday, bucket = { due: 0, onTime: 0 });
    if (doneTs) { bucket.due++; if (doneTs.slice(0, 10) <= o.needBy) bucket.onTime++; }
    else if (o.needBy < today) bucket.due++; // overdue and still open
  }
  const weekRows = [...weeks.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-8);

  box.innerHTML = `
    <div class="card" style="margin-bottom:var(--sp-4)">
      <div class="card-head-row"><h3>${t('takt.title', { name: esc(p.name) })}</h3></div>
      ${canEdit ? `
      <div class="takt-config">
        <label>${t('takt.start')} <input type="date" id="takt-start" value="${esc(takt.startDate || '')}"></label>
        <label>${t('takt.period')} <input type="number" id="takt-period" min="1" max="30" value="${takt.periodDays}" style="width:64px"></label>
        <input type="text" id="takt-newzone" placeholder="${esc(t('takt.zonePlaceholder'))}" style="width:170px">
        <button class="btn small" id="takt-addzone">${t('takt.addZone')}</button>
        <button class="btn small primary" id="takt-save">${t('takt.save')}</button>
      </div>` : ''}
      ${legendStatuses.length ? `<div class="status-legend" style="margin:4px 0 10px">
        ${legendStatuses.map(s => `<span class="legend-chip"><span class="status-dot" style="background:${STATUSES[s].color}"></span>${statusLabel(s)}</span>`).join('')}
        <span class="legend-chip" style="color:var(--red-text)">⚠ ${t('takt.overdue')}</span>
        ${stockInfo.shortOrderIds.size ? `<span class="legend-chip">📦 ${t('takt.stockShort')}</span>` : ''}
      </div>` : ''}
      ${stockInfo.lines.some(l => l.short > 0) ? `
      <div class="card" style="margin:0 0 10px;border-color:var(--red-text)">
        <div style="font-size:var(--fs-300);font-weight:600;color:var(--red-text);margin-bottom:6px">📦 ${t('takt.stockRisk.title')}</div>
        <div style="display:flex;flex-direction:column;gap:4px">
          ${stockInfo.lines.filter(l => l.short > 0).map(l => `
            <div style="font-size:var(--fs-300);display:flex;justify-content:space-between;gap:var(--sp-2);flex-wrap:wrap">
              <span>${esc(l.comp.name)} <span class="muted">(${esc(partyName(l.factoryId))})</span></span>
              <span><b style="color:var(--red-text)">${t('takt.stockRisk.short', { n: fmtNum(l.short, 0) })}</b>
                <span class="muted">— ${t('takt.stockRisk.needHave', { need: fmtNum(l.need, 0), have: fmtNum(l.have, 0) })}</span></span>
            </div>`).join('')}
        </div>
        <div class="muted" style="font-size:var(--fs-200);margin-top:var(--sp-2)">${t('takt.stockRisk.hint')}</div>
      </div>` : ''}
      ${takt.zones.length && takt.startDate ? `
      <div style="overflow:auto"><table class="takt-table">
        <thead><tr><th>${t('takt.zone')}</th>${[...Array(periods)].map((_, i) =>
          `<th class="${i === todayPeriod ? 'takt-today' : ''}">${t('takt.periodN', { n: i + 1 })}<div class="muted" style="font-weight:400">${periodStart(i).slice(5)}${i === todayPeriod ? ' • ' + t('takt.now') : ''}</div></th>`).join('')}<th>${t('takt.progress')}</th></tr></thead>
        <tbody>${takt.zones.map((z, zi) => { const zs = zoneStats(z.id); return `<tr>
          <td><b>${esc(z.name)}</b>${canEdit ? ` <a href="#" class="takt-delzone" data-zone="${z.id}" title="${esc(t('common.remove'))}">✕</a>` : ''}</td>
          ${[...Array(periods)].map((_, i) => `<td class="${i === zi ? 'takt-target' : ''}${i === todayPeriod ? ' takt-today' : ''}">${
            orders.filter(o => o.zoneId === z.id && periodOf(o.needBy) === i).map(chip).join(' ')
          }</td>`).join('')}
          <td title="${esc(t('takt.progressTip', { a: fmtNum(zs.inst, 0), b: fmtNum(zs.total, 0) }))}">
            <div class="bar-track" style="min-width:60px"><div class="bar-fill" style="width:${zs.pct}%;background:var(--green)"></div></div>
            <div class="muted" style="font-size:var(--fs-100)">${fmtNum(zs.pct, 0)}%</div></td>
        </tr>`; }).join('')}</tbody>
        <tfoot><tr><td class="muted" style="font-size:var(--fs-200)">${t('takt.load')}</td>
          ${periodLoad.map((n, i) => `<td class="muted ${i === todayPeriod ? 'takt-today' : ''}" style="font-size:var(--fs-200)">${n || ''}</td>`).join('')}<td></td></tr></tfoot>
      </table></div>
      <div class="muted" style="font-size:var(--fs-200);margin-top:var(--sp-2)">${t('takt.hint')}</div>`
      : `<div class="muted" style="font-size:var(--fs-400)">${t('takt.empty')}</div>`}
      ${unzoned.length && takt.zones.length ? `
        <div style="margin-top:var(--sp-3);font-size:var(--fs-300)" class="muted">${t('takt.unzoned')}</div>
        <div style="display:flex;gap:var(--sp-2);flex-wrap:wrap;margin-top:var(--sp-1)">${unzoned.map(chip).join(' ')}</div>` : ''}
    </div>

    <div class="grid-2">
      <div class="card">
        <h3>${t('cycle.title')}</h3>
        ${phaseDays.map(x => `<div class="bar-row">
          <div class="bar-label">${t('cycle.' + x.key)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${x.days != null ? x.days / maxDays * 100 : 0}%"></div></div>
          <div class="bar-value">${x.days != null ? t('cycle.days', { d: fmtNum(x.days, 1) }) : '—'}</div>
        </div>`).join('')}
        <div class="muted" style="font-size:var(--fs-200);margin-top:var(--sp-2)">${t('cycle.hint')}</div>
      </div>
      <div class="card">
        <h3>${t('ppcTrend.title')}</h3>
        ${weekRows.length ? weekRows.map(([monday, b]) => {
          const pct = b.due ? b.onTime / b.due * 100 : null;
          return `<div class="bar-row">
            <div class="bar-label">${monday.slice(5)}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${pct ?? 0}%;background:${pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--amber)' : 'var(--red)'}"></div></div>
            <div class="bar-value">${pct != null ? fmtNum(pct, 0) + '%' : '—'}</div>
          </div>`;
        }).join('') : `<div class="muted">${t('ppcTrend.none')}</div>`}
        <div class="muted" style="font-size:var(--fs-200);margin-top:var(--sp-2)">${t('ppcTrend.hint')}</div>
      </div>
    </div>`;

  box.querySelectorAll('.takt-chip').forEach(c => c.addEventListener('click', () => openOrderModal(c.dataset.ord)));
  const persistTakt = () => {
    p.takt = takt;
    syncProject(p);
    renderTaktPlanning();
  };
  $('#takt-addzone')?.addEventListener('click', () => {
    const name = $('#takt-newzone').value.trim();
    if (!name) return;
    takt.zones.push({ id: uid('zn'), name });
    takt.startDate = $('#takt-start').value || takt.startDate;
    takt.periodDays = Math.max(1, Number($('#takt-period').value) || 7);
    persistTakt();
  });
  $('#takt-save')?.addEventListener('click', () => {
    takt.startDate = $('#takt-start').value;
    takt.periodDays = Math.max(1, Number($('#takt-period').value) || 7);
    persistTakt();
    toast(t('takt.saved'));
  });
  box.querySelectorAll('.takt-delzone').forEach(a => a.addEventListener('click', (e) => {
    e.preventDefault();
    takt.zones = takt.zones.filter(z => z.id !== a.dataset.zone);
    persistTakt();
  }));
}

// ---------------------------------------------------------------- QTO

// elements of the loaded model that pass the viewer's visibility filters
function visibleElements() {
  if (!modelFilter) return currentElements;
  return currentElements.filter(el => {
    if (!modelFilter.types.has(el.type)) return false;
    if (el.storeyId != null && currentStoreys.length && !modelFilter.storeys.has(el.storeyId)) return false;
    return true;
  });
}

// same aggregation as the import step, applied to an arbitrary element subset
function aggregateGroups(elements) {
  const map = new Map();
  const storeyName = new Map(currentStoreys.map(s => [s.id, s.name]));
  const storeySets = new Map(); // key -> Set of storey names (QTO storey filtering)
  for (const el of elements) {
    const key = el.type + '|' + el.name;
    let g = map.get(key);
    if (!g) {
      g = { key, type: el.type, name: el.name, count: 0, volume: 0, area: 0, length: 0, weight: 0, elementIds: [], globalIds: [], storeys: [] };
      map.set(key, g);
      storeySets.set(key, new Set());
    }
    g.count += 1;
    g.volume += el.volume || 0;
    g.area += el.area || 0;
    g.length += el.length || 0;
    g.weight += el.weight || 0;
    g.elementIds.push(el.id);
    g.globalIds.push(el.globalId || null);
    const sname = storeyName.get(el.storeyId);
    if (sname) storeySets.get(key).add(sname);
  }
  for (const [key, set] of storeySets) map.get(key).storeys = [...set].sort();
  return [...map.values()].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

// The QTO table is virtualized: models bring 10k+ typology rows and a full render
// (plus two listeners per row) froze the page for seconds. Only the rows inside the
// scroll viewport exist in the DOM; spacer rows keep the scrollbar geometry honest.
const QTO_ROW_H = 37;    // fixed row height keeps the windowing math exact
const QTO_OVERSCAN = 10; // extra rows rendered above/below the viewport

let qtoRows = [];             // groups after the text filter (what the table shows)
let qtoByKey = new Map();     // key -> group, O(1) lookups from delegated events
let qtoWin = [-1, -1];        // currently rendered slice — skip rewrites that change nothing

function qtoRowHtml(g) {
  const sel = qtoSelection.has(g.key);
  // recipe button lives INSIDE the name cell — the virtualization spacers
  // hardcode colspan="8", so the column count must not change
  const recipeN = getRecipe(activeProject(), g.key).length;
  const recipeBtn = CREATOR_ROLES.includes(state.role)
    ? ` <button class="ghost small qto-recipe" title="${esc(t('recipe.editTitle'))}"
         style="padding:1px 6px">🧩${recipeN || ''}</button>`
    : (recipeN ? ' <span title="' + esc(t('recipe.editTitle')) + '">🧩</span>' : '');
  // the ROW carries the selection, not just the tick: a 16px checkbox inside a 37px row
  // was the only signal that a typology was going into the production request
  return `<tr data-key="${esc(g.key)}"${sel ? ' class="is-selected"' : ''}>
    <td><input type="checkbox" class="qto-check" ${sel ? 'checked' : ''}></td>
    <td><span class="type-chip">${esc(g.type)}</span></td>
    <td class="qto-name" title="${esc(g.name)}${g.storeys?.length ? ' — ' + esc(g.storeys.join(', ')) : ''}">${esc(g.name)}${recipeBtn}</td>
    <td class="num">${g.count}</td>
    <td class="num">${g.volume ? fmtNum(g.volume) : '—'}</td>
    <td class="num">${g.area ? fmtNum(g.area) : '—'}</td>
    <td class="num">${g.length ? fmtNum(g.length) : '—'}</td>
    <td class="num"><input type="number" class="qto-qty"
         min="1" max="${g.count}" value="${sel ? qtoSelection.get(g.key) : g.count}"
         style="width:74px" ${sel ? '' : 'disabled'}></td>
  </tr>`;
}

function updateQtoWindow() {
  const scroller = $('#qto-scroll');
  const body = $('#qto-tbody');
  if (!scroller || !body) return;
  const start = Math.max(0, Math.floor(scroller.scrollTop / QTO_ROW_H) - QTO_OVERSCAN);
  const end = Math.min(qtoRows.length,
    Math.ceil((scroller.scrollTop + (scroller.clientHeight || 600)) / QTO_ROW_H) + QTO_OVERSCAN);
  if (start === qtoWin[0] && end === qtoWin[1]) return;
  qtoWin = [start, end];
  body.innerHTML =
    `<tr class="qto-spacer"><td colspan="8" style="height:${start * QTO_ROW_H}px"></td></tr>` +
    qtoRows.slice(start, end).map(qtoRowHtml).join('') +
    `<tr class="qto-spacer"><td colspan="8" style="height:${(qtoRows.length - end) * QTO_ROW_H}px"></td></tr>`;
}

function applyQtoTextFilter() {
  const box = $('#qto-content');
  // multi-term AND search over type, typology name and storey names, so
  // "slab piso 1" finds every floor-1 slab typology in one go
  const terms = (box.dataset.filter || '').toLowerCase().split(/\s+/).filter(Boolean);
  const storey = box.dataset.storey || '';
  const qtype = box.dataset.qtype || '';
  const recipeMode = box.dataset.recipe || ''; // '' | with | without
  const recipes = activeProject()?.recipes || {};
  qtoRows = qtoGroups.filter(g => {
    if (storey && !(g.storeys || []).includes(storey)) return false;
    if (qtype && g.type !== qtype) return false;
    if (recipeMode === 'with' && !(recipes[g.key] || []).length) return false;
    if (recipeMode === 'without' && (recipes[g.key] || []).length) return false;
    if (!terms.length) return true;
    const hay = (g.type + ' ' + g.name + ' ' + (g.storeys || []).join(' ')).toLowerCase();
    return terms.every(t => hay.includes(t));
  });
  qtoWin = [-1, -1]; // rows changed — force the next window rewrite
  const counter = $('#qto-rowcount');
  if (counter) counter.textContent = fmtNum(qtoRows.length, 0);
}

// selection summary + create button — updated in place, never re-rendering the table
function updateQtoToolbar() {
  const selCount = [...qtoSelection.values()].reduce((s, v) => s + v, 0);
  const info = $('#qto-selinfo');
  if (info) info.textContent = t('qto.selected', { n: qtoSelection.size, m: fmtNum(selCount, 0) });
  const btn = $('#btn-create-order');
  if (btn) btn.disabled = !qtoSelection.size;
}

window.addEventListener('resize', () => updateQtoWindow());

function renderQto() {
  const box = $('#qto-content');
  const p = activeProject();
  if (!p) {
    box.innerHTML = `<div class="empty-state"><div class="big">📐</div>
      ${t('qto.noProject')}</div>`;
    return;
  }
  if (!p.fileName) {
    const canUpload = CREATOR_ROLES.includes(state.role);
    box.innerHTML = `<div class="empty-state"><div class="big">📐</div>
      ${t('qto.noModelYet', { name: esc(p.name) })}<br>
      ${canUpload ? `<button class="btn primary" id="qto-upload-cta" style="margin-top:var(--sp-3)">${t('qto.uploadModel')}</button>` : ''}</div>`;
    $('#qto-upload-cta')?.addEventListener('click', () => {
      dashUploadTargetId = p.id;
      $('#dash-ifc-input').click();
    });
    return;
  }
  // QTO mirrors the 3D view: when the model is loaded, take off only the visible elements
  const modelLoaded = loadedProjectId === p.id && currentElements.length > 0;
  const vis = modelLoaded ? visibleElements() : null;
  const filtered = modelLoaded && vis.length !== currentElements.length;
  qtoGroups = modelLoaded ? aggregateGroups(vis) : p.groups;
  qtoByKey = new Map(qtoGroups.map(g => [g.key, g]));

  box.innerHTML = `
    <div class="qto-toolbar">
      <span class="type-chip" style="font-size:var(--fs-300)">${esc(p.name)}</span>
      ${filtered ? `<span class="type-chip" style="font-size:var(--fs-300);color:var(--amber-text)" title="${esc(t('qto.matchingViewTitle'))}">
        ${t('qto.matchingView', { a: vis.length, b: currentElements.length })}</span>` : ''}
      <input type="text" id="qto-filter" placeholder="${esc(t('qto.filterPlaceholder'))}" value="${esc(box.dataset.filter || '')}">
      <select id="qto-type">
        <option value="">${t('qto.typeAll')}</option>
        ${[...new Set(qtoGroups.map(g => g.type))].sort().map(ty =>
          `<option value="${esc(ty)}" ${ty === box.dataset.qtype ? 'selected' : ''}>${esc(ty)}</option>`).join('')}
      </select>
      ${(() => { // storey filter — only when this model's groups carry storey names
        const storeys = [...new Set(qtoGroups.flatMap(g => g.storeys || []))].sort();
        return storeys.length ? `<select id="qto-storey">
          <option value="">${t('qto.storeyAll')}</option>
          ${storeys.map(s => `<option value="${esc(s)}" ${s === box.dataset.storey ? 'selected' : ''}>${esc(s)}</option>`).join('')}
        </select>` : '';
      })()}
      <select id="qto-recipe-filter">
        <option value="">${t('qto.recipeAll')}</option>
        <option value="with" ${box.dataset.recipe === 'with' ? 'selected' : ''}>${t('qto.recipeWith')}</option>
        <option value="without" ${box.dataset.recipe === 'without' ? 'selected' : ''}>${t('qto.recipeWithout')}</option>
      </select>
      <button class="ghost small" id="qto-clear" title="${esc(t('common.clearFilters'))}">✕</button>
      <span class="muted" style="font-size:var(--fs-300)"><span id="qto-rowcount"></span></span>
      <span class="selected-info" id="qto-selinfo"></span>
      ${CREATOR_ROLES.includes(state.role)
        ? `<button class="btn" id="btn-bulk-recipe" title="${esc(t('qto.bulkRecipeTitle'))}">${t('qto.bulkRecipe')}</button>
           <button class="btn primary" id="btn-create-order" disabled>${t('qto.createRequest')}</button>`
        : `<span class="muted" style="font-size:var(--fs-300)">${t('qto.onlyDirectors')}</span>`}
    </div>
    <div class="card" id="qto-scroll" style="padding:0; overflow:auto; max-height: calc(100dvh - 250px);">
      <table>
        <thead><tr>
          <th></th><th>${t('qto.type')}</th><th>${t('qto.typology')}</th>
          <th class="num">${t('qto.count')}</th><th class="num">${t('qto.volume')}</th><th class="num">${t('qto.area')}</th>
          <th class="num">${t('qto.length')}</th><th class="num">${t('qto.qtyToOrder')}</th>
        </tr></thead>
        <tbody id="qto-tbody"></tbody>
      </table>
    </div>`;

  applyQtoTextFilter();
  updateQtoToolbar();
  updateQtoWindow();

  // windowing: re-slice on scroll — rendering ~30 rows costs ~1 ms, no throttling needed
  // (rAF-based throttling would stall in background tabs and leave the window stale)
  $('#qto-scroll').addEventListener('scroll', updateQtoWindow, { passive: true });

  // one delegated listener replaces two listeners per row
  $('#qto-tbody').addEventListener('change', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (!tr) return;
    const g = qtoByKey.get(tr.dataset.key);
    if (!g) return;
    if (e.target.classList.contains('qto-check')) {
      if (e.target.checked) qtoSelection.set(g.key, g.count);
      else qtoSelection.delete(g.key);
      tr.classList.toggle('is-selected', e.target.checked); // the row follows the tick
      const qty = tr.querySelector('.qto-qty');
      qty.disabled = !e.target.checked;
      qty.value = g.count;
      updateQtoToolbar();
    } else if (e.target.classList.contains('qto-qty')) {
      const v = Math.max(1, Math.min(g.count, Number(e.target.value) || 1));
      e.target.value = v;
      if (qtoSelection.has(g.key)) { qtoSelection.set(g.key, v); updateQtoToolbar(); }
    }
  });

  // recipe editor (🧩 in the name cell) — same delegation pattern, click events
  $('#qto-tbody').addEventListener('click', (e) => {
    const btn = e.target.closest('.qto-recipe');
    if (!btn) return;
    const tr = btn.closest('tr[data-key]');
    const g = tr && qtoByKey.get(tr.dataset.key);
    if (g) openRecipeModal(g);
  });

  // text filter only re-slices the window — the input never loses focus now
  let filterTimer;
  $('#qto-filter').addEventListener('input', (e) => {
    box.dataset.filter = e.target.value;
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      applyQtoTextFilter();
      $('#qto-scroll').scrollTop = 0;
      updateQtoWindow();
    }, 120);
  });
  const refilter = () => { applyQtoTextFilter(); $('#qto-scroll').scrollTop = 0; updateQtoWindow(); };
  $('#qto-storey')?.addEventListener('change', (e) => { box.dataset.storey = e.target.value; refilter(); });
  $('#qto-type').addEventListener('change', (e) => { box.dataset.qtype = e.target.value; refilter(); });
  $('#qto-recipe-filter').addEventListener('change', (e) => { box.dataset.recipe = e.target.value; refilter(); });
  $('#qto-clear').addEventListener('click', () => {
    delete box.dataset.filter; delete box.dataset.storey; delete box.dataset.qtype; delete box.dataset.recipe;
    renderQto(); // rebuild the toolbar so every control resets visually
  });

  $('#btn-bulk-recipe')?.addEventListener('click', () => openBulkRecipeModal());
  $('#btn-create-order')?.addEventListener('click', () => openCreateOrderModal());
}

function openCreateOrderModal(presetItems = null) {
  const p = activeProject();
  if (!p) return;
  const source = qtoGroups || p.groups; // what the QTO table is showing (may mirror 3D filters)
  const factories = state.parties.filter(x => x.type === 'factory');
  // items come either from the 3D selection (preset) or from the QTO checkboxes
  const items = presetItems || [...qtoSelection.entries()].map(([key, qty]) => {
    const g = source.find(x => x.key === key);
    const frac = qty / g.count;
    return {
      key, type: g.type, name: g.name, unit: 'un', qty,
      volume: g.volume * frac, area: g.area * frac, weight: g.weight * frac,
      globalIds: (g.globalIds || []).slice(0, qty), // exact GUIDs being ordered (QR labels)
    };
  });
  if (!items.length) { toast(t('qto.nothingSelected')); return; }

  openModal(`
    <h2>${t('order.newTitle', { project: esc(p.name) })}</h2>
    <div class="form-row"><label>${t('order.factory')}</label>
      <select id="ord-supplier">${factories.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select>
    </div>
    ${p.takt?.zones?.length ? `
    <div class="form-row"><label>${t('order.taktZone')}</label>
      <select id="ord-zone"><option value="">${t('order.noZone')}</option>
        ${p.takt.zones.map(z => `<option value="${z.id}">${esc(z.name)}</option>`).join('')}
      </select></div>` : ''}
    <div class="form-row"><label>${t('order.neededBy')}</label>
      <input type="date" id="ord-needby">
      <div class="muted" style="font-size:var(--fs-200);margin-top:var(--sp-1)">${t('order.neededByHint')}</div></div>
    <div class="form-row"><label>${t('order.notes')}</label>
      <textarea id="ord-notes" rows="3"></textarea></div>
    <div class="card" style="padding:0;max-height:260px;overflow:auto">
      <table><thead><tr><th>${t('order.type')}</th><th>${t('order.typology')}</th><th class="num">${t('order.qty')}</th><th class="num">${t('order.volume')}</th></tr></thead>
      <tbody>${items.map(it => `<tr><td><span class="type-chip">${esc(it.type)}</span></td>
        <td>${esc(it.name)}</td><td class="num">${it.qty}</td>
        <td class="num">${it.volume ? fmtNum(it.volume) : '—'}</td></tr>`).join('')}</tbody></table>
    </div>
    <div class="modal-actions">
      <button class="btn" id="ord-cancel">${t('common.cancel')}</button>
      <button class="btn primary" id="ord-save">${t('order.createRequest')}</button>
    </div>`);

  // picking a takt zone pulls the JIT date from the plan (still editable)
  $('#ord-zone')?.addEventListener('change', () => {
    const zi = p.takt.zones.findIndex(z => z.id === $('#ord-zone').value);
    if (zi >= 0 && p.takt.startDate) {
      $('#ord-needby').value = addDays(p.takt.startDate, zi * p.takt.periodDays);
    }
  });
  $('#ord-cancel').addEventListener('click', closeModal);
  $('#ord-save').addEventListener('click', async () => {
    if (!factories.length) { toast(t('order.addFactoryFirst')); return; }
    const btn = $('#ord-save');
    btn.disabled = true;
    const r = await createOrder({
      projectId: p.id,
      supplierId: $('#ord-supplier').value,
      needBy: $('#ord-needby').value,
      notes: $('#ord-notes').value,
      zoneId: $('#ord-zone')?.value || null,
      items,
    });
    // A refusal keeps the form open with what was typed still in it. This used to close
    // the modal and announce a code for a request the server had rejected.
    if (!r.ok) { toast(r.error || t('order.createFailed')); btn.disabled = false; return; }
    qtoSelection.clear();
    V?.clearSelection(); // 3D multi-select, if that's where the items came from
    closeModal();
    // queued is not created: say which one it was, or the person walks away believing
    // the factory can already see it
    toast(r.queued ? t('order.createdQueued', { code: r.order.code }) : t('order.created', { code: r.order.code }));
    showView('orders');
  });
}

// ---------------------------------------------------------------- Orders

function renderOrders() {
  const box = $('#orders-content');
  // the kanban follows the active project, like every other view
  const projectOrders = state.orders.filter(o => o.projectId === state.activeProjectId);
  if (!projectOrders.length) {
    box.innerHTML = `<div class="empty-state"><div class="big">📦</div>
      ${t('orders.noneYet')}</div>`;
    return;
  }
  box.innerHTML = `<div class="kanban">
    ${STATUS_ORDER.map(s => {
      const orders = projectOrders.filter(o => o.status === s);
      // every pipeline stage is always visible (even at 0); only the "rejected"
      // exception column hides itself when empty
      if (!orders.length && s === 'rejected') return '';
      const st = STATUSES[s];
      return `<div class="kanban-col">
        <div class="kanban-col-head" style="color:var(--st-${s}-ink)">
          <span><span class="status-dot" style="background:${st.color}"></span>${statusLabel(s)}</span>
          <span class="count-badge">${orders.length}</span>
        </div>
        <div class="kanban-cards">
          ${orders.map(o => `
            <div class="order-card" data-id="${o.id}">
              <div class="code">${o.code} <span class="type-chip" style="font-size:var(--fs-100)">${esc(getProject(o.projectId)?.name || '—')}</span></div>
              <div class="meta">${esc(partyName(o.supplierId))}</div>
              <div class="meta">${fmtNum(orderItemCount(o), 0)} elements · ${o.items.length} typologies</div>
              ${jitLabel(o) ? `<div class="meta">${jitLabel(o)}</div>` : ''}
              ${o.status === 'accepted' && sdStatus(o) !== 'validated' ? `<div class="meta" style="color:var(--amber-text)">📐 ${t('sd.chip.' + sdStatus(o))}</div>` : ''}
              ${trackingCount(o, 'built') ? `<div class="meta" style="color:var(--cyan-text)">🏭 built ${trackingCount(o, 'built')}/${orderGlobalIds(o).length}</div>` : ''}
              ${openNcCount(o)
                ? `<div class="meta" style="color:var(--red-text)">⚠ ${t('order.ncOpenChip', { n: openNcCount(o) })}</div>`
                : o.nonConformities.length ? `<div class="meta" style="color:var(--green-text)">✅ ${t('order.ncClosedChip', { n: o.nonConformities.length })}</div>` : ''}
            </div>`).join('')}
        </div>
      </div>`;
    }).join('')}
  </div>`;

  box.querySelectorAll('.order-card').forEach(c =>
    c.addEventListener('click', () => openOrderModal(c.dataset.id)));
}

function openOrderModal(orderId) {
  const o = state.orders.find(x => x.id === orderId);
  if (!o) return;
  let nexts = canAdvance(o, currentUser);
  // once partial loads exist they drive transit/delivered — hide the whole-order jumps
  if (o.shipments?.length) nexts = nexts.filter(n => !['transit', 'delivered'].includes(n));

  const remaining = shipmentRemaining(o);
  const remainingTotal = [...remaining.values()].reduce((s, v) => s + v, 0);
  // one truck at a time: while a load is on the road, the next one cannot be
  // requested — JIT on a constrained site means the previous load must arrive
  // (and free the crane/laydown area) before another leaves the factory
  // …except for the administrator, who can send anyway; the server records that
  // override on the request rather than refusing it
  const loadInTransit = (o.shipments || []).some(s => s.status === 'transit') && !isAdmin(state.role);
  const canShip = ['ready', 'transit'].includes(o.status) && remainingTotal > 0 && !loadInTransit
    && (hasFullAccess(state.role) || ['logistics', 'foreman', 'site_director'].includes(state.role));
  const canDeliver = hasFullAccess(state.role) || ['logistics', 'foreman'].includes(state.role);
  const shipmentsHtml = (o.shipments?.length || canShip) ? `
    <h3 class="section-title">${t('order.loads')}</h3>
    ${(o.shipments || []).map(s => {
      const n = s.items.reduce((sum, i) => sum + i.qty, 0);
      return `<div class="look-row">
        <div><b>${t('order.loadN', { n: s.num })}</b>
          <span class="muted">· ${fmtDate(s.createdAt)} · ${t('order.nElements', { n: fmtNum(n, 0) })}</span></div>
        <div style="display:flex;gap:var(--sp-2);align-items:center">
          ${statusBadge(s.status)}
          ${s.status === 'transit' && canDeliver
            ? `<button class="btn small primary" data-deliver="${s.id}">${t('order.markDelivered')}</button>`
            : s.deliveredAt ? `<span class="muted" style="font-size:var(--fs-200)">${fmtDate(s.deliveredAt)}</span>` : ''}
        </div>
      </div>`;
    }).join('')}
    ${remainingTotal > 0 && o.shipments?.length
      ? `<div class="muted" style="font-size:var(--fs-300);margin:4px 0">${t('order.remainingAtFactory', { n: fmtNum(remainingTotal, 0) })}</div>` : ''}
    ${canShip ? `<button class="btn" id="btn-ship" style="margin-top:var(--sp-2)">${t('order.sendPartial')}</button>`
      : loadInTransit && remainingTotal > 0 ? `<div class="muted" style="font-size:var(--fs-300);margin-top:var(--sp-2)">🚚 ${t('ship.waitTransit')}</div>` : ''}
    <div style="margin-bottom:var(--sp-4)"></div>` : '';

  const inspectionsHtml = o.inspections?.length ? `
    <h3 class="section-title">${t('order.inspections')}</h3>
    <div style="display:flex;gap:var(--sp-3);flex-wrap:wrap;margin-bottom:var(--sp-4)">
      ${o.inspections.map(i => `
        <div class="insp-card ${i.pass ? '' : 'fail'}">
          <div style="font-size:var(--fs-300)"><b>${t('insp.gate.' + i.gate)}</b> ${i.pass ? '<span style="color:var(--green-text)">✓</span>' : '<span style="color:var(--red-text)">✗</span>'}</div>
          <div class="muted" style="font-size:var(--fs-200)">${fmtDate(i.ts)} · ${roleLabel(i.actor)}</div>
          ${i.note ? `<div class="muted" style="font-size:var(--fs-200);max-width:180px">${esc(i.note)}</div>` : ''}
          ${i.photo ? `<img class="insp-photo" src="${esc(i.photo)}" alt="">` : ''}
        </div>`).join('')}
    </div>` : '';

  // closing the loop: when field tracking says every element is fixed, suggest
  // the final status transition instead of waiting for someone to remember it
  const totalGids = orderGlobalIds(o).length;
  const allFixed = totalGids > 0 && trackingCount(o, 'fixed') >= totalGids;
  const installBanner = (o.status === 'delivered' && allFixed && nexts.includes('installed')) ? `
    <div class="insp-banner">
      <span>✅ ${t('order.allFixedBanner', { n: totalGids })}</span>
      <button class="btn primary small" data-next="installed">→ ${statusLabel('installed')}</button>
    </div>` : '';

  // components consumed producing this order — aggregated from the ledger, so it
  // stays exact even if the recipe is edited later ('site' never gets these moves)
  const consumedAgg = new Map();
  for (const m of state.stockMoves) {
    if (m.orderId !== o.id || m.type !== 'consume') continue;
    consumedAgg.set(m.componentId, (consumedAgg.get(m.componentId) || 0) + m.qty);
  }
  const consumedHtml = consumedAgg.size ? `
    <h3 class="section-title">${t('order.componentsConsumed')}</h3>
    <div style="display:flex;gap:var(--sp-2);flex-wrap:wrap;margin-bottom:var(--sp-4)">
      ${[...consumedAgg].map(([cid, q]) => {
        const c = state.components.find(x => x.id === cid);
        return `<span class="type-chip">${esc(c?.name || cid)}: ${fmtNum(q, Number.isInteger(q) ? 0 : 2)} ${c ? t('unit.' + c.unit) : ''}</span>`;
      }).join('')}
    </div>` : '';

  // shop drawings gate (accepted → production): factory submits, the Project
  // Director validates, and only then may fabrication start. Shown from Accepted
  // onwards; once the order is past it, the card remains as the approval record.
  const sd = sdStatus(o);
  const sdRelevant = o.status === 'accepted' || o.shopDrawings;
  const SD_BORDER = { validated: 'var(--green)', waived: 'var(--muted)', submitted: 'var(--amber)', pending: 'var(--red)' };
  const sdHtml = !sdRelevant ? '' : `
    <h3 class="section-title">${t('sd.section')}</h3>
    <div class="insp-card" style="margin-bottom:var(--sp-4);border-left:3px solid ${SD_BORDER[sd] || 'var(--muted)'}">
      <div style="display:flex;justify-content:space-between;gap:var(--sp-3);align-items:flex-start;flex-wrap:wrap">
        <div style="flex:1;min-width:180px">
          <div style="font-size:var(--fs-300)"><b>${t('sd.status.' + sd)}</b></div>
          ${o.shopDrawings?.ref ? `<div style="font-size:var(--fs-400)">${esc(o.shopDrawings.ref)}</div>` : ''}
          ${o.shopDrawings?.submittedAt ? `<div class="muted" style="font-size:var(--fs-200)">📐 ${t('sd.submittedBy', { who: roleLabel(o.shopDrawings.submittedBy), when: fmtDate(o.shopDrawings.submittedAt) })}</div>` : ''}
          ${o.shopDrawings?.validatedAt ? `<div class="muted" style="font-size:var(--fs-200)">✅ ${t('sd.validatedBy', { who: roleLabel(o.shopDrawings.validatedBy), when: fmtDate(o.shopDrawings.validatedAt) })}</div>` : ''}
        </div>
        <div style="display:flex;gap:var(--sp-2);flex-wrap:wrap">
          ${sd === 'pending' && canSubmitShopDrawings(state.role) ? `<button class="btn small" id="btn-sd-submit">${t('sd.submit')}</button>` : ''}
          ${sd === 'submitted' && canValidateShopDrawings(state.role) ? `<button class="btn small primary" id="btn-sd-validate">${t('sd.validate')}</button>` : ''}
          ${sd === 'submitted' && !canValidateShopDrawings(state.role) ? `<span class="muted" style="font-size:var(--fs-200)">${t('sd.awaitingValidation')}</span>` : ''}
        </div>
      </div>
    </div>`;

  // non-conformities: raised → repaired → validated by site management. Until now
  // these were only a count on the kanban card and a line in the timeline; the list
  // itself was never shown, so a defect had nowhere to be followed up.
  const NC_COLORS = { open: 'var(--red)', repaired: 'var(--amber)', validated: 'var(--green)' };
  const canRaiseNc = canRecordNc(state.role);   // includes the factory
  const canRepair = canRepairNc(state.role);    // quality/foremen/directors
  const canValidate = canValidateNc(state.role);
  const ncHtml = o.nonConformities?.length ? `
    <h3 class="section-title">
      ${t('order.ncSection', { open: openNcCount(o), total: o.nonConformities.length })}</h3>
    <div style="display:flex;flex-direction:column;gap:var(--sp-2);margin-bottom:var(--sp-4)">
      ${o.nonConformities.map((nc, i) => {
        const st = ncStatus(nc);
        return `<div class="insp-card ${st === 'open' ? 'fail' : ''}" style="border-left:3px solid ${NC_COLORS[st]}">
          <div style="display:flex;justify-content:space-between;gap:var(--sp-3);align-items:flex-start;flex-wrap:wrap">
            <div style="flex:1;min-width:180px">
              <div style="font-size:var(--fs-300)"><b>${t('nc.status.' + st)}</b></div>
              <div style="font-size:var(--fs-400)">${esc(nc.note || '—')}</div>
              <div class="muted" style="font-size:var(--fs-200)">${fmtDate(nc.ts)} · ${roleLabel(nc.actor)}</div>
              ${nc.repairedAt ? `<div class="muted" style="font-size:var(--fs-200)">🔧 ${t('nc.repairedBy', { who: roleLabel(nc.repairedBy), when: fmtDate(nc.repairedAt) })}${nc.repairNote ? ' — ' + esc(nc.repairNote) : ''}</div>` : ''}
              ${nc.validatedAt ? `<div class="muted" style="font-size:var(--fs-200)">✅ ${t('nc.validatedBy', { who: roleLabel(nc.validatedBy), when: fmtDate(nc.validatedAt) })}</div>` : ''}
            </div>
            <div style="display:flex;gap:var(--sp-2);flex-wrap:wrap">
              ${st === 'open' && canRepair ? `<button class="btn small" data-ncfix="${i}">${t('nc.markRepaired')}</button>` : ''}
              ${st === 'repaired' && canValidate ? `<button class="btn small primary" data-ncok="${i}">${t('nc.validate')}</button>` : ''}
              ${st === 'repaired' && !canValidate ? `<span class="muted" style="font-size:var(--fs-200)">${t('nc.awaitingValidation')}</span>` : ''}
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>` : '';

  openModal(`
    <h2>${o.code} ${statusBadge(o.status)}</h2>
    <div class="grid-2" style="margin-bottom:var(--sp-3)">
      <div>
        <div class="prop-row"><span class="k">${t('order.project')}</span><span class="v">${esc(getProject(o.projectId)?.name || '—')}</span></div>
        <div class="prop-row"><span class="k">${t('order.siteAddress')}</span><span class="v">${esc(getProject(o.projectId)?.address || '—')}</span></div>
        <div class="prop-row"><span class="k">${t('order.factoryLabel')}</span><span class="v">${esc(partyName(o.supplierId))}</span></div>
        ${partyContactRow(o.supplierId)}
        <div class="prop-row"><span class="k">${t('order.createdLabel')}</span><span class="v">${fmtDate(o.createdAt)}</span></div>
        <div class="prop-row"><span class="k">${t('order.neededOnSite')}</span><span class="v">${jitLabel(o) || '—'}</span></div>
        <div class="prop-row"><span class="k">${t('order.totalElements')}</span><span class="v">${fmtNum(orderItemCount(o), 0)}</span></div>
        <div class="prop-row"><span class="k">${t('order.totalVolume')}</span><span class="v">${fmtNum(o.items.reduce((s, i) => s + (i.volume || 0), 0))} m³</span></div>
        ${orderCarbon(o) ? `<div class="prop-row"><span class="k">${t('order.carbon')}</span><span class="v">${fmtNum(orderCarbon(o) / 1000, 1)} t CO₂e</span></div>` : ''}
      </div>
      <div>${o.notes ? `<div class="muted" style="font-size:var(--fs-300)">${t('order.notesLabel')}</div><div style="font-size:var(--fs-400)">${esc(o.notes)}</div>` : ''}</div>
    </div>
    <div class="card" style="padding:0;max-height:200px;overflow:auto;margin-bottom:var(--sp-4)">
      <table><thead><tr><th>${t('order.type')}</th><th>${t('order.typology')}</th><th class="num">${t('order.qty')}</th><th class="num">${t('order.volume')}</th></tr></thead>
      <tbody>${o.items.map(it => `<tr><td><span class="type-chip">${esc(it.type)}</span></td>
        <td>${esc(it.name)}</td><td class="num">${it.qty}</td>
        <td class="num">${it.volume ? fmtNum(it.volume) : '—'}</td></tr>`).join('')}</tbody></table>
    </div>
    ${consumedHtml}
    ${sdHtml}
    ${installBanner}
    ${shipmentsHtml}
    ${ncHtml}
    ${inspectionsHtml}
    <div style="display:flex;gap:var(--sp-2);flex-wrap:wrap;margin-bottom:var(--sp-4)">
      ${nexts.map(n => `<button class="btn ${n === 'rejected' ? '' : 'primary'}" data-next="${n}">
        ${n === 'rejected' ? t('order.reject') : '→ ' + statusLabel(n)}</button>`).join('')
        || `<span class="muted">${t('order.noActions', { role: roleLabel(state.role), who: actorLabel(STATUSES[o.status].actor) })}</span>`}
      ${(state.role === 'factory' || hasFullAccess(state.role)) && ['accepted', 'production', 'ready'].includes(o.status) && orderGlobalIds(o).length
        ? `<button class="btn" id="btn-asbuilt">${t('order.asBuilt', { a: trackingCount(o, 'built'), b: orderGlobalIds(o).length })}</button>` : ''}
      ${(state.role === 'quality' || hasFullAccess(state.role)) && STARTED_STATUSES.includes(o.status)
        ? `<button class="btn" id="btn-inspect">🔍 ${t('order.newInspection')}</button>` : ''}
      ${canRaiseNc && STARTED_STATUSES.includes(o.status) ? `<button class="btn" id="btn-nc" style="margin-left:auto">${t('order.recordNc')}</button>` : ''}
      ${isGcRole(state.role) ? `<button class="btn" id="btn-email">${t('order.emailFactory')}</button>` : ''}
      ${o.status !== 'draft' && o.status !== 'rejected' && orderGlobalIds(o).length
        ? `<button class="btn" id="btn-labels">${t('order.qrLabels')}</button>` : ''}
      <button class="btn" id="btn-print">${t('order.printPdf')}</button>
    </div>
    <h3 class="section-title">${t('order.timeline')}</h3>
    <ul class="timeline">
      ${[...o.events].reverse().map(e => `<li>
        <div>${esc(e.action)} <span class="muted">— ${esc(roleLabel(e.actor))}</span></div>
        ${e.note ? `<div class="muted">${esc(e.note)}</div>` : ''}
        <div class="ts">${fmtDate(e.ts)}</div>
      </li>`).join('')}
    </ul>
    <div class="modal-actions" style="justify-content:space-between">
      ${CREATOR_ROLES.includes(state.role) && (DELETABLE_STATUSES.includes(o.status) || isAdmin(state.role))
        ? `<button class="btn" id="ord-delete" style="border-color:var(--red-text);color:var(--red-text)">${t('order.deleteRequest')}</button>`
        : '<span></span>'}
      <button class="btn" id="ord-close">${t('common.close')}</button>
    </div>`);

  // background sync replaces state.orders with fresh server copies, which would
  // leave this modal's closures pointing at a detached, stale object — mark the
  // modal so rerenderCurrentView can re-open it with live data on remote changes
  $('#modal-body').dataset.kind = 'order:' + orderId;

  $('#ord-close').addEventListener('click', closeModal);
  $('#ord-delete')?.addEventListener('click', () => {
    if (!confirm(t('order.deleteConfirm', { code: o.code, n: orderItemCount(o), status: statusLabel(o.status) }))) return;
    deleteOrder(o.id);
    closeModal();
    toast(t('order.deleted', { code: o.code }));
    renderOrders();
    renderDashboard();
    applyStatusColors(); // elements go back to "not ordered" gray in the 3D view
  });
  document.querySelectorAll('[data-next]').forEach(b => b.addEventListener('click', async () => {
    const next = b.dataset.next;
    const doAdvance = async (note = '') => {
      advanceOrder(o, next, note);
      toast(t('order.advanced', { code: o.code, status: statusLabel(o.status) }));
      closeModal();
      // submitting = ordering from the factory → email it automatically (if SMTP configured)
      if (next === 'submitted') await emailOrder(o, { auto: true });
      renderOrders();
      renderDashboard();
      applyStatusColors(); // keep the 3D twin in sync with the new status
    };
    // the two physical hand-offs pass through a quality gate first; requesting
    // dispatch (Ready → Sent/Transit) also locks in the binding JIT date+time (the
    // creation-time date was only an estimate) — the project/site director calls
    // this, since they track how the site is actually progressing. Orders shipped
    // in partial loads take this same gate in openShipmentModal instead (their
    // whole-order "→ Sent / Transit" button is hidden once shipments exist).
    if (next === 'transit') {
      openJitModal(o.id, (date, time) => doAdvance(t('order.jit.confirmedNote', { date, time })));
    } else if (next === 'production' && !['validated', 'waived'].includes(sdStatus(o)) && !isAdmin(state.role)) {
      // fabrication cannot start before the Project Director validates the shop
      // drawings (server enforces this too) — the administrator can override, and
      // the server writes that override into the request's history
      toast(t('sd.requiredToast'));
    } else if (next === 'ready' || next === 'delivered') {
      openInspectionModal(o.id, next, doAdvance);
    } else {
      await doAdvance();
    }
  }));
  document.querySelectorAll('.insp-photo').forEach(img =>
    img.addEventListener('click', () => img.classList.toggle('expanded')));
  $('#btn-ship')?.addEventListener('click', () => openShipmentModal(orderId));
  document.querySelectorAll('[data-deliver]').forEach(b => b.addEventListener('click', () => {
    // receiving a load on site passes through the reception quality gate
    openInspectionModal(o.id, 'delivered', () => {
      markShipmentDelivered(o, b.dataset.deliver);
      toast(t('order.loadDeliveredToast', { code: o.code }));
      openOrderModal(orderId);
      renderOrders();
      renderDashboard();
      applyStatusColors();
    });
  }));
  // quality manager: record an inspection at any moment (e.g. at the factory)
  // without moving the workflow — the gate is inferred from where the order is
  $('#btn-inspect')?.addEventListener('click', () => {
    const gate = ['transit', 'delivered', 'installed'].includes(o.status) ? 'delivered' : 'ready';
    openInspectionModal(o.id, gate, () => {
      toast(t('insp.recordedToast', { code: o.code }));
      openOrderModal(orderId);
      renderOrders();
      renderDashboard();
    });
  });
  $('#btn-sd-submit')?.addEventListener('click', () => {
    const ref = prompt(t('sd.submitPrompt')) ?? '';
    submitShopDrawings(o, ref.trim());
    toast(t('sd.submittedToast'));
    openOrderModal(orderId); renderOrders();
  });
  $('#btn-sd-validate')?.addEventListener('click', () => {
    if (!confirm(t('sd.validateConfirm'))) return;
    validateShopDrawings(o);
    toast(t('sd.validatedToast'));
    openOrderModal(orderId); renderOrders();
  });
  $('#btn-nc')?.addEventListener('click', () => {
    const note = prompt(t('order.ncPrompt'));
    if (note) { addNonConformity(o, note); openOrderModal(orderId); renderOrders(); renderDashboard(); }
  });
  // NC lifecycle — repair is recorded by whoever fixed it, the sign-off is a
  // separate act reserved for site management
  document.querySelectorAll('[data-ncfix]').forEach(b => b.addEventListener('click', () => {
    const note = prompt(t('nc.repairPrompt')) ?? '';
    markNcRepaired(o, Number(b.dataset.ncfix), note.trim());
    toast(t('nc.repairedToast'));
    openOrderModal(orderId); renderOrders(); renderDashboard();
  }));
  document.querySelectorAll('[data-ncok]').forEach(b => b.addEventListener('click', () => {
    if (!confirm(t('nc.validateConfirm'))) return;
    markNcValidated(o, Number(b.dataset.ncok));
    toast(t('nc.validatedToast'));
    openOrderModal(orderId); renderOrders(); renderDashboard();
  }));
  $('#btn-print').addEventListener('click', () => printOrder(o));
  // the QR-labels button is absent on drafts and rejected requests — without the
  // optional call the missing element threw here and left every listener below it
  // (including "email the factory") unwired
  $('#btn-labels')?.addEventListener('click', () => printLabels(o));
  $('#btn-asbuilt')?.addEventListener('click', () => openAsBuiltModal(orderId));
  $('#btn-email')?.addEventListener('click', async () => {
    const sent = await emailOrder(o);
    if (sent) openOrderModal(orderId); // refresh the timeline with the new event
  });
}

// phone photos are 3–10 MB; the record only needs evidence, not resolution
function downscalePhoto(file, maxDim = 900) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => resolve(null);
    img.src = URL.createObjectURL(file);
  });
}

// requesting dispatch (Ready → Sent/Transit) locks in the binding JIT date+time
// (the creation-time date was only a planning estimate) — the project/site
// director sets this, since they track the site's actual progress
function openJitModal(orderId, onConfirm) {
  const o = state.orders.find(x => x.id === orderId);
  if (!o) return;
  openModal(`
    <h2>📅 ${t('order.jit.title', { code: o.code })}</h2>
    <p class="view-intro">${t('order.jit.hint')}</p>
    <div class="form-row"><label>${t('order.jit.date')}</label>
      <input type="date" id="jit-date" value="${esc(o.needBy || '')}"></div>
    <div class="form-row"><label>${t('order.jit.time')}</label>
      <input type="time" id="jit-time" value="${esc(o.needByTime || '')}"></div>
    <div class="modal-actions">
      <button class="btn" id="jit-cancel">${t('common.cancel')}</button>
      <button class="btn primary" id="jit-save">${t('order.jit.confirm')}</button>
    </div>`);
  $('#jit-cancel').addEventListener('click', closeModal);
  $('#jit-save').addEventListener('click', () => {
    const date = $('#jit-date').value, time = $('#jit-time').value;
    // the administrator may dispatch without a firm slot; the server records the
    // override on the request. Everyone else has to commit to a date and time.
    if ((!date || !time) && !isAdmin(state.role)) { toast(t('order.jit.required')); return; }
    if (date) o.needBy = date;
    if (time) o.needByTime = time;
    closeModal();
    onConfirm(date, time);
  });
}

const INSPECTION_CHECKS = ['dims', 'damage', 'label', 'docs'];

// quality gate before the two physical hand-offs: factory exit and site reception.
// Passing requires every check ticked; failing requires a note and records a NC.
function openInspectionModal(orderId, gate, onPass) {
  const o = state.orders.find(x => x.id === orderId);
  if (!o) return;
  openModal(`
    <h2>🔍 ${t('insp.title.' + gate, { code: o.code })}</h2>
    <p class="view-intro">${t('insp.hint')}</p>
    <div class="filter-group" style="margin-bottom:var(--sp-3)">
      ${INSPECTION_CHECKS.map(c => `<label class="filter-item">
        <input type="checkbox" class="insp-check" value="${c}"> ${t('insp.check.' + c)}</label>`).join('')}
    </div>
    <div class="form-row"><label>${t('insp.photo')}</label>
      <input type="file" id="insp-photo" accept="image/*" capture="environment"></div>
    <div class="form-row"><label>${t('insp.note')}</label>
      <textarea id="insp-note" rows="2"></textarea></div>
    <div class="modal-actions" style="justify-content:space-between">
      <button class="btn" id="insp-fail" style="border-color:var(--red-text);color:var(--red-text)">${t('insp.fail')}</button>
      <span style="display:flex;gap:var(--sp-2)">
        <button class="btn" id="insp-cancel">${t('common.cancel')}</button>
        <button class="btn primary" id="insp-pass" disabled>${t('insp.pass')}</button>
      </span>
    </div>`);
  const update = () => {
    $('#insp-pass').disabled = [...document.querySelectorAll('.insp-check')].some(c => !c.checked);
  };
  document.querySelectorAll('.insp-check').forEach(c => c.addEventListener('change', update));
  $('#insp-cancel').addEventListener('click', () => openOrderModal(orderId));
  const collect = async (pass) => {
    const file = $('#insp-photo').files[0];
    return {
      gate, pass,
      checks: Object.fromEntries([...document.querySelectorAll('.insp-check')].map(c => [c.value, c.checked])),
      note: $('#insp-note').value.trim(),
      photo: file ? await downscalePhoto(file) : null,
    };
  };
  $('#insp-pass').addEventListener('click', async () => {
    recordInspection(o, await collect(true));
    onPass();
  });
  $('#insp-fail').addEventListener('click', async () => {
    if (!$('#insp-note').value.trim()) { toast(t('insp.noteRequired')); return; }
    recordInspection(o, await collect(false));
    toast(t('insp.failedToast', { code: o.code }));
    openOrderModal(orderId);
    renderOrders();
    renderDashboard();
  });
}

// logistics/foreman picks how much of each typology goes on this load
function openShipmentModal(orderId) {
  const o = state.orders.find(x => x.id === orderId);
  if (!o) return;
  const remaining = shipmentRemaining(o);
  const rows = o.items.filter(it => remaining.has(it.key));
  openModal(`
    <h2>🚚 ${t('ship.title', { code: o.code })}</h2>
    <p class="view-intro">${t('ship.hint')}</p>
    <div class="card" style="padding:0;max-height:320px;overflow:auto;margin-bottom:var(--sp-4)">
      <table><thead><tr>
        <th>${t('order.typology')}</th><th class="num">${t('ship.remaining')}</th><th class="num">${t('ship.thisLoad')}</th>
      </tr></thead>
      <tbody>${rows.map(it => `<tr>
        <td>${esc(it.name)}</td>
        <td class="num">${remaining.get(it.key)}</td>
        <td class="num"><input type="number" class="ship-qty" data-key="${esc(it.key)}"
             min="0" max="${remaining.get(it.key)}" value="${remaining.get(it.key)}" style="width:74px"></td>
      </tr>`).join('')}</tbody></table>
    </div>
    <div class="modal-actions">
      <button class="btn" id="ship-cancel">${t('common.cancel')}</button>
      <button class="btn primary" id="ship-ok">${t('ship.send')}</button>
    </div>`);
  $('#ship-cancel').addEventListener('click', () => openOrderModal(orderId));
  $('#ship-ok').addEventListener('click', () => {
    const items = [];
    for (const inp of document.querySelectorAll('.ship-qty')) {
      const it = o.items.find(x => x.key === inp.dataset.key);
      const max = remaining.get(inp.dataset.key) || 0;
      const qty = Math.max(0, Math.min(max, Number(inp.value) || 0));
      if (qty > 0) items.push({ key: it.key, name: it.name, qty });
    }
    if (!items.length) { toast(t('ship.nothingSelected')); return; }
    const send = () => {
      createShipment(o, items);
      toast(t('ship.sentToast', { n: fmtNum(items.reduce((s, i) => s + i.qty, 0), 0) }));
      openOrderModal(orderId);
      renderOrders();
      renderDashboard();
      applyStatusColors();
    };
    // the first load is what actually leaves the factory (Ready → Sent/Transit) —
    // same JIT gate as the whole-order jump
    if (o.status === 'ready') openJitModal(o.id, () => send());
    else send();
  });
}

// tick off a per-element phase for many elements at once — the factory does this
// as pieces come off the line, the site does it floor by floor for the grout steps
function openAsBuiltModal(orderId, phase = 'built') {
  const o = state.orders.find(x => x.id === orderId);
  if (!o) return;
  const rows = o.items.flatMap(it => (it.globalIds || []).map(gid => ({ gid, name: it.name })));
  const phaseLabel = t('scan.phase.' + phase);
  // the grout chain is genuinely sequential (nothing is grouted before it is fixed),
  // so each site step requires its predecessor. The gate applies WITHIN the site
  // phases only: the factory/logistics steps before them are often recorded at order
  // level rather than per element, and gating on those would just block real work.
  const siteIdx = SITE_PHASES.indexOf(phase);
  const prev = siteIdx > 0 ? SITE_PHASES[siteIdx - 1] : null;
  openModal(`
    <h2>${t('asbuilt.title', { code: o.code })} — ${phaseLabel}</h2>
    <p class="view-intro">${t('asbuilt.hint')}</p>
    <div style="display:flex;gap:var(--sp-2);margin-bottom:var(--sp-2);flex-wrap:wrap">
      <button class="ghost small" id="ab-all">${t('asbuilt.selectAll')}</button>
      <button class="ghost small" id="ab-none">${t('asbuilt.selectNone')}</button>
    </div>
    <div class="card" style="padding:10px;max-height:320px;overflow:auto">
      ${rows.map(r => {
        const track = o.tracking?.[r.gid] || {};
        const done = track[phase];
        const blocked = prev && !track[prev]; // predecessor not recorded yet
        return `<label class="filter-item" style="justify-content:space-between${blocked ? ';opacity:.5' : ''}">
          <span><input type="checkbox" class="ab-check" value="${esc(r.gid)}" ${done ? 'checked disabled' : ''}${blocked && !done ? ' disabled' : ''}> ${esc(r.name)}
            <span class="muted" style="font-size:var(--fs-100)">${esc(r.gid)}</span></span>
          ${done ? `<span class="muted">${fmtDate(done)}</span>`
                 : blocked ? `<span class="muted" style="font-size:var(--fs-100)">${t('asbuilt.needsPrev', { phase: t('scan.phase.' + prev) })}</span>` : ''}
        </label>`;
      }).join('')}
    </div>
    <div class="modal-actions">
      <button class="btn" id="ab-cancel">${t('common.cancel')}</button>
      <button class="btn primary" id="ab-save">${t('asbuilt.record')}</button>
    </div>`);
  const selectable = () => document.querySelectorAll('.ab-check:not(:disabled)');
  $('#ab-all').addEventListener('click', () => selectable().forEach(c => { c.checked = true; }));
  $('#ab-none').addEventListener('click', () => selectable().forEach(c => { c.checked = false; }));
  $('#ab-cancel').addEventListener('click', () => openOrderModal(orderId));
  $('#ab-save').addEventListener('click', () => {
    const gids = [...document.querySelectorAll('.ab-check:checked:not(:disabled)')].map(c => c.value);
    if (gids.length) {
      markPhaseBatch(o, gids, phase, phaseLabel);
      toast(t('asbuilt.recorded', { n: gids.length }));
    }
    openOrderModal(orderId);
    renderOrders();
    renderDashboard();
  });
}

function buildOrderEmail(o) {
  const supplier = state.parties.find(p => p.id === o.supplierId);
  const to = (supplier?.email || '').trim();
  if (!to) return null;
  const prj = getProject(o.projectId);
  const subject = `Production Request ${o.code} — ${prj?.name || 'project'}`;
  const lines = [
    `Production Request ${o.code}`,
    `Project: ${prj?.name || '—'} (${prj?.fileName || 'no IFC'})`,
    `Deliver to (site address): ${prj?.address || '—'}`,
    `Status: ${STATUSES[o.status].label}`,
    `Needed on site (JIT): ${o.needBy || '—'}`,
    '',
    'Items:',
    ...o.items.map(it =>
      `- ${it.type} | ${it.name} — ${it.qty} un` +
      (it.volume ? ` (${fmtNum(it.volume)} m3)` : '')),
    '',
    `Total elements: ${orderItemCount(o)}`,
  ];
  if (o.notes) lines.push('', 'Notes: ' + o.notes);
  lines.push('', '--', 'Sent via TwinFlow');
  return { to, subject, text: lines.join('\r\n') };
}

function openMailto({ to, subject, text }) {
  const href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
  if (window.TwinFlow) window.TwinFlow.lastMailto = href; // inspectable in devtools/tests
  window.location.href = href;
}

// Sends the order by email. Tries the server SMTP API first; if the server has no
// SMTP configured (or is unreachable), falls back to opening the local mail app.
// With auto=true (e.g. on submit) it stays silent instead of falling back.
async function emailOrder(o, { auto = false } = {}) {
  const msg = buildOrderEmail(o);
  if (!msg) {
    if (!auto) toast(t('email.noneSet'));
    return false;
  }
  try {
    const res = await fetch('api/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok) {
      addEvent(o, `✉ Email sent to ${msg.to}${data.test ? ' (test mode)' : ''}`);
      toast(t('email.sent', { to: msg.to, test: data.test ? t('email.sentTestSuffix') : '' }));
      return true;
    }
    if (res.status === 503) {
      if (!auto) {
        toast(t('email.smtpNotConfigured'));
        openMailto(msg);
      }
      return false;
    }
    toast(t('email.failed', { err: data.error || 'HTTP ' + res.status }));
    return false;
  } catch {
    if (!auto) {
      toast(t('email.serverUnreachable'));
      openMailto(msg);
    }
    return false;
  }
}

// One QR label per physical element (GUID from the IFC model when available),
// linking the piece on the factory floor to its digital twin.
function printLabels(o) {
  const prj = getProject(o.projectId);
  const labels = [];
  for (const it of o.items) {
    const g = prj?.groups.find(x => x.key === it.key);
    for (let i = 0; i < it.qty; i++) {
      // prefer the GUIDs snapshotted at order creation (they reflect any 3D filter)
      const gid = it.globalIds?.[i] || g?.globalIds?.[i] || `${o.code}|${it.key}|${i + 1}`;
      labels.push({ title: it.name, sub: `${o.code} · ${prj?.name || ''} · ${i + 1}/${it.qty}`, gid });
    }
  }
  if (!labels.length) { toast(t('order.nothingInRequest')); return; }
  const w = window.open('', '_blank');
  w.document.write(`<html><head><title>${o.code} — QR labels</title>
    <style>
      body{font-family:Arial,sans-serif;margin:8mm;display:grid;grid-template-columns:repeat(3,1fr);gap:5mm}
      .lbl{border:1px solid #000;border-radius:2mm;padding:4mm;text-align:center;page-break-inside:avoid}
      .lbl .t{font-weight:bold;font-size:11px;margin-bottom:2mm}
      .lbl .qr{display:flex;justify-content:center;margin:1mm 0}
      .lbl .s{font-size:9px;color:#333;margin-top:2mm}
      .lbl .g{font-size:8px;color:#555;word-break:break-all}
    </style>
    <!-- resolved against this page, not the domain root: under a sub-path deploy
         (/twinflow) location.origin dropped the prefix and the QR library 404'd,
         so every printed label came out without its code -->
    <script src="${new URL('vendor/qrcode.min.js', location.href).href}"><\/script>
    </head><body>
    ${labels.map((l, i) => `<div class="lbl">
      <div class="t">${esc(l.title)}</div>
      <div class="qr" id="qr${i}"></div>
      <div class="s">${esc(l.sub)}</div>
      <div class="g">${esc(l.gid)}</div>
    </div>`).join('')}
    <script>window.onload = function () {
      ${labels.map((l, i) => `new QRCode(document.getElementById('qr${i}'), { text: ${JSON.stringify(l.gid)}, width: 90, height: 90 });`).join('\n')}
      setTimeout(function () { window.print(); }, 300);
    };<\/script>
    </body></html>`);
  w.document.close();
}

function printOrder(o) {
  const prj = getProject(o.projectId);
  const w = window.open('', '_blank');
  w.document.write(`<html><head><title>${o.code}</title>
    <style>body{font-family:Segoe UI,sans-serif;padding:30px;color:#111}
    table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:6px;text-align:left}
    h1{font-size:20px}</style></head><body>
    <h1>Production Request ${o.code} — ${statusLabel(o.status)}</h1>
    <p><b>${t('order.project')}:</b> ${esc(prj?.name || '—')}<br>
       <b>${t('order.siteAddress')}:</b> ${esc(prj?.address || '—')}<br>
       <b>${t('order.factoryLabel')}:</b> ${esc(partyName(o.supplierId))}<br>
       <b>${t('order.createdLabel')}:</b> ${fmtDate(o.createdAt)}<br>
       <b>${t('order.neededOnSite')}:</b> ${o.needBy || '—'}<br>
       <b>${t('order.notesLabel').replace(':', '')}:</b> ${esc(o.notes || '—')}</p>
    <table><tr><th>${t('order.type')}</th><th>${t('order.typology')}</th><th>${t('order.qty')}</th><th>${t('order.volume')}</th></tr>
    ${o.items.map(it => `<tr><td>${esc(it.type)}</td><td>${esc(it.name)}</td>
      <td>${it.qty}</td><td>${it.volume ? fmtNum(it.volume) : '—'}</td></tr>`).join('')}
    </table>
    <h3>${t('order.timeline')}</h3>
    <ul>${o.events.map(e => `<li>${fmtDate(e.ts)} — ${esc(e.action)} (${esc(roleLabel(e.actor))})${e.note ? ': ' + esc(e.note) : ''}</li>`).join('')}</ul>
    </body></html>`);
  w.document.close();
  w.print();
}

// ---------------------------------------------------------------- activity log
// The digital thread, finally in one place. Every act was already being recorded,
// but only inside the record it belonged to — answering "what happened this week,
// and who did it" meant opening requests one by one. Nothing new is stored here:
// this reads the trails that already exist (order events, the stock ledger and the
// purchase-order milestones) and merges them newest-first.
//
// Scoping needs no work: project-restricted roles are already served a filtered
// state by the server, so they can only ever aggregate what they were allowed to see.

const ACT_KINDS = { order: '#1666aa', stock: '#b96e14', po: '#7c5cd6' };
let activityFilters = { scope: 'project', kind: 'all', who: 'all', q: '' };
let activityShown = 150; // grows on demand — a long-running project has thousands

// order events record a ROLE (whoever acted), the ledger records a USERNAME.
// Show each for what it is rather than pretending they are the same thing.
function actorText(who) {
  if (!who) return '—';
  return ROLES[who] ? roleLabel(who) : who;
}

// Building the merged list walks every order event, every ledger row and every
// purchase order, then sorts the lot — 56k entries on a 100-project portfolio,
// measured at ~800 ms. Doing that per keystroke made the search unusable, so the
// built list is cached and only the (cheap) filtering re-runs. Invalidated
// whenever the data or the scope changes, never by a filter.
let activityCache = null; // { scope, entries }
function invalidateActivityCache() { activityCache = null; }

function activityEntries() {
  if (activityCache && activityCache.scope === activityFilters.scope) return activityCache.entries;
  const entries = buildActivityEntries();
  activityCache = { scope: activityFilters.scope, entries };
  return entries;
}

function buildActivityEntries() {
  const out = [];
  const inScope = (projectId) =>
    activityFilters.scope === 'all' || projectId === state.activeProjectId;

  for (const o of state.orders) {
    if (!inScope(o.projectId)) continue;
    for (const e of o.events || []) {
      out.push({ ts: e.ts, kind: 'order', who: e.actor, label: e.action || '—',
        note: e.note || '', ref: o.code, projectId: o.projectId });
    }
  }
  for (const m of state.stockMoves || []) {
    // ledger rows carry a projectId only when consumption tied them to an order
    if (!inScope(m.projectId ?? state.activeProjectId)) continue;
    out.push({ ts: m.ts, kind: 'stock', who: m.by,
      label: `${t('stock.move.' + m.type)} · ${fmtQty(m.qty)} ${compUnit(m.componentId)}`,
      note: [compName(m.componentId), m.note].filter(Boolean).join(' — '),
      ref: m.orderCode || '', projectId: m.projectId });
  }
  for (const po of state.procurement || []) {
    // purchase orders are project-independent (warehouse level), so they show in
    // every scope rather than being hidden behind the active project
    const who = po.by;
    const lines = poLines(po);
    // An order carries several references now, so the timeline names how many rather
    // than pretending there is one. The names still go in the note, because "3
    // referências" alone tells you nothing about what was bought.
    const label = (st) => `${t('po.status.' + st)} · ${t('po.linesN', { n: lines.length })}`;
    const note = [lines.map(l => compName(l.componentId)).join(', '), partyName(po.supplierId), po.note].filter(Boolean).join(' — ');
    if (po.awardedAt) out.push({ ts: po.awardedAt, kind: 'po', who, label: label('awarded'), note, ref: '' });
    if (po.invoicedAt) out.push({ ts: po.invoicedAt, kind: 'po', who, label: label('invoiced'), note, ref: '' });
    // one entry per line received, at the moment it was received — a part-delivered
    // order should read as several arrivals on the timeline, because that is what it was
    for (const l of lines) {
      if (!l.receivedAt) continue;
      out.push({ ts: l.receivedAt, kind: 'po', who: l.receivedBy || who,
        label: `${t('po.status.delivered')} · ${fmtQty(l.qty)} ${compUnit(l.componentId)}`,
        note: [compName(l.componentId), partyName(po.supplierId)].filter(Boolean).join(' — '), ref: '' });
    }
  }

  return out.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}

// the actor dropdown is built from the scope-filtered set but NOT from the actor
// filter itself — otherwise picking someone would collapse the list to that one
// person and there would be no way back
function activityFiltered(entries) {
  const q = activityFilters.q.trim().toLowerCase();
  return entries
    .filter(e => activityFilters.kind === 'all' || e.kind === activityFilters.kind)
    .filter(e => activityFilters.who === 'all' || e.who === activityFilters.who)
    .filter(e => !q || `${e.label} ${e.note} ${e.ref} ${actorText(e.who)}`.toLowerCase().includes(q));
}

// The shell (filters) is rendered once; typing only rewrites the rows below it.
// Re-rendering the whole view per keystroke also destroyed the search box, which
// is why it used to need a focus/caret restore hack — now it is never touched.
function renderActivity() {
  const box = $('#activity-content');
  const entries = activityEntries();
  const actors = [...new Set(entries.map(e => e.who).filter(Boolean))]
    .sort((a, b) => actorText(a).localeCompare(actorText(b)));

  const opt = (v, label, cur) => `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(label)}</option>`;
  box.innerHTML = `
    <p class="view-intro">${t('activity.hint')}</p>
    <div class="card" id="training-panel" style="margin-bottom:var(--sp-4);padding:12px 14px">
      <div style="display:flex;flex-wrap:wrap;gap:var(--sp-3);align-items:center;justify-content:space-between">
        <div>
          <b style="font-size:var(--fs-400)">${t('training.title')}</b>
          <div class="muted" style="font-size:var(--fs-300);margin-top:2px">${t('training.hint')}</div>
          <div class="muted" style="font-size:var(--fs-300);margin-top:var(--sp-1)" id="training-stats">…</div>
        </div>
        <button class="btn" id="training-export">${t('training.export')}</button>
      </div>
    </div>
    <div class="filter-bar" style="display:flex;flex-wrap:wrap;gap:var(--sp-2);margin-bottom:var(--sp-4)">
      <select id="act-scope">
        ${opt('project', t('activity.scopeProject', { name: activeProject()?.name || '—' }), activityFilters.scope)}
        ${opt('all', t('activity.scopeAll'), activityFilters.scope)}
      </select>
      <select id="act-kind">
        ${opt('all', t('activity.kindAll'), activityFilters.kind)}
        ${opt('order', t('activity.kindOrder'), activityFilters.kind)}
        ${opt('stock', t('activity.kindStock'), activityFilters.kind)}
        ${opt('po', t('activity.kindPo'), activityFilters.kind)}
      </select>
      <select id="act-who">
        ${opt('all', t('activity.whoAll'), activityFilters.who)}
        ${actors.map(a => opt(a, actorText(a), activityFilters.who)).join('')}
      </select>
      <input type="search" id="act-q" placeholder="${t('activity.search')}" value="${esc(activityFilters.q)}" style="flex:1;min-width:160px">
      <span class="muted" id="act-count" style="align-self:center;font-size:var(--fs-300)"></span>
    </div>
    <div id="act-rows"></div>`;

  const refresh = () => { activityShown = 150; renderActivityRows(); };
  $('#act-scope').addEventListener('change', (e) => {
    activityFilters.scope = e.target.value;
    invalidateActivityCache(); // scope decides what gets built, so it must rebuild
    renderActivity();
  });
  $('#act-kind').addEventListener('change', (e) => { activityFilters.kind = e.target.value; refresh(); });
  $('#act-who').addEventListener('change', (e) => { activityFilters.who = e.target.value; refresh(); });
  $('#act-q').addEventListener('input', (e) => { activityFilters.q = e.target.value; refresh(); });

  // the decision log lives in a file on the server, not in the state the client holds,
  // so its size has to be asked for
  fetch('api/training/summary').then(r => r.json()).then((d) => {
    const el = $('#training-stats');
    if (!el) return; // the view was left while the request was in flight
    el.textContent = d.ok
      ? t('training.stats', { files: d.files.length, kb: fmtNum(d.bytes / 1024, 1) })
      : t('training.unavailable');
  }).catch(() => { const el = $('#training-stats'); if (el) el.textContent = t('training.unavailable'); });
  $('#training-export').addEventListener('click', () => { location.href = 'api/training/export'; });

  renderActivityRows();
}

function renderActivityRows() {
  const all = activityFiltered(activityEntries());
  const rows = all.slice(0, activityShown);
  $('#act-count').textContent = t('activity.count', { n: all.length });
  $('#act-rows').innerHTML = rows.length
    ? `<div class="card" style="padding:0">
      <table class="activity-table"><thead><tr>
        <th>${t('activity.when')}</th><th>${t('activity.who')}</th>
        <th>${t('activity.what')}</th><th>${t('activity.ref')}</th></tr></thead>
      <tbody>${rows.map(e => `<tr>
        <td class="muted" style="white-space:nowrap" data-label="${t('activity.when')}">${fmtDate(e.ts)}</td>
        <td data-label="${t('activity.who')}"><span class="type-chip">${esc(actorText(e.who))}</span></td>
        <td data-label="${t('activity.what')}">
          <span class="act-dot" style="background:${ACT_KINDS[e.kind]}"></span>${esc(e.label)}
          ${e.note ? `<div class="muted" style="font-size:var(--fs-300)">${esc(e.note)}</div>` : ''}</td>
        <td class="muted" data-label="${t('activity.ref')}">${esc(e.ref || '—')}</td>
      </tr>`).join('')}</tbody></table>
    </div>
    ${all.length > rows.length
      ? `<div style="margin-top:var(--sp-3)"><button class="btn" id="act-more">${t('activity.more', { n: all.length - rows.length })}</button></div>`
      : ''}`
    : `<div class="empty-state">${t('activity.empty')}</div>`;
  $('#act-more')?.addEventListener('click', () => { activityShown += 150; renderActivityRows(); });
}

// ---------------------------------------------------------------- Partners
// (the companies/teams in the process: GC, off-site factory, logistics, site team)

// Contacts are actionable: on a phone (the app is used on site) tapping the number
// opens the dialer and the address opens the mail app. `tel:` needs the digits with
// no spaces, while the label keeps the readable spacing.
function telLink(phone) {
  const n = (phone || '').trim();
  if (!n) return '—';
  const dial = n.replace(/[^\d+]/g, '');
  if (!dial) return esc(n);
  return `<a href="tel:${esc(dial)}" class="contact-link" title="${esc(t('partners.call', { n }))}">📞 ${esc(n)}</a>`;
}
function mailLink(email) {
  const e = (email || '').trim();
  if (!e) return '—';
  return `<a href="mailto:${esc(e)}" class="contact-link" title="${esc(t('partners.mailTo', { e }))}">✉ ${esc(e)}</a>`;
}

// one prop-row with whatever contact the supplier has — omitted entirely when it has
// none, so the order detail does not grow an empty line
function partyContactRow(partyId) {
  const p = state.parties.find(x => x.id === partyId);
  if (!p?.email && !p?.phone) return '';
  const bits = [p.phone ? telLink(p.phone) : '', p.email ? mailLink(p.email) : ''].filter(Boolean);
  return `<div class="prop-row"><span class="k">${t('partners.contact')}</span><span class="v">${bits.join(' · ')}</span></div>`;
}

function renderParties() {
  const box = $('#parties-content');
  const canManage = CREATOR_ROLES.includes(state.role); // mirrors the server gate on api/parties
  const typeLabels = { admin: t('partners.type.admin'), supplier: t('partners.type.supplier'), factory: t('partners.type.factory'), logistics: t('partners.type.logistics'), site: t('partners.type.site') };
  box.innerHTML = `
    <p class="view-intro">${t('partners.hint')}</p>
    ${canManage ? `<div style="margin-bottom:var(--sp-4)"><button class="btn primary" id="btn-add-party">${t('partners.add')}</button></div>` : ''}
    <div class="card" style="padding:0">
      <table class="parties-table"><thead><tr><th>${t('partners.name')}</th><th>${t('partners.role')}</th><th>${t('partners.email')}</th><th>${t('partners.phone')}</th>${canManage ? '<th></th>' : ''}</tr></thead>
      <tbody>${state.parties.map(p => `<tr>
        <td data-label="${t('partners.name')}">${esc(p.name)}</td>
        <td data-label="${t('partners.role')}"><span class="type-chip">${typeLabels[p.type] || esc(p.type || '')}</span></td>
        <td class="muted" data-label="${t('partners.email')}">${mailLink(p.email)}</td>
        <td class="muted" data-label="${t('partners.phone')}">${telLink(p.phone)}</td>
        ${canManage ? `<td><button class="ghost small" data-edit="${p.id}">${t('common.edit')}</button>
            <button class="ghost small danger" data-del="${p.id}">${t('common.delete')}</button></td>` : ''}
      </tr>`).join('')}</tbody></table>
    </div>`;

  $('#btn-add-party')?.addEventListener('click', () => openPartyModal());
  box.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openPartyModal(b.dataset.edit)));
  box.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    const p = state.parties.find(x => x.id === b.dataset.del);
    if (state.orders.some(o => o.supplierId === p.id)) { toast(t('partners.hasRequests')); return; }
    if (confirm(t('partners.confirmDelete', { name: p.name }))) {
      deleteParty(p.id);
      renderParties();
    }
  }));
}

function openPartyModal(id) {
  const p = id ? state.parties.find(x => x.id === id) : null;
  openModal(`
    <h2>${p ? t('partners.editPartner') : t('partners.addPartner')}</h2>
    <div class="form-row"><label>${t('partners.name')}</label><input type="text" id="pt-name" value="${esc(p?.name || '')}"></div>
    <div class="form-row"><label>${t('partners.role')}</label>
      <select id="pt-type">
        <option value="supplier" ${p?.type === 'supplier' ? 'selected' : ''}>${t('partners.type.supplier')}</option>
        <option value="factory" ${p?.type === 'factory' ? 'selected' : ''}>${t('partners.type.factory')}</option>
        <option value="logistics" ${p?.type === 'logistics' ? 'selected' : ''}>${t('partners.type.logistics')}</option>
        <option value="site" ${p?.type === 'site' ? 'selected' : ''}>${t('partners.type.site')}</option>
        <option value="admin" ${p?.type === 'admin' ? 'selected' : ''}>${t('partners.type.admin')}</option>
      </select></div>
    <div class="form-row"><label>${t('partners.email')}</label><input type="email" id="pt-email" value="${esc(p?.email || '')}" placeholder="nome@empresa.pt">
      <p class="muted" style="margin:4px 0 0;font-size:var(--fs-300)">${t('partners.emailHint')}</p></div>
    <div class="form-row"><label>${t('partners.phone')}</label><input type="tel" id="pt-phone" value="${esc(p?.phone || '')}" placeholder="+351 000 000 000"></div>
    <div class="form-row"><label>${t('partners.nif')} <span class="muted">${t('partners.nifHint')}</span></label>
      <input type="text" id="pt-nif" value="${esc(p?.nif || '')}" placeholder="500000000"></div>
    <div class="form-row"><label>${t('partners.address')} <span class="muted">${t('partners.addressHint')}</span></label>
      <textarea id="pt-address" rows="2">${esc(p?.address || '')}</textarea></div>
    <div class="form-row form-row-split">
      <div><label>${t('partners.postalCode')}</label>
        <input type="text" id="pt-postal" value="${esc(p?.postalCode || '')}" placeholder="3000-001"></div>
      <div><label>${t('partners.city')}</label>
        <input type="text" id="pt-city" value="${esc(p?.city || '')}" placeholder="Coimbra"></div>
    </div>
    <div class="form-row"><label>${t('partners.country')}</label>
      <input type="text" id="pt-country" value="${esc(p?.country || 'PT')}" maxlength="2" style="width:80px">
      <div class="muted" style="font-size:var(--fs-200);margin-top:var(--sp-1)">${t('partners.addressAtHint')}</div></div>
    <div class="modal-actions">
      <button class="btn" id="pt-cancel">${t('common.cancel')}</button>
      <button class="btn primary" id="pt-save">${t('common.save')}</button>
    </div>`);
  $('#pt-cancel').addEventListener('click', closeModal);
  $('#pt-save').addEventListener('click', () => {
    const name = $('#pt-name').value.trim();
    if (!name) { toast(t('common.nameRequired')); return; }
    const email = $('#pt-email').value.trim();
    // mirrors the server check: this address is what orders are mailed to
    if (email && !/^[^\s,;·<>()[\]@]+@[^\s,;·<>()[\]@]+\.[a-z]{2,}$/i.test(email)) {
      toast(t('partners.emailInvalid')); return;
    }
    upsertParty({
      id: p?.id || uid('p'),
      name,
      type: $('#pt-type').value,
      email,
      phone: $('#pt-phone').value.trim(),
      nif: $('#pt-nif').value.trim(),
      address: $('#pt-address').value.trim(),
      postalCode: $('#pt-postal').value.trim(),
      city: $('#pt-city').value.trim(),
      country: $('#pt-country').value.trim().toUpperCase() || 'PT',
    });
    closeModal(); renderParties();
  });
}

// ---------------------------------------------------------------- warehouse / component stock

// quantities: integers plain, fractional values with 2 decimals
const fmtQty = (n) => fmtNum(n || 0, Number.isInteger(n || 0) ? 0 : 2);
// These are chip BACKGROUNDS with white text on them, so each one has to carry the text:
// measured, five of the eight were under 4.5:1 (in 3.74, consume/use 3.96, defect/loss
// 4.38). Darkened just enough to pass while staying the same hue — they are not the
// workflow status palette, which is pinned to store.js and must not move.
const MOVE_COLORS = { in: '#3b824d', send: '#1666aa', return: '#2a7f8f', consume: '#a86412', use: '#a86412', defect: '#cd4242', loss: '#cd4242', adjust: '#64748b', reverse: '#7c5cd6' };
// view filters, kept across re-renders (module state, like the QTO filter)
let stockSearch = '';       // components: name/ref text search
let stockView = '';         // components: '' | low | negative | factory | consumed
let stockUnit = '';         // components: unit
let stockFactory = '';      // components: only refs with a balance at this factory
let stockType = '';         // components: family from the warehouse sheet (FIXAÇÃO, CALÇOS…)
let stockLocation = '';     // components: pallet
let stockSort = 'name';     // components: name | warehouse | factory | consumed
let stockMoveFilterId = ''; // movements: component
let moveType = '';          // movements: in | send | consume | adjust
let moveFactory = '';       // movements: factory party id
let moveProject = '';       // movements: project id
let moveFrom = '';          // movements: date range (YYYY-MM-DD)
let moveTo = '';
let moveSearch = '';        // movements: note / request code text search
let moveShowAll = false;    // movements: recent 50 ↔ everything
let expandedMoveGroups = new Set(); // movements: which grouped rows are expanded
// Stock is split in two tabs — balances ("what do I have, where") and the ledger
// ("what happened"). They used to share one page, which meant two independent
// filter bars competing for the same screen.
let stockTab = 'balances'; // balances | moves
let stockFocusId = null;    // which search input to re-focus after a re-render

const factoryTotal = (c) => Object.values(c.factoryQty || {}).reduce((s, n) => s + n, 0);

// MRP-lite: component needs of the open order book. For every request that is
// committed but not fully produced (submitted → in production), the units still
// to produce (qty − stockConsumed) × the project recipe, aggregated per
// component + supplier factory and compared with that factory's balance.
const NEEDS_STATUSES = new Set(['submitted', 'accepted', 'production']);
function stockNeeds() {
  const agg = new Map(); // 'componentId|factoryId' -> units needed
  for (const o of state.orders) {
    if (!NEEDS_STATUSES.has(o.status)) continue;
    const recipes = getProject(o.projectId)?.recipes || {};
    for (const it of o.items || []) {
      const remaining = Math.max(0, (Number(it.qty) || 0) - (Number(o.stockConsumed?.[it.key]) || 0));
      if (!remaining) continue;
      for (const r of recipes[it.key] || []) {
        if (!(Number(r.qtyPer) > 0)) continue;
        const k = r.componentId + '|' + (o.supplierId || '');
        agg.set(k, (agg.get(k) || 0) + remaining * Number(r.qtyPer));
      }
    }
  }
  return [...agg].map(([k, need]) => {
    const [componentId, factoryId] = k.split('|');
    const comp = state.components.find(c => c.id === componentId);
    return { comp, factoryId, need, have: comp?.factoryQty?.[factoryId] || 0 };
  }).filter(r => r.comp)
    .map(r => ({ ...r, short: Math.max(0, r.need - r.have) }))
    .sort((a, b) => b.short - a.short || a.comp.name.localeCompare(b.comp.name));
}

// CSV download of whatever the active filters show — ';' separator + UTF-8 BOM
// so PT-locale Excel opens it with correct columns and accents
function downloadCsv(filename, header, rows) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[";\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
  };
  const body = [header, ...rows].map(r => r.map(cell).join(';')).join('\r\n');
  const bom = String.fromCharCode(0xFEFF); // explicit BOM — invisible literals confuse editors
  const blob = new Blob([bom + body], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(t('stock.csvDone'));
}

function stockFilteredComponents() {
  const q = stockSearch.trim().toLowerCase();
  const isLow = (c) => c.minQty != null && c.warehouseQty < c.minQty;
  // the searchable text is every descriptor the warehouse might identify a
  // reference by — somebody looking for "ROTHOBLAAS" or "M20X40" should not have
  // to know which column that lives in
  const haystack = (c) => [c.name, c.ref, c.type && t('stock.type.' + c.type), c.size, c.standard, c.brand, c.location]
    .filter(Boolean).join(' ').toLowerCase();
  // archived references are out of the list unless you ask for them by name — the
  // whole point is that they stop being in the way
  const pool = stockView === 'archived' ? state.components.filter(c => c.archivedAt) : activeComponents();
  let list = pool.filter(c => {
    if (q && !haystack(c).includes(q)) return false;
    if (stockUnit && c.unit !== stockUnit) return false;
    if (stockType === '__none') { if (c.type) return false; }
    else if (stockType && c.type !== stockType) return false;
    if (stockLocation && c.location !== stockLocation) return false;
    // this select answers "where is the stock" — the warehouse is one of the places
    // it can be, and it was the only one missing
    if (stockFactory === 'warehouse') { if (!(c.warehouseQty > 0)) return false; }  // null fails this, correctly
    else if (stockFactory && !(c.factoryQty?.[stockFactory])) return false;
    if (stockView === 'low') return isLow(c);
    if (stockView === 'negative') return (c.warehouseQty != null && c.warehouseQty < 0) || Object.values(c.factoryQty || {}).some(n => n < 0);
    if (stockView === 'factory') return Object.values(c.factoryQty || {}).some(n => n > 0);
    if (stockView === 'consumed') return c.consumedQty > 0;
    return true;
  });
  const by = {
    name: (a, b) => a.name.localeCompare(b.name),
    warehouse: (a, b) => (b.warehouseQty ?? -Infinity) - (a.warehouseQty ?? -Infinity),
    factory: (a, b) => factoryTotal(b) - factoryTotal(a),
    consumed: (a, b) => b.consumedQty - a.consumedQty,
    // walking the warehouse pallet by pallet is a real way to read this list
    location: (a, b) => (a.location || '￿').localeCompare(b.location || '￿') || a.name.localeCompare(b.name),
  }[stockSort] || ((a, b) => a.name.localeCompare(b.name));
  return [...list].sort(by);
}

function stockFilteredMoves() {
  const q = moveSearch.trim().toLowerCase();
  // The searchable text of a movement includes the COMPONENT it moved — its name and
  // every descriptor. Without that, looking for "PARAFUSO" or "PALETE 07" in the ledger
  // returned nothing, because a movement stores only an id and the words the user
  // actually knows live on the component. Built once, not per row: the ledger only grows.
  const compById = new Map(state.components.map(c => [c.id, c]));
  const textOf = (m) => {
    const c = compById.get(m.componentId);
    return [
      m.note, m.orderCode, m.by, t('stock.move.' + m.type),
      c?.name, c?.ref, c?.type && t('stock.type.' + c.type), c?.size, c?.standard, c?.brand, c?.location,
      m.factoryId ? partyName(m.factoryId) : '',
      m.projectId ? state.projects.find(p => p.id === m.projectId)?.name : '',
    ].filter(Boolean).join(' ').toLowerCase();
  };
  return state.stockMoves.filter(m => {
    if (stockMoveFilterId && m.componentId !== stockMoveFilterId) return false;
    if (moveType && m.type !== moveType) return false;
    if (moveFactory && m.factoryId !== moveFactory) return false;
    if (moveProject && m.projectId !== moveProject) return false;
    const day = (m.ts || '').slice(0, 10); // ISO timestamps — date compare as strings
    if (moveFrom && day < moveFrom) return false;
    if (moveTo && day > moveTo) return false;
    if (q && !textOf(m).includes(q)) return false;
    return true;
  });
}

// merges movements that share request code + component + type into one row
// (e.g. several partial sends against the same order) to cut down table volume;
// the summary row hides individual notes — expanding it reveals the member moves
function groupStockMoves(list) {
  const groups = new Map();
  for (const m of list) {
    const key = (m.orderCode && !m.reversedBy && m.type !== 'reverse')
      ? `${m.orderCode}|${m.componentId}|${m.type}`
      : `_${m.id}`;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { ...m, key, count: 1, moves: [m], bys: m.by ? [m.by] : [] });
    } else {
      g.count++;
      g.qty += m.qty;
      g.moves.push(m);
      if (m.ts > g.ts) g.ts = m.ts;
      if (m.by && !g.bys.includes(m.by)) g.bys.push(m.by);
    }
  }
  return [...groups.values()]
    .map(g => ({ ...g, by: g.bys.join(', ') }))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

// which factory the signed-in account is bound to, '' when it runs the warehouse.
// Mirrors stockScope() in serve.mjs — the server is the authority; this only decides
// what is worth drawing.
// The three answers to "what does this do", and the text behind the ⓘ. The definitions
// sit next to the field because choosing between material and consumível is a judgement
// nobody makes the same way twice unless it is written down where they are choosing.
const TYPES = ['material', 'equipment', 'consumable'];
const TYPE_HELP = () => TYPES.map(k => `${t('stock.type.' + k)} — ${t('stock.typeHelp.' + k)}`).join('\n');

const WAREHOUSE_ROLES = ['admin', 'project_director', 'site_director', 'foreman'];
const myFactoryId = () => (WAREHOUSE_ROLES.includes(state.role) ? '' : (currentUser?.partyId || ''));
const stockUnlinked = () => state.role === 'factory' && !currentUser?.partyId;

function renderStock() {
  const box = $('#stock-content');
  // a factory account nobody has linked yet: say so plainly, rather than showing an
  // empty warehouse that looks like a warehouse with nothing in it
  if (stockUnlinked()) {
    box.innerHTML = `<div class="empty-state">${t('stock.notLinked')}</div>`;
    return;
  }
  const boundFactory = myFactoryId();
  const canManage = CREATOR_ROLES.includes(state.role);
  // the factory floor and the site crew both consume what they hold
  const canMark = canManage || ['factory', 'site'].includes(state.role);
  const low = lowStockComponents();
  const isLow = (c) => c.minQty != null && c.warehouseQty != null && c.warehouseQty < c.minQty;
  // null means the server withheld it (an account bound to a factory never sees the
  // warehouse balance) — a dash, not a zero, because zero is a claim about stock
  const qtyCell = (n) => n == null ? '<span class="muted">—</span>'
    : `<span ${n < 0 ? 'style="color:var(--red-text);font-weight:600"' : ''}>${fmtQty(n)}</span>`;
  const sel = (v, cur) => (v === cur ? 'selected' : '');

  // The views that used to be a six-option select nobody could see into. Each one now
  // carries its own count, so the answer arrives without a click — and the ones with
  // nothing to show are simply not drawn. A dropdown hides its emptiness; a chip cannot.
  const isLowFor = (c) => c.minQty != null && c.warehouseQty != null && c.warehouseQty < c.minQty;
  const VIEW_CHIPS = [
    { key: 'low', label: 'stock.view.low', showAtZero: true,
      count: () => activeComponents().filter(isLowFor).length },
    { key: 'negative', label: 'stock.view.negative',
      count: () => activeComponents().filter(c => (c.warehouseQty != null && c.warehouseQty < 0) || Object.values(c.factoryQty || {}).some(n => n < 0)).length },
    { key: 'factory', label: 'stock.view.factory',
      count: () => activeComponents().filter(c => Object.values(c.factoryQty || {}).some(n => n > 0)).length },
    { key: 'consumed', label: 'stock.view.consumed',
      count: () => activeComponents().filter(c => c.consumedQty > 0).length },
    { key: 'archived', label: 'stock.view.archivedChip',
      count: () => state.components.filter(c => c.archivedAt).length },
  ];
  // a unit filter is only a filter when there is more than one unit in the warehouse
  const unitsInUse = [...new Set(state.components.map(c => c.unit))].sort();
  const comps = stockFilteredComponents();
  const needs = stockNeeds();
  // the second line carries the maker's identifiers, which are how a warehouse
  // recognises a part it has in its hand
  const subLine = (c) => [c.brand, c.standard, c.ref].filter(Boolean).map(esc).join(' · ');
  const rows = comps.map(c => `<tr${c.archivedAt ? ' class="row-archived"' : ''}>
    <td>${esc(c.name)}${c.archivedAt ? ` <span class="type-chip">${t('stock.archivedChip')}</span>` : ''}${subLine(c) ? `<div class="muted" style="font-size:var(--fs-200)">${subLine(c)}</div>` : ''}</td>
    <td class="muted">${c.type ? `<span class="type-chip" title="${esc(t('stock.typeHelp.' + c.type))}">${t('stock.type.' + c.type)}</span>` : ''}</td>
    <td class="muted">${esc(c.size || '')}</td>
    <td class="muted" style="white-space:nowrap">${esc(c.location || '')}</td>
    <td><span class="type-chip">${t('unit.' + c.unit)}</span></td>
    <td class="num">${qtyCell(c.warehouseQty)}${isLow(c) ? ` <span title="${esc(t('stock.lowStockFlag', { min: fmtQty(c.minQty) }))}">⚠️</span>` : ''}</td>
    <td>${Object.entries(c.factoryQty || {}).filter(([, q]) => q !== 0)
        .map(([fid, q]) => `<span class="type-chip">${esc(partyName(fid))}: ${qtyCell(q)}</span>`).join(' ') || '—'}</td>
    <td class="num">${fmtQty(c.consumedQty)}</td>
    <td style="white-space:nowrap">${canManage ? `
      <button class="ghost small" data-in="${c.id}">${t('stock.entry')}</button>
      <button class="ghost small" data-adj="${c.id}">${t('stock.adjust')}</button>` : ''}${canManage && isLow(c) ? `
      <button class="ghost small" data-pobuy="${c.id}|${Math.max(0, c.minQty - c.warehouseQty)}" title="${esc(t('po.buyTitle', { n: fmtQty(Math.max(0, c.minQty - c.warehouseQty)) }))}">${t('po.buy')}</button>` : ''}${(canManage || canMark) && Object.values(c.factoryQty || {}).some(n => n > 0) ? `
      <button class="ghost small" data-ret="${c.id}" title="${esc(t('stock.returnTitle'))}">${t('stock.return')}</button>` : ''}${canMark ? `
      <button class="ghost small" data-mark="${c.id}" title="${esc(t('stock.markTitle'))}">${t('stock.mark')}</button>` : ''}
      <button class="ghost small" data-hist="${c.id}" title="${esc(t('stock.historyTitle'))}">${t('stock.history')}</button>${canManage ? `
      <button class="ghost small" data-edit="${c.id}">${t('common.edit')}</button>
      <button class="ghost small" data-arch="${c.id}" title="${esc(t(c.archivedAt ? 'stock.unarchiveTitle' : 'stock.archiveTitle'))}">${t(c.archivedAt ? 'stock.unarchive' : 'stock.archive')}</button>
      <button class="ghost small danger" data-del="${c.id}">${t('common.delete')}</button>` : ''}</td>
  </tr>`).join('');

  const filteredMoves = stockFilteredMoves();
  const groupedMoves = groupStockMoves(filteredMoves);
  const moves = (moveShowAll ? [...groupedMoves] : groupedMoves.slice(-50)).reverse();
  const compName = (id) => state.components.find(c => c.id === id)?.name || '—';
  const projName = (id) => state.projects.find(p => p.id === id)?.name || '';
  const factories = state.parties.filter(p => ['factory', 'site'].includes(p.type) && (!myFactoryId() || p.id === myFactoryId()));
  const canRevertMove = (m) => !m.reversedBy && (
    (canManage && ['in', 'send', 'return', 'adjust', 'use', 'defect', 'loss'].includes(m.type)) ||
    (['factory', 'site'].includes(state.role) && ['use', 'defect', 'loss', 'return'].includes(m.type) && m.by === currentUser.username));
  const moveRows = moves.map(m => {
    const expandable = m.count > 1;
    const isOpen = expandable && expandedMoveGroups.has(m.key);
    const summaryRow = `<tr${m.reversedBy ? ' style="opacity:.55;text-decoration:line-through"' : ''}${expandable ? ` style="cursor:pointer" data-move-toggle="${esc(m.key)}"` : ''}>
      <td class="muted" style="white-space:nowrap">${new Date(m.ts).toLocaleString()}</td>
      <td>${esc(compName(m.componentId))}</td>
      <td><span class="type-chip" style="background:${MOVE_COLORS[m.type] || '#64748b'};color:#fff">${t('stock.move.' + m.type)}</span>${expandable ? ` <span class="type-chip" title="${esc(t('stock.moveGrouped', { n: m.count }))}">${isOpen ? '▾' : '▸'} ×${m.count}</span>` : ''}</td>
      <td class="num">${m.type === 'adjust' && m.qty > 0 ? '+' : ''}${fmtQty(m.qty)}</td>
      <td class="muted">${m.factoryId ? esc(partyName(m.factoryId)) : '—'}</td>
      <td class="muted">${m.orderCode ? `${esc(m.orderCode)}${projName(m.projectId) ? ' · ' + esc(projName(m.projectId)) : ''}` : '—'}</td>
      <td class="muted">${esc(m.by || '')}</td>
      <td class="muted" style="font-size:var(--fs-200)">${expandable ? '' : esc(m.note || '')}</td>
      <td style="white-space:nowrap">${m.type === 'send'
        ? `<button class="ghost small" data-guia="${esc(m.ts)}|${esc(m.factoryId || '')}" title="${esc(t('stock.guiaReprint'))}">${t('stock.guia')}</button>` : ''}${!expandable && canRevertMove(m)
        ? `<button class="ghost small" data-rev="${m.id}" title="${esc(t('stock.reverseTitle'))}">↩</button>` : ''}</td>
    </tr>`;
    const childRows = isOpen ? m.moves.map(cm => `<tr style="background:rgba(100,116,139,.08)${cm.reversedBy ? ';opacity:.55;text-decoration:line-through' : ''}">
      <td class="muted" style="white-space:nowrap;padding-left:24px;font-size:var(--fs-200)">↳ ${new Date(cm.ts).toLocaleString()}</td>
      <td></td>
      <td></td>
      <td class="num">${fmtQty(cm.qty)}</td>
      <td class="muted">${cm.factoryId ? esc(partyName(cm.factoryId)) : '—'}</td>
      <td class="muted">${cm.orderCode ? esc(cm.orderCode) : '—'}</td>
      <td class="muted">${esc(cm.by || '')}</td>
      <td class="muted" style="font-size:var(--fs-200)">${esc(cm.note || '')}</td>
      <td>${canRevertMove(cm)
        ? `<button class="ghost small" data-rev="${cm.id}" title="${esc(t('stock.reverseTitle'))}">↩</button>` : ''}</td>
    </tr>`).join('') : '';
    return summaryRow + childRows;
  }).join('');

  const onBalances = stockTab === 'balances';

  // procurement tab: newest first; the status chip doubles as the phase timeline
  const PO_COLORS = { awarded: '#b96e14', invoiced: '#1666aa', partial: '#7a4fbf', delivered: '#298646' };
  const pos = [...(state.procurement || [])].reverse();
  const poRows = pos.map(po => {
    const sup = state.parties.find(p => p.id === po.supplierId);
    const lines = poLines(po);
    const anyReceived = lines.some(l => (l.qtyReceived || 0) > 0);
    // Each line carries its own state and its own button, because each is received on
    // its own day. The order-level chip only summarises what the lines already say.
    const linesHtml = lines.map(l => {
      const out = poOutstanding(l);
      const comp = state.components.find(c => c.id === l.componentId);
      const unit = comp ? t('unit.' + comp.unit) : '';
      return `<div style="display:flex;gap:var(--sp-2);align-items:baseline;padding:2px 0;${out ? '' : 'opacity:.6'}">
        <span style="flex:1;min-width:0">${esc(compName(l.componentId))}</span>
        <span class="num" style="white-space:nowrap">${fmtQty(l.qty)} ${unit}</span>
        ${l.qtyReceived ? `<span class="muted" style="font-size:var(--fs-200);white-space:nowrap">${t('po.receivedOf', { n: fmtQty(l.qtyReceived) })}</span>` : ''}
        ${out === 0
          ? `<span style="color:var(--green-text);font-size:var(--fs-200);white-space:nowrap">✓ ${t('po.lineDone')}</span>`
          : canManage ? `<button class="ghost small" data-porecv="${po.id}|${l.id}" title="${esc(t('po.receiveTitle', { n: fmtQty(out) }))}">${t('po.receive')}</button>` : ''}
      </div>`;
    }).join('');
    return `<tr>
      <td style="min-width:260px">${linesHtml}</td>
      <td class="muted">${esc(sup?.name || '—')}
        ${sup?.phone ? `<div style="font-size:var(--fs-200)">${telLink(sup.phone)}</div>` : ''}</td>
      <td><span class="type-chip" style="background:${PO_COLORS[po.status] || '#666'};color:#fff">${t('po.status.' + po.status)}</span></td>
      <td class="muted" style="font-size:var(--fs-200);white-space:nowrap">
        ${po.awardedAt ? `${t('po.awardedShort')} ${new Date(po.awardedAt).toLocaleDateString()}` : ''}
        ${po.invoicedAt ? ` · ${t('po.invoicedShort')} ${new Date(po.invoicedAt).toLocaleDateString()}` : ''}
        ${po.deliveredAt ? ` · ${t('po.deliveredShort')} ${new Date(po.deliveredAt).toLocaleDateString()}` : ''}</td>
      <td class="muted" style="font-size:var(--fs-200)">${esc(po.note || '')}</td>
      <td style="white-space:nowrap">
        <button class="ghost small" data-podoc="${po.id}" title="${esc(t('po.docTitle'))}">🧾</button>
        ${canManage ? `
        ${!po.invoicedAt ? `<button class="ghost small" data-poadv="${po.id}">→ ${t('po.status.invoiced')}</button>` : ''}
        ${!anyReceived ? `<button class="ghost small danger" data-podel="${po.id}">✕</button>` : ''}` : ''}</td>
    </tr>`;
  }).join('');

  box.innerHTML = `
    <p class="view-intro">${t('stock.hint')}</p>
    <div class="kpi-grid" style="margin-bottom:var(--sp-4)">
      <div class="card"><div class="kpi-label">${t('stock.kpi.refs')}</div><div class="kpi-value">${activeComponents().length}</div></div>
      <div class="card"><div class="kpi-label">${t('stock.kpi.lowStock')}</div>
        <div class="kpi-value" ${low.length ? 'style="color:var(--red-text)"' : ''}>${low.length}</div></div>
      <div class="card" id="kpi-moves" style="cursor:pointer" title="${esc(t('stock.tab.movesGo'))}">
        <div class="kpi-label">${t('stock.kpi.moves')}</div><div class="kpi-value">${state.stockMoves.length}</div></div>
    </div>
    <div class="view-tabs">
      <button class="vtab ${stockTab === 'balances' ? 'active' : ''}" data-stab="balances">📦 ${t('stock.tab.balances')}</button>
      <button class="vtab ${stockTab === 'moves' ? 'active' : ''}" data-stab="moves">📜 ${t('stock.tab.moves')}</button>
      <button class="vtab ${stockTab === 'purchase' ? 'active' : ''}" data-stab="purchase">🛒 ${t('stock.tab.purchase')}</button>
    </div>
    ${!onBalances ? '' : `
    <div class="card" style="margin-bottom:var(--sp-4)">
      <h3 style="margin:0 0 4px">${t('stock.needs.title')}</h3>
      <p class="view-intro">${t('stock.needs.hint')}</p>
      ${!needs.length
        ? `<div class="muted" style="font-size:var(--fs-400)">${t('stock.needs.none')}</div>`
        : `${needs.every(n => !n.short) ? `<div style="font-size:var(--fs-400);color:var(--green-text);margin-bottom:var(--sp-2)">${t('stock.needs.covered')}</div>` : ''}
          <div style="overflow-x:auto"><table><thead><tr>
            <th>${t('stock.name')}</th><th>${t('stock.factory')}</th>
            <th class="num">${t('stock.needs.required')}</th><th class="num">${t('stock.inFactories')}</th>
            <th class="num">${t('stock.needs.short')}</th><th></th>
          </tr></thead><tbody>
          ${needs.map(n => `<tr>
            <td>${esc(n.comp.name)} <span class="type-chip">${t('unit.' + n.comp.unit)}</span></td>
            <td class="muted">${esc(partyName(n.factoryId))}</td>
            <td class="num">${fmtQty(n.need)}</td>
            <td class="num">${fmtQty(n.have)}</td>
            <td class="num">${n.short > 0 ? `<span style="color:var(--red-text);font-weight:600">${fmtQty(n.short)}</span>` : '—'}</td>
            <td style="white-space:nowrap">${n.short > 0 && canManage
              ? `<button class="ghost small" data-need="${n.comp.id}|${esc(n.factoryId)}|${n.short}">${t('stock.needs.send', { n: fmtQty(n.short) })}</button>` : ''}
              ${/* Buying is the answer only when the WAREHOUSE cannot cover the shortfall.
                    If it can, the act is a send, and offering both would suggest the
                    warehouse is short when it is not. */''}
              ${n.short > 0 && canManage && (n.comp.warehouseQty ?? 0) < n.short
                ? `<button class="ghost small" data-pobuy="${n.comp.id}|${n.short - Math.max(0, n.comp.warehouseQty ?? 0)}" title="${esc(t('po.buyTitle', { n: fmtQty(n.short - Math.max(0, n.comp.warehouseQty ?? 0)) }))}">${t('po.buy')}</button>` : ''}</td>
          </tr>`).join('')}
          </tbody></table></div>`}
    </div>
    <div style="display:flex;gap:var(--sp-2);align-items:center;flex-wrap:wrap;margin-bottom:var(--sp-3)">
      ${canManage ? `<button class="btn primary" id="btn-add-component">${t('stock.addComponent')}</button>` : ''}
      ${canManage ? `<button class="btn" id="btn-send-batch" title="${esc(t('stock.sendBatchTip'))}">${t('stock.send')}</button>` : ''}
      ${state.role === 'admin' ? `<button class="btn" id="btn-import-stock" title="${esc(t('stock.importTitle'))}">⬆ ${t('stock.import')}</button>` : ''}
      <input type="text" id="stock-search" placeholder="${esc(t('stock.search'))}" value="${esc(stockSearch)}" style="min-width:180px">
      ${VIEW_CHIPS.map(v => {
        const n = v.count();
        // a view that would show nothing is not offered — except the minimum-stock one,
        // where zero is the answer somebody wants ("nothing is short") rather than noise
        if (!n && !v.showAtZero) return '';
        const on = stockView === v.key;
        return `<button class="btn small view-chip${on ? ' active' : ''}${!n ? ' empty' : ''}"
          data-view-chip="${v.key}">${t(v.label)} ${n}</button>`;
      }).join('')}
      ${unitsInUse.length > 1 ? `<select id="stock-unit">
        <option value="">${t('stock.allUnits')}</option>
        ${unitsInUse.map(u => `<option value="${u}" ${sel(u, stockUnit)}>${t('unit.' + u)}</option>`).join('')}
      </select>` : ''}
      <select id="stock-type" title="${esc(TYPE_HELP())}">
        <option value="">${t('stock.allComponentTypes')}</option>
        ${TYPES.map(k => `<option value="${k}" ${sel(k, stockType)}>${t('stock.type.' + k)}</option>`).join('')}
        <option value="__none" ${sel('__none', stockType)}>${t('stock.typeUnset')}</option>
      </select>
      <select id="stock-location">
        <option value="">${t('stock.allLocations')}</option>
        ${[...new Set(state.components.map(c => c.location).filter(Boolean))].sort().map(v =>
          `<option value="${esc(v)}" ${sel(v, stockLocation)}>${esc(v)}</option>`).join('')}
      </select>
      <select id="stock-factory">
        <option value="">${t('stock.holdingAny')}</option>
        ${boundFactory ? '' : `<option value="warehouse" ${sel('warehouse', stockFactory)}>${t('stock.holdingWarehouse')}</option>`}
        ${factories.map(f => `<option value="${f.id}" ${sel(f.id, stockFactory)}>${esc(f.name)}</option>`).join('')}
      </select>
      <select id="stock-sort">
        <option value="name" ${sel('name', stockSort)}>${t('stock.sort.name')}</option>
        <option value="warehouse" ${sel('warehouse', stockSort)}>${t('stock.sort.warehouse')}</option>
        <option value="factory" ${sel('factory', stockSort)}>${t('stock.sort.factory')}</option>
        <option value="consumed" ${sel('consumed', stockSort)}>${t('stock.sort.consumed')}</option>
        <option value="location" ${sel('location', stockSort)}>${t('stock.sort.location')}</option>
      </select>
      <button class="ghost small" id="stock-clear" title="${esc(t('common.clearFilters'))}">✕</button>
      <button class="ghost small" id="stock-csv" title="${esc(t('stock.csvTitle'))}">${t('stock.csv')}</button>
      <span class="muted" style="font-size:var(--fs-300)">${t('stock.compCount', { a: comps.length, b: state.components.length })}</span>
    </div>
    <div class="card" style="padding:0;margin-bottom:18px;overflow-x:auto">
      ${comps.length ? `<table><thead><tr>
        <th>${t('stock.name')}</th><th>${t('stock.type')}</th><th>${t('stock.size')}</th>
        <th>${t('stock.location')}</th><th>${t('stock.unit')}</th><th class="num">${t('stock.warehouse')}</th>
        <th>${t('stock.inFactories')}</th><th class="num">${t('stock.consumed')}</th><th></th>
      </tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="empty-state">${state.components.length ? t('stock.noMatches') : t('stock.noComponents')}</div>`}
    </div>`}
    ${stockTab !== 'moves' ? '' : `
    <div style="display:flex;gap:var(--sp-2);align-items:center;flex-wrap:wrap;margin-bottom:var(--sp-3)">
      ${stockMoveFilterId ? `<button class="btn small view-chip active" id="stock-move-clear-comp">
        ${t('stock.filterOnlyComponent', { name: esc(compName(stockMoveFilterId)) })} ✕</button>` : ''}
      <select id="stock-move-type">
        <option value="">${t('stock.allTypes')}</option>
        ${['in', 'send', 'return', 'consume', 'use', 'defect', 'loss', 'adjust', 'reverse'].map(k => `<option value="${k}" ${sel(k, moveType)}>${t('stock.move.' + k)}</option>`).join('')}
      </select>
      ${state.stockMoves.some(m => m.factoryId) ? `<select id="stock-move-factory">
        <option value="">${t('stock.allFactories')}</option>
        ${factories.map(f => `<option value="${f.id}" ${sel(f.id, moveFactory)}>${esc(f.name)}</option>`).join('')}
      </select>` : ''}
      ${state.stockMoves.some(m => m.projectId) ? `<select id="stock-move-project">
        <option value="">${t('stock.allProjects')}</option>
        ${state.projects.map(p => `<option value="${p.id}" ${sel(p.id, moveProject)}>${esc(p.name)}</option>`).join('')}
      </select>` : ''}
      <input type="text" id="stock-move-search" placeholder="${esc(t('stock.searchMoves'))}" value="${esc(moveSearch)}" style="min-width:160px">
      <label class="muted" style="font-size:var(--fs-300)">${t('stock.dateFrom')}
        <input type="date" id="stock-move-from" value="${moveFrom}"></label>
      <label class="muted" style="font-size:var(--fs-300)">${t('stock.dateTo')}
        <input type="date" id="stock-move-to" value="${moveTo}"></label>
      <button class="ghost small" id="stock-move-clear" title="${esc(t('common.clearFilters'))}">✕</button>
      <button class="ghost small" id="stock-move-csv" title="${esc(t('stock.csvTitle'))}">${t('stock.csv')}</button>
      <span class="muted" style="font-size:var(--fs-300)">${t('stock.movesCount', { a: moves.length, b: groupedMoves.length })}</span>
      ${groupedMoves.length > 50 ? `<button class="ghost small" id="stock-move-all">${moveShowAll ? t('stock.showRecent') : t('stock.showAll', { n: groupedMoves.length })}</button>` : ''}
    </div>
    <div class="card" style="padding:0;overflow-x:auto">
      ${moves.length ? `<table><thead><tr>
        <th>${t('stock.date')}</th><th>${t('stock.name')}</th><th>${t('stock.moveType')}</th><th class="num">${t('stock.qty')}</th>
        <th>${t('stock.factory')}</th><th>${t('stock.order')}</th><th>${t('stock.by')}</th><th>${t('stock.note')}</th><th></th>
      </tr></thead><tbody>${moveRows}</tbody></table>`
      : `<div class="empty-state">${state.stockMoves.length ? t('stock.noMatches') : t('stock.noMoves')}</div>`}
    </div>`}
    ${stockTab !== 'purchase' ? '' : `
    <p class="view-intro">${t('po.hint')}</p>
    ${canManage ? `<div style="margin-bottom:var(--sp-3)"><button class="btn primary" id="btn-add-po">${t('po.new')}</button></div>` : ''}
    <div class="card" style="padding:0;overflow-x:auto">
      ${pos.length ? `<table><thead><tr>
        <th>${t('po.lines')}</th><th>${t('po.supplier')}</th>
        <th>${t('po.statusCol')}</th><th>${t('po.dates')}</th><th>${t('stock.note')}</th><th></th>
      </tr></thead><tbody>${poRows}</tbody></table>`
      : `<div class="empty-state">${t('po.none')}</div>`}
    </div>`}`;

  // a full re-render would steal focus mid-typing — put the caret back where it was
  if (stockFocusId) {
    const el = $('#' + stockFocusId);
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    stockFocusId = null;
  }

  // tab switching — each tab renders only its own filters, so every handler below
  // must tolerate its element being absent
  box.querySelectorAll('[data-stab]').forEach(b => b.addEventListener('click', () => {
    stockTab = b.dataset.stab;
    renderStock();
  }));
  $('#kpi-moves')?.addEventListener('click', () => { stockTab = 'moves'; renderStock(); });
  // jump from a component to its own history, pre-filtered — the link that makes
  // splitting the tabs an improvement rather than just tidier
  box.querySelectorAll('[data-hist]').forEach(b => b.addEventListener('click', () => {
    stockMoveFilterId = b.dataset.hist;
    stockTab = 'moves';
    renderStock();
  }));

  $('#btn-add-component')?.addEventListener('click', () => openComponentModal());
  $('#btn-import-stock')?.addEventListener('click', () => openStockImportModal());
  box.querySelectorAll('[data-arch]').forEach(b => b.addEventListener('click', async () => {
    const c = state.components.find(x => x.id === b.dataset.arch);
    if (!c) return;
    const archiving = !c.archivedAt;
    // archiving something that still holds stock is allowed on purpose — a warehouse
    // does stop using a reference it still has leftovers of — but say the number out
    // loud first, so it is a decision and not a surprise
    const held = c.warehouseQty + Object.values(c.factoryQty || {}).reduce((a, n) => a + n, 0);
    if (archiving && held > 0 && !confirm(t('stock.archiveWithStock', { name: c.name, n: fmtQty(held), unit: t('unit.' + c.unit) }))) return;
    const d = await archiveComponent(c.id, archiving);
    if (d.ok) { toast(t(archiving ? 'stock.archived' : 'stock.unarchived', { name: c.name })); renderStock(); }
    else toast(d.error || t('stock.moveFailed'));
  }));
  $('#btn-add-po')?.addEventListener('click', () => openProcurementModal());
  // "Encomendar" from a shortfall: the reference and the gap are already known, so the
  // sheet opens with its first line filled in. Both numbers stay editable — a suggested
  // quantity is a starting point, not an instruction, and buying exactly to the minimum
  // is rarely what anybody actually orders.
  box.querySelectorAll('[data-pobuy]').forEach(b => b.addEventListener('click', () => {
    const [componentId, qty] = b.dataset.pobuy.split('|');
    stockTab = 'purchase';
    openProcurementModal({ componentId, qty: Number(qty) || '' });
  }));
  box.querySelectorAll('[data-poadv]').forEach(b => b.addEventListener('click', async () => {
    const d = await advanceProcurement(b.dataset.poadv);
    toast(d.ok ? t('po.advanced') : (d.error || t('stock.moveFailed')));
    renderStock();
  }));
  box.querySelectorAll('[data-podoc]').forEach(b => b.addEventListener('click', () => {
    const po = state.procurement.find(x => x.id === b.dataset.podoc);
    if (po) openPoDoc(po);
  }));
  // Receiving a line is the irreversible step — it books the warehouse entry. The
  // quantity is asked for rather than assumed, because a supplier sending 80 of 100 is
  // ordinary; the whole outstanding amount is offered as the default so the common case
  // is still one confirmation.
  box.querySelectorAll('[data-porecv]').forEach(b => b.addEventListener('click', async () => {
    const [poId, lineId] = b.dataset.porecv.split('|');
    const po = state.procurement.find(x => x.id === poId);
    const line = poLines(po).find(l => l.id === lineId);
    if (!line) return;
    const out = poOutstanding(line);
    const answer = prompt(t('po.receivePrompt', { name: compName(line.componentId), n: fmtQty(out) }), String(out));
    if (answer === null) return;
    const qty = Number(String(answer).replace(',', '.'));
    if (!(qty > 0)) { toast(t('stock.invalidQty')); return; }
    if (qty > out) { toast(t('po.receiveTooMuch', { n: fmtQty(out) })); return; }
    b.disabled = true;
    const d = await receiveProcurementLine({ id: poId, lineId, qty });
    toast(d.ok ? t('po.received', { n: fmtQty(qty), name: compName(line.componentId) }) : (d.error || t('stock.moveFailed')));
    renderStock();
  }));
  box.querySelectorAll('[data-podel]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm(t('po.deleteConfirm'))) return;
    const d = await deleteProcurement(b.dataset.podel);
    toast(d.ok ? t('po.deleted') : (d.error || t('stock.moveFailed')));
    renderStock();
  }));
  let searchTimer;
  const wireSearch = (id, apply) => $('#' + id)?.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { apply(e.target.value); stockFocusId = id; renderStock(); }, 200);
  });
  wireSearch('stock-search', (v) => { stockSearch = v; });
  wireSearch('stock-move-search', (v) => { moveSearch = v; });
  const wireSelect = (id, apply) => $('#' + id)?.addEventListener('change', (e) => { apply(e.target.value); renderStock(); });
  box.querySelectorAll('[data-view-chip]').forEach(b => b.addEventListener('click', () => {
    stockView = stockView === b.dataset.viewChip ? '' : b.dataset.viewChip; // pressing it again clears it
    renderStock();
  }));
  wireSelect('stock-unit', (v) => { stockUnit = v; });
  wireSelect('stock-type', (v) => { stockType = v; });
  wireSelect('stock-location', (v) => { stockLocation = v; });
  wireSelect('stock-factory', (v) => { stockFactory = v; });
  wireSelect('stock-sort', (v) => { stockSort = v; });
  wireSelect('stock-move-type', (v) => { moveType = v; });
  wireSelect('stock-move-factory', (v) => { moveFactory = v; });
  wireSelect('stock-move-project', (v) => { moveProject = v; });
  wireSelect('stock-move-from', (v) => { moveFrom = v; });
  wireSelect('stock-move-to', (v) => { moveTo = v; });
  $('#stock-clear')?.addEventListener('click', () => {
    stockSearch = ''; stockView = ''; stockUnit = ''; stockFactory = ''; stockSort = 'name';
    stockType = ''; stockLocation = '';
    renderStock();
  });
  $('#stock-move-clear')?.addEventListener('click', () => {
    stockMoveFilterId = ''; moveType = ''; moveFactory = ''; moveProject = '';
    moveFrom = ''; moveTo = ''; moveSearch = ''; moveShowAll = false;
    renderStock();
  });
  $('#stock-move-clear-comp')?.addEventListener('click', () => { stockMoveFilterId = ''; renderStock(); });
  $('#stock-move-all')?.addEventListener('click', () => { moveShowAll = !moveShowAll; renderStock(); });
  box.querySelectorAll('[data-move-toggle]').forEach(tr => tr.addEventListener('click', () => {
    const key = tr.dataset.moveToggle;
    if (expandedMoveGroups.has(key)) expandedMoveGroups.delete(key); else expandedMoveGroups.add(key);
    renderStock();
  }));

  // CSV exports honour whatever the filters currently show
  $('#stock-csv')?.addEventListener('click', () => downloadCsv('twinflow-stock.csv',
    [t('stock.name'), t('stock.ref'), t('stock.type'), t('stock.size'),
      t('stock.standard'), t('stock.brand'), t('stock.location'), t('stock.unit'),
      t('stock.warehouse'), t('stock.inFactories'), t('stock.consumed'), t('stock.minQty')],
    comps.map(c => [c.name, c.ref || '', c.type ? t('stock.type.' + c.type) : '', c.size || '',
      c.standard || '', c.brand || '', c.location || '', c.unit,
      c.warehouseQty, factoryTotal(c), c.consumedQty, c.minQty ?? ''])));
  $('#stock-move-csv')?.addEventListener('click', () => downloadCsv('twinflow-movements.csv',
    [t('stock.date'), t('stock.name'), t('stock.moveType'), t('stock.qty'), t('stock.factory'), t('stock.order'), t('stock.by'), t('stock.note')],
    [...groupedMoves].reverse().map(m => [m.ts, compName(m.componentId), t('stock.move.' + m.type), m.qty,
      m.factoryId ? partyName(m.factoryId) : '', m.orderCode || '', m.by || '', m.note || ''])));

  // needs card: one click opens the send modal pre-filled with the shortfall
  // the shortfall button opens the same batch sheet, with its own line filled in —
  // so covering one shortfall and covering the whole run are the same act, and you
  // can add the other lines you were going to send anyway before confirming
  box.querySelectorAll('[data-need]').forEach(b => b.addEventListener('click', () => {
    const [componentId, factoryId, qty] = b.dataset.need.split('|');
    openStockSendModal({ factoryId, lines: [{ componentId, qty: Number(qty) }] });
  }));
  // Reprinting an old document. The shipment was never stored as a record — it IS the
  // sends that share one timestamp and one destination, so it is looked up rather than
  // remembered, and therefore cannot drift from the stock it describes.
  box.querySelectorAll('[data-guia]').forEach(b => b.addEventListener('click', () => {
    const [ts, dest] = b.dataset.guia.split('|');
    // A reversed (estornado) line is a mistake being corrected, not goods that travelled.
    // The ledger strikes it through; a document rebuilt FROM the ledger has to leave it
    // out. Reprinting it at full quantity broke the one promise this document makes —
    // that it cannot disagree with the stock record — and the same omission was in the
    // server-composed email, so a wrong paper could also be posted to the destination.
    const load = state.stockMoves.filter(m => m.type === 'send' && m.ts === ts
      && (m.factoryId || '') === dest && !m.reversedBy);
    if (load.length) openGuia(load);
    else toast(t('stock.guiaAllReversed'));
  }));
  box.querySelectorAll('[data-mark]').forEach(b => b.addEventListener('click', () => openMarkModal(b.dataset.mark)));

  // ledger reversals (estorno) — the inverse movement is recorded, both stay visible
  box.querySelectorAll('[data-rev]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm(t('stock.reverseConfirm'))) return;
    const d = await stockReverse(b.dataset.rev);
    toast(d.ok ? t('stock.reversed') : (d.error || t('stock.moveFailed')));
    renderStock();
  }));

  box.querySelectorAll('[data-in]').forEach(b => b.addEventListener('click', () => openStockMoveModal(b.dataset.in, 'in')));
  box.querySelectorAll('[data-ret]').forEach(b => b.addEventListener('click', () => openStockMoveModal(b.dataset.ret, 'return')));
  $('#btn-send-batch')?.addEventListener('click', () => openStockSendModal());
  box.querySelectorAll('[data-adj]').forEach(b => b.addEventListener('click', () => openStockMoveModal(b.dataset.adj, 'adjust')));
  box.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openComponentModal(b.dataset.edit)));
  box.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const c = state.components.find(x => x.id === b.dataset.del);
    if (!confirm(t('stock.deleteConfirm', { name: c.name }))) return;
    const d = await deleteComponent(c.id);
    toast(d.ok ? t('stock.deleted') : (d.error || t('stock.moveFailed')));
    renderStock();
  }));
}

function openComponentModal(id, onCreated = null) {
  const c = id ? state.components.find(x => x.id === id) : null;
  // one optional minimum per factory, alongside the warehouse one; blank means "no
  // minimum here", which is not the same as zero and is what stops the alert
  const factories = state.parties.filter(p => p.type === 'factory');
  openModal(`
    <h2>${c ? t('stock.editComponent') : t('stock.addComponent')}</h2>
    <div class="form-row" style="display:flex;align-items:center;gap:var(--sp-2)">
      <button class="btn small" id="cp-sym-diam" title="${esc(t('stock.symbolDiameterTitle'))}">Ø</button>
      <span class="muted" style="font-size:var(--fs-200)">${t('stock.symbolHint')}</span>
    </div>
    <div class="form-row"><label>${t('stock.name')}</label><input type="text" id="cp-name" value="${esc(c?.name || '')}">
      <div id="cp-similar" style="margin-top:var(--sp-1)"></div></div>
    <div class="form-row"><label>${t('stock.ref')}</label><input type="text" id="cp-ref" value="${esc(c?.ref || '')}"></div>
    <div class="form-row form-row-split">
      <div><label>${t('stock.type')} <span class="info-dot" title="${esc(TYPE_HELP())}">i</span></label>
        <select id="cp-type">
          <option value="">${t('stock.typeNone')}</option>
          ${TYPES.map(k => `<option value="${k}" ${c?.type === k ? 'selected' : ''}>${t('stock.type.' + k)}</option>`).join('')}
        </select></div>
      <div><label>${t('stock.size')}</label><input type="text" id="cp-size" value="${esc(c?.size || '')}"></div>
    </div>
    <div class="form-row form-row-split">
      <div><label>${t('stock.standard')}</label><input type="text" id="cp-standard" value="${esc(c?.standard || '')}"></div>
      <div><label>${t('stock.brand')}</label><input type="text" id="cp-brand" value="${esc(c?.brand || '')}"></div>
    </div>
    <div class="form-row"><label>${t('stock.location')} <span class="muted">${t('stock.locationHint')}</span></label>
      <input type="text" id="cp-location" value="${esc(c?.location || '')}" list="cp-location-list">
      <datalist id="cp-location-list">${[...new Set(state.components.map(x => x.location).filter(Boolean))]
        .sort().map(l => `<option value="${esc(l)}"></option>`).join('')}</datalist></div>
    <div class="form-row"><label>${t('stock.unit')}</label>
      <select id="cp-unit">${UNITS.map(u => `<option value="${u}" ${c?.unit === u ? 'selected' : ''}>${t('unit.' + u)}</option>`).join('')}</select></div>
    <div class="form-row"><label>${t('stock.minQty')} <span class="muted">${t('stock.minQtyHint')}</span></label>
      <input type="number" id="cp-min" min="0" step="any" value="${c?.minQty ?? ''}"></div>
    ${factories.length ? `
    <div class="form-row">
      <label>${t('stock.factoryMin')} <span class="muted">${t('stock.factoryMinHint')}</span></label>
      ${factories.map(f => `
        <div class="factory-min-row">
          <span class="factory-min-name">${esc(f.name)}</span>
          <input type="number" class="factory-min" data-fid="${f.id}" min="0" step="any"
                 value="${c?.factoryMinQty?.[f.id] ?? ''}" placeholder="—">
        </div>`).join('')}
    </div>` : ''}
    <div class="modal-actions">
      <button class="btn" id="cp-cancel">${t('common.cancel')}</button>
      <button class="btn primary" id="cp-save">${t('common.save')}</button>
    </div>`);
  $('#cp-cancel').addEventListener('click', closeModal);

  // Ø is not on a Portuguese keyboard, and it belongs in half the descriptors here
  // (VARÃO Ø20, TUBO Ø200). One button rather than one per field: it types into whichever
  // text box you were last in, at the caret, so it behaves like a key would.
  //
  // The mousedown/preventDefault is the whole trick — without it the button takes focus
  // on press, the input's selectionStart is gone by the time the click fires, and the
  // character lands at position 0 of a field that no longer knows where the caret was.
  const SYMBOL_FIELDS = ['cp-name', 'cp-ref', 'cp-size', 'cp-standard', 'cp-brand', 'cp-location'];
  const isSymbolField = (el) => !!el && SYMBOL_FIELDS.includes(el.id);
  // Read document.activeElement rather than listen for 'focus'. A focus LISTENER does not
  // fire while the document itself is unfocused — activeElement still updates — so the
  // event version silently typed into the wrong box whenever the window had been clicked
  // away from. There is no reason to track a state that the DOM already holds.
  let lastField = $('#cp-name');
  const remember = () => { if (isSymbolField(document.activeElement)) lastField = document.activeElement; };
  const symBtn = $('#cp-sym-diam');
  symBtn.addEventListener('touchstart', remember, { passive: true });
  symBtn.addEventListener('mousedown', (e) => { remember(); e.preventDefault(); }); // keep the caret where it is
  symBtn.addEventListener('click', () => {
    remember(); // the preventDefault above means focus never actually left the input
    const el = isSymbolField(document.activeElement) ? document.activeElement : (lastField || $('#cp-name'));
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, start) + 'Ø' + el.value.slice(end);
    el.focus();
    el.setSelectionRange(start + 1, start + 1);
    // the duplicate check listens for input — a symbol typed this way must count as typing
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // "Does this already exist?" answered while typing, not after saving.
  //
  // The server refuses only an EXACT collision of nome+medida+localização, because in
  // this warehouse four groups share a name and differ by medida, and one reference
  // legitimately sits on two pallets — a stricter rule would reject real data. That
  // leaves the near-miss, which no rule can judge and a person recognises instantly:
  // so show what already exists and let them look.
  const plain = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '');
  const similarBox = $('#cp-similar');
  const showSimilar = () => {
    const typed = plain($('#cp-name').value);
    if (typed.length < 3) { similarBox.innerHTML = ''; return; }
    const hits = state.components
      .filter(x => x.id !== c?.id)
      .filter(x => { const n = plain(x.name); return n.includes(typed) || typed.includes(n); })
      .slice(0, 6);
    const ref = $('#cp-ref').value.trim();
    const sameRef = ref ? state.components.filter(x => x.id !== c?.id && x.ref === ref) : [];
    similarBox.innerHTML = [
      hits.length ? `<div class="muted" style="font-size:var(--fs-200)">${t('stock.similarFound', { n: hits.length })}
        ${hits.map(x => `<div>· <a href="#" data-similar="${x.id}">${esc(x.name)}</a>
          ${[x.size, x.location].filter(Boolean).map(esc).join(' · ')} — ${fmtQty(x.warehouseQty)} ${t('unit.' + x.unit)}</div>`).join('')}</div>` : '',
      // a repeated reference is legitimate here (one screw, two pallets), so it warns
      // rather than blocks — but it is worth a second look before saving
      sameRef.length ? `<div style="font-size:var(--fs-200);color:var(--amber-text,var(--muted))">${t('stock.sameRefWarn', { name: esc(sameRef[0].name) })}</div>` : '',
    ].join('');
    similarBox.querySelectorAll('[data-similar]').forEach(a => a.addEventListener('click', (e) => {
      e.preventDefault();
      closeModal();
      openComponentModal(a.dataset.similar);
    }));
  };
  let simTimer;
  const wireSimilar = (sel) => $(sel)?.addEventListener('input', () => {
    clearTimeout(simTimer); simTimer = setTimeout(showSimilar, 200);
  });
  wireSimilar('#cp-name'); wireSimilar('#cp-ref');
  if (!c) showSimilar(); // creating: check from the first keystroke

  $('#cp-save').addEventListener('click', async () => {
    const name = $('#cp-name').value.trim();
    if (!name) { toast(t('common.nameRequired')); return; }
    const minRaw = $('#cp-min').value.trim();
    const factoryMinQty = {};
    document.querySelectorAll('.factory-min').forEach((el) => {
      const v = el.value.trim();
      if (v !== '') factoryMinQty[el.dataset.fid] = Number(v); // blank = no minimum, key omitted
    });
    const d = await upsertComponent({
      id: c?.id || uid('cmp'),
      name, ref: $('#cp-ref').value.trim(), unit: $('#cp-unit').value,
      type: $('#cp-type').value,
      size: $('#cp-size').value.trim(),
      standard: $('#cp-standard').value.trim(),
      brand: $('#cp-brand').value.trim(),
      location: $('#cp-location').value.trim(),
      minQty: minRaw === '' ? null : Number(minRaw),
      factoryMinQty,
    });
    // onCreated exists when this form was opened from somewhere that needs the new
    // reference back — the purchase order sheet. It hands over instead of returning to
    // the stock table, so the order being written is not lost behind this modal.
    if (d.ok && onCreated && !c) { toast(t('stock.saved')); onCreated(d.component); }
    else if (d.ok) { toast(t('stock.saved')); closeModal(); renderStock(); }
    // a refused duplicate is not an error to shrug at — it means what you were about
    // to create is already in the warehouse, so offer to go straight to it
    else if (d.duplicateOf && confirm(t('stock.duplicateConfirm', { name: d.duplicateOf.name }))) {
      closeModal();
      openComponentModal(d.duplicateOf.id);
    } else toast(d.error || t('stock.moveFailed'));
  });
}

// Importing the warehouse's own inventory sheet. Administrator only — the server
// enforces that too; this only decides whether the button is drawn.
//
// The upload happens twice on purpose. The first pass asks the server what the
// file WOULD do and writes nothing; what comes back is shown in full before
// anything is committed. A spreadsheet is somebody else's document, and the only
// honest way to import one is to say what you understood of it first.
function openStockImportModal() {
  let chosen = null;
  const post = async (file, commit) => {
    const r = await fetch('api/stock/import' + (commit ? '?commit=1' : ''), { method: 'POST', body: file });
    return r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }));
  };

  const shell = (inner) => `
    <h2>${t('stock.import')}</h2>
    <p class="view-intro">${t('stock.importHint')}</p>
    <div id="imp-body">${inner}</div>`;

  const pick = `
    <div class="form-row">
      <label>${t('stock.importFile')}</label>
      <input type="file" id="imp-file" accept=".xlsx">
    </div>
    <div class="modal-actions"><button class="btn" id="imp-cancel">${t('common.cancel')}</button></div>`;

  openModal(shell(pick));
  $('#imp-cancel').addEventListener('click', closeModal);

  $('#imp-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    chosen = file;
    $('#imp-body').innerHTML = `<p class="muted">${t('stock.importReading')}</p>`;
    const d = await post(file, false);
    if (!d.ok) {
      $('#imp-body').innerHTML = `<p style="color:var(--red-text)">${esc(d.error || '')}</p>
        <div class="modal-actions"><button class="btn" id="imp-cancel">${t('common.close')}</button></div>`;
      $('#imp-cancel').addEventListener('click', closeModal);
      return;
    }
    const { summary, items, skipped } = d.plan;
    // rows the sheet could not answer for are listed, never summarised away: a
    // count of "3 problems" is exactly the thing a person scrolls past
    const flagged = items.filter(i => i.notes.length);
    const preview = items.slice(0, 200);
    $('#imp-body').innerHTML = `
      <div class="kpi-grid" style="margin-bottom:var(--sp-3)">
        <div class="card"><div class="kpi-label">${t('stock.importNew')}</div><div class="kpi-value">${summary.create}</div></div>
        <div class="card"><div class="kpi-label">${t('stock.importExisting')}</div><div class="kpi-value">${summary.update}</div></div>
        <div class="card"><div class="kpi-label">${t('stock.importUnits')}</div><div class="kpi-value">${fmtQty(summary.openingQty)}</div></div>
      </div>
      ${summary.update ? `<p class="muted" style="font-size:var(--fs-300)">${t('stock.importKeepsBalances')}</p>` : ''}
      ${flagged.length ? `<p style="font-size:var(--fs-300)">⚠️ ${t('stock.importNoQty', { n: flagged.length })}
        <span class="muted">${flagged.map(i => esc(i.name)).join(', ')}</span></p>` : ''}
      ${skipped.length ? `<p style="font-size:var(--fs-300);color:var(--red-text)">${t('stock.importSkipped', { n: skipped.length })}
        <span class="muted">${skipped.map(s => t('stock.importRow', { n: s.sheetRow })).join(', ')}</span></p>` : ''}
      <div class="card" style="padding:0;max-height:320px;overflow:auto;margin-bottom:var(--sp-3)">
        <table><thead><tr>
          <th>${t('stock.name')}</th><th>${t('stock.size')}</th><th>${t('stock.location')}</th>
          <th class="num">${t('stock.qty')}</th><th>${t('stock.unit')}</th>
        </tr></thead><tbody>
        ${preview.map(i => `<tr>
          <td>${esc(i.name)}</td>
          <td class="muted">${esc(i.size || '')}</td>
          <td class="muted" style="white-space:nowrap">${esc(i.location || '')}</td>
          <td class="num">${i.action === 'update' ? '—' : fmtQty(i.qty)}</td>
          <td class="muted">${t('unit.' + i.unit)}</td>
        </tr>`).join('')}
        </tbody></table>
      </div>
      ${items.length > preview.length ? `<p class="muted" style="font-size:var(--fs-300)">${t('stock.importMore', { n: items.length - preview.length })}</p>` : ''}
      <div class="modal-actions">
        <button class="btn" id="imp-cancel">${t('common.cancel')}</button>
        <button class="btn primary" id="imp-go">${t('stock.importConfirm', { n: summary.create + summary.update })}</button>
      </div>`;
    $('#imp-cancel').addEventListener('click', closeModal);
    $('#imp-go').addEventListener('click', async () => {
      const btn = $('#imp-go');
      btn.disabled = true;
      btn.textContent = t('stock.importWorking');
      const done = await post(chosen, true);
      if (!done.ok) { toast(done.error || t('stock.moveFailed')); btn.disabled = false; return; }
      await refreshFromServer();
      closeModal();
      toast(t('stock.importDone', { a: done.applied.created, b: done.applied.updated }));
      renderStock();
    });
  });
}

// one modal for the three manual movements: entry (in), send to factory, adjust.
// preset ({ factoryId, qty }) pre-fills it — used by the needs card's shortfall button
// new purchase order: component + supplier (supplier or fabrication company) + qty
// One order, many references — an order sheet rather than a single-reference form.
//
// `draft` survives the re-renders: a line added, a reference created mid-order or a
// quantity typed must not be lost because the list below it redrew. It is held outside
// the render function for that reason, and reset on every open.
// preset ({ componentId, qty }) pre-fills the first line.
let poDraft = null;
function openProcurementModal(preset = null) {
  const suppliers = state.parties.filter(p => ['supplier', 'factory'].includes(p.type));
  if (!suppliers.length) { toast(t('po.noSuppliers')); return; }
  poDraft = {
    supplierId: suppliers[0].id,
    note: '',
    lines: [{ componentId: preset?.componentId || '', qty: preset?.qty ?? '' }],
  };
  renderProcurementModal();
}

function renderProcurementModal() {
  const suppliers = state.parties.filter(p => ['supplier', 'factory'].includes(p.type));
  const comps = activeComponents();
  const d = poDraft;
  // a reference already on the sheet is not offered again — the server refuses a
  // repeated line, so the list must not invite one
  const taken = (exceptIdx) => new Set(d.lines.filter((_, i) => i !== exceptIdx).map(l => l.componentId).filter(Boolean));
  const lineHtml = (l, i) => {
    const used = taken(i);
    const options = comps.filter(c => !used.has(c.id) || c.id === l.componentId);
    return `<div class="po-line" style="display:flex;gap:var(--sp-2);align-items:center;margin-bottom:var(--sp-2)">
      <select class="po-line-comp" data-i="${i}" style="flex:1;min-width:0">
        <option value="">${t('po.pickComponent')}</option>
        ${options.map(c => `<option value="${c.id}" ${c.id === l.componentId ? 'selected' : ''}>${esc(c.name)}${c.ref ? ' · ' + esc(c.ref) : ''}</option>`).join('')}
      </select>
      <input type="number" class="po-line-qty" data-i="${i}" min="0" step="any" style="width:90px"
             value="${l.qty === '' ? '' : esc(String(l.qty))}" placeholder="${t('stock.qty')}">
      <span class="muted" style="font-size:var(--fs-200);width:34px">${l.componentId ? t('unit.' + (comps.find(c => c.id === l.componentId)?.unit || 'un')) : ''}</span>
      <button class="ghost small danger po-line-del" data-i="${i}" title="${esc(t('po.removeLine'))}" ${d.lines.length === 1 ? 'disabled' : ''}>✕</button>
    </div>`;
  };
  openModal(`
    <h2>🛒 ${t('po.new')}</h2>
    <div class="form-row"><label>${t('po.supplier')}</label>
      <select id="po-supplier">${suppliers.map(s => `<option value="${s.id}" ${s.id === d.supplierId ? 'selected' : ''}>${esc(s.name)} (${t('partners.type.' + s.type)})</option>`).join('')}</select></div>
    <div class="form-row">
      <label>${t('po.lines')} <span class="muted">${t('po.linesHint')}</span></label>
      <div id="po-lines">${d.lines.map(lineHtml).join('')}</div>
      <div style="display:flex;gap:var(--sp-2);margin-top:var(--sp-1)">
        <button class="btn small" id="po-add-line">+ ${t('po.addLine')}</button>
        <button class="btn small" id="po-new-comp">+ ${t('po.newComponent')}</button>
      </div>
    </div>
    <div class="form-row"><label>${t('stock.note')}</label>
      <input type="text" id="po-note" value="${esc(d.note)}" placeholder="${esc(t('po.notePlaceholder'))}"></div>
    <div class="modal-actions">
      <button class="btn" id="po-cancel">${t('common.cancel')}</button>
      <button class="btn primary" id="po-save">${t('po.create')}</button>
    </div>`);

  // every edit writes straight into the draft, so a re-render never loses a keystroke
  const readBack = () => {
    d.supplierId = $('#po-supplier').value;
    d.note = $('#po-note').value;
    document.querySelectorAll('.po-line-comp').forEach(s => { d.lines[+s.dataset.i].componentId = s.value; });
    document.querySelectorAll('.po-line-qty').forEach(inp => { d.lines[+inp.dataset.i].qty = inp.value === '' ? '' : Number(inp.value); });
  };
  document.querySelectorAll('.po-line-comp').forEach(s => s.addEventListener('change', () => { readBack(); renderProcurementModal(); }));
  document.querySelectorAll('.po-line-qty').forEach(inp => inp.addEventListener('input', readBack));
  document.querySelectorAll('.po-line-del').forEach(b => b.addEventListener('click', () => {
    readBack();
    d.lines.splice(+b.dataset.i, 1);
    renderProcurementModal();
  }));
  $('#po-add-line').addEventListener('click', () => { readBack(); d.lines.push({ componentId: '', qty: '' }); renderProcurementModal(); });
  // A reference that does not exist yet is created through the SAME full form as
  // anywhere else — with the live "already exists?" list and the server's exact-duplicate
  // refusal. A quick two-field create here would be the fastest way to end up with the
  // same screw under two references and a balance split between them.
  $('#po-new-comp').addEventListener('click', () => {
    readBack();
    openComponentModal(null, (created) => {
      const empty = d.lines.findIndex(l => !l.componentId);
      if (empty >= 0) d.lines[empty].componentId = created.id;
      else d.lines.push({ componentId: created.id, qty: '' });
      renderProcurementModal();
    });
  });
  $('#po-cancel').addEventListener('click', () => { poDraft = null; closeModal(); });
  $('#po-save').addEventListener('click', async () => {
    readBack();
    const lines = d.lines.filter(l => l.componentId);
    if (!lines.length) { toast(t('po.needALine')); return; }
    if (lines.some(l => !(Number(l.qty) > 0))) { toast(t('stock.invalidQty')); return; }
    const btn = $('#po-save');
    btn.disabled = true;
    const r = await createProcurement({ supplierId: d.supplierId, note: d.note.trim(), lines });
    if (!r.ok) { toast(r.error || t('stock.moveFailed')); btn.disabled = false; return; }
    toast(t('po.created'));
    poDraft = null;
    closeModal();
    renderStock();
  });
}

// The purchase order on paper. Rebuilt from the record every time it is opened, so it
// cannot drift from what the system holds. The PDF is generated here (js/pdf.js) rather
// than handed to the browser's print dialog: a file can be attached to an email or
// filed, and on a phone "print" is a dead end where "download" opens the share sheet.
//
// It shows what is still OWED as its own column, because the reason to produce a
// part-received order is to chase what has not arrived.
function openPoDoc(po) {
  const sup = state.parties.find(p => p.id === po.supplierId);
  const us = state.parties.find(p => p.type === 'admin');
  const lines = poLines(po);
  const comp = (id) => state.components.find(c => c.id === id);
  const who = (p) => p ? `<strong>${esc(p.name)}</strong><br>${p.nif ? 'NIF ' + esc(p.nif) + '<br>' : ''}${esc(p.address || '').replace(/\n/g, '<br>')}` : '—';
  openModal(`
    <h2>🛒 ${t('po.docTitle')}</h2>
    <div id="po-print">
      <div class="form-row-split" style="margin-bottom:var(--sp-3)">
        <div><div class="kpi-label">${t('po.docFrom')}</div><div style="font-size:var(--fs-300)">${who(us)}</div></div>
        <div><div class="kpi-label">${t('po.supplier')}</div><div style="font-size:var(--fs-300)">${who(sup)}</div></div>
      </div>
      <div class="form-row-split" style="margin-bottom:var(--sp-3)">
        <div><div class="kpi-label">${t('po.docRef')}</div><div style="font-size:var(--fs-300)">${esc(po.id)}</div></div>
        <div><div class="kpi-label">${t('po.statusCol')}</div>
          <div style="font-size:var(--fs-300)">${t('po.status.' + po.status)}
            ${po.awardedAt ? ` · ${t('po.awardedShort')} ${new Date(po.awardedAt).toLocaleDateString()}` : ''}</div></div>
      </div>
      <table><thead><tr>
        <th>${t('stock.name')}</th><th>${t('stock.guiaRef')}</th>
        <th class="num">${t('po.ordered')}</th><th class="num">${t('po.receivedCol')}</th>
        <th class="num">${t('po.outstanding')}</th><th>${t('stock.unit')}</th>
      </tr></thead><tbody>
        ${lines.map(l => { const c = comp(l.componentId); const out = poOutstanding(l); return `<tr>
          <td>${esc(c?.name || '—')}</td><td class="muted">${esc(c?.ref || '')}</td>
          <td class="num">${fmtQty(l.qty)}</td>
          <td class="num">${l.qtyReceived ? fmtQty(l.qtyReceived) : '—'}</td>
          <td class="num" ${out ? 'style="font-weight:600"' : ''}>${out ? fmtQty(out) : '—'}</td>
          <td class="muted">${c ? t('unit.' + c.unit) : ''}</td></tr>`; }).join('')}
      </tbody></table>
      ${po.note ? `<p class="muted" style="font-size:var(--fs-300);margin-top:var(--sp-2)">${esc(po.note)}</p>` : ''}
      <p class="muted" style="font-size:var(--fs-200);margin-top:var(--sp-3)">
        ${t('po.docIssued', { who: esc(po.by || ''), when: po.awardedAt ? new Date(po.awardedAt).toLocaleString() : '' })}</p>
    </div>
    <div class="modal-actions">
      <button class="btn" id="po-doc-close">${t('common.close')}</button>
      <button class="btn primary" id="po-doc-pdf">${t('doc.pdf')}</button>
    </div>`);
  $('#po-doc-close').addEventListener('click', closeModal);
  $('#po-doc-pdf').addEventListener('click', async () => {
    const { buildPdf, downloadPdf } = await import('./pdf.js');
    const idLine = (p) => p
      ? [p.name, p.nif ? 'NIF ' + p.nif : '', ...(p.address || '').split('\n'),
        [p.postalCode, p.city].filter(Boolean).join(' ')]
      : ['—'];
    downloadPdf(buildPdf({
      title: t('po.docTitle'),
      blocks: [
        { label: t('po.docFrom'), lines: idLine(us) },
        { label: t('po.supplier'), lines: idLine(sup) },
      ],
      meta: [
        [t('po.docRef'), po.id],
        [t('po.statusCol'), `${t('po.status.' + po.status)}${po.awardedAt ? ` · ${t('po.awardedShort')} ${new Date(po.awardedAt).toLocaleDateString()}` : ''}`],
      ],
      table: {
        columns: [
          { label: t('stock.name'), width: 34 },
          { label: t('stock.guiaRef'), width: 16 },
          { label: t('po.ordered'), width: 13, align: 'right' },
          { label: t('po.receivedCol'), width: 13, align: 'right' },
          { label: t('po.outstanding'), width: 13, align: 'right' },
          { label: t('stock.unit'), width: 11 },
        ],
        rows: lines.map(l => {
          const c = comp(l.componentId);
          const out = poOutstanding(l);
          return [c?.name || '—', c?.ref || '', fmtQty(l.qty),
            l.qtyReceived ? fmtQty(l.qtyReceived) : '—', out ? fmtQty(out) : '—',
            c ? t('unit.' + c.unit) : ''];
        }),
      },
      notes: [po.note || ''],
      footer: t('po.docIssued', { who: po.by || '', when: po.awardedAt ? new Date(po.awardedAt).toLocaleString() : '' }),
    }), `encomenda-${po.id}.pdf`);
  });
}

// `datetime-local` wants local wall-clock, not UTC — toISOString() would offset it by
// the timezone and pre-fill the wrong hour.
function localNowForInput() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

// The paper that travels with the load.
//
// It is NOT a guia de transporte in the legal sense: nothing here is reported to the tax
// authority, and a document that looks official without being it is worse than no
// document — somebody would carry it believing they were covered. So it says what it is,
// in red, at the top — and that line goes into the PDF too, because the paper is what
// reaches the driver, not the screen it was made on.
//
// It is rebuilt from the ledger rather than stored: a shipment IS the movements sharing
// one timestamp and one destination, so the document can be reprinted later and can never
// disagree with the stock record.
function openGuia(moves) {
  if (!moves?.length) return;
  const m0 = moves[0];
  const sender = state.parties.find(p => p.type === 'admin');
  const dest = state.parties.find(p => p.id === m0.factoryId);
  // What the AT requires, checked here rather than at submission time: the sender's
  // address must be complete in all four parts, because AddressDetail, City, PostalCode
  // and Country are each mandatory. Saying so on the document is how it gets fixed before
  // it matters, instead of surfacing as a rejected communication later.
  const missing = [];
  const addressGaps = (p, required) => {
    if (!p) return;
    if (!p.nif) missing.push(`NIF — ${p.name}`);
    if (!p.address) missing.push(`${t('partners.address')} — ${p.name}`);
    if (required && !p.postalCode) missing.push(`${t('partners.postalCode')} — ${p.name}`);
    if (required && !p.city) missing.push(`${t('partners.city')} — ${p.name}`);
  };
  if (!sender) missing.push(t('stock.guiaNoSender'));
  else addressGaps(sender, true); // the sender is also the loading place — all four parts
  addressGaps(dest, false);

  const who = (p) => p ? `<strong>${esc(p.name)}</strong><br>${p.nif ? 'NIF ' + esc(p.nif) + '<br>' : ''}`
    + `${esc(p.address || '').replace(/\n/g, '<br>')}`
    + `${p.postalCode || p.city ? `<br>${esc([p.postalCode, p.city].filter(Boolean).join(' '))}` : ''}` : '—';
  const comp = (id) => state.components.find(c => c.id === id);
  openModal(`
    <h2>${t('stock.guiaTitle')}</h2>
    ${m0.atDocCodeId ? `
    <p style="color:var(--green-text);font-weight:600;font-size:var(--fs-300);border:1px solid var(--green-text);padding:var(--sp-2);border-radius:var(--r-sm)">
      ${t('stock.at.communicatedBanner', { doc: esc(m0.documentNumber || ''), code: esc(m0.atDocCodeId) })}
      ${m0.atProduction ? '' : `<br><span style="font-weight:400">⚠ ${t('stock.at.testEnvironment')}</span>`}</p>`
    : `
    <p style="color:var(--red-text);font-weight:600;font-size:var(--fs-300);border:1px solid var(--red-text);padding:var(--sp-2);border-radius:var(--r-sm)">
      ${t('stock.guiaNotOfficial')}
      ${m0.atStatus === 'error' ? `<br><span style="font-weight:400">${t('stock.at.lastError', { error: esc(m0.atMessage || '') })}</span>` : ''}</p>`}
    ${missing.length ? `<p class="muted" style="font-size:var(--fs-300)">⚠️ ${t('stock.guiaMissing', { what: missing.map(esc).join('; ') })}</p>` : ''}
    <div id="guia-print">
      <div class="form-row-split" style="margin-bottom:var(--sp-3)">
        <div><div class="kpi-label">${t('stock.guiaFrom')}</div><div style="font-size:var(--fs-300)">${who(sender)}</div></div>
        <div><div class="kpi-label">${t('stock.guiaTo')}</div><div style="font-size:var(--fs-300)">${who(dest)}</div></div>
      </div>
      <div class="form-row-split" style="margin-bottom:var(--sp-3)">
        <div><div class="kpi-label">${t('stock.departAt')}</div>
          <div style="font-size:var(--fs-300)">${m0.departAt ? new Date(m0.departAt).toLocaleString() : new Date(m0.ts).toLocaleString()}</div></div>
        <div><div class="kpi-label">${t('stock.plate')}</div>
          <div style="font-size:var(--fs-300)">${esc(m0.plate || '—')}</div></div>
      </div>
      <div class="kpi-label">${t('stock.guiaGoods')}</div>
      <table><thead><tr><th>${t('stock.name')}</th><th>${t('stock.guiaRef')}</th>
        <th class="num">${t('stock.qty')}</th><th>${t('stock.unit')}</th></tr></thead><tbody>
        ${moves.map(m => { const c = comp(m.componentId); return `<tr>
          <td>${esc(c?.name || '—')}</td><td class="muted">${esc(c?.ref || '')}</td>
          <td class="num">${fmtQty(m.qty)}</td><td class="muted">${c ? t('unit.' + c.unit) : ''}</td></tr>`; }).join('')}
      </tbody></table>
      ${m0.note ? `<p class="muted" style="font-size:var(--fs-300);margin-top:var(--sp-2)">${esc(m0.note)}</p>` : ''}
      <p class="muted" style="font-size:var(--fs-200);margin-top:var(--sp-3)">
        ${t('stock.guiaIssued', { who: esc(currentUser?.name || currentUser?.username || ''), when: new Date(m0.ts).toLocaleString() })}</p>
    </div>
    <div class="modal-actions">
      <button class="btn" id="guia-close">${t('common.close')}</button>
      ${!m0.atDocCodeId && currentUser?.canCommunicateAt && CREATOR_ROLES.includes(state.role)
        ? `<button class="btn" id="guia-at-btn">${t('stock.at.send')}</button>` : ''}
      ${dest?.email ? `<button class="btn" id="guia-mail-btn" title="${esc(t('stock.guiaMailTitle', { to: dest.email }))}">${t('stock.guiaMail')}</button>` : ''}
      <button class="btn primary" id="guia-pdf-btn">${t('doc.pdf')}</button>
    </div>`);
  $('#guia-close').addEventListener('click', closeModal);
  // Communicating a load that went out without it, or retrying one the AT refused. The
  // number is not taken again on a retry — the same document is being communicated.
  $('#guia-at-btn')?.addEventListener('click', async (e) => {
    const type = prompt(t('stock.at.askType'), m0.movementType || 'GT');
    if (type === null) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = t('stock.at.sending');
    const d = await atCommunicateShipment({ ts: m0.ts, factoryId: m0.factoryId || '', movementType: String(type).toUpperCase().trim() });
    if (d.ok) {
      toast(t('stock.at.done', { code: d.atDocCodeId, doc: d.documentNumber }));
      closeModal();
      renderStock();
      openGuia(d.moves);
    } else {
      toast(d.error || t('stock.moveFailed'));
      btn.disabled = false;
      btn.textContent = t('stock.at.send');
    }
  });
  $('#guia-pdf-btn').addEventListener('click', async () => {
    const { buildPdf, downloadPdf } = await import('./pdf.js');
    const idLine = (p) => p
      ? [p.name, p.nif ? 'NIF ' + p.nif : '', ...(p.address || '').split('\n'),
        [p.postalCode, p.city].filter(Boolean).join(' ')]
      : ['—'];
    downloadPdf(buildPdf({
      title: t('stock.guiaTitle'),
      // the disclaimer travels with the document, not just with the screen — it is the
      // whole reason this is safe to hand to a driver
      warning: t('stock.guiaNotOfficial'),
      blocks: [
        { label: t('stock.guiaFrom'), lines: idLine(sender) },
        { label: t('stock.guiaTo'), lines: idLine(dest) },
      ],
      meta: [
        [t('stock.departAt'), m0.departAt ? new Date(m0.departAt).toLocaleString() : new Date(m0.ts).toLocaleString()],
        [t('stock.plate'), m0.plate || '—'],
      ],
      table: {
        columns: [
          { label: t('stock.name'), width: 46 },
          { label: t('stock.guiaRef'), width: 20 },
          { label: t('stock.qty'), width: 17, align: 'right' },
          { label: t('stock.unit'), width: 17 },
        ],
        rows: moves.map(m => {
          const c = comp(m.componentId);
          return [c?.name || '—', c?.ref || '', fmtQty(m.qty), c ? t('unit.' + c.unit) : ''];
        }),
      },
      notes: [m0.note || '', missing.length ? `⚠ ${t('stock.guiaMissing', { what: missing.join('; ') })}` : ''],
      footer: t('stock.guiaIssued', { who: currentUser?.name || currentUser?.username || '', when: new Date(m0.ts).toLocaleString() }),
    }), `guia-${new Date(m0.ts).toISOString().slice(0, 10)}-${(dest?.name || 'destino').replace(/[^\w-]+/g, '_')}.pdf`);
  });
  // nothing leaves without this click: no checkbox, no send-on-confirm
  $('#guia-mail-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = t('stock.guiaMailSending');
    const d = await sendGuiaEmail({ ts: m0.ts, factoryId: m0.factoryId || '' });
    if (d.ok) toast(t(d.test ? 'stock.guiaMailTest' : 'stock.guiaMailSent', { to: d.to }));
    else { toast(d.error || t('stock.moveFailed')); btn.disabled = false; btn.textContent = t('stock.guiaMail'); }
  });
}

// Sending to a factory, as many references as the pallet actually carries.
//
// This replaced a per-row Enviar button. A delivery to the factory is one act with
// twenty lines on it, and recording it twenty times invites the two failures that
// matter: forgetting a line, and getting halfway when one line turns out to exceed
// the balance. The server applies the whole batch or none of it; this only has to
// make the quantities easy to type and the ceiling visible while typing.
function openStockSendModal(preset = {}) {
  // stock leaves the warehouse for a factory that will build with it, or for a site
  // that will fix it — both hold a balance until it is used
  const factories = state.parties.filter(p => ['factory', 'site'].includes(p.type));
  if (!factories.length) { toast(t('stock.noFactories')); return; }
  const qty = new Map(); // componentId -> raw input value, kept across re-renders
  for (const l of preset.lines || []) qty.set(l.componentId, String(l.qty));
  let search = '';

  openModal(`
    <h2>${t('stock.sendBatchTitle')}</h2>
    <div class="form-row"><label>${t('stock.factory')}</label>
      <select id="sb-factory">${factories.map(f =>
        `<option value="${f.id}" ${f.id === preset.factoryId ? 'selected' : ''}>${esc(f.name)} — ${t('partners.type.' + f.type)}</option>`).join('')}</select></div>
    <div class="form-row form-row-split">
      <div><label>${t('stock.plate')} <span class="muted">${t('stock.plateHint')}</span></label>
        <input type="text" id="sb-plate" placeholder="00-AA-00"></div>
      <div><label>${t('stock.departAt')}</label>
        <input type="datetime-local" id="sb-depart" value="${localNowForInput()}"></div>
    </div>
    <div class="form-row"><label>${t('stock.note')}</label>
      <input type="text" id="sb-note" placeholder="${esc(t('stock.sendBatchNote'))}"></div>
    ${currentUser?.canCommunicateAt ? `
    <div class="form-row" style="border:1px solid var(--line);border-radius:var(--r-sm);padding:var(--sp-2)">
      <label style="display:flex;align-items:center;gap:var(--sp-2);margin:0">
        <input type="checkbox" id="sb-at" style="width:auto"> ${t('stock.at.communicate')}</label>
      <div id="sb-at-type" class="hidden" style="margin-top:var(--sp-2)">
        <label>${t('stock.at.docType')}</label>
        <select id="sb-at-doctype">
          ${[['GT', 'stock.at.type.GT'], ['GA', 'stock.at.type.GA'], ['GR', 'stock.at.type.GR'],
            ['GC', 'stock.at.type.GC'], ['GD', 'stock.at.type.GD']].map(([c, k]) =>
            `<option value="${c}">${c} — ${t(k)}</option>`).join('')}
        </select>
        <div class="muted" style="font-size:var(--fs-200);margin-top:var(--sp-1)">${t('stock.at.docTypeHint')}</div>
      </div>
    </div>` : ''}
    <div class="form-row"><label>${t('stock.search')}</label>
      <input type="text" id="sb-search" placeholder="${esc(t('stock.search'))}"></div>
    <div class="card" style="padding:0;max-height:300px;overflow:auto;margin-bottom:var(--sp-3)">
      <table><tbody id="sb-rows"></tbody></table>
    </div>
    <div id="sb-summary" class="muted" style="font-size:var(--fs-300);margin-bottom:var(--sp-2)"></div>
    <div class="modal-actions">
      <button class="btn" id="sb-cancel">${t('common.cancel')}</button>
      <button class="btn primary" id="sb-go">${t('stock.send')}</button>
    </div>`);

  const rowsBox = $('#sb-rows');
  const summary = $('#sb-summary');
  const goBtn = $('#sb-go');
  // the document type only matters once communicating is actually asked for
  $('#sb-at')?.addEventListener('change', (e) => {
    $('#sb-at-type').classList.toggle('hidden', !e.target.checked);
  });

  const chosen = () => [...qty.entries()]
    .map(([id, v]) => ({ id, n: Number(v), comp: state.components.find(c => c.id === id) }))
    .filter(x => x.comp && Number.isFinite(x.n) && x.n > 0);

  const refreshSummary = () => {
    const picked = chosen();
    // over-asking is caught here as well as on the server, because finding out at
    // the end which of twenty lines was impossible is the worst moment to find out
    const over = picked.filter(x => x.n > x.comp.warehouseQty);
    summary.innerHTML = over.length
      ? `<span style="color:var(--red-text)">${t('stock.sendBatchOver', { n: over.length, names: over.map(x => esc(x.comp.name)).join(', ') })}</span>`
      : t('stock.sendBatchSummary', { lines: picked.length });
    goBtn.disabled = !picked.length || over.length > 0;
    goBtn.textContent = picked.length ? t('stock.sendBatchGo', { n: picked.length }) : t('stock.send');
  };

  const renderRows = () => {
    const q = search.trim().toLowerCase();
    const list = activeComponents()
      .filter(c => !q || [c.name, c.ref, c.type, c.size, c.brand, c.location].filter(Boolean).join(' ').toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    rowsBox.innerHTML = list.map(c => {
      const v = qty.get(c.id) || '';
      const over = Number(v) > c.warehouseQty;
      return `<tr>
        <td>${esc(c.name)}${[c.size, c.location].filter(Boolean).length
          ? `<div class="muted" style="font-size:var(--fs-200)">${[c.size, c.location].filter(Boolean).map(esc).join(' · ')}</div>` : ''}</td>
        <td class="num muted" style="white-space:nowrap">${fmtQty(c.warehouseQty)} ${t('unit.' + c.unit)}</td>
        <td style="width:110px"><input type="number" class="sb-qty" data-cid="${c.id}" min="0" step="any"
          value="${esc(v)}" style="width:100%${over ? ';border-color:var(--red-text)' : ''}"></td>
      </tr>`;
    }).join('') || `<tr><td class="muted" style="padding:var(--sp-3)">${t('stock.noMatches')}</td></tr>`;
    rowsBox.querySelectorAll('.sb-qty').forEach(inp => inp.addEventListener('input', () => {
      const v = inp.value.trim();
      if (v === '') qty.delete(inp.dataset.cid); else qty.set(inp.dataset.cid, v);
      const comp = state.components.find(c => c.id === inp.dataset.cid);
      inp.style.borderColor = Number(v) > comp.warehouseQty ? 'var(--red-text)' : '';
      refreshSummary();
    }));
    refreshSummary();
  };
  renderRows();

  let searchTimer;
  $('#sb-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { search = e.target.value; renderRows(); }, 200);
  });
  $('#sb-cancel').addEventListener('click', closeModal);
  goBtn.addEventListener('click', async () => {
    const picked = chosen();
    if (!picked.length) return;
    goBtn.disabled = true;
    const departRaw = $('#sb-depart').value;
    const d = await stockSendBatch({
      factoryId: $('#sb-factory').value,
      note: $('#sb-note').value.trim(),
      plate: $('#sb-plate').value.trim(),
      departAt: departRaw ? new Date(departRaw).toISOString() : '',
      lines: picked.map(x => ({ componentId: x.id, qty: x.n })),
      communicateAt: !!$('#sb-at')?.checked,
      movementType: $('#sb-at-doctype')?.value || 'GT',
    });
    if (d.ok) {
      const dest = $('#sb-factory').value;
      closeModal();
      toast(t('stock.sendBatchDone', { n: d.moves.length, factory: partyName(dest) }));
      // The send succeeded whatever the AT answered — say the two things separately, or a
      // refused communication reads as a load that never left.
      if (d.at?.ok) toast(t('stock.at.done', { code: d.at.atDocCodeId, doc: d.at.documentNumber }));
      else if (d.at) toast(t('stock.at.failedButSent', { error: d.at.error }));
      renderStock();
      // the moment the load is recorded is the moment somebody needs the paper
      openGuia(d.moves);
    } else { toast(d.error || t('stock.moveFailed')); goBtn.disabled = false; }
  });
}

function openStockMoveModal(componentId, kind, preset = {}) {
  const c = state.components.find(x => x.id === componentId);
  const factories = state.parties.filter(p => ['factory', 'site'].includes(p.type)
    && (!myFactoryId() || p.id === myFactoryId()));
  if (kind === 'send' && !factories.length) { toast(t('stock.noFactories')); return; }
  // a return can only come from somewhere that is actually holding some
  const holding = factories.filter(f => (c.factoryQty?.[f.id] || 0) > 0);
  if (kind === 'return' && !holding.length) { toast(t('stock.returnNothing')); return; }
  const title = { in: 'stock.entryTitle', send: 'stock.sendTitle', adjust: 'stock.adjustTitle', return: 'stock.returnTitleFull' }[kind];
  openModal(`
    <h2>${t(title, { name: esc(c.name) })}</h2>
    <p class="view-intro">${t('stock.balanceNow', { n: fmtQty(c.warehouseQty), unit: t('unit.' + c.unit) })}</p>
    ${kind === 'send' ? `<div class="form-row"><label>${t('stock.factory')}</label>
      <select id="sm-factory">${factories.map(f => `<option value="${f.id}" ${f.id === preset.factoryId ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></div>` : ''}
    ${kind === 'return' ? `<div class="form-row"><label>${t('stock.returnFrom')}</label>
      <select id="sm-origin">${holding.map(f => `<option value="${f.id}">${esc(f.name)} — ${fmtQty(c.factoryQty[f.id])} ${t('unit.' + c.unit)}</option>`).join('')}</select></div>` : ''}
    ${kind === 'adjust' ? `<div class="form-row"><label>${t('stock.adjustTarget')}</label>
      <select id="sm-target"><option value="">${t('stock.warehouse')}</option>
        ${factories.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select></div>` : ''}
    <div class="form-row"><label>${t('stock.qty')} (${t('unit.' + c.unit)})${kind === 'adjust' ? ` <span class="muted">${t('stock.adjustHint')}</span>` : ''}</label>
      <input type="number" id="sm-qty" step="any" ${kind === 'adjust' ? '' : 'min="0"'} ${preset.qty ? `value="${preset.qty}"` : ''}></div>
    <div class="form-row"><label>${t('stock.note')}</label><input type="text" id="sm-note"></div>
    <div class="modal-actions">
      <button class="btn" id="sm-cancel">${t('common.cancel')}</button>
      <button class="btn primary" id="sm-save">${t('common.save')}</button>
    </div>`);
  $('#sm-qty').focus();
  $('#sm-cancel').addEventListener('click', closeModal);
  $('#sm-save').addEventListener('click', async () => {
    const qty = Number($('#sm-qty').value);
    if (!Number.isFinite(qty) || (kind !== 'adjust' && qty <= 0) || (kind === 'adjust' && qty === 0)) {
      toast(t('stock.invalidQty')); return;
    }
    const d = await stockMove({
      componentId: c.id, type: kind, qty,
      factoryId: kind === 'send' ? $('#sm-factory').value
        : kind === 'return' ? $('#sm-origin').value
        : (kind === 'adjust' ? $('#sm-target').value || null : null),
      note: $('#sm-note').value.trim(),
    });
    if (d.ok) { toast(t('stock.moveRecorded')); closeModal(); renderStock(); }
    else toast(d.error || t('stock.moveFailed'));
  });
}

// factory-floor mark: record components at a factory as consumed / defective / lost
// WITHOUT needing an element recipe. Available to the factory role and directors.
function openMarkModal(componentId) {
  const c = state.components.find(x => x.id === componentId);
  // marks are recorded where the stock is — a factory floor or a site
  const factories = state.parties.filter(p => ['factory', 'site'].includes(p.type)
    && (!myFactoryId() || p.id === myFactoryId()));
  if (!factories.length) { toast(t('stock.noFactories')); return; }
  // default to the place that actually holds stock of this component
  const withStock = Object.entries(c.factoryQty || {}).find(([, q]) => q > 0)?.[0];
  openModal(`
    <h2>${t('stock.markTitle')} — ${esc(c.name)}</h2>
    <div class="form-row"><label>${t('stock.markType')}</label>
      <select id="mk-type">
        <option value="use">${t('stock.move.use')}</option>
        <option value="defect">${t('stock.move.defect')}</option>
        <option value="loss">${t('stock.move.loss')}</option>
      </select></div>
    <div class="form-row"><label>${t('stock.factory')}</label>
      <select id="mk-factory">${factories.map(f => `<option value="${f.id}" ${f.id === withStock ? 'selected' : ''}>${esc(f.name)} (${fmtQty(c.factoryQty?.[f.id] || 0)})</option>`).join('')}</select></div>
    <div class="form-row"><label>${t('stock.qty')} (${t('unit.' + c.unit)})</label>
      <input type="number" id="mk-qty" min="0" step="any"></div>
    <div class="form-row"><label>${t('stock.note')}</label><input type="text" id="mk-note"></div>
    <div class="modal-actions">
      <button class="btn" id="mk-cancel">${t('common.cancel')}</button>
      <button class="btn primary" id="mk-save">${t('common.save')}</button>
    </div>`);
  $('#mk-qty').focus();
  $('#mk-cancel').addEventListener('click', closeModal);
  $('#mk-save').addEventListener('click', async () => {
    const qty = Number($('#mk-qty').value);
    if (!Number.isFinite(qty) || qty <= 0) { toast(t('stock.invalidQty')); return; }
    const d = await stockMove({
      componentId: c.id, type: $('#mk-type').value, qty,
      factoryId: $('#mk-factory').value, note: $('#mk-note').value.trim(),
    });
    if (d.ok) { toast(t('stock.marked')); closeModal(); renderStock(); }
    else toast(d.error || t('stock.moveFailed'));
  });
}

// shared [component | qty-per-element] line editor for the recipe modals.
// recipeLinesHtml() goes inside the openModal template; wireRecipeLines() is called
// after the modal renders and returns collect() — the DOM is the source of truth.
function recipeLinesHtml() {
  return `
    <div style="display:flex;gap:var(--sp-2);margin-bottom:6px;font-size:var(--fs-200)" class="muted">
      <span style="flex:1">${t('recipe.component')}</span><span style="width:90px">${t('recipe.qtyPer')}</span><span style="width:30px"></span>
    </div>
    <div id="rc-rows"></div>
    <button class="ghost small" id="rc-add">${t('recipe.addRow')}</button>`;
}

function wireRecipeLines(initialRows) {
  let rows = initialRows.map(r => ({ ...r })); // editable copy
  const rowHtml = (r, i) => `
    <div style="display:flex;gap:var(--sp-2);margin-bottom:var(--sp-2);align-items:center" data-row="${i}">
      <select class="rc-comp" style="flex:1">
        ${// archived references are not offered for NEW lines, but one already written into
          // this recipe stays in its own list — dropping it would silently repoint the line
          // at whatever sorted first, changing a recipe nobody asked to change
          [...activeComponents(), ...state.components.filter(c => c.archivedAt && c.id === r.componentId)]
            .map(c => `<option value="${c.id}" ${c.id === r.componentId ? 'selected' : ''}>${esc(c.name)}${c.archivedAt ? ' · ' + t('stock.archivedChip') : ''} (${t('unit.' + c.unit)})</option>`).join('')}
      </select>
      <input type="number" class="rc-qty" min="0" step="any" value="${r.qtyPer ?? 1}"
             style="width:90px" title="${esc(t('recipe.qtyPer'))}">
      <button class="ghost small danger rc-del" title="${esc(t('common.delete'))}">✕</button>
    </div>`;
  const collect = () => [...document.querySelectorAll('#rc-rows [data-row]')].map(div => ({
    componentId: div.querySelector('.rc-comp').value,
    qtyPer: Number(div.querySelector('.rc-qty').value) || 0,
  }));
  const redraw = () => {
    $('#rc-rows').innerHTML = rows.length ? rows.map(rowHtml).join('')
      : `<div class="muted" style="font-size:var(--fs-300);margin-bottom:var(--sp-2)">${t('recipe.none')}</div>`;
  };
  redraw();
  $('#rc-add').addEventListener('click', () => {
    rows = collect();
    rows.push({ componentId: state.components[0].id, qtyPer: 1 });
    redraw();
  });
  $('#rc-rows').addEventListener('click', (e) => {
    if (!e.target.classList.contains('rc-del')) return;
    rows = collect();
    rows.splice(Number(e.target.closest('[data-row]').dataset.row), 1);
    redraw();
  });
  return collect;
}

// recipe (BOM) editor: which components — and how many per element — one element
// of this QTO group consumes when the factory produces it
function openRecipeModal(g) {
  const project = activeProject();
  if (!project) return;
  if (!state.components.length) { toast(t('recipe.noComponents')); return; }
  openModal(`
    <h2>${t('recipe.title', { name: esc(g.name) })}</h2>
    <p class="view-intro">${t('recipe.hint', { n: g.count })}</p>
    ${recipeLinesHtml()}
    <div class="modal-actions">
      <button class="btn" id="rc-cancel">${t('common.cancel')}</button>
      <button class="btn primary" id="rc-save">${t('common.save')}</button>
    </div>`);
  const collect = wireRecipeLines(getRecipe(project, g.key));
  $('#rc-cancel').addEventListener('click', closeModal);
  $('#rc-save').addEventListener('click', () => {
    const clean = collect().filter(r => r.componentId && r.qtyPer > 0);
    setRecipe(project, g.key, clean); // empty list removes the recipe
    toast(t('recipe.saved'));
    closeModal();
    qtoWin = [-1, -1]; updateQtoWindow(); // refresh the 🧩 badges in the visible rows
  });
}

// bulk recipe: apply the same component lines to MANY typologies at once —
// e.g. filter "slab piso 1" (or pick the storey) and give every match 4 brackets
function openBulkRecipeModal() {
  const project = activeProject();
  if (!project) return;
  if (!state.components.length) { toast(t('recipe.noComponents')); return; }
  const selKeys = [...qtoSelection.keys()];
  const filtKeys = qtoRows.map(g => g.key);
  if (!selKeys.length && !filtKeys.length) { toast(t('recipe.bulkNone')); return; }
  openModal(`
    <h2>${t('recipe.bulkTitle')}</h2>
    <p class="view-intro">${t('recipe.bulkHint')}</p>
    <div class="form-row"><label>${t('recipe.bulkApplyTo')}</label>
      <select id="rb-target">
        ${selKeys.length ? `<option value="sel">${t('recipe.bulkTargetSelected', { n: selKeys.length })}</option>` : ''}
        <option value="filt" ${selKeys.length ? '' : 'selected'}>${t('recipe.bulkTargetFiltered', { n: filtKeys.length })}</option>
      </select></div>
    ${recipeLinesHtml()}
    <label class="filter-item" style="margin-top:var(--sp-3);display:block">
      <input type="checkbox" id="rb-replace"> ${t('recipe.bulkReplace')}</label>
    <div class="modal-actions">
      <button class="btn" id="rb-cancel">${t('common.cancel')}</button>
      <button class="btn primary" id="rb-save">${t('recipe.bulkApply')}</button>
    </div>`);
  const collect = wireRecipeLines([{ componentId: state.components[0].id, qtyPer: 1 }]);
  $('#rb-cancel').addEventListener('click', closeModal);
  $('#rb-save').addEventListener('click', () => {
    const keys = $('#rb-target').value === 'sel' ? selKeys : filtKeys;
    const lines = collect().filter(r => r.componentId && r.qtyPer > 0);
    const replace = $('#rb-replace').checked;
    if (!keys.length) { toast(t('recipe.bulkNone')); return; }
    // merge with zero lines would be a silent no-op; replace with zero lines CLEARS
    if (!lines.length && !replace) { toast(t('recipe.bulkNoLines')); return; }
    applyRecipeBulk(project, keys, lines, replace);
    toast(t('recipe.bulkApplied', { n: keys.length }));
    closeModal();
    qtoWin = [-1, -1]; updateQtoWindow(); // refresh the 🧩 badges
  });
}

// ---------------------------------------------------------------- configuration (export / import / reset)

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'twinflow-data.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast(t('config.exportedToast'));
}

// Running version, in the sidebar footer. The build stamp is what actually
// answers "did my deploy take?" — cached JS has bitten us before, so this reads
// the server's view of the files it is serving, not a constant compiled in here.
let appVersionText = null;
async function showAppVersion() {
  const el = $('#app-version');
  try {
    const v = await (await fetch('api/version')).json();
    appVersionText = v.build ? `v${v.version} · build ${v.build}` : `v${v.version}`;
  } catch {
    appVersionText = null; // server unreachable — say nothing rather than guess
  }
  if (el && appVersionText) {
    el.textContent = appVersionText;
    el.title = t('footer.versionTitle');
  }
}

async function openConfigModal() {
  const isAdmin = currentUser.role === 'admin';
  const canExport = CREATOR_ROLES.includes(state.role);
  const item = (id, icon, label, hint, danger = false) => `
    <button class="config-item ${danger ? 'danger' : ''}" id="${id}">
      <span class="config-item-icon">${icon}</span>
      <span class="config-item-text">
        <span class="config-item-label">${label}</span>
        ${hint ? `<span class="config-item-hint">${hint}</span>` : ''}
      </span>
      <span class="config-item-chev">›</span>
    </button>`;
  openModal(`
    <h2>${t('config.title')}</h2>
    <div class="config-section-title">${t('config.sectionManage')}</div>
    ${item('cfg-partners', '👥', t('nav.partners'), t('config.partnersHint'))}
    ${isAdmin ? item('cfg-users', '👤', t('nav.users'), t('config.usersHint')) : ''}
    <div class="config-section-title">${t('config.sectionData')}</div>
    ${canExport ? item('cfg-export', '⬇', t('config.exportData'), t('config.exportHint')) : ''}
    ${isAdmin ? `
      ${item('cfg-import', '⬆', t('config.importData'), t('config.importHint'))}
      ${item('cfg-reset', '✕', t('config.resetData'), t('config.resetHint'), true)}`
      : `<div class="muted config-hint" style="padding:4px 2px 0">${t('config.adminRestricted')}</div>`}
    <div class="config-section-title">${t('config.sectionSystem')}</div>
    <div class="muted config-hint" id="cfg-email" style="padding:2px 2px 6px">${t('config.emailChecking')}</div>
    ${appVersionText ? `<div class="muted config-hint" style="padding:0 2px 6px">${t('config.version')} ${esc(appVersionText)}</div>` : ''}
    ${item('cfg-logout', '↩', t('config.signout'), '', true)}
    <div class="modal-actions"><button class="btn" id="cfg-close">${t('common.close')}</button></div>`);

  $('#cfg-close').addEventListener('click', closeModal);
  $('#cfg-partners').addEventListener('click', () => { closeModal(); showView('parties'); });
  $('#cfg-users')?.addEventListener('click', () => { closeModal(); showView('users'); });
  $('#cfg-export')?.addEventListener('click', exportData);
  $('#cfg-import')?.addEventListener('click', () => $('#import-input').click());
  $('#cfg-logout').addEventListener('click', async () => {
    await fetch('api/logout', { method: 'POST' }).catch(() => {});
    // the remembered account goes with the session: signing out has to mean signed out,
    // including the copy this device keeps in order to open with no signal
    try {
      localStorage.removeItem('twinflow.signedIn');
      localStorage.removeItem(USER_CACHE_KEY);
    } catch { /* private mode */ }
    location.href = 'login.html';
  });
  $('#cfg-reset')?.addEventListener('click', async () => {
    if (!confirm(t('config.resetConfirm'))) return;
    await resetAll();
    await clearIfcFiles().catch(() => {});
    location.reload();
  });
  try {
    const st = await (await fetch('api/email-status')).json();
    const el = $('#cfg-email');
    if (el) el.textContent = st.configured
      ? t('config.emailConfigured', { test: st.test ? t('config.emailTestSuffix') : '', from: st.from || '—' })
      : t('config.emailNotConfigured');
  } catch { /* server offline */ }
}

$('#btn-config').addEventListener('click', openConfigModal);
$('#import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    // accept exports from the old single-project schema too
    if (data.project && !data.projects) {
      const prj = { id: uid('prj'), ...data.project };
      data.projects = [prj];
      (data.orders || []).forEach(o => { if (!o.projectId) o.projectId = prj.id; });
      delete data.project;
    }
    const ok = await importFullState(data); // server becomes the new truth for all devices
    if (!ok) { toast(t('config.importFailed')); return; }
    renderProjectSelect();
    closeModal();
    showView('dashboard');
    toast(t('config.dataImported'));
  } catch { toast(t('config.invalidFile')); }
  e.target.value = '';
});

// ---------------------------------------------------------------- static text (index.html) translation

// translates the parts of the app shell that aren't rebuilt by renderX() functions —
// nav labels/titles, topbar labels, and other markup baked directly into index.html
function applyStaticTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
}

// ---------------------------------------------------------------- init

(async () => {
  if (!await ensureAuth()) return; // redirects to login.html when not signed in

  await setLang(currentUser.lang || 'en'); // the dictionary is fetched here, before any rendering
  applyStaticTranslations();

  // An account on the seeded password gets one screen and nothing else. The server
  // refuses every other route while the flag is set, so booting the rest of the app
  // would only paint an empty shell over a wall of 403s. The dictionary is loaded above
  // this line so the demand is legible in the account's own language.
  if (currentUser.mustChangePassword) { forcePasswordChange(); return; }

  $('#view-title').textContent = t('view.dashboard'); // initial title isn't covered by data-i18n
  state.role = currentUser.role; // the role comes from the account now
  save();
  renderUserChip();

  // the viewer is NOT created here any more: three.js and web-ifc are fetched the
  // first time the Model view is opened (see loadViewerStack)
  // model management (import/replace IFC) is director-level — hide the entry point
  if (!CREATOR_ROLES.includes(currentUser.role)) $('#btn-open-ifc').classList.add('hidden');
  // the assembly team has no stock role (its state arrives empty) — hide the view
  if (currentUser.role === 'site') document.querySelector('.nav-btn[data-view="stock"]')?.classList.add('hidden');
  // Activity is the decision-log console — administrator only
  if (!isAdmin(currentUser.role)) document.querySelector('.nav-btn[data-view="activity"]')?.classList.add('hidden');
  renderProjectSelect();
  // restore the view the user was on — but only if this account can still reach it
  // (roles differ per account, and admin-only views must never be restored blindly)
  let startView = 'dashboard';
  try {
    // ?view=scan comes from the home-screen shortcuts declared in manifest.json — a long
    // press on the installed icon goes straight to the scanner, which is the one thing
    // somebody opens the app for while standing next to the element. It wins over the
    // remembered view, and is subject to the same check: an account that cannot reach
    // the view does not get sent there.
    const asked = new URLSearchParams(location.search).get('view');
    const saved = asked || localStorage.getItem(VIEW_PREF_KEY);
    const btn = saved && document.querySelector(`.nav-btn[data-view="${saved}"]`);
    if (btn && !btn.classList.contains('hidden')) startView = saved;
  } catch { /* private mode — dashboard it is */ }
  showView(startView); // instant paint from the offline cache…
  // …and say so, for as long as it is true. Showing yesterday's numbers as though they
  // were today's is the one thing an offline mode must not do quietly, and a toast that
  // fades after four seconds does exactly that.
  setOfflineNotice(offlineSession);
  // The radio coming back is not the same as the server answering — a phone can rejoin a
  // site wifi that has no route out. So the notice only comes down once something has
  // actually reached the API, and it goes back up the moment the connection drops.
  window.addEventListener('offline', () => setOfflineNotice(true));
  window.addEventListener('online', async () => {
    try {
      const r = await fetch('api/rev');
      if (!r.ok) return;
      setOfflineNotice(false);
      offlineSession = false;
      rerenderCurrentView(); // paint the truth we were just handed
    } catch { /* still nothing there — leave the notice up */ }
  });

  // …then load the shared truth from the server and re-render; afterwards a background
  // poll picks up changes made on other devices and refreshes the current view
  const rerenderCurrentView = () => {
    renderProjectSelect();
    invalidateActivityCache(); // the data just changed under us
    const view = document.querySelector('.view.active').id.replace('view-', '');
    if (view === 'dashboard') renderDashboard();
    if (view === 'model') renderQto(); // the merged screen's table may show new remote data
    if (view === 'orders') renderOrders();
    if (view === 'planning') renderTaktPlanning();
    if (view === 'stock') renderStock();
    if (view === 'assembly') renderAssembly();
    if (view === 'activity') renderActivity();
    if (view === 'parties') renderParties();
    // an open order modal holds closures over pre-sync objects — re-open it with
    // the fresh ones (sub-modals like inspections don't set kind and are left alone)
    const kind = $('#modal-body').dataset.kind;
    if (kind?.startsWith('order:') && !$('#modal-backdrop').classList.contains('hidden')) {
      openOrderModal(kind.slice('order:'.length));
    }
  };
  // someone else changed the same request first: our write was refused, so say so
  // plainly and show the fresh version — silently losing the action is not an option
  setOrderConflictHandler((orderId) => {
    toast(t('toast.orderConflict'));
    rerenderCurrentView();
    const open = $('#modal-body').dataset.kind === 'order:' + orderId
      && !$('#modal-backdrop').classList.contains('hidden');
    if (open) openOrderModal(orderId);
  });
  // the server refused a write on a shared record (a role gate, an invalid value):
  // the store has already reloaded the real state — say what happened and repaint
  setPushRejectedHandler((reason) => {
    toast(t('toast.pushRejected', { reason }));
    rerenderCurrentView();
  });
  // Something reached the server, so the notice is no longer telling the truth and comes
  // down — whatever it was that got through, and without waiting for the device to change
  // network. No re-render here: every path that reports this either applied the new state
  // already (and re-rendered through onRemoteChange) or found nothing had changed.
  setServerReachedHandler(() => {
    offlineSession = false;
    // Read the bar rather than the flag: it goes up by two routes — this device losing
    // its connection, and the boot fallback above — and only one of them sets the flag.
    const bar = $('#offline-bar');
    if (bar && !bar.classList.contains('hidden')) setOfflineNotice(false);
  });

  showAppVersion();

  initState(() => { rerenderCurrentView(); toast(t('toast.updatedRemote')); }, hasFullAccess(currentUser.role))
    .then(async () => {
      rerenderCurrentView();
      // records made offline (e.g. QR scans without coverage) go out now — creations
      // before updates, because an update to a request the server has never seen fails
      const created = await flushPendingNewOrders().catch(() => 0);
      const n = await flushPendingOrders().catch(() => 0);
      if (created) toast(t('toast.syncedNewOrders', { n: created }));
      if (n) toast(t('toast.syncedOffline', { n }));
    });
  // the saved IFC is restored lazily, the first time the Model view is opened

  // expose for testing / automation
  // the two stats helpers are read through V so the test surface never forces the
  // 3D stack to load; they return undefined until the Model view has been opened
  window.TwinFlow = {
    state, loadIfcFromBuffer, showView,
    getVisibilityStats: (...a) => V?.getVisibilityStats(...a),
    getColorStats: (...a) => V?.getColorStats(...a),
  };
})();
