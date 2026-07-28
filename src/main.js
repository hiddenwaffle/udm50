'use strict';
// Menu-bar launcher for Google AI Mode — V1 prototype.
// A Spotlight-style bar (global hotkey) that opens Google AI Mode with your query
// pre-loaded, and logs YOUR questions to a local transcript. Everything here is the
// "durable side": our own shell, hotkey, window plumbing, and transcript. Nothing
// depends on Google's DOM.

const { app, BrowserWindow, globalShortcut, ipcMain, session, screen, Menu, Tray, nativeImage, clipboard, dialog, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { applyChromiumSwitches, hardenSession } = require('./harden');

// Chromium switches (locale/accept-lang) must be set before app is ready.
applyChromiumSwitches(app);

// Keep the prototype self-contained: cookies/cache/partitions live in-project
// (delete .userdata/ to fully reset the session, incl. the captcha exemption).
// Source lives in src/, but user data belongs to the PROJECT, one level up. Getting this wrong
// silently relocates the cookie jar — including what keeps Google's CAPTCHA away — and orphans
// your query history, so every root-relative path goes through ROOT rather than __dirname.
const ROOT = path.join(__dirname, '..');
app.setPath('userData', path.join(ROOT, '.userdata'));

// The ONE place the app's display name comes from. app.getName() reads `productName` from
// package.json (falling back to `name`), which is also what electron-builder uses when packaging —
// so renaming the app is a one-line edit there, not a sweep through UI strings. Safe to read this
// early: it does not depend on `ready`, and userData is pinned above so the name can't move it.
const APP_NAME = app.getName();

// ---------------------------------------------------------------------------
// Config (the knobs worth having in one place)
// ---------------------------------------------------------------------------

// Persistent partition, NOT ephemeral. Empirically, a fresh cookieless context
// trips Google's "unusual traffic" captcha on every launch; persisting the cookie
// jar (incl. the abuse-exemption cookie) makes repeat launches sail through.
// This does NOT log you in — it's an anonymous-but-persistent cookie store.
const PARTITION = 'persist:aimode';

// Private queries run in a NON-persistent partition — no `persist:` prefix means Chromium keeps
// its cookies and cache in memory only and drops them when the app quits, so nothing about the
// query ever reaches disk. A fresh partition name per private window, so two private sessions in
// one run can't see each other's cookies either.
let privateSeq = 0;
const nextPrivatePartition = () => `aimode-private-${++privateSeq}`;

// Chromium glosses "udm" as "Unified Drilldown Mode" (new_tab_page_ui.cc) — Google-authored, but
// one engineer's inline comment added after Nov 2024, not a Search spec; the popular "User Display
// Mode" is an uncited 2025 blog guess. Nothing anywhere explains why 50: the values are a sparse,
// allocation-ordered enum. Evidence, value table and traps: README.md.
//
// KEEP THIS URL BARE — checked 2026-07-28 after a third-hand report that udm=50 was "stale" and
// replaced by aep=11. It has not been: Chromium ships the omnibox AI Mode URL as
// `search?sourceid=chrome&udm=50&aep=48&q=…`, and `aep` is an ENTRY-POINT tag whose value varies by
// where you came from (48 omnibox, 11 the g.ai shortcut) while udm=50 stays constant. Adding aep
// would assert a provenance we don't have.
//
// udm=50 routes to the AI Mode backend. Undocumented/reverse-engineered; if AI Mode
// ever stops loading, this parameter is the first suspect (a one-line fix).
const chatUrl = (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=50`;

const DEFAULT_HOTKEY = 'CommandOrControl+Shift+Space';
// Default FALLBACK hotkey: Option+Space — the conventional Spotlight-alternative launcher slot
// (Alfred's default). Rationale: anyone whose ⌥Space is already claimed is running a full
// launcher and almost certainly wouldn't also run this, so a real conflict is unlikely; everyone
// else has it free. It only registers if the primary is unavailable (see applyHotkey).
const DEFAULT_FALLBACK_HOTKEY = 'Alt+Space';
const SETTINGS_FILE = path.join(ROOT, '.userdata', 'settings.json');

// Default AI Mode window size (first open, and Settings → Reset window). No default x/y:
// Electron centers a window that's created without a position.
const DEFAULT_AI_BOUNDS = { width: 1040, height: 860 };

// Launcher history lives IN-PROJECT for an easily-inspectable prototype. For a
// "real" install, swap this for app.getPath('userData').
const HISTORY_DIR = path.join(ROOT, 'transcript');
const HISTORY_FILE = path.join(HISTORY_DIR, 'launcher_history.json');
const HISTORY_CAP = 200;    // most-recent queries kept for recall
const HISTORY_SHOWN = 50;   // max rows handed to the dropdown at once

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let launcher = null;
let aiWindow = null;
let findBarWin = null;   // Cmd+F bar — a child window of aiWindow (see "Find-in-page" below)
let tray = null;
let settingsWin = null;
let history = [];
// Spotlight is ONE long-lived field with a persistent undo stack, which is why its text comes
// back on the next summon AND why ⌘Z can undo a clear you made before dismissing it. Our bar is
// destroyed on every dismiss (Space-jump fix), so both behaviors are emulated from two slots kept
// out here. Both hold only ABANDONED text — submitting clears them, since history covers
// submitted queries. In memory only; a relaunch starts empty.
let lastDraft = '';     // what was in the box → prefilled, selected, on the next summon
let clearedDraft = '';  // what an explicit clear removed → what ⌘Z puts back
// Private/normal is sticky across summons: flipping it is a deliberate act, and re-flipping every
// time would be busywork. Deliberately NOT persisted to settings.json — a relaunch starts normal,
// so the app can never come back from a restart quietly private. Lives here for the usual reason:
// the bar is destroyed on every dismiss.
let lastPrivate = false;
let activeHotkey = null; // the accelerator currently registered (null if none)
let appActive = false;   // is our app currently the frontmost (active) app?
let settings = { hotkey: DEFAULT_HOTKEY, hotkeyFallback: DEFAULT_FALLBACK_HOTKEY, fallbackInitialized: false, hotkeyEnabled: true, maxCacheMB: 0, persistAiBounds: false, aiBounds: null, lastSaveDir: '', rewriteRedditLinks: true };

// Load-health check: set just before each AI Mode navigation, consumed once by the detection
// listeners when the page settles. `lastQuery` backs the Retry button; `lastReport` backs Copy.
let pendingCheck = null;
let lastQuery = null;
let lastQueryPrivate = false;
let lastReport = null;

// ---------------------------------------------------------------------------
// Launcher query history (yours, for recall in the dropdown)
// ---------------------------------------------------------------------------

function loadHistory() {
  try {
    const arr = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (Array.isArray(arr)) history = arr.filter((x) => typeof x === 'string');
  } catch (_) { history = []; }
}

function saveHistory() {
  try { fs.mkdirSync(HISTORY_DIR, { recursive: true }); } catch (_) {}
  fs.writeFile(HISTORY_FILE, JSON.stringify(history), () => {});
}

function addHistory(text) {
  const t = (text || '').trim();
  if (!t) return;
  const lc = t.toLowerCase();
  history = history.filter((h) => h.toLowerCase() !== lc); // dedup (case-insensitive), move to front
  history.unshift(t);
  if (history.length > HISTORY_CAP) history.length = HISTORY_CAP;
  saveHistory();
}

function removeHistory(text) {
  const lc = String(text || '').toLowerCase();
  history = history.filter((h) => h.toLowerCase() !== lc);
  // Deleting an entry has to delete it everywhere, or the next summon could prefill it (or ⌘Z
  // resurrect it). Normally the slots hold unsubmitted text only, but you can abandon a draft
  // that happens to match an old entry.
  if (lastDraft.trim().toLowerCase() === lc) lastDraft = '';
  if (clearedDraft.trim().toLowerCase() === lc) clearedDraft = '';
  saveHistory();
}

function filterHistory(query) {
  const q = String(query || '').trim().toLowerCase();
  const list = q ? history.filter((h) => h.toLowerCase().includes(q)) : history.slice();
  return list.slice(0, HISTORY_SHOWN);
}

// ---------------------------------------------------------------------------
// Settings (global hotkey: change / disable). Persisted in .userdata/settings.json.
// ---------------------------------------------------------------------------

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (s && typeof s === 'object') {
      if (typeof s.hotkey === 'string' && s.hotkey) settings.hotkey = s.hotkey;
      if (typeof s.hotkeyFallback === 'string') settings.hotkeyFallback = s.hotkeyFallback;
      if (typeof s.hotkeyEnabled === 'boolean') settings.hotkeyEnabled = s.hotkeyEnabled;
      if (typeof s.maxCacheMB === 'number' && isFinite(s.maxCacheMB)) settings.maxCacheMB = Math.max(0, s.maxCacheMB);
      if (typeof s.persistAiBounds === 'boolean') settings.persistAiBounds = s.persistAiBounds;
      if (s.aiBounds && typeof s.aiBounds === 'object') settings.aiBounds = s.aiBounds;
      if (typeof s.fallbackInitialized === 'boolean') settings.fallbackInitialized = s.fallbackInitialized;
      if (typeof s.lastSaveDir === 'string') settings.lastSaveDir = s.lastSaveDir;
    }
  } catch (_) {}

  // One-time: give a config from before the built-in fallback existed (or a brand-new one with
  // no fallback) the default Option+Space fallback. An explicit user Clear sets
  // fallbackInitialized, so we never re-fill a fallback the user deliberately emptied.
  if (!settings.fallbackInitialized) {
    if (!settings.hotkeyFallback) settings.hotkeyFallback = DEFAULT_FALLBACK_HOTKEY;
    settings.fallbackInitialized = true;
    saveSettings();
  }
}

function saveSettings() {
  try { fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true }); } catch (_) {}
  fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), () => {});
}

// AI Mode window bounds persistence. Bounds live in settings.json with the other prefs; writes
// are debounced so a drag/resize doesn't hammer the disk. `persistAiBounds` gates remembering;
// Settings → Reset clears them back to the default size.
function boundsOnScreen(b) {
  // A saved position can land off-screen if the display layout changed — require overlap.
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    return b.x < wa.x + wa.width && b.x + b.width > wa.x && b.y < wa.y + wa.height && b.y + b.height > wa.y;
  });
}
function validBounds(b) {
  return !!b && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(b[k]))
    && b.width >= 400 && b.height >= 300 && boundsOnScreen(b);
}
let saveBoundsTimer = null;
function saveAiBounds(immediate) {
  if (!settings.persistAiBounds || !aiWindow || aiWindow.isDestroyed()) return;
  if (aiWindow.isMinimized() || aiWindow.isFullScreen()) return; // don't persist a degenerate size
  const b = aiWindow.getBounds();
  settings.aiBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
  clearTimeout(saveBoundsTimer);
  if (immediate) saveSettings();
  else saveBoundsTimer = setTimeout(saveSettings, 400); // coalesce writes during a drag
}

// ---------------------------------------------------------------------------
// Cache size / clear (Settings → Clear cache, Firefox-style with the size shown).
// ---------------------------------------------------------------------------

function humanSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i === 0 ? n : (n >= 100 ? Math.round(n) : n.toFixed(1))} ${u[i]}`;
}

async function dirSize(dir) {
  let total = 0, entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
  catch (_) { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += await dirSize(p);
      else total += (await fs.promises.stat(p)).size;
    } catch (_) {}
  }
  return total;
}

