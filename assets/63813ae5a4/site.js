// Jing's Vault: unlock with an access key, then browse the files this key may see.
// Everything comes from the vault API, which checks Lock, Hide and the key's grants on every request.
import { CONFIG } from './config.js';
import * as C from './crypto.js';
import { h, icon, btn, toast } from './ui.js';
import { NotesBrowser } from './browser.js';
import { buildTree, findNode, setDirIds } from './tree.js';
import { parseId } from './ids.js';

const SESSION = 'vault-session'; // { token, expires }
const OLD_KEY = 'notes-session-key'; // the access key itself, remembered by the previous version of the site
const EXPIRED = `This key is invalid, expired or has been revoked. Ask ${CONFIG.ownerName} for a new one.`;
const rootEl = document.getElementById('root');

// The API this page talks to. Only a copy opened on this Mac (127.0.0.1) may point elsewhere, for testing.
const API = (() => {
  if (location.hostname === '127.0.0.1') {
    try {
      const o = localStorage.getItem('vault-api-override');
      if (o) return o;
    } catch { /* storage blocked */ }
  }
  return CONFIG.apiBase;
})();

// Code version, taken from the versioned folder this script was loaded from (none when run from source).
const VERSION = import.meta.url.match(/\/assets\/([0-9a-f]{10})\//)?.[1] || null;
const CHECK_EVERY = 20_000;

// Drop the ?v=… left by a version reload, so the address stays clean.
if (new URLSearchParams(location.search).has('v')) history.replaceState(null, '', location.pathname + location.hash);

/** Load the latest website code. Tries once per version, so a slow cache cannot cause a reload loop. */
function reloadToLatest(version) {
  try {
    if (sessionStorage.getItem('vault-reloaded') === version) return false;
    sessionStorage.setItem('vault-reloaded', version);
  } catch {
    return false;
  }
  // A new address skips the browser's cached copy of the page.
  location.replace(`${location.pathname}?v=${encodeURIComponent(version)}`);
  return true;
}

/** The newest published code version, or null when it cannot be told (running from source, offline…). */
async function latestVersion() {
  if (!VERSION) return null;
  try {
    const r = await fetch(`assets/versions.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const list = await r.json();
    return Array.isArray(list) && list[0] !== VERSION ? list[0] : null;
  } catch {
    return null;
  }
}

// The session is remembered on the device until the key expires or the user logs out.
const store = {
  get() {
    try { return JSON.parse(localStorage.getItem(SESSION) || 'null'); } catch { return null; }
  },
  save(session) {
    try { localStorage.setItem(SESSION, JSON.stringify(session)); } catch { /* private mode */ }
  },
  oldKey() {
    try { return localStorage.getItem(OLD_KEY); } catch { return null; }
  },
  clear() {
    try {
      localStorage.removeItem(SESSION);
      localStorage.removeItem(OLD_KEY);
      sessionStorage.removeItem(OLD_KEY); // left over from the old one-time keys
    } catch { /* private mode */ }
  },
};

const S = { session: null, rev: null, expires: null, root: null, contact: '', lockedDirs: new Set(), noDownloadDirs: new Set() };

// The admin console used to live on this origin; make sure no old GitHub token stays behind.
try {
  localStorage.removeItem('notes-admin-token');
  sessionStorage.removeItem('notes-admin-token');
} catch { /* storage blocked */ }
let browser = null;
let watchTimer = null;
let checking = false;
let lastCheck = 0;

const shortDate = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

// ---------- API ----------

class SignedOut extends Error {}

async function call(path, { method = 'GET', body, raw = false } = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      cache: 'no-store',
      headers: {
        ...(S.session ? { Authorization: `Bearer ${S.session.token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Cannot reach the vault. Check your connection and try again.');
  }
  if (res.status === 401 && path !== '/api/session') throw new SignedOut();
  if (!res.ok) {
    let data = {};
    try { data = await res.json(); } catch { /* not JSON */ }
    const e = new Error(data.message || `The vault answered ${res.status}.`);
    e.status = res.status;
    e.code = data.error;
    throw e;
  }
  return raw ? new Uint8Array(await res.arrayBuffer()) : res.json();
}

/** Trade an access key for a session. Returns false when the key does not work. */
async function signIn(key) {
  try {
    S.session = await call('/api/session', { method: 'POST', body: { key } });
    return true;
  } catch (e) {
    if (e.status === 401) return false;
    throw e;
  }
}

/** Load what this key can see, and work out which folders get a padlock or a no-download mark. */
async function loadTree() {
  const t = await call('/api/tree');
  Object.assign(S, { rev: t.rev, expires: t.expires, contact: t.contact || '' });
  S.root = buildTree(t.files, Object.keys(t.dirs));
  setDirIds(S.root, t.dirs);
  // A folder gets a padlock when it sits under a lock this key cannot open, or when none of the files
  // inside can be opened; a no-download mark when it has files to open but none of them can be downloaded.
  const closed = t.locks.filter((l) => !l.o).map((l) => l.p);
  S.lockedDirs = new Set();
  S.noDownloadDirs = new Set();
  const markDirs = (node) => {
    let any = false;
    let open = false;
    let save = false;
    const take = (a, o, s) => { any = any || a; open = open || o; save = save || s; };
    for (const f of node.files.values()) take(true, canOpen(f), canDownload(f));
    for (const d of node.dirs.values()) take(...markDirs(d));
    if (node.path && (closed.some((c) => node.path === c || node.path.startsWith(`${c}/`)) || (any && !open))) S.lockedDirs.add(node.path);
    else if (node.path && any && !save) S.noDownloadDirs.add(node.path);
    return [any, open, save];
  };
  markDirs(S.root);
}

const canOpen = (f) => !!f.o;
const canDownload = (f) => canOpen(f) && !f.nd;

function lockOut(message = EXPIRED) {
  Object.assign(S, { session: null, rev: null, expires: null, root: null, lockedDirs: new Set(), noDownloadDirs: new Set() });
  store.clear();
  clearInterval(watchTimer);
  browser = null;
  showLogin(message);
}

/** Run an API step; a revoked or expired key logs the page out. */
async function guarded(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SignedOut) {
      lockOut();
      throw new Error('Your access has ended.');
    }
    throw e;
  }
}

// ---------- Live updates ----------

/** Notice changes while the page is open: refresh the file list, log out a revoked key, offer new code. */
async function checkForUpdates() {
  if (!S.session || checking) return;
  if (S.expires && Date.parse(S.expires) <= Date.now()) return lockOut();
  if (document.visibilityState !== 'visible') return;
  checking = true;
  lastCheck = Date.now();
  try {
    const { rev } = await call('/api/version');
    if (rev !== S.rev) {
      await loadTree();
      browser?.setTree(S.root);
      toast('Vault updated');
    }
    const newer = await latestVersion();
    if (newer) showUpdateBanner(newer);
  } catch (e) {
    if (e instanceof SignedOut) lockOut();
    // Otherwise offline for a moment: try again next time.
  } finally {
    checking = false;
  }
}

function startWatching() {
  clearInterval(watchTimer);
  watchTimer = setInterval(checkForUpdates, CHECK_EVERY);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastCheck > CHECK_EVERY / 2) checkForUpdates();
});