// On-disk cache footprint of the AI Mode partition. Prefer Electron's getCacheSize (reflects
// clearable cache and drops to ~0 after a clear); fall back to measuring the Cache dirs directly
// if that API is absent.
async function aiCacheBytes() {
  const ses = session.fromPartition(PARTITION);
  if (typeof ses.getCacheSize === 'function') {
    try { return await ses.getCacheSize(); } catch (_) {}
  }
  const base = path.join(app.getPath('userData'), 'Partitions', 'aimode');
  return (await dirSize(path.join(base, 'Cache'))) + (await dirSize(path.join(base, 'Code Cache')));
}

// Logical size of the AI Mode partition's cookies (sum of "name=value" bytes). The on-disk
// Cookies SQLite file barely shrinks after a clear, so measuring the payload instead lets the
// button's "(size)" drop to ~0 once cleared — which is what the user expects to see.
async function aiCookieBytes() {
  const ses = session.fromPartition(PARTITION);
  try {
    const cookies = await ses.cookies.get({});
    return cookies.reduce((n, c) => n + Buffer.byteLength(`${c.name}=${c.value}`, 'utf8'), 0);
  } catch (_) { return 0; }
}

// Cap the on-disk HTTP cache to the user's "max saved data" setting. This is a Chromium startup
// switch (Chromium then keeps its cache under the cap), so it must be set BEFORE the first
// session — hence called pre-`ready`. Cookies live in a separate store and are never capped, so
// the captcha-exemption cookie always survives, even at Minimal (0).
function applyCacheLimit() {
  const bytes = Math.round(Math.max(0, Number(settings.maxCacheMB) || 0) * 1024 * 1024);
  // NOTE: disk-cache-size=0 tells Chromium "use the default (large) size", so at Minimal we pass
  // 1 — Chromium clamps to its own small floor, i.e. effectively nothing cached.
  app.commandLine.appendSwitch('disk-cache-size', String(bytes > 0 ? bytes : 1));
}

// Runtime backstop for the cap (the startup switch alone can't be changed live): when the AI
// window closes, or the limit is lowered, trim the cache if it's over budget. Whole-cache clear
// rather than LRU, but it only fires on close/change, and never touches cookies.
async function enforceCacheCap() {
  const capBytes = Math.max(0, Number(settings.maxCacheMB) || 0) * 1024 * 1024;
  let bytes = 0;
  try { bytes = await aiCacheBytes(); } catch (_) { return; }
  if (bytes <= capBytes) return;
  const ses = session.fromPartition(PARTITION);
  try { await ses.clearCache(); } catch (_) {}
  try { await ses.clearCodeCaches({}); } catch (_) {}
  if (DEBUG_SUMMON) dlog('[cache] over cap → cleared', JSON.stringify({ wasBytes: bytes, capBytes }));
}

// (Re)register the global hotkey, trying the primary then the fallback. Sets
// `activeHotkey` to whichever registered (null if none). Returns { registered, exhausted }
// where exhausted = every configured shortcut failed. NOTE: macOS can't always report a
// cross-app conflict (register may return true even when another app owns it), so a null
// result is reliable but a non-null one isn't a guarantee the key actually fires.
function applyHotkey() {
  globalShortcut.unregisterAll();
  activeHotkey = null;
  if (!settings.hotkeyEnabled) return { registered: null, exhausted: false };
  const candidates = [settings.hotkey, settings.hotkeyFallback].filter(Boolean);
  for (const acc of candidates) {
    let ok = false;
    try { ok = globalShortcut.register(acc, toggleLauncher); } catch (_) { ok = false; }
    if (ok) { activeHotkey = acc; return { registered: acc, exhausted: false }; }
    derror(`[settings] could not register hotkey: ${acc}`);
  }
  return { registered: null, exhausted: candidates.length > 0 };
}

function openSettings() {
  reclaimActivation(); // a hidden app can show a window without becoming active
  if (settingsWin) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 480, height: 596, resizable: false, minimizable: false, maximizable: false,
    show: false,
    title: `${APP_NAME} — Settings`,
    webPreferences: { preload: path.join(__dirname, 'settings_preload.js'), spellcheck: false }
  });
  settingsWin.on('closed', () => { settingsWin = null; });
  // Size the window to its content so nothing needs scrolling. The panel is static-height, but
  // measuring it (rather than hard-coding) stays correct if the settings ever change. Clamp to the
  // display so a short screen falls back to the panel's own overflow scroll instead of overflowing.
  settingsWin.webContents.once('did-finish-load', async () => {
    if (!settingsWin || settingsWin.isDestroyed()) return;
    try {
      const h = await settingsWin.webContents.executeJavaScript('document.querySelector(".wrap").scrollHeight');
      const maxH = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea.height - 40;
      settingsWin.setContentSize(480, Math.min(Math.ceil(h) + 2, maxH));
    } catch (_) { /* keep the default height */ }
    settingsWin.center();
    settingsWin.show();
    settingsWin.focus();
    app.focus({ steal: true });
  });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
}

// ---------------------------------------------------------------------------
// Right-click context menu (Electron ships none). Built generically from the
// context — edit actions gate on editFlags; link/image items appear when present.
// ---------------------------------------------------------------------------

// AI Mode's answer images usually sit UNDER a transparent lightbox-opener overlay, so
// Chromium's hit test reports "no image" at the click point (params.srcURL empty) and the
// image items never appeared. elementsFromPoint digs through the whole stack, covered
// elements included — probe it for the image the user actually clicked.
function imageAtPoint(win, x, y) {
  const js = `(() => {
    for (const el of document.elementsFromPoint(${Number(x)}, ${Number(y)})) {
      if (el.tagName === 'IMG' && (el.currentSrc || el.src)) return el.currentSrc || el.src;
    }
    return null;
  })()`;
  return win.webContents.executeJavaScript(js, true).catch(() => null);
}

// Bytes + extension for an image src: data: URLs decode locally, http(s) downloads through
// the window's own session (Google's cookies apply). null on anything else or on failure.
function imageBytes(win, src) {
  if (/^data:/i.test(src)) return Promise.resolve(decodeDataUrl(src));
  if (/^https?:/i.test(src)) return fetchImage(win.webContents.session, src);
  return Promise.resolve(null);
}

function suggestedImageName(src, ext) {
  try {
    const base = decodeURIComponent(new URL(src).pathname.split('/').pop() || '');
    const stem = base.replace(/\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i, '');
    if (stem && /^[\w][\w .%-]*$/.test(stem)) return `${stem}.${ext}`;
  } catch (_) { /* data: URL or unparsable — generic name below */ }
  return `image.${ext}`;
}

async function copyImage(win, src, hitPoint) {
  // When Chromium's own hit test saw the image, its native copy handles every format.
  if (hitPoint) { win.webContents.copyImageAt(hitPoint.x, hitPoint.y); return; }
  const img = await imageBytes(win, src); // overlay-covered image: decode/download ourselves
  const ni = img && nativeImage.createFromBuffer(img.data);
  if (ni && !ni.isEmpty()) clipboard.writeImage(ni); // decodes PNG/JPEG; other formats no-op
}

async function saveImage(win, src) {
  const img = await imageBytes(win, src);
  if (!img) { dialog.showErrorBox('Save Image', 'The image could not be downloaded.'); return; }
  const dir = settings.lastSaveDir || app.getPath('downloads');
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(dir, suggestedImageName(src, img.ext)),
    filters: [{ name: 'Image', extensions: [img.ext] }]
  });
  if (!canceled && filePath) fs.writeFile(filePath, img.data, () => {});
}

// Reveal a window's saved transcript in Finder (browser "show in folder" idiom). If the file
// was moved or deleted, fall back to opening its folder — a later Cmd+S re-save recreates the
// file there — and if even that's gone, the last-used save folder.
function revealSaved(win) {
  const p = win && win._savedPath;
  if (!p) return;
  if (fs.existsSync(p)) { shell.showItemInFolder(p); return; }
  const dir = path.dirname(p);
  if (fs.existsSync(dir)) shell.openPath(dir);
  else if (settings.lastSaveDir) shell.openPath(settings.lastSaveDir);
}

// macOS "Look Up" — the system dictionary/Siri-knowledge popover, the same panel you get from
// ⌃⌘D or a three-finger tap. showDefinitionForSelection acts on the webContents' live selection,
// so there's nothing to pass it; the label just echoes what you picked, as Finder/Safari do.
function lookUpItem(win, selection) {
  if (process.platform !== 'darwin') return null;
  const s = selection.replace(/\s+/g, ' ').trim();
  const shown = s.length > 24 ? `${s.slice(0, 24)}…` : s;
  return { label: `Look Up “${shown}”`, click: () => win.webContents.showDefinitionForSelection() };
}

function installContextMenu(win) {
  win.webContents.on('context-menu', async (_e, params) => {
    const ef = params.editFlags || {};
    const selection = (params.selectionText || '').trim();
    const t = [];

    if (params.linkURL) {
      t.push(
        // Through copyLink, so this path gets the Reddit rewrite and the confirmation banner too —
        // it used to write the clipboard directly and silently.
        { label: 'Copy Link', click: () => copyLink(params.linkURL) },
        { type: 'separator' }
      );
    }
    let imgSrc = (params.mediaType === 'image' && params.srcURL) ? params.srcURL : null;
    const chromiumSawIt = !!imgSrc;
    if (!imgSrc && !params.isEditable) imgSrc = await imageAtPoint(win, params.x, params.y);
    if (imgSrc) {
      t.push({ label: 'Copy Image', click: () => copyImage(win, imgSrc, chromiumSawIt ? { x: params.x, y: params.y } : null) });
      if (!/^data:/i.test(imgSrc)) t.push({ label: 'Copy Image Address', click: () => clipboard.writeText(imgSrc) });
      t.push({ label: 'Save Image…', click: () => saveImage(win, imgSrc) });
      t.push({ type: 'separator' });
    }
    const lookUp = selection ? lookUpItem(win, selection) : null;
    if (params.isEditable) {
      if (lookUp) t.push(lookUp, { type: 'separator' });
      t.push(
        { role: 'cut', enabled: !!ef.canCut },
        { role: 'copy', enabled: !!ef.canCopy },
        { role: 'paste', enabled: !!ef.canPaste },
        { type: 'separator' },
        { role: 'selectAll' }
      );
    } else {
      if (selection) {
        if (lookUp) t.push(lookUp);
        t.push({ role: 'copy', enabled: !!ef.canCopy }, { type: 'separator' });
      }
      t.push({ role: 'selectAll' });
    }

    // Reveal this conversation's saved transcript in Finder — like a browser's "show download
    // in folder". Only appears once THIS window has been saved (Cmd+S sets _savedPath; a new
    // query clears it). If the file was moved, revealSaved falls back to opening its folder.
    if (win._savedPath) {
      t.push(
        { type: 'separator' },
        { label: 'Show Saved Transcript', click: () => revealSaved(win) }
      );
    }

    if (t.length) Menu.buildFromTemplate(t).popup({ window: win });
  });
}

// ---------------------------------------------------------------------------
// Launcher bar (Spotlight-style)
// ---------------------------------------------------------------------------

// Build a fresh launcher window. We create a NEW one for every summon (see showLauncher) so it's
// BORN on the current Space — a long-lived window keeps its startup "home" Space, and
// app.focus({steal}) yanks you back to that Space even for an all-Spaces window (the desktop jump).
function createLauncher() {
  const win = new BrowserWindow({
    width: 640, height: 72,
    frame: false, transparent: true, resizable: false,
    show: false, alwaysOnTop: true, skipTaskbar: true,
    fullscreenable: false, minimizable: false, maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false
    }
  });
  win._armed = false; // set true shortly after show, so a transient blur during activation can't dismiss it
  win.loadFile(path.join(__dirname, 'launcher.html'));
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Dismiss on genuine focus loss (click-away / Space switch). Guarded so the transient blur that
  // can fire while we activate the app during show doesn't destroy the bar, and so a superseded
  // window's late blur can't dismiss the current one.
  win.on('blur', () => {
    if (!win._armed || launcher !== win) return;
    if (DEBUG_SUMMON) dlog('[launcher] blur → hide');
    hideLauncher(true);
  });

  // Cmd+Q / Cmd+W dismiss the bar rather than quitting the app; Cmd+, opens Settings.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.meta) return;
    const k = (input.key || '').toLowerCase();
    if (k === 'q' || k === 'w') { event.preventDefault(); hideLauncher(true); }
    else if (k === ',') {
      // Dismiss the bar first, the way a menu command would: Settings is a real window, and
      // leaving a transient always-on-top panel floating over it looks broken. No focus yield
      // here — we're about to raise a window of our own.
      event.preventDefault();
      hideLauncher();
      openSettings();
    }
  });

  installContextMenu(win);
  return win;
}

const DEBUG_SUMMON = false; // set true to re-enable the [summon]/[save] diagnostics

// Timestamped console helpers. Prefix every line with HH:MM:SS.mmm so the reveal / focus /
// activation timeline is readable — you can see not just WHAT fired but WHEN.
function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
function dlog(...args) { console.log(ts(), ...args); }
function dwarn(...args) { console.warn(ts(), ...args); }
function derror(...args) { console.error(ts(), ...args); }

// Snapshot the observable state around a reveal. macOS gives us no way to read the current
// Space number, so we log everything we CAN see — the all-Spaces flag (prime suspect: if it
// reads false when we expect true, a jump is likely), display ids, and app-active state — and
// pair it with an EXPECT line so a "jumped/didn't" report maps to a specific code path.
// `win` is whichever window is being revealed.
function revealSnapshot(win) {
  try {
    const cursor = screen.getCursorScreenPoint();
    const focused = BrowserWindow.getFocusedWindow();
    return {
      allSpaces: win.isVisibleOnAllWorkspaces(),
      visible: win.isVisible(),
      winDisplay: screen.getDisplayMatching(win.getBounds()).id,
      cursorDisplay: screen.getDisplayNearestPoint(cursor).id,
      displays: screen.getAllDisplays().length,
      appActive,
      aiOpen: !!aiWindow,
      aiDisplay: aiWindow ? screen.getDisplayMatching(aiWindow.getBounds()).id : null,
      focusedId: focused ? focused.id : null
    };
  } catch (e) { return { error: String(e) }; }
}

function showLauncher() {
  reclaimActivation(); // we may have hidden the app on the last dismiss to give focus back
  // Recreate the bar FRESH each summon so it's born on the current Space (see createLauncher).
  if (launcher && !launcher.isDestroyed()) { const old = launcher; launcher = null; old.destroy(); }
  const win = createLauncher();
  launcher = win;

  let shown = false;
  const reveal = () => {
    if (shown || win.isDestroyed() || launcher !== win) return;
    shown = true;

    // Top-center of whichever display the cursor is on.
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const [w] = win.getSize();
    win.setPosition(Math.round(wa.x + (wa.width - w) / 2), Math.round(wa.y + wa.height * 0.20));

    if (DEBUG_SUMMON) dlog('[reveal:launcher] as-found —', JSON.stringify(revealSnapshot(win)));
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // BECOME A REGULAR APP BEFORE ACTIVATING. An accessory app (menu-bar only, no Dock icon) is the
    // weakest possible case for taking focus, and on macOS 14+ activateIgnoringOtherApps no longer
    // reliably lets a background app steal activation at all — it fails SILENTLY. Proven on a second
    // machine 2026-07-28: the reveal snapshot showed appActive:false and focusedId:null AFTER
    // app.focus({steal:true}) had run, and `[app] became active` did not appear in the log until the
    // user clicked the bar seven seconds later. The AI window path never had this bug because
    // bringForward() calls setRegular() first — this is that same missing step.
    // hideLauncher drops us back to accessory, so the Dock icon only exists while the bar is up.
    setRegular();
    win.show();
    // Unconditional. It used to be gated on `!appActive`; the gate was not the cause here (the flag
    // read false), but it was already recorded as not fixing the flash it was added for, and a bar
    // that silently declines to take the keyboard is the worst thing this code can do.
    app.focus({ steal: true });
    win.focus();
    win.webContents.focus();                    // ensure keystrokes go to the input
    // Carries the draft AND the sticky mode so the renderer can paint both in the same tick it
    // focuses — an invoke() round-trip would let a normal-looking empty bar paint first and then
    // flip to private a frame later, which is exactly the flicker you don't want on this control.
    win.webContents.send('launcher-shown', { draft: lastDraft, private: lastPrivate });
    setTimeout(() => { if (!win.isDestroyed() && launcher === win) win._armed = true; }, 150);
    if (DEBUG_SUMMON) dlog('[reveal:launcher] EXPECT no-jump (fresh window, born on current Space) —', JSON.stringify(revealSnapshot(win)));
  };

  // Reveal only once the window has painted (no blank flash). ready-to-show is the primary
  // trigger; did-finish-load is a fallback in case it's flaky for a transparent window.
  win.once('ready-to-show', reveal);
  win.webContents.once('did-finish-load', () => setTimeout(reveal, 250)); // fallback if ready-to-show is flaky
}