function showUpdateBanner(version) {
  if (document.querySelector('.update-banner')) return;
  const reload = () => {
    try { sessionStorage.removeItem('vault-reloaded'); } catch { /* storage blocked */ }
    if (version) reloadToLatest(version);
    else location.reload();
  };
  const banner = h('div', { class: 'update-banner', role: 'status' },
    icon('refresh', 16),
    h('span', { text: 'A new version of the vault is available.' }),
    btn('Refresh', reload, { kind: 'primary' }));
  document.querySelector('.topbar')?.after(banner);
}

/** Read a file. If the vault changed since the list was loaded, reload the list and say why it failed. */
async function readFile(file) {
  if (!canOpen(file)) throw new Error('This file is locked.');
  return guarded(async () => {
    try {
      return await call(`/api/files/${file.i}`, { raw: true });
    } catch (e) {
      if (e.status !== 403 && e.status !== 404) throw e;
      await loadTree();
      browser?.setTree(S.root);
      const fresh = findNode(S.root, file.p);
      if (fresh?.kind === 'file' && canOpen(fresh.file) && fresh.file.i !== file.i) return call(`/api/files/${fresh.file.i}`, { raw: true });
      throw new Error(e.status === 403 ? 'This file is locked.' : 'This file is no longer available.');
    }
  });
}

/** Full-text search, done by the API among the files this key can open. */
async function searchContent(query) {
  if (parseId(query)) return [];
  const { hits } = await guarded(() => call(`/api/search?q=${encodeURIComponent(query)}`));
  return hits;
}

// ---------- Screens ----------