// Hand activation BACK to whatever app you were in, the way Spotlight does. Destroying our only
// window does NOT do that: we're an accessory app, so we stay frontmost with no window, and the
// app behind us ends up half-focused — its menu is in the menu bar (accessory apps own no menu
// bar) while its window is not key, hence gray traffic lights and keystrokes going nowhere.
// NSApp's hide: deactivates us and activates the next app in line, which is the fix. Called while
// our window is still alive so hide: has something to act on, and only when nothing else of ours
// is on screen — the AI window or Settings being up means activation is theirs to keep.
let appHidden = false;
function yieldActivation(ignore) {
  if (process.platform !== 'darwin') return;
  const others = BrowserWindow.getAllWindows()
    .filter((w) => w !== ignore && !w.isDestroyed() && w.isVisible());
  if (others.length) return;
  appHidden = true;
  app.hide();
  if (DEBUG_SUMMON) dlog('[launcher] app.hide() → activation back to the previous app');
}

// Undo the above before we put a window back on screen (a hidden app can otherwise show a window
// without becoming active). No-op unless we actually hid.
function reclaimActivation() {
  if (!appHidden) return;
  appHidden = false;
  app.show();
  // app.show() un-hides WITHOUT focusing, so by definition we are not frontmost afterwards. Say so
  // explicitly rather than waiting for an event that may never arrive: this flag is diagnostic now,
  // but a wrong value here is what made the bar come up unfocused on some machines.
  appActive = false;
}

// `yieldFocus` is for genuine dismissals only. The submit path must NOT yield — the AI window is
// about to be shown and would inherit a hidden, deactivated app.
function hideLauncher(yieldFocus) {
  if (!launcher || launcher.isDestroyed()) return;
  const w = launcher;
  launcher = null;   // clear ref first so the window's own blur/close handlers no-op
  if (yieldFocus) yieldActivation(w);
  w.destroy();       // fully close it; the next summon builds a fresh one on the current Space
  // Back to menu-bar-only. reveal() escalates to a regular app so it can take focus at all; without
  // this the Dock icon would stay behind after the bar is gone. Gated on `yieldFocus`, i.e. genuine
  // dismissals: the submit path is about to open the AI window, which wants regular anyway, and
  // flipping accessory→regular milliseconds apart is pointless churn in the flash-prone code.
  // (Submitting an EMPTY query opens nothing, so that path restores accessory itself.)
  if (yieldFocus && (!aiWindow || aiWindow.isDestroyed())) setAccessory();
}

function toggleLauncher() {
  // If the mini browser is open, the hotkey switches TO it (our stand-in for Cmd+Tab):
  // bring it to the current Space if it's in the background, then focus its input box.
  // Because the launcher is never shown while the AI window exists, the two-window
  // activation churn — and thus the flash — can't happen at all.
  if (aiWindow && !aiWindow.isDestroyed()) {
    if (!aiWindow.isFocused()) bringForward(aiWindow); // background → bring it to me
    aiWindow.webContents.send('focus-input');          // focus its box, ready to type
    return;
  }
  if (launcher && !launcher.isDestroyed()) hideLauncher(true); // open → dismiss (focus goes back)
  else showLauncher();                                         // closed → summon a fresh bar
}

// ---------------------------------------------------------------------------
// Menu-bar (tray) residency — the app lives in the top-right, not the Dock.
// ---------------------------------------------------------------------------

function buildTrayMenu() {
  if (!tray) return;
  const wantsHotkey = settings.hotkeyEnabled && (settings.hotkey || settings.hotkeyFallback);
  const failed = wantsHotkey && !activeHotkey; // configured a hotkey, but none registered
  tray.setTitle(failed ? '⚠' : '✦');
  tray.setToolTip(failed ? `${APP_NAME} — hotkey unavailable` : APP_NAME);

  const items = [];
  if (failed) {
    items.push({ label: '⚠ Hotkey unavailable — set another in Settings', enabled: false });
    items.push({ type: 'separator' });
  }
  items.push({ label: 'Ask AI Mode…', accelerator: activeHotkey || undefined, registerAccelerator: false, click: () => showLauncher() });
  if (settings.lastSaveDir) items.push({ label: 'Open Last Save Folder', click: () => shell.openPath(settings.lastSaveDir) });
  items.push({ label: 'Settings…', click: () => openSettings() });
  items.push({ type: 'separator' });
  items.push({ label: `Quit ${APP_NAME}`, click: () => app.quit() });
  // Clicking the menu-bar icon opens a standard dropdown; the hotkey stays the fast path.
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('✦');                                  // text glyph (no icon asset needed yet)
  tray.setToolTip(APP_NAME);
  buildTrayMenu();
}

// ---------------------------------------------------------------------------
// AI Mode window (Google's side — kept scoped, external links bounce out)
// ---------------------------------------------------------------------------

// (Reveal-on-current-Space now lives in bringForward, done deterministically without the
// old all-Spaces toggle — see below.)

// Toggle between a regular app (Dock icon + Cmd+Tab) and a menu-bar-only accessory.
// setActivationPolicy is the lever that actually governs Cmd+Tab membership on macOS —
// app.dock.show() alone shows the icon but doesn't reliably add the app to the switcher.
function setRegular() {
  if (typeof app.setActivationPolicy === 'function') app.setActivationPolicy('regular');
  if (app.dock) app.dock.show();
}
function setAccessory() {
  if (typeof app.setActivationPolicy === 'function') app.setActivationPolicy('accessory');
  if (app.dock) app.dock.hide();
}

// Bring the AI window forward once its content is ready (see showAiMode) so we never flash
// blank/stale. Deterministic reveal — NO all-Spaces toggle:
//   • fresh window  → a hidden window has no Space assignment, so show() lands it on the
//     CURRENT Space by construction → no jump.
//   • reused window → it already lives on its home Space; focusing takes you there,
//     Cmd+Tab-style (an accepted jump, not the old accidental one).
// `fresh` only drives the EXPECT log below — the actual calls are identical either way.
function bringForward(win, fresh) {
  reclaimActivation(); // a hidden app can show a window without becoming active
  setRegular(); // Dock + Cmd+Tab membership
  if (DEBUG_SUMMON) {
    const expect = fresh
      ? 'no-jump (fresh window, shown on the current Space)'
      : 'jump-possible (reused window may live on another Space)';
    dlog(`[reveal:ai] EXPECT ${expect} —`, JSON.stringify({ fresh: !!fresh, ...revealSnapshot(win) }));
  }
  win.show();
  win.focus();
  app.focus({ steal: true }); // activate our app so keystrokes land in the window
  if (DEBUG_SUMMON) dlog('[reveal:ai] done —', JSON.stringify(revealSnapshot(win)));
}

// Links are copied to the clipboard, never opened in a browser. Unwrap Google's
// /url?q= redirect wrapper so we copy the real destination, not the tracking URL.
function unwrapGoogleRedirect(u) {
  try {
    const url = new URL(u);
    if (url.hostname.endsWith('google.com') && url.pathname === '/url') {
      const real = url.searchParams.get('q') || url.searchParams.get('url');
      if (real) return real;
    }
  } catch (_) {}
  return u;
}

function isGoogleHost(u) {
  try { return new URL(u).hostname.endsWith('google.com'); }
  catch (_) { return false; }
}

// Optional (Settings → "Copy Reddit links as old.reddit.com"): old.reddit.com is the same content
// on the lighter, non-gated UI. Only the www/bare host is rewritten — media hosts (i.redd.it) and
// anything already on another subdomain are left alone.
function preferOldReddit(u) {
  if (!settings.rewriteRedditLinks) return u;
  try {
    const url = new URL(u);
    if (url.hostname === 'www.reddit.com' || url.hostname === 'reddit.com') {
      url.hostname = 'old.reddit.com';
      return url.toString();
    }
  } catch (_) {}
  return u;
}

// The one place a URL becomes clipboard text: unwrap Google's redirect, then apply the Reddit
// rewrite. Every copy path routes through copyLink so both transforms are unskippable.
function linkToCopy(rawUrl) { return preferOldReddit(unwrapGoogleRedirect(rawUrl)); }

function copyLink(rawUrl) {
  const url = linkToCopy(rawUrl);
  if (!url) return;
  clipboard.writeText(url);
  if (aiWindow && !aiWindow.isDestroyed()) aiWindow.webContents.send('link-copied', url);
}

// ---------------------------------------------------------------------------
// AI Mode load-health check (background on the parameter: README.md).
// The udm=50 surface is undocumented, so if Google ever ignores
// or renames the param we must NOT silently present ordinary web results as if they were AI
// Mode. We watch each navigation and, when the page didn't come up as AI Mode, show a clear,
// copy-pasteable "crash report" overlay (rendered by ai_preload.js) instead of leaving the
// user guessing. A captcha/verification page is the exception — it's a solvable interstitial,
// not a silent failure, so we leave it fully interactive and never cover it. Detection is
// deliberately CONSERVATIVE — when unsure we assume healthy, so a working page is never nuked.
// ---------------------------------------------------------------------------

// Runs IN the page (main world) after load settles; reports only raw facts. #result-stats is
// the "About N results" line a normal SERP shows and AI Mode does not — our clearest degrade
// tell. If Google ever renames it we simply stop detecting THAT signal (fail safe: no false
// alarm). The old version of this comment went on to call the udm-param check a backstop that
// "still catches a dropped/renamed parameter" — that had the failure modes exactly backwards, and
// it was the reasoning that produced the bug fixed in diagnoseLoad below: the param check is the
// one that fails UNSAFE. See there.
const SURFACE_PROBE = `(() => {
  try {
    const text = ((document.body && document.body.innerText) || '').slice(0, 4000);
    return {
      href: location.href,
      path: location.pathname,
      hasResultStats: !!document.getElementById('result-stats'),
      hasRso: !!document.querySelector('#rso'),
      looksSorry: location.pathname.indexOf('/sorry') === 0 ||
                  /unusual traffic|detected unusual|are not a robot|solve the above/i.test(text)
    };
  } catch (e) { return { error: String(e) }; }
})()`;

// Decide health from the page probe + the final URL. Returns null when healthy, else a failure
// descriptor. Fires only on strong, specific signals — never on "unknown".
function diagnoseLoad(probe, finalURL) {
  // Captcha pages are handled upstream (left interactive), so they never reach here.
  let udmDropped = false;
  try {
    const u = new URL(finalURL);
    if (u.hostname.endsWith('google.com') && u.pathname === '/search') {
      udmDropped = u.searchParams.get('udm') !== '50'; // Google stripped/changed the AI-Mode param
    }
  } catch (_) {}
  const looksSerp = !!(probe && probe.hasResultStats); // AI Mode omits the results-count line
  // A missing udm=50 is EVIDENCE, never a verdict — only a positive tell that we got an ORDINARY
  // results page can condemn a page. Until 2026-07-28 this was `udmDropped || looksSerp`, which
  // meant the day Google reshapes the query string while still serving AI Mode, a perfectly good
  // answer would be covered by a full-screen error. Google demonstrably does reshape it: Chromium
  // ships the omnibox AI Mode URL as `udm=50&aep=48`, and g.ai 301s to `udm=50&aep=11` — `aep`
  // being an entry-point tag ("identifies source of the request", per Chromium's own comment), not
  // a surface selector. That is a rename away from breaking us for no reason. `udmDropped` is
  // still reported, because it is genuinely useful in the copied report.
  if (looksSerp) return { type: 'degraded', udmDropped, looksSerp };
  return null;
}

// A copy-pasteable, crash-report-style block: what happened, our best diagnosis, the exact
// URLs, and the build versions — everything needed to report or debug the failure.
function buildLoadReport(f, ctx) {
  const stamp = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  const rows = [
    ['Time', stamp],
    ['Result', f.headline],
    ['Likely cause', f.cause],
    ['', ''],
    ['Query', ctx.query],
    ['Requested', ctx.url],
    ['Final URL', f.finalURL || '(no navigation)'],
    ['Detected by', f.detectedBy],
    ['', ''],
    ['App', `${APP_NAME} (prototype)`],
    ['Electron', process.versions.electron],
    ['Chromium', process.versions.chrome],
    ['Node', process.versions.node],
    ['Platform', `${process.platform} ${os.release()}`]
  ];
  const body = rows.map(([k, v]) => (k ? `${(k + ':').padEnd(15)}${v}` : '')).join('\n');
  const heading = `${APP_NAME} — load report`;
  return `${heading}\n${'─'.repeat(heading.length)}\n${body}`; // rule follows the name's length
}

// Compose the human-facing copy for a failure type, build the report, and hand both to the
// overlay in the AI window.
function triggerLoadError(info, ctx) {
  let headline, explanation, cause, detectedBy;
  if (info.type === 'network') {
    headline = 'AI Mode did not load — Google could not be reached.';
    explanation = 'The page failed to load at the network level. This is almost always a connection problem (offline, VPN, DNS, or a firewall) rather than a problem with AI Mode itself.';
    cause = `The main-frame navigation failed (${info.code} ${info.desc}).`;
    detectedBy = `Chromium reported a failed load: ${info.code} ${info.desc}.`;
  } else {
    headline = 'AI Mode did not load — Google returned a normal results page.';
    explanation = 'Your query loaded, but Google served an ordinary web-results page instead of the AI Mode answer surface. This app requests AI Mode with a special URL parameter (udm=50); when Google ignores or stops honoring it, you silently get regular results instead of an answer.';
    cause = 'No AI Mode answer surface was rendered — the page came back as ordinary web results.';
    const bits = [];
    // Reported as corroboration only; on its own it does not (and must not) trigger this overlay.
    if (info.udmDropped) bits.push('the final URL no longer carries udm=50');
    if (info.looksSerp) bits.push('the page shows a results-count line (#result-stats) that AI Mode omits');
    detectedBy = bits.join('; ') || 'surface heuristic';
  }
  const f = { headline, explanation, cause, detectedBy, finalURL: info.finalURL };
  lastReport = buildLoadReport(f, ctx);
  if (DEBUG_SUMMON) dlog('[load-check] FAIL', JSON.stringify({ type: info.type, finalURL: info.finalURL, detectedBy }));
  if (aiWindow && !aiWindow.isDestroyed()) {
    aiWindow.webContents.send('show-load-error', {
      // `app` rides along because the overlay lives in the sandboxed preload, which can't require
      // anything local to learn the name for itself.
      type: info.type, headline, explanation, cause, report: lastReport, app: APP_NAME
    });
  }
}

// ---------------------------------------------------------------------------
// Transcript file save (Cmd+S / Cmd+Shift+S). Opt-in, per-window: the first save of a query
// opens a native Save box (defaulting to the folder you last saved into — persisted across
// launches); after that, Cmd+S re-saves the same file silently, Cmd+Shift+S is Save As.
// NOTE: answer-content capture is best-effort for now (the main region's text); richer markdown
// capture is a follow-up.
// ---------------------------------------------------------------------------

function slugify(s) {
  return (String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)) || 'query';
}

function autoFileName(question) {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const ts = `${d.getFullYear()}_${p(d.getMonth() + 1)}_${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  return `${ts}_${slugify(question)}.md`;
}

// Ask the AI window's preload (ai_preload.js §7) to walk its live answer DOM into clean Markdown
// and hand it back. Request/response over IPC, keyed by id, with a short timeout so a wedged page
// can never hang the save — we just fall back to writing the header + a "not captured" note.
let transcriptReqSeq = 0;
const transcriptWaiters = new Map();
ipcMain.on('transcript-content', (_e, reqId, markdown, err, images) => {
  const resolve = transcriptWaiters.get(reqId);
  if (!resolve) return;
  transcriptWaiters.delete(reqId);
  if (DEBUG_SUMMON) dlog('[save] content', `${(markdown || '').length} chars`, err ? `ERR: ${err}` : '');
  resolve({ answer: markdown || '', images: Array.isArray(images) ? images : [] });
});
function requestTranscript(win) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve('');
    const id = ++transcriptReqSeq;
    transcriptWaiters.set(id, resolve);
    const questions = Array.isArray(win._questions) ? win._questions : [];
    try { win.webContents.send('build-transcript', id, questions); } catch (e) { if (DEBUG_SUMMON) dwarn('[save] send failed', String(e)); }
    setTimeout(() => {
      if (transcriptWaiters.has(id)) {
        transcriptWaiters.delete(id);
        if (DEBUG_SUMMON) dwarn('[save] content TIMEOUT — no reply from preload (old preload? no §7 handler?)');
        resolve({ answer: '', images: [] });
      }
    }, 4000);
  });
}

// Download the answer's content images (tokens planted by ai_preload §7's image()) through the AI
// window's own session — Google's cookies apply and no page CSP is involved — into a
// "<mdname>_files" folder next to the transcript, then rewrite each token to a relative link
// (which a confined viewer renders, unlike remote URLs). A failed download drops its image
// reference rather than leaving a broken link; with no successes the folder is never created.
const IMG_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/x-icon': 'ico'
};
function fetchImage(sess, url) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    try { req = net.request({ url, session: sess, useSessionCookies: true }); }
    catch (e) { return finish(null); }
    const chunks = [];
    req.on('response', (res) => {
      const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => finish((res.statusCode === 200 && chunks.length)
        ? { data: Buffer.concat(chunks), ext: IMG_EXT[type] || 'png' } : null));
      res.on('error', () => finish(null));
    });
    req.on('error', () => finish(null));
    setTimeout(() => { try { req.abort(); } catch (e) { /* already closed */ } finish(null); }, 8000);
    req.end();
  });
}
function decodeDataUrl(src) {
  const m = String(src).match(/^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i);
  if (!m) return null;
  try { return { data: Buffer.from(m[2], 'base64'), ext: IMG_EXT[m[1].toLowerCase()] || 'png' }; }
  catch (e) { return null; }
}
async function materializeImages(markdown, images, target, win) {
  const scrub = (md) => md.replace(/!\[[^\]]*\]\(__AIIMG_\d+__\)/g, '').replace(/\n{3,}/g, '\n\n');
  if (!images || !images.length || !win || win.isDestroyed()) return scrub(markdown);
  const dirName = `${path.basename(target).replace(/\.md$/i, '')}_files`;
  const dir = path.join(path.dirname(target), dirName);
  const results = await Promise.all(images.map((im) => (
    String(im.src).startsWith('data:')                    // canvas snapshots / serialized svg / data imgs
      ? Promise.resolve(decodeDataUrl(im.src))
      : fetchImage(win.webContents.session, im.src)
  )));
  let made = false, n = 0;
  results.forEach((res, i) => {
    if (!res) return;                                     // leftover tokens are scrubbed below
    if (!made) { fs.mkdirSync(dir, { recursive: true }); made = true; }
    const name = `img_${++n}.${res.ext}`;
    fs.writeFileSync(path.join(dir, name), res.data);
    markdown = markdown.replace(
      new RegExp(`!\\[([^\\]]*)\\]\\(${images[i].token}\\)`),
      `![$1](${encodeURI(`${dirName}/${name}`)})`
    );
  });
  return scrub(markdown);
}

// DEBUG (Cmd+Shift+D): write ai_preload §7's structural outline of the live answer DOM to a .txt
// next to the transcripts — for diagnosing constructs the walker mishandles (math, headings,
// images…). Same request/timeout pattern as requestTranscript above.
let dumpReqSeq = 0;
const dumpWaiters = new Map();
ipcMain.on('dom-dump', (_e, reqId, text, err) => {
  const resolve = dumpWaiters.get(reqId);
  if (!resolve) return;
  dumpWaiters.delete(reqId);
  resolve(err ? `(dump error)\n${err}` : (text || '(empty dump)'));
});
async function dumpDomToFile(win) {
  if (!win || win.isDestroyed()) return;
  const text = await new Promise((resolve) => {
    const id = ++dumpReqSeq;
    dumpWaiters.set(id, resolve);
    try { win.webContents.send('dump-dom', id); } catch (e) { /* the timeout resolves */ }
    setTimeout(() => {
      if (dumpWaiters.has(id)) { dumpWaiters.delete(id); resolve('(no reply from preload)'); }
    }, 4000);
  });
  const dir = (win._savedPath && path.dirname(win._savedPath)) || settings.lastSaveDir || app.getPath('documents');
  const target = path.join(dir, autoFileName('dom dump').replace(/\.md$/, '.txt'));
  try {
    fs.writeFileSync(target, text);
    if (!win.isDestroyed()) win.webContents.send('transcript-saved', path.basename(dir));
  } catch (e) {
    if (DEBUG_SUMMON) dwarn('[dump] failed', String(e));
  }
}

function buildTranscriptMarkdown(question, answer) {
  const stamp = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  // Title must be a single clean line — a pasted multi-line/code first query would otherwise break
  // the YAML (the full query still appears, as the first labeled turn callout in the body).
  const oneLine = String(question || 'AI Mode query').replace(/\s+/g, ' ').trim();
  const title = (oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine) || 'AI Mode query';
  // Header = the title as a real H1, FIRST on the page, then a one-row "Saved" table with the
  // timestamp. NOT YAML front matter: tried 2026-07-23, tried again 2026-07-27 — front matter is
  // positional (it only counts with NOTHING above it), so it forces the metadata above the title
  // and, to avoid printing the query three times, costs you the H1 altogether. The user's verdict
  // both times was that it reads unevenly. A plain GFM table can sit below the title; front matter
  // can't. Don't propose it a third time. "Saved" is capitalized because it's display text now,
  // not a front-matter key. No source URL (the share link only re-runs the first prompt and its
  // session token won't reload the thread); the opening message appears in full as the first
  // [!NOTE] callout even though the title cuts at 120ch.
  const header = [`# ${title}`, '', `| Saved | ${stamp} |`, '| --- | --- |', ''].join('\n');
  return `${header}\n${answer || '_(Answer text not captured.)_'}\n`;
}