function showLogin(message = '') {
  document.title = "Jing's Vault";
  const input = h('input', {
    class: 'field big', autocomplete: 'off',
    autocapitalize: 'characters', spellcheck: 'false', 'aria-label': 'Access key',
  });
  const error = h('p', { class: 'form-error', role: 'alert', text: message });
  const submit = btn('Unlock', null, { kind: 'primary', iconName: 'lock', type: 'submit' });
  const form = h('form', {
    class: 'auth-card',
    onsubmit: async (e) => {
      e.preventDefault();
      if (!C.isPlausibleKey(C.normaliseKey(input.value))) {
        error.textContent = 'That does not look like a key. Keys look like XXXX-XXXX-XXXX-XXXX.';
        return;
      }
      submit.disabled = true;
      submit.lastChild.textContent = 'Checking…';
      error.textContent = '';
      try {
        if (await signIn(input.value)) {
          store.save(S.session);
          await loadTree();
          showApp();
          return;
        }
        error.textContent = EXPIRED;
      } catch (err) {
        error.textContent = err.message;
      }
      submit.disabled = false;
      submit.lastChild.textContent = 'Unlock';
    },
  },
  h('span', { class: 'brand-mark' }, icon('vault', 28)),
  h('h1', { text: "Jing's Vault" }),
  h('p', { class: 'muted', text: `Enter the access key ${CONFIG.ownerName} sent you.` }),
  input,
  submit,
  error,
  );
  rootEl.replaceChildren(h('main', { class: 'auth' }, form));
  input.focus();
}

function showApp() {
  document.title = "Jing's Vault";
  const search = h('input', {
    class: 'search-input', type: 'search', placeholder: 'Search names, contents or IDs…', 'aria-label': 'Search the vault',
    autocomplete: 'off', spellcheck: 'false',
  });
  let lastQuery = '';
  const runSearch = debounce(() => {
    if (search.value.trim() === lastQuery) return;
    lastQuery = search.value.trim();
    browser.search(lastQuery);
  }, 250);
  search.addEventListener('input', runSearch);
  search.addEventListener('keyup', runSearch);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      search.value = '';
      lastQuery = '';
      browser.search('');
    }
  });

  const until = h('span', { text: `Until ${shortDate(S.expires)}` });
  const top = h('header', { class: 'topbar' },
    h('div', { class: 'brand' }, h('span', { class: 'brand-mark sm' }, icon('vault', 19)), h('span', { class: 'brand-name', text: "Jing's Vault" })),
    h('label', { class: 'search' }, icon('search', 16), search),
    h('div', { class: 'top-right' },
      h('span', { class: 'pill', title: 'Your access ends at this time' }, icon('clock', 14), until),
      btn('Log out', () => {
        lockOut('');
        toast('Logged out. The key has been removed from this device.');
      }, { kind: 'ghost', iconName: 'logout' }),
    ),
  );
  const body = h('div', { class: 'shell-body' });
  rootEl.replaceChildren(h('div', { class: 'shell' }, top, body));
  browser = new NotesBrowser(body, {
    readFile,
    searchContent,
    tag: (p, isDir, item) => ((isDir ? S.lockedDirs.has(p) : !canOpen(item)) ? 'lock' : null),
    isBlocked: (f) => !canOpen(f),
    // Locked files already show a padlock, so the no-download mark is only for files that open.
    noDownload: (p, isDir, item) => (isDir ? S.noDownloadDirs.has(p) : canOpen(item) && !!item.nd),
    canDownload,
    owner: CONFIG.ownerName,
    // Read when a popup opens, so it follows the latest list.
    contact: () => S.contact,
  });
  browser.onNavigate = () => {
    search.value = '';
    lastQuery = '';
  };
  browser.setTree(S.root);
  lastCheck = Date.now();
  startWatching();
  openFromHash();
}

/** A link like …/#D-7F3K9Q opens that document (or folder) once the vault is unlocked. */
function openFromHash() {
  const id = parseId(decodeURIComponent(location.hash.slice(1)));
  if (!id || !browser) return;
  if (!browser.openId(id)) toast(`Nothing here has the ID ${id}.`, 'error');
}
window.addEventListener('hashchange', openFromHash);

async function boot() {
  const newer = await latestVersion();
  if (newer && reloadToLatest(newer)) return;
  S.session = store.get();
  const oldKey = !S.session && store.oldKey();
  if (!S.session && !oldKey) return showLogin();
  rootEl.replaceChildren(h('main', { class: 'auth' }, h('div', { class: 'pv-msg' }, h('span', { class: 'spinner' }), 'Unlocking…')));
  try {
    // A key remembered by the previous version of the site is traded for a session once, then forgotten.
    if (oldKey) {
      if (!(await signIn(oldKey))) return lockOut();
      store.clear();
      store.save(S.session);
    }
    await loadTree();
    return showApp();
  } catch (e) {
    if (e instanceof SignedOut) return lockOut();
    S.session = null;
    showLogin(e.message);
  }
}

boot();