// Save the current query's transcript. First save (or Save As) prompts with a native box at the
// remembered folder; a re-save writes the same file silently. Updates the remembered folder.
async function saveTranscript(win, opts) {
  if (!win || win.isDestroyed()) { if (DEBUG_SUMMON) dlog('[save] no window'); return; }
  const saveAs = !!(opts && opts.saveAs);
  const question = win._query || 'AI Mode query';
  if (DEBUG_SUMMON) dlog('[save] start', JSON.stringify({ saveAs, hasPath: !!win._savedPath, question }));

  let target = (!saveAs && win._savedPath) ? win._savedPath : null;
  if (!target) {
    const dir = settings.lastSaveDir || app.getPath('documents');
    let res;
    try {
      res = await dialog.showSaveDialog(win, {
        title: 'Save transcript',
        defaultPath: path.join(dir, autoFileName(question)),
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      });
    } catch (e) { if (DEBUG_SUMMON) dwarn('[save] dialog threw', String(e)); return; }
    if (!res || res.canceled || !res.filePath) { if (DEBUG_SUMMON) dlog('[save] dialog canceled'); return; }
    target = res.filePath;
    win._savedPath = target;
    settings.lastSaveDir = path.dirname(target); // remember for the next query's first save
    saveSettings();
    buildTrayMenu();                              // surface "Open Last Save Folder" once we have one
  }

  const { answer, images } = await requestTranscript(win);
  try {
    let markdown = buildTranscriptMarkdown(question, answer);
    try {
      markdown = await materializeImages(markdown, images, target, win);
    } catch (e) { if (DEBUG_SUMMON) dwarn('[save] images failed', String(e)); }
    fs.writeFileSync(target, markdown);
    if (!win.isDestroyed()) win.webContents.send('transcript-saved', path.basename(path.dirname(target)));
    if (DEBUG_SUMMON) dlog('[save] wrote', target);
  } catch (e) {
    if (DEBUG_SUMMON) dwarn('[save] failed', String(e));
  }
}

// What a private session inherits, so Google doesn't treat it as a bot.
//
// This started out copying ONLY `GOOGLE_ABUSE_EXEMPTION`, on the theory that it was the token
// keeping us past the "unusual traffic" gate. That was wrong, and private windows got CAPTCHA'd
// anyway: inspecting the real jar on 2026-07-28 showed NO such cookie exists — it is issued only
// when you actually solve a CAPTCHA. What the normal session actually carries is the ordinary
// google.com jar (AEC, NID, SNID, __Secure-STRP, DV, OTZ), and a brand-new session having none of
// it is precisely what looks automated.
//
// So we copy the google.com jar. THE COST, stated plainly because it is the whole privacy story:
// NID is a stable identifier, so Google can link a private query to your normal session. Private
// mode here means "leaves nothing on this machine" — no history entry, no draft, no disk cookies
// or cache, nothing surviving the window. It has never meant, and now definitely does not mean,
// unlinkable from Google's side.
//
// To narrow it, restrict the filter below (e.g. names AEC + SNID + __Secure-STRP, dropping NID)
// and see whether the gate still lets you through — untested, and the failure mode is a CAPTCHA,
// not a broken app.
async function seedPrivateCookies(ses) {
  try {
    const jar = await session.fromPartition(PARTITION).cookies.get({ domain: 'google.com' });
    let ok = 0;
    for (const c of jar) {
      const host = String(c.domain || 'google.com').replace(/^\./, '');
      try {
        await ses.cookies.set({
          url: `https://${host}${c.path || '/'}`,
          name: c.name, value: c.value,
          // Host-only cookies must NOT carry a domain, or Chromium rejects the write.
          ...(String(c.domain || '').startsWith('.') ? { domain: c.domain } : {}),
          path: c.path, secure: c.secure, httpOnly: c.httpOnly,
          expirationDate: c.expirationDate, sameSite: c.sameSite
        });
        ok++;
      } catch (e) {
        dwarn('[private] cookie rejected:', c.name, String(e));
      }
    }
    // Always logged, not gated behind DEBUG_SUMMON: the previous version failed SILENTLY, and the
    // only symptom was a CAPTCHA appearing minutes later with nothing to point at.
    dlog(`[private] seeded ${ok}/${jar.length} google.com cookies`);
    if (!ok) dwarn('[private] nothing seeded — expect the "unusual traffic" CAPTCHA');
    return ok;
  } catch (e) {
    dwarn('[private] could not read the cookie jar', String(e));
    return 0;   // worst case: you solve a CAPTCHA. Never a reason to block the query.
  }
}

async function showAiMode(query, opts) {
  const url = chatUrl(query); // udm=50 — see the const up top
  const wantPrivate = !!(opts && opts.private);

  // A window's session partition is fixed at creation, so switching modes CANNOT reuse the window:
  // it has to be torn down and rebuilt. That discards whatever conversation was in it — the same
  // cost any new query already pays (a reused window is replaced via loadURL), just less obvious.
  if (aiWindow && !aiWindow.isDestroyed() && !!aiWindow._private !== wantPrivate) {
    const old = aiWindow;
    aiWindow = null;              // clear first so 'closed' handlers don't fight us
    old.destroy();
  }

  const reused = !!aiWindow; // diagnostic: was an existing AI window reused, or created fresh?

  if (!aiWindow) {
    const partition = wantPrivate ? nextPrivatePartition() : PARTITION;
    const useSaved = settings.persistAiBounds && validBounds(settings.aiBounds);
    aiWindow = new BrowserWindow({
      width: useSaved ? settings.aiBounds.width : DEFAULT_AI_BOUNDS.width,
      height: useSaved ? settings.aiBounds.height : DEFAULT_AI_BOUNDS.height,
      ...(useSaved ? { x: settings.aiBounds.x, y: settings.aiBounds.y } : {}),
      show: false,
      webPreferences: {
        partition,
        preload: path.join(__dirname, 'ai_preload.js'),
        spellcheck: false
      }
    });
    aiWindow._private = wantPrivate;
    // A private partition is brand new, so it needs the same hardening the persistent one gets at
    // startup (deny all permissions, force en-US, clean UA) — otherwise private windows would be
    // LESS locked down than normal ones.
    if (wantPrivate) hardenSession(session.fromPartition(partition));
    // Remember size/position across opens (debounced; flushed on close). Gated by the
    // "Remember window size & position" setting; Settings → Reset clears it to the default.
    aiWindow.on('resize', () => { saveAiBounds(false); positionFindBar(); });
    aiWindow.on('move', () => { saveAiBounds(false); positionFindBar(); });
    aiWindow.on('close', () => saveAiBounds(true));
    // UA is set at the session level in hardenSession() (also covers subresources).
    aiWindow.on('closed', () => {
      if (findBarWin && !findBarWin.isDestroyed()) findBarWin.destroy();
      findBarWin = null;
      aiWindow = null;
      setAccessory();
      if (DEBUG_SUMMON) dlog('[dock] hide → accessory (menu-bar only)');
      enforceCacheCap(); // trim cache back under the "max saved data" limit
    });

    // Clicking into the AI window should dismiss the launcher too — its own 'blur' doesn't
    // fire for same-app focus changes, which is why clicking it currently leaves it open.
    aiWindow.on('focus', () => { if (launcher && !launcher.isDestroyed() && launcher.isVisible()) hideLauncher(); });

    // Keep the app on AI Mode; EXTERNAL links are copied to the clipboard, never opened.
    // Loose filter (any google.com host stays in-window) — AI Mode routes through several.
    aiWindow.webContents.on('will-navigate', (e, u) => {
      if (!isGoogleHost(unwrapGoogleRedirect(u))) { e.preventDefault(); copyLink(u); }
    });
    aiWindow.webContents.setWindowOpenHandler(({ url: u }) => {
      copyLink(u);            // a new tab/window would be an external link — copy it instead
      return { action: 'deny' };
    });

    // Cmd+Ctrl+D looks the selection up in the macOS dictionary; Cmd+Q/W close this window (app
    // stays alive); Cmd+S saves the transcript, Cmd+Shift+S = Save As;
    // Cmd+Shift+D writes a DOM-outline debug dump; Cmd+F opens the find bar (its own child window —
    // see "Find-in-page" below), Cmd+G / Cmd+Shift+G step to next / previous match, Esc closes the
    // bar if it's open.
    aiWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'Escape' && findBarVisible()) {
        event.preventDefault();
        closeFindBar();
        return;
      }
      if (!input.meta) return;
      const k = (input.key || '').toLowerCase();
      if (input.control && k === 'd') {
        event.preventDefault();          // ⌃⌘D — macOS's own "Look Up" shortcut
        aiWindow.webContents.showDefinitionForSelection();
        return;
      }
      if (k === ',') {
        event.preventDefault();   // ⌘, — Settings, as in every other Mac app
        openSettings();
      } else if (k === 'q' || k === 'w') {
        event.preventDefault();
        if (aiWindow) aiWindow.close();
      } else if (k === 's') {
        event.preventDefault();
        if (DEBUG_SUMMON) dlog('[save] Cmd+S', input.shift ? '(Save As)' : '');
        saveTranscript(aiWindow, { saveAs: input.shift });
      } else if (k === 'd' && input.shift) {
        event.preventDefault();
        dumpDomToFile(aiWindow);   // DEBUG: dump the answer DOM outline next to the transcripts
      } else if (k === 'f') {
        event.preventDefault();
        openFindBar();
      } else if (k === 'g') {
        event.preventDefault();
        if (findBarVisible()) findBarWin.webContents.send('find:again', !!input.shift);
        else openFindBar();
      }
    });

    // Feed Electron's find-in-page results (match counts) to the find bar window. Chromium streams
    // several events per search — partial counts while it scans outward from the scroll position,
    // with only the last flagged finalUpdate — so tag them and drop anything that isn't from the
    // latest findInPage request (stale results otherwise show varying/wrong totals).
    aiWindow.webContents.on('found-in-page', (_e, result) => {
      if (!aiWindow || aiWindow.isDestroyed()) return;
      if (result.requestId !== findRequests.get(aiWindow.webContents)) return;
      if (findBarWin && !findBarWin.isDestroyed()) {
        findBarWin.webContents.send('find:result', {
          matches: result.matches,
          active: Math.max(0, result.activeMatchOrdinal || 0),
          final: !!result.finalUpdate,
        });
      }
      // Chromium won't scroll to a match that's inside the viewport but hidden behind the
      // page's sticky top rail / fixed bottom input box ("visible" to the find machinery).
      // Hand the active match's rect to the preload, which nudges the scroller if an
      // overlay is actually covering it.
      if (result.finalUpdate && result.matches > 0 && result.selectionArea && result.selectionArea.height) {
        aiWindow.webContents.send('find-nudge', result.selectionArea);
      }
    });

    installContextMenu(aiWindow);

    // Load-health: if a navigation doesn't come up as AI Mode, show the crash-report overlay
    // instead of silently presenting normal results. Both listeners are gated by pendingCheck
    // (set in showAiMode just before loadURL), so they fire once per query and ignore in-page
    // follow-up navigation.
    aiWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!pendingCheck || !isMainFrame || code === -3) return; // -3 = ABORTED (superseded nav)
      const ctx = pendingCheck; pendingCheck = null;
      triggerLoadError({ type: 'network', code, desc, finalURL: url || ctx.url }, ctx);
    });
    aiWindow.webContents.on('did-stop-loading', async () => {
      if (!pendingCheck) return;
      let probe = null;
      try { probe = await aiWindow.webContents.executeJavaScript(SURFACE_PROBE, true); } catch (_) {}
      const finalURL = (aiWindow && !aiWindow.isDestroyed()) ? aiWindow.webContents.getURL() : pendingCheck.url;
      // A captcha / "unusual traffic" page is Google's own INTERACTIVE interstitial, not a
      // silent failure — never cover it. Leave it fully usable and stay armed; once you solve
      // it Google continues to the real page and we check THAT instead.
      if (probe && probe.looksSorry) {
        if (DEBUG_SUMMON) dlog('[load-check] captcha — left interactive, still watching', JSON.stringify({ finalURL }));
        return; // do NOT consume pendingCheck
      }
      const ctx = pendingCheck; pendingCheck = null;
      const fail = diagnoseLoad(probe, finalURL);
      if (DEBUG_SUMMON) dlog('[load-check]', fail ? 'FAIL' : 'ok', JSON.stringify({ finalURL, probe }));
      if (fail) triggerLoadError({ ...fail, finalURL }, ctx);
    });

    // Fresh window: bring it forward only once it has painted (kills the blank-white flash).
    aiWindow.once('ready-to-show', () => bringForward(aiWindow, true));

    // Re-announce private mode on EVERY navigation: the preload is recreated per page load, so a
    // one-shot message would vanish the moment you asked a follow-up.
    if (wantPrivate) {
      aiWindow.webContents.on('did-finish-load', () => {
        if (aiWindow && !aiWindow.isDestroyed()) aiWindow.webContents.send('private-mode');
      });
    }
  }

  if (DEBUG_SUMMON) {
    dlog('[ai] open', JSON.stringify({
      reused,
      cursorDisplay: screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id,
      displays: screen.getAllDisplays().length
    }));
  }

  lastQuery = query;
  lastQueryPrivate = wantPrivate;  // so the crash overlay's Retry reopens in the SAME mode
  aiWindow._query = query;
  aiWindow._questions = [query];  // this turn + in-page follow-ups (page-question); used to label the transcript
  aiWindow._savedPath = null;     // a new top-level query is a new document (Cmd+S will prompt)
  pendingCheck = { url, query };  // arms the load-health listeners for THIS navigation
  // Seed before the FIRST navigation of a fresh private window, or that query eats a CAPTCHA.
  if (wantPrivate && !reused) await seedPrivateCookies(aiWindow.webContents.session);
  if (!aiWindow || aiWindow.isDestroyed()) return; // the await gave the user time to close it
  // Superseded navigations (a second query fired while this one loads) reject with ERR_ABORTED.
  // Harmless, but now that we're inside an async function it would surface as an unhandled
  // rejection instead of dying quietly.
  aiWindow.loadURL(url).catch(() => {});
  // Reused window: bring it forward once the NEW answer has loaded, so we don't flash the
  // previous answer. (Fresh windows are handled by 'ready-to-show' wired at creation above.)
  if (reused) aiWindow.webContents.once('did-stop-loading', () => bringForward(aiWindow, false));
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Load settings before 'ready' so the disk-cache cap (a Chromium startup switch) is in place
// before the first session is created.
loadSettings();
applyCacheLimit();

app.whenReady().then(() => {
  setAccessory(); // menu-bar-only app at startup: no Dock icon, out of Cmd+Tab

  // Harden the AI partition (where Google loads) and the default session (launcher):
  // deny all permissions, force en-US, set the clean Chrome UA.
  hardenSession(session.fromPartition(PARTITION));
  hardenSession(session.defaultSession);

  loadHistory();
  const hk = applyHotkey();          // register before the tray so it reflects the real state
  createTray();
  dlog(`[${APP_NAME}] ready — hotkey: ${hk.registered || (settings.hotkeyEnabled ? 'UNAVAILABLE (taken?)' : 'disabled')}`);

  // Track whether we're the frontmost app (governs whether summon needs to steal focus).
  app.on('did-become-active', () => { appActive = true; if (DEBUG_SUMMON) dlog('[app] became active'); });
  app.on('did-resign-active', () => { appActive = false; if (DEBUG_SUMMON) dlog('[app] resigned active'); });

  // Verbose event tracing to correlate the Space-jump with focus/activation events.
  if (DEBUG_SUMMON) {
    const wn = (w) => (w === launcher ? 'launcher' : w === aiWindow ? 'ai' : w === settingsWin ? 'settings' : `#${w && w.id}`);
    app.on('browser-window-focus', (_e, w) => dlog('[focus]', wn(w)));
    app.on('browser-window-blur', (_e, w) => dlog('[blur] ', wn(w)));
  }
});

// Launcher submit → remember in history + open AI Mode.
ipcMain.on('submit-query', (_e, payload) => {
  hideLauncher();
  lastDraft = clearedDraft = ''; // submitted text belongs to history (↓), not to the draft slots
  // Tolerate the old string form so a stale renderer can't wedge submission.
  const isPrivate = !!(payload && typeof payload === 'object' && payload.private);
  const q = String((payload && typeof payload === 'object' ? payload.query : payload) || '').trim();
  if (!q) { setAccessory(); return; } // nothing is opening — drop the Dock icon reveal() added
  if (!isPrivate) addHistory(q); // a private query leaves no trace in the recall list
  showAiMode(q, { private: isPrivate }).catch((e) => derror('[ai] open failed', String(e)));
});

// Escape / explicit dismiss — hands focus back to the app you came from.
ipcMain.on('hide-launcher', () => hideLauncher(true));

// History dropdown: fetch matches, delete an entry, and grow/shrink the bar.
ipcMain.handle('history:get', (_e, query) => filterHistory(query));
ipcMain.handle('history:delete', (_e, { text, query }) => { removeHistory(text); return filterHistory(query); });
ipcMain.on('launcher:resize', (_e, height) => {
  if (!launcher || launcher.isDestroyed()) return;
  const [w] = launcher.getSize();
  launcher.setSize(w, Math.max(72, Math.min(600, Math.round(height))));
});

// The bar mirrors its text here on EVERY edit, so what we hold is always the box's current
// content rather than a guess about which edit mattered. The non-empty → empty transition is the
// interesting one: that's a clear, so the text that just vanished becomes what ⌘Z offers back.
// (Faithful for an atomic clear — Escape, or select-all then delete. Backspacing to empty one
// character at a time leaves only the last character, since we have no real undo stack out here;
// in-session ⌘Z still walks those edits properly inside the renderer.)
ipcMain.on('draft:save', (_e, text) => {
  const v = (typeof text === 'string' && text.trim()) ? text : '';
  if (!v && lastDraft) clearedDraft = lastDraft;
  lastDraft = v;
});
ipcMain.handle('draft:cleared', () => clearedDraft);
ipcMain.on('mode:set', (_e, isPrivate) => { lastPrivate = !!isPrivate; });

// Settings window: read current settings, save + apply, close.
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:save', (_e, incoming) => {
  if (incoming && typeof incoming === 'object') {
    if (typeof incoming.hotkey === 'string' && incoming.hotkey) settings.hotkey = incoming.hotkey;
    if (typeof incoming.hotkeyFallback === 'string') { settings.hotkeyFallback = incoming.hotkeyFallback; settings.fallbackInitialized = true; }
    if (typeof incoming.hotkeyEnabled === 'boolean') settings.hotkeyEnabled = incoming.hotkeyEnabled;
    if (typeof incoming.maxCacheMB === 'number' && isFinite(incoming.maxCacheMB)) settings.maxCacheMB = Math.max(0, Math.min(4096, incoming.maxCacheMB));
    if (typeof incoming.persistAiBounds === 'boolean') settings.persistAiBounds = incoming.persistAiBounds;
    if (typeof incoming.rewriteRedditLinks === 'boolean') settings.rewriteRedditLinks = incoming.rewriteRedditLinks;
  }
  saveSettings();
  enforceCacheCap(); // trim now if the new (possibly lower) cap is already exceeded
  const result = applyHotkey();
  buildTrayMenu();
  return { ...result, settings };
});

// Settings → "Reset window": forget saved bounds and, if the window is open, snap it back to
// the default size and re-center it (position included).
ipcMain.handle('settings:resetAiBounds', () => {
  settings.aiBounds = null;
  saveSettings();
  if (aiWindow && !aiWindow.isDestroyed()) {
    aiWindow.setSize(DEFAULT_AI_BOUNDS.width, DEFAULT_AI_BOUNDS.height);
    aiWindow.center();
  }
  return { ok: true };
});

// Settings → Clear cache. Reports the on-disk AI Mode cache size, and clears the HTTP +
// compiled-code caches on demand. Cookies are NOT touched, so the captcha exemption survives.
ipcMain.handle('cache:size', async () => humanSize(await aiCacheBytes()));
ipcMain.handle('cache:clear', async () => {
  const ses = session.fromPartition(PARTITION);
  try { await ses.clearCache(); } catch (_) {}
  try { await ses.clearCodeCaches({}); } catch (_) {}
  return humanSize(await aiCacheBytes());
});

// Settings → Clear cookies. Wipes the AI Mode partition's cookie jar — INCLUDING Google's
// abuse-exemption cookie, so the next launch may hit the "unusual traffic" captcha again. This
// is the only in-app way to clear that token; cache clearing deliberately leaves it alone.
ipcMain.handle('cookies:size', async () => humanSize(await aiCookieBytes()));
ipcMain.handle('cookies:clear', async () => {
  const ses = session.fromPartition(PARTITION);
  try { await ses.clearStorageData({ storages: ['cookies'] }); } catch (_) {}
  return humanSize(await aiCookieBytes());
});
ipcMain.on('settings:close', () => { if (settingsWin) settingsWin.close(); });

// Follow-up questions typed directly into the AI Mode page (captured generically).
ipcMain.on('page-question', (e, query) => {
  const q = (query || '').trim();
  if (!q) return;
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && Array.isArray(win._questions) && win._questions[win._questions.length - 1] !== q) {
    win._questions.push(q); // remember the turn so the transcript can label who asked what
  }
});

// AI Mode load-failure overlay: Copy the crash report to the clipboard, or Retry the query.
ipcMain.on('load-error:copy', () => { if (lastReport) clipboard.writeText(lastReport); });
ipcMain.on('load-error:retry', () => {
  if (lastQuery) showAiMode(lastQuery, { private: lastQueryPrivate }).catch((e) => derror('[ai] retry failed', String(e)));
});

// "Show in Finder" from the saved toast: reveal the transcript this window wrote.
ipcMain.on('reveal-saved', (e) => revealSaved(BrowserWindow.fromWebContents(e.sender)));

// Find-in-page (Cmd+F). Electron ships findInPage() but NO find-bar UI, and findInPage steals
// in-page focus on every call — so a bar rendered INSIDE the searched page loses its input focus
// each search and fights the page forever (tried; unwinnable). Instead the bar lives in its own
// tiny frameless CHILD window (find_bar.html), pinned to the AI window's top-right — Chrome's own
// architecture, where the find UI is browser chrome outside the page. findInPage never changes
// OS-level window focus, so the bar keeps the keyboard unconditionally.
// findRequests remembers the searched webContents' latest findInPage request id so the
// 'found-in-page' listener can drop trailing results from a superseded search.
const findRequests = new WeakMap();
const FIND_BAR_W = 340, FIND_BAR_H = 40;

function findBarVisible() {
  return !!(findBarWin && !findBarWin.isDestroyed() && findBarWin.isVisible());
}

// Pin the bar to the AI window's top-right, inside the content area (tracks move/resize).
function positionFindBar() {
  if (!findBarWin || findBarWin.isDestroyed() || !aiWindow || aiWindow.isDestroyed()) return;
  const b = aiWindow.getContentBounds();
  findBarWin.setPosition(b.x + b.width - FIND_BAR_W - 16, b.y + 12);
}

function openFindBar() {
  if (!aiWindow || aiWindow.isDestroyed()) return;
  if (!findBarWin || findBarWin.isDestroyed()) {
    findBarWin = new BrowserWindow({
      width: FIND_BAR_W, height: FIND_BAR_H,
      parent: aiWindow,
      frame: false, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false,
      show: false, skipTaskbar: true, roundedCorners: true,
      backgroundColor: '#2b2b2f',
      // Local file we author (find_bar.html), never remote content — plain nodeIntegration is fine.
      webPreferences: { nodeIntegration: true, contextIsolation: false, spellcheck: false }
    });
    findBarWin.loadFile(path.join(__dirname, 'find_bar.html'));
    // Cmd shortcuts still work while the bar (its own window) has the keyboard.
    findBarWin.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !input.meta) return;
      const k = (input.key || '').toLowerCase();
      if (k === 'f') { event.preventDefault(); findBarWin.webContents.send('find:open'); }
      else if (k === 'g') { event.preventDefault(); findBarWin.webContents.send('find:again', !!input.shift); }
      else if (k === 'q' || k === 'w') { event.preventDefault(); if (aiWindow) aiWindow.close(); }
      else if (k === 's') { event.preventDefault(); if (aiWindow) saveTranscript(aiWindow, { saveAs: input.shift }); }
      else if (k === ',') { event.preventDefault(); openSettings(); }
    });
  }
  positionFindBar();
  findBarWin.show();                              // takes key focus, and keeps it: findInPage can't touch it
  findBarWin.webContents.send('find:open');       // focus + select the query (no-op if still loading; the
                                                  // bar focuses its input on load/window-focus anyway)
}

// Hide the bar (kept alive so the query survives reopen) and hand the keyboard back to the page.
// keepSelection leaves you scrolled to (and selecting) the last match, like Chrome's Esc.
function closeFindBar() {
  if (findBarVisible()) findBarWin.hide();
  if (aiWindow && !aiWindow.isDestroyed()) {
    findRequests.delete(aiWindow.webContents);
    aiWindow.webContents.stopFindInPage('keepSelection');
    aiWindow.focus();
  }
}

// 'find' / 'find:stop' arrive from the bar window; the search target is its PARENT (the AI window).
function findTargetOf(sender) {
  const win = BrowserWindow.fromWebContents(sender);
  const target = win && !win.isDestroyed() ? (win.getParentWindow() || win) : null;
  return target && !target.isDestroyed() ? target : null;
}
ipcMain.on('find', (e, opts) => {
  const target = findTargetOf(e.sender);
  if (!target) return;
  const { text, findNext, forward } = opts || {};
  if (!text) { findRequests.delete(target.webContents); target.webContents.stopFindInPage('clearSelection'); return; }
  findRequests.set(target.webContents, target.webContents.findInPage(text, { findNext: !!findNext, forward: forward !== false }));
});
ipcMain.on('find:stop', (e) => {
  const target = findTargetOf(e.sender);
  if (!target) return;
  findRequests.delete(target.webContents);
  target.webContents.stopFindInPage('clearSelection');
});
ipcMain.on('find:close', () => closeFindBar());

app.on('will-quit', () => globalShortcut.unregisterAll());

// Stay alive as a menu-bar app even when the AI window is closed. Quitting is done
// from the tray (right-click ✦ → Quit); closing the AI window must NOT quit the app.
app.on('window-all-closed', () => { /* intentionally no-op: the tray keeps us running */ });
