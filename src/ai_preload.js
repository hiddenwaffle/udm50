'use strict';
// Preload for the AI Mode window. All DOM-only so it works under the window's default
// sandbox (a sandboxed preload can't require local modules):
//   1. DOM-agnostic capture of YOUR questions (no Google selectors).
//   2. Focus the page (not the input) on load, so arrow keys scroll immediately.
//   3. Firefox-style middle-click autoscroll (Chromium/macOS lacks it natively).
//   4. "Saved ✓" / "Link copied" banners (links are copied, never opened in a browser).
//   5. Predictable PageUp/PageDown/Space paging that keeps overlap (no skipped content).
//   6. A copy-pasteable "AI Mode didn't load" crash-report overlay when a page comes up wrong.
//   7. On-demand capture of the answer DOM into clean Markdown (for the Cmd+S transcript save).
//   8. A Chrome-style find-in-page bar (Cmd+F) — Electron has no built-in one.

const { ipcRenderer } = require('electron');

// ===========================================================================
// 1. Question capture — reads the focused editable at submit time.
// ===========================================================================

let lastNonEmpty = '';   // last non-empty text seen in the focused editable
let lastLogged = '';     // dedup: last thing we sent
let lastLoggedAt = 0;

function isEditable(el) {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

function readText(el) {
  if (!el) return '';
  // Prefer forms that keep line breaks: textarea/input .value, else contenteditable .innerText.
  // (textContent flattens a pasted multi-line snippet / terminal dump into one run.)
  const t = ('value' in el && typeof el.value === 'string') ? el.value
    : (typeof el.innerText === 'string' ? el.innerText : el.textContent);
  return (t || '').trim();
}

function isVisible(el) {
  if (!el || el.disabled || el.readOnly) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
}

// Generic "the input box" finder — text-entry elements by web semantics only (no Google
// selectors). If several are visible, pick the most prominent (largest) one.
function findPrimaryInput() {
  const sel = 'textarea, input[type="text"], input[type="search"], input:not([type]),' +
    ' [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="combobox"]';
  const visible = Array.from(document.querySelectorAll(sel)).filter(isVisible);
  if (visible.length <= 1) return visible[0] || null;
  visible.sort((a, b) => {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return (rb.width * rb.height) - (ra.width * ra.height);
  });
  return visible[0];
}

function moveCaretToEnd(el) {
  try {
    if (typeof el.setSelectionRange === 'function' && typeof el.value === 'string') {
      el.setSelectionRange(el.value.length, el.value.length);
    } else if (el.isContentEditable) {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
    }
  } catch (_) {}
}

// Brief glow-ring around an element — visual confirmation that the hotkey focused the box.
function pulseInput(el) {
  try {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const ring = document.createElement('div');
    ring.style.cssText = [
      'position:fixed', `left:${Math.round(r.left - 4)}px`, `top:${Math.round(r.top - 4)}px`,
      `width:${Math.round(r.width + 8)}px`, `height:${Math.round(r.height + 8)}px`,
      'border-radius:14px', 'pointer-events:none', 'z-index:2147483647',
      'box-shadow:0 0 0 3px rgba(76,141,255,0.9), 0 0 16px 5px rgba(76,141,255,0.45)',
      'opacity:1', 'transition:opacity .55s ease'
    ].join(';');
    (document.body || document.documentElement).appendChild(ring);
    requestAnimationFrame(() => { ring.style.opacity = '0'; });
    setTimeout(() => ring.remove(), 650);
  } catch (_) {}
}

function submitQuestion(text) {
  const t = (text || '').trim();
  if (!t) return;
  const now = Date.now();
  if (t === lastLogged && now - lastLoggedAt < 4000) return; // dedup near-simultaneous signals
  lastLogged = t;
  lastLoggedAt = now;
  ipcRenderer.send('page-question', t);
}

// Heuristic 1: Enter committed in a focused editable.
// Ignore Shift+Enter (newline) and IME composition (mid-word).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  const el = document.activeElement;
  if (!isEditable(el)) return;
  const t = readText(el);
  if (t) submitQuestion(t);
}, true);

// Heuristic 2: a focused editable that HAD text suddenly empties => it was submitted.
// Covers a click-to-send button, or a contenteditable where Enter inserts a newline.
// BUT ignore emptying caused by a USER deletion (backspace / select-all-delete / cut) —
// otherwise rephrasing a question logs one you never asked.
document.addEventListener('input', (e) => {
  const el = document.activeElement;
  if (!isEditable(el)) return;
  const cur = readText(el);
  if (cur) { lastNonEmpty = cur; return; }
  const userDeleted = typeof e.inputType === 'string' && e.inputType.startsWith('delete');
  if (lastNonEmpty && !userDeleted) submitQuestion(lastNonEmpty);
  lastNonEmpty = '';
}, true);

// ===========================================================================
// 2. Focus management. Focus the PAGE (not the input) when a query view loads AND
//    right after you submit — so arrow keys / Space / PgDn scroll the answer
//    immediately. Google auto-focuses its "Ask anything" box; we blur it during a
//    short grace window unless you deliberately click/type into it. Tab (alone) jumps
//    into the input box; Enter submits and then hands focus back to the page.
// ===========================================================================

(function pageFocusManager() {
  const GRACE = 2500;   // ms to keep blurring auto-focus after a load or a submit
  let engaged = false;  // you're deliberately in a box right now
  let hijackUntil = 0;  // blur editable auto-focus while Date.now() < hijackUntil
  let blurs = 0;        // per-window cap so we never war with Google

  function grabPage() {                        // blur the box, reclaim the page for scrolling
    engaged = false;
    hijackUntil = Date.now() + GRACE;
    blurs = 0;
    if (isEditable(document.activeElement)) document.activeElement.blur();
  }

  document.addEventListener('focusin', (e) => {
    if (!engaged && blurs < 12 && Date.now() < hijackUntil && isEditable(e.target)) {
      e.target.blur();
      blurs++;
    }
  }, true);

  document.addEventListener('mousedown', () => { engaged = true; }, true); // clicking a box = intent

  document.addEventListener('keydown', (e) => {
    // Tab (alone) jumps straight into the input box, skipping other UI elements.
    if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !isEditable(document.activeElement)) {
      const input = findPrimaryInput();
      if (input) {
        e.preventDefault();
        e.stopPropagation();
        engaged = true; hijackUntil = 0;       // deliberately entering the box
        input.focus();
        moveCaretToEnd(input);
      }
      return;
    }
    // Enter inside the box submits -> reclaim the page so arrows scroll the new answer.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && isEditable(document.activeElement)) {
      setTimeout(grabPage, 60);                // let Google process the submit first
      return;
    }
    // Typing a real character means you want the box; scroll/paging keys don't.
    if (e.key.length === 1 && e.key !== ' ') { engaged = true; hijackUntil = 0; }
  }, true);

  // Warm summon: the global hotkey, pressed while this window is focused, focuses the input
  // box here in-page — no separate launcher window pops up to fight for focus.
  ipcRenderer.on('focus-input', () => {
    const input = findPrimaryInput();
    if (input) {
      engaged = true; hijackUntil = 0;
      input.focus();
      moveCaretToEnd(input);
      pulseInput(input); // visible confirmation the hotkey landed on the box
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', grabPage, { once: true });
  else grabPage();
  window.addEventListener('load', () => setTimeout(grabPage, 0), { once: true });
})();

// ===========================================================================
// 3. Autoscroll — middle-click drops an anchor; moving the mouse scrolls in any
//    direction, speed grows with distance^1.5 (ported from Firefox). Click again / Escape / wheel exits.
// ===========================================================================

(function installAutoscroll() {
  let active = false;
  let originX = 0, originY = 0, curX = 0, curY = 0;
  let accX = 0, accY = 0;                 // sub-pixel accumulators (so slow pans still move)
  let scroller = null, indicator = null, rafId = 0, stoppedAt = 0, lastFrame = 0;

  // Ported from Firefox's autoscroll (toolkit/actors/AutoScrollChild.sys.mjs): each frame the
  // scroll step is accelerate(offset) × (Δt / 20ms). Speed grows with offset^1.5 and has NO upper
  // clamp, so shoving the mouse toward the edge scrolls fast, the way Firefox does.
  const SPEED_DIVISOR = 12;   // Firefox's `speed`; also the dead-zone radius (|offset| ≤ 12px ⇒ 0)
  const FRAME_BASELINE = 20;  // ms — Firefox normalizes to a 50fps step, scaling the delta by Δt/20
  const MAX_DT = 100;         // ms — cap Δt so a hang or blur can't produce one giant jump

  function accelerate(offset) {
    const val = offset / SPEED_DIVISOR;
    if (val > 1) return val * Math.sqrt(val) - 1;
    if (val < -1) return val * Math.sqrt(-val) + 1;
    return 0;
  }

  function nearestScroller(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = getComputedStyle(n);
      const y = (s.overflowY === 'auto' || s.overflowY === 'scroll') && n.scrollHeight > n.clientHeight + 1;
      const x = (s.overflowX === 'auto' || s.overflowX === 'scroll') && n.scrollWidth > n.clientWidth + 1;
      if (y || x) return n;
    }
    return document.scrollingElement || document.documentElement;
  }

  function makeIndicator() {
    const d = document.createElement('div');
    d.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'pointer-events:none',
      'width:26px', 'height:26px', 'margin:-13px 0 0 -13px', 'border-radius:50%',
      'border:2px solid rgba(128,128,128,0.9)', 'background:rgba(255,255,255,0.30)',
      'box-shadow:0 0 0 1px rgba(0,0,0,0.25)', `left:${originX}px`, `top:${originY}px`
    ].join(';');
    const dot = document.createElement('div');
    dot.style.cssText = 'position:absolute;left:50%;top:50%;width:4px;height:4px;margin:-2px 0 0 -2px;border-radius:50%;background:rgba(70,70,70,0.9)';
    d.appendChild(dot);
    (document.body || document.documentElement).appendChild(d);
    return d;
  }

  function loop(now) {
    if (!active) return;
    const comp = Math.min(MAX_DT, now - lastFrame) / FRAME_BASELINE;
    lastFrame = now;
    accX += accelerate(curX - originX) * comp;   // sub-pixel accumulators carry the remainder, so a
    accY += accelerate(curY - originY) * comp;   // slow pan still creeps instead of rounding to zero
    const ix = Math.trunc(accX), iy = Math.trunc(accY);
    if (ix || iy) { scroller.scrollBy(ix, iy); accX -= ix; accY -= iy; }
    rafId = requestAnimationFrame(loop);
  }

  function start(e) {
    active = true;
    originX = curX = e.clientX;
    originY = curY = e.clientY;
    accX = accY = 0;
    scroller = nearestScroller(e.target);
    indicator = makeIndicator();
    document.documentElement.style.cursor = 'all-scroll';
    lastFrame = performance.now();   // seed so the first frame's Δt is ~0, not a jump from zero
    rafId = requestAnimationFrame(loop);
  }

  function stop() {
    if (!active) return;
    active = false;
    stoppedAt = Date.now();
    cancelAnimationFrame(rafId);
    if (indicator && indicator.parentNode) indicator.parentNode.removeChild(indicator);
    indicator = null;
    document.documentElement.style.cursor = '';
  }

  document.addEventListener('mousedown', (e) => {
    if (active) { e.preventDefault(); e.stopPropagation(); stop(); return; } // any click exits
    if (e.button === 1) { e.preventDefault(); e.stopPropagation(); start(e); }
  }, true);

  document.addEventListener('mousemove', (e) => {
    if (active) { curX = e.clientX; curY = e.clientY; }
  }, true);

  // Suppress middle-click's default aux action (open-link-in-new-tab) and swallow the
  // click that exits autoscroll so it doesn't also activate a link.
  document.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); }, true);
  document.addEventListener('click', (e) => {
    if (active || Date.now() - stoppedAt < 250) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  document.addEventListener('keydown', (e) => { if (active && e.key === 'Escape') stop(); }, true);
  document.addEventListener('wheel', () => { if (active) stop(); }, true);
  window.addEventListener('blur', stop);
})();

// ===========================================================================
// 4. Banners — top-of-page confirmations ("Saved ✓", "Link copied"). Both cover the same
//    low-value chrome strip, and Esc dismisses either.
// ===========================================================================

// A URL is far longer than a folder name, so elide the MIDDLE: the host and the tail (the part
// that identifies a permalink) are the halves worth reading.
function elideUrl(u, max) {
  const s = String(u || '');
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) * 0.66);
  return `${s.slice(0, head)}…${s.slice(-(max - 1 - head))}`;
}

// Big light-green success banner across the TOP (that strip is low-value page chrome, so
// covering it is cheap). The folder name is underlined + clickable → reveal in Finder.
function showSavedBanner(folder) {
  let el = document.getElementById('__ai_saved_banner');
  if (!el) {
    el = document.createElement('div');
    el.id = '__ai_saved_banner';
    el.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
      'pointer-events:none', 'text-align:center',
      'padding:24px 28px', 'box-sizing:border-box',
      'background:#d6f5df', 'color:#12692e',
      'font:600 34px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'box-shadow:0 6px 24px rgba(0,0,0,0.18)',
      'opacity:0', 'transition:opacity .18s ease'
    ].join(';');
    (document.body || document.documentElement).appendChild(el);
  }
  el.textContent = 'Saved to ';
  const link = document.createElement('span');
  link.textContent = folder || 'folder';
  link.style.cssText = 'text-decoration:underline; cursor:pointer; pointer-events:auto;';
  link.onclick = () => { el.style.opacity = '0'; ipcRenderer.send('reveal-saved'); };
  el.appendChild(link);
  el.style.transition = 'opacity .18s ease'; // gentle appear/auto-fade (Esc overrides to a fast fade)
  el.style.opacity = '1';
  clearTimeout(el.__hideTimer);
  el.__hideTimer = setTimeout(() => { el.style.opacity = '0'; }, 4000);
}

// Same top-strip idiom as the saved banner so a copy is as hard to miss as a save, but toned
// down: blue instead of green (different event), smaller type, and the URL itself on a second
// line — which is what you actually want to check, especially when a rewrite changed it.
function showLinkBanner(url) {
  let el = document.getElementById('__ai_link_banner');
  if (!el) {
    el = document.createElement('div');
    el.id = '__ai_link_banner';
    el.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
      'pointer-events:none', 'text-align:center',
      'padding:14px 24px 16px', 'box-sizing:border-box',
      'background:#dce8ff', 'color:#123c78',
      'font:600 22px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'box-shadow:0 6px 24px rgba(0,0,0,0.18)',
      'opacity:0', 'transition:opacity .18s ease'
    ].join(';');
    (document.body || document.documentElement).appendChild(el);
  }
  el.textContent = 'Link copied';
  const detail = document.createElement('div');
  detail.textContent = elideUrl(url, 96);
  detail.style.cssText = [
    'margin-top:5px', 'opacity:0.78', 'white-space:nowrap', 'overflow:hidden',
    'font:400 13px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace'
  ].join(';');
  el.appendChild(detail);
  el.style.transition = 'opacity .18s ease';
  el.style.opacity = '1';
  clearTimeout(el.__hideTimer);
  el.__hideTimer = setTimeout(() => { el.style.opacity = '0'; }, 2600);
}

// Esc dismisses whichever banner is showing, with a near-instant fade.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const id of ['__ai_saved_banner', '__ai_link_banner']) {
    const el = document.getElementById(id);
    if (!el || el.style.opacity === '0') continue;
    clearTimeout(el.__hideTimer);
    el.style.transition = 'opacity 100ms linear';
    el.style.opacity = '0';
  }
}, true);

// A forget-mode window must be identifiable at a glance, or you cannot know whether what you are
// about to type is being kept. (Never labelled "private": this window's cookies are copied from
// the normal session, so Google sees it exactly as usual — what it guarantees is that THIS APP
// forgets it.) Bottom-left: clear of the top banners, of the find bar pinned
// top-right, and of Google's own input box at bottom-center. The `__ai` id prefix is what keeps it
// out of saved transcripts. Main re-sends this on every navigation, since the preload is recreated
// per page load; the guard makes the repeat a no-op.
ipcRenderer.on('private-mode', () => {
  if (document.getElementById('__ai_private_badge')) return;
  const el = document.createElement('div');
  el.id = '__ai_private_badge';
  el.textContent = 'NO MEMORY';
  el.style.cssText = [
    'position:fixed', 'left:14px', 'bottom:14px', 'z-index:2147483646', 'pointer-events:none',
    'font:700 11px/1 -apple-system,BlinkMacSystemFont,sans-serif', 'letter-spacing:0.1em',
    'padding:7px 11px', 'border-radius:999px',
    'background:rgba(40,26,66,0.92)', 'color:#d9c2ff',
    'border:1px solid rgba(180,140,255,0.45)', 'box-shadow:0 4px 14px rgba(0,0,0,0.4)'
  ].join(';');
  (document.body || document.documentElement).appendChild(el);
});

ipcRenderer.on('link-copied', (_e, url) => showLinkBanner(url));
ipcRenderer.on('transcript-saved', (_e, folder) => showSavedBanner(folder));

// ===========================================================================
// 5. Predictable paging. PageDown/PageUp (and Space / Shift+Space) scroll by a
//    fraction of the viewport so nothing is skipped past the sticky top bar / bottom
//    input. Chromium's default pages a full viewport, which overshoots the readable area.
// ===========================================================================

// The page's real scroller (the document, or AI Mode's biggest scrollable box). Shared by
// paging below and the find-in-page nudge after it.
let cachedScroller = null; // preload re-runs on navigation, so this is naturally per-page
function mainScroller() {
  if (cachedScroller && cachedScroller.isConnected &&
      cachedScroller.scrollHeight > cachedScroller.clientHeight + 1) return cachedScroller;
  const doc = document.scrollingElement || document.documentElement;
  if (doc && doc.scrollHeight > doc.clientHeight + 1) { cachedScroller = doc; return doc; }
  let best = doc, bestArea = -1;                       // fallback: biggest scrollable box (scan once, then cache)
  for (const el of document.querySelectorAll('*')) {
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    const s = getComputedStyle(el);
    if (s.overflowY !== 'auto' && s.overflowY !== 'scroll') continue;
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) { bestArea = area; best = el; }
  }
  cachedScroller = best;
  return best;
}

(function pageScroll() {
  const OVERLAP = 245;     // px kept visible from the previous view per page (covers the sticky
                           // top bar + bottom input). Raise to overlap more, lower to scroll farther.
  const DURATION = 160;    // ms per page — lower = faster (browser's built-in smooth is slower)
  let anim = null;

  // Custom smooth scroll with a short, fixed duration. Re-pressing retargets from the
  // current position (no stacking), so held/rapid paging stays crisp.
  function animateBy(sc, delta) {
    if (anim) cancelAnimationFrame(anim);
    const start = sc.scrollTop;
    const max = sc.scrollHeight - sc.clientHeight;
    const dist = Math.max(0, Math.min(max, start + delta)) - start;
    if (!dist) { anim = null; return; }
    const t0 = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);          // easeOutCubic
    function step(now) {
      const p = Math.min(1, (now - t0) / DURATION);
      sc.scrollTop = start + dist * ease(p);
      anim = p < 1 ? requestAnimationFrame(step) : null;
    }
    anim = requestAnimationFrame(step);
  }

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isEditable(document.activeElement)) return;      // don't hijack while typing
    let dir = 0;
    if (e.key === 'PageDown') dir = 1;
    else if (e.key === 'PageUp') dir = -1;
    else if (e.key === ' ') dir = e.shiftKey ? -1 : 1;
    else return;
    const sc = mainScroller();
    if (!sc) return;
    e.preventDefault();
    e.stopPropagation();
    animateBy(sc, dir * Math.max(120, sc.clientHeight - OVERLAP));
  }, true);
})();

// Find-in-page nudge. Chromium scrolls the active match "into the viewport" — but a match
// already inside the viewport that's merely COVERED by the sticky top rail or the fixed
// bottom input box counts as visible, so it never scrolls. Main forwards each final match
// rect (viewport coords); if a fixed/sticky overlay is stacked over it, scroll just enough
// to clear the overlay's edge. A match whose text LIVES in a sticky bar (searching a word
// from the source rail) is left alone — visible already, and the hit stack under it holds
// no buried content text.
ipcRenderer.on('find-nudge', (_e, r) => {
  if (!r || !r.height) return;
  const overlayOver = (x, y) => {
    const stack = document.elementsFromPoint(x, y);
    if (!stack.length) return null;
    let fixedRoot = null; // OUTERMOST fixed/sticky ancestor of the topmost hit
    for (let n = stack[0]; n && n !== document.documentElement; n = n.parentElement) {
      const p = getComputedStyle(n).position;
      if (p === 'fixed' || p === 'sticky') fixedRoot = n;
    }
    if (!fixedRoot) return null;
    const ownText = (el) => {
      for (const c of el.childNodes) if (c.nodeType === 3 && /\S/.test(c.nodeValue)) return true;
      return false;
    };
    for (const el of stack) if (!fixedRoot.contains(el) && ownText(el)) return fixedRoot;
    return null; // nothing buried below — the match IS the overlay's own text
  };
  const M = 12; // breathing room past the overlay edge
  const sc = mainScroller();
  if (!sc) return;
  const cx = Math.max(4, Math.min(innerWidth - 4, r.x + r.width / 2));
  const hit = overlayOver(cx, Math.max(0, r.y + 2)) ||
              overlayOver(cx, Math.min(innerHeight - 2, r.y + r.height - 2));
  if (!hit) return;
  const o = hit.getBoundingClientRect();
  if (o.height > innerHeight * 0.8) return; // near-full-height wrapper — no sane edge, don't guess
  // Scroll direction comes from WHERE THE OVERLAY SITS, not from which probe point found it:
  // a match fully behind the bottom input box is covered at BOTH edges, and branching on the
  // top probe treated that as "top overlay" — scrolling the match the wrong way, further
  // under the bar.
  if (o.top + o.height / 2 < innerHeight / 2) sc.scrollBy(0, r.y - o.bottom - M); // top bar → below it
  else sc.scrollBy(0, r.y + r.height - o.top + M);                                // bottom bar → above it
});

// ===========================================================================
// 6. Load-failure overlay — a full-window "crash report" panel shown when the main process
//    detects the page didn't come up as AI Mode: a network error, or a silent degrade to a
//    normal results page. (A captcha is left interactive and never covered.) Rendered here,
//    over Google's page, so it's unmissable;
//    dismissible so a false positive costs nothing; Copy routes the report to the clipboard
//    via main. Styles are applied through cssText (CSSOM) — not blocked by Google's CSP, same
//    idiom as the toast/autoscroll above.
// ===========================================================================

ipcRenderer.on('show-load-error', (_e, d) => {
  const prev = document.getElementById('__aimode_load_error');
  if (prev) prev.remove();

  const scrim = document.createElement('div');
  scrim.id = '__aimode_load_error';
  scrim.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483647',
    'background:rgba(18,18,24,0.95)',
    'display:flex', 'align-items:flex-start', 'justify-content:center',
    'overflow:auto', 'padding:44px 22px', 'box-sizing:border-box',
    'font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', 'color:#e7e7ee'
  ].join(';');

  const card = document.createElement('div');
  card.style.cssText = [
    'width:100%', 'max-width:640px', 'background:#1f1f27',
    'border:1px solid #34343f', 'border-radius:14px',
    'padding:26px 28px', 'box-sizing:border-box', 'box-shadow:0 18px 60px rgba(0,0,0,0.55)'
  ].join(';');

  const badge = document.createElement('div');
  badge.textContent = d.app || 'AI Mode'; // name comes from main (see APP_NAME) — nothing to require here
  badge.style.cssText = 'font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#ff9d6e;margin-bottom:10px';

  const h = document.createElement('div');
  h.textContent = d.headline || 'AI Mode did not load.';
  h.style.cssText = 'font-size:19px;font-weight:650;color:#fff;margin-bottom:12px';

  const p = document.createElement('div');
  p.textContent = d.explanation || '';
  p.style.cssText = 'color:#c7c7d3;margin-bottom:14px';

  const cause = document.createElement('div');
  cause.style.cssText = 'color:#c7c7d3;margin-bottom:18px';
  if (d.cause) {
    const strong = document.createElement('span');
    strong.textContent = 'Likely cause: ';
    strong.style.cssText = 'color:#fff;font-weight:650';
    cause.appendChild(strong);
    cause.appendChild(document.createTextNode(d.cause));
  }

  const pre = document.createElement('pre');
  pre.textContent = d.report || '';
  pre.style.cssText = [
    'margin:0 0 18px', 'padding:14px 16px', 'background:#131319',
    'border:1px solid #2c2c37', 'border-radius:10px',
    'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
    'white-space:pre-wrap', 'word-break:break-word', 'color:#c2c2ce',
    'max-height:320px', 'overflow:auto', 'user-select:text', '-webkit-user-select:text'
  ].join(';');

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap';
  function button(label, primary) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = [
      'font:inherit', 'font-weight:600', 'padding:9px 16px', 'border-radius:9px', 'cursor:pointer',
      primary ? 'border:1px solid #2f6fed' : 'border:1px solid #3a3a46',
      primary ? 'background:#2f6fed' : 'background:transparent', 'color:#fff'
    ].join(';');
    return b;
  }
  const copy = button('Copy report', true);
  const retry = button('Retry', false);
  const dismiss = button('Dismiss', false);
  copy.addEventListener('click', () => {
    ipcRenderer.send('load-error:copy');
    copy.textContent = 'Copied ✓';
    setTimeout(() => { copy.textContent = 'Copy report'; }, 1600);
  });
  retry.addEventListener('click', () => { ipcRenderer.send('load-error:retry'); scrim.remove(); });
  dismiss.addEventListener('click', () => scrim.remove());
  row.appendChild(copy); row.appendChild(retry); row.appendChild(dismiss);

  card.appendChild(badge); card.appendChild(h); card.appendChild(p);
  if (d.cause) card.appendChild(cause);
  card.appendChild(pre); card.appendChild(row);
  scrim.appendChild(card);
  (document.body || document.documentElement).appendChild(scrim);
});

// ===========================================================================
// 7. Transcript capture — when the main process asks (Cmd+S save), walk the answer region's
//    live DOM into clean Markdown and send it back. We RE-EMIT Markdown from the HTML
//    (<h2>→"##", <li>→"- ", <a>→"[text](url)", <table>→GFM pipes) instead of grabbing
//    innerText, which would flatten every heading / list / link into one wall of text. Selection
//    keeps this file's rule — web semantics, never Google's obfuscated class names: start at
//    [role="main"], skip chrome + invisible nodes, and cut off the SERP boilerplate that trails
//    an AI answer (its labels are stable strings because harden.js pins the page to en-US).
// ===========================================================================

(function transcriptCapture() {
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD',
    'SVG', 'CANVAS', 'IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'IFRAME',
    'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION',
    'NAV', 'HEADER', 'FOOTER', 'FORM', 'ASIDE'
  ]);
  // ARIA landmark/control roles that mark page chrome (the top bar, mode tabs, footer, menus)
  // rather than answer content — skipped even when Google hangs them on a plain <div>.
  const SKIP_ROLES = new Set([
    'button', 'navigation', 'search', 'textbox', 'banner', 'contentinfo',
    'complementary', 'tablist', 'tab', 'menu', 'menubar', 'toolbar', 'dialog'
  ]);
  // Section labels Google appends AFTER an AI answer. en-US is pinned (harden.js), so these are
  // stable text — not class names — and safe to match without rotting when Google reshuffles.
  const CUTOFF_LABELS = new Set([
    'people also ask', 'related searches', 'people also search for',
    'more to ask', 'people also search', 'related to this search'
  ]);

  function collapse(s) { return s.replace(/\s+/g, ' '); }         // HTML-style whitespace folding

  // A $$…$$ display block can't live inside a heading or table cell — those contexts collapse to a
  // single line, where "$$ x $$" renders literally. Downgrade embedded display math to inline $…$.
  function unblockMath(s) {
    return s.replace(/\$\$\s*([^$]+?)\s*\$\$/g, (_m, t) => `$${t}$`);
  }

  // Card hrefs sometimes route through google.com/url?q=…; unwrap so the saved link goes straight
  // to the page. Parens are percent-encoded so the URL can't close the [](…) markdown early.
  function cleanUrl(h) {
    let u = String(h);
    const m = u.match(/^https?:\/\/(?:www\.)?google\.[^/]+\/url\?[^#]*?[&?](?:q|url)=([^&]+)/i)
      || u.match(/^https?:\/\/(?:www\.)?google\.[^/]+\/url\?(?:q|url)=([^&]+)/i);
    if (m) { try { u = decodeURIComponent(m[1]); } catch (e) { /* keep wrapped */ } }
    return u.replace(/\(/g, '%28').replace(/\)/g, '%29');
  }

  function hidden(el) {
    if (el.id && String(el.id).startsWith('__ai')) return true;  // our own overlays (saved banner, toast,
                                                                 // load-error scrim) must never be captured
    if (SKIP_TAGS.has(el.tagName.toUpperCase())) return true;    // MathML/SVG tagNames come through lowercase
    if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden')) return true;
    const role = el.getAttribute('role');
    if (role && SKIP_ROLES.has(role)) return true;
    const s = getComputedStyle(el);
    return s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0';
  }

  function textLen(el) { return (el.innerText || '').replace(/\s+/g, ' ').trim().length; }

  // Content graphics. IMG/CANVAS/SVG are normally skipped (SKIP_TAGS — favicons, icons, spacer
  // gifs, glyph SVGs), but a real answer illustration is worth keeping: non-presentational and
  // actually rendered at a meaningful size. IMG contributes its URL (or data: URI), CANVAS a pixel
  // snapshot, a large visible inline SVG its own serialized markup. Each becomes a token; main.js
  // materializeImages writes the file next to the saved markdown and rewrites the token to a
  // relative link — a confined viewer only renders in-folder relative images, never remote URLs.
  let capturedImages = [];
  function image(node) {
    const tag = node.tagName.toUpperCase();
    if (node.getAttribute('role') === 'presentation' || node.getAttribute('aria-hidden') === 'true') return '';
    let r = { width: 0, height: 0 };
    try { r = node.getBoundingClientRect(); } catch (e) { /* detached node */ }
    if (r.width < 120 || r.height < 80) return '';               // favicons, thumbnails, decorations
    let src = '';
    if (tag === 'IMG') {
      src = node.getAttribute('src') || '';
      if (!/^https?:\/\//i.test(src) && !/^data:image\//i.test(src)) return '';
    } else if (tag === 'CANVAS') {
      // canvas graphics have no URL — snapshot the pixels (throws if cross-origin tainted)
      try { src = node.toDataURL('image/png'); } catch (e) { return ''; }
      if (!/^data:image\//.test(src)) return '';
    } else if (tag === 'SVG') {
      // math glyph SVGs never get here (aria-hidden, wrappers intercepted before descending)
      try {
        let xml = node.outerHTML || '';
        if (!xml) return '';
        if (!/xmlns=/.test(xml)) xml = xml.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
        src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(xml)))}`;
      } catch (e) { return ''; }
    } else {
      return '';
    }
    const alt = collapse(node.getAttribute('alt') || node.getAttribute('aria-label') || '').replace(/[[\]\\]/g, '').trim();
    const token = `__AIIMG_${capturedImages.length}__`;
    capturedImages.push({ token, src, alt });
    return `\n\n![${alt || 'image'}](${token})\n\n`;
  }

  // The original TeX source of a rendered formula, when a renderer embeds one in an
  // <annotation encoding="application/x-tex"> node. Google does NOT (its only annotation is a
  // spoken-English text/plain one — and note "text/plain" contains "tex", so match the encoding
  // exactly, never by substring). '' when absent.
  function texOf(node) {
    for (const a of node.querySelectorAll('annotation')) {
      const enc = (a.getAttribute('encoding') || '').toLowerCase();
      if (enc === 'tex' || enc.includes('x-tex')) return a.textContent.trim();
    }
    return '';
  }

  // TeX for a run of math characters. NFKC first: Unicode math-alphanumerics (𝑓, 𝜋, 𝐀 …) normalize
  // to their plain ASCII/Greek base letters; then named symbols become TeX commands and anything
  // unknown passes through untouched (KaTeX copes with most plain Unicode).
  const TEX_CHARS = {
    '−': '-', '∗': '*', '⋅': '\\cdot ', '·': '\\cdot ', '×': '\\times ', '÷': '\\div ',
    '±': '\\pm ', '∓': '\\mp ', '∞': '\\infty ', '∫': '\\int ', '∬': '\\iint ', '∮': '\\oint ',
    '∑': '\\sum ', '∏': '\\prod ', '∂': '\\partial ', '∇': '\\nabla ',
    '≤': '\\le ', '≥': '\\ge ', '≠': '\\ne ', '≈': '\\approx ', '≡': '\\equiv ', '∝': '\\propto ',
    '∈': '\\in ', '∉': '\\notin ', '⊂': '\\subset ', '⊆': '\\subseteq ', '∪': '\\cup ', '∩': '\\cap ',
    '∅': '\\varnothing ', '∀': '\\forall ', '∃': '\\exists ', '¬': '\\neg ', '∧': '\\land ', '∨': '\\lor ',
    '→': '\\to ', '←': '\\leftarrow ', '↔': '\\leftrightarrow ', '⇒': '\\Rightarrow ', '⇐': '\\Leftarrow ',
    '⇔': '\\Leftrightarrow ', '↦': '\\mapsto ', '…': '\\dots ', '⋯': '\\cdots ', '⋮': '\\vdots ', '⋱': '\\ddots ',
    '∘': '\\circ ', '⊕': '\\oplus ', '⊗': '\\otimes ', '′': "'", '″': "''", '°': '^{\\circ} '
  };
  const GREEK = {
    'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'ε': 'varepsilon', 'ϵ': 'epsilon',
    'ζ': 'zeta', 'η': 'eta', 'θ': 'theta', 'ϑ': 'vartheta', 'ι': 'iota', 'κ': 'kappa',
    'λ': 'lambda', 'μ': 'mu', 'ν': 'nu', 'ξ': 'xi', 'π': 'pi', 'ϖ': 'varpi', 'ρ': 'rho',
    'σ': 'sigma', 'ς': 'varsigma', 'τ': 'tau', 'υ': 'upsilon', 'φ': 'varphi', 'ϕ': 'phi',
    'χ': 'chi', 'ψ': 'psi', 'ω': 'omega',
    'Γ': 'Gamma', 'Δ': 'Delta', 'Θ': 'Theta', 'Λ': 'Lambda', 'Ξ': 'Xi', 'Π': 'Pi',
    'Σ': 'Sigma', 'Υ': 'Upsilon', 'Φ': 'Phi', 'Ψ': 'Psi', 'Ω': 'Omega'
  };
  function texStr(s) {
    let out = '';
    for (const ch of String(s).normalize('NFKC')) {
      out += TEX_CHARS[ch] || (GREEK[ch] ? `\\${GREEK[ch]} ` : ch);
    }
    return out;
  }

  // MathML → TeX, covering the constructs Google's display math actually uses (msubsup, mover,
  // mfrac, mtable, …). Unknown elements degrade to their children, so the worst case is the old
  // flattened-glyph text — never a crash. Skips <annotation> (Google's is spoken English).
  function mmlToTex(node) {
    if (node.nodeType === 3) return texStr(node.textContent);
    if (node.nodeType !== 1) return '';
    const el = [...node.childNodes].filter((c) => c.nodeType === 1);
    const all = () => [...node.childNodes].map(mmlToTex).join('');
    const one = (n) => (n ? mmlToTex(n) : '');
    switch (node.tagName.toUpperCase()) {
      case 'SEMANTICS': return el.filter((c) => !/^annotation/i.test(c.tagName)).map(mmlToTex).join('');
      case 'ANNOTATION': case 'ANNOTATION-XML': return '';
      case 'MI': case 'MN': case 'MO': case 'MTEXT': return texStr(node.textContent);
      case 'MSPACE': return ' ';
      case 'MSUP': return `{${one(el[0])}}^{${one(el[1])}}`;
      case 'MSUB': return `{${one(el[0])}}_{${one(el[1])}}`;
      case 'MSUBSUP': case 'MUNDEROVER': return `{${one(el[0])}}_{${one(el[1])}}^{${one(el[2])}}`;
      case 'MUNDER': return `\\underset{${one(el[1])}}{${one(el[0])}}`;
      case 'MOVER': {
        const base = one(el[0]);
        const acc = (el[1] ? el[1].textContent : '').trim();
        if (!acc) return base;
        if (acc.length === 1) {
          if ('̂ˆ^'.includes(acc)) return `\\hat{${base}}`;
          if ('‾¯̅_'.includes(acc)) return `\\overline{${base}}`;
          if ('⃗→'.includes(acc)) return `\\vec{${base}}`;
          if ('̃˜~'.includes(acc)) return `\\tilde{${base}}`;
          if ('̇˙'.includes(acc)) return `\\dot{${base}}`;
        }
        return `\\overset{${one(el[1])}}{${base}}`;
      }
      case 'MFRAC': return `\\frac{${one(el[0])}}{${one(el[1])}}`;
      case 'MSQRT': return `\\sqrt{${all()}}`;
      case 'MROOT': return `\\sqrt[${one(el[1])}]{${one(el[0])}}`;
      case 'MTABLE': return `\\begin{matrix}${el.map(mmlToTex).join(' \\\\ ')}\\end{matrix}`;
      case 'MTR': return el.map(mmlToTex).join(' & ');
      case 'MTD': return all();
      default: return all();                              // math, mrow, mstyle, mpadded, …
    }
  }

  // True if the element carries any real text OUTSIDE svg/math subtrees — used to spot Google's
  // math widget wrappers, whose only "text" lives in aria-hidden glyph SVGs or MathML internals.
  function hasBareText(node) {
    for (const c of node.childNodes) {
      if (c.nodeType === 3 && c.textContent.trim()) return true;
      if (c.nodeType === 1) {
        const t = c.tagName.toUpperCase();
        if (t !== 'SVG' && t !== 'MATH' && hasBareText(c)) return true;
      }
    }
    return false;
  }

  // Like hasBareText, but ignores one subtree (the formula itself) and anything aria-hidden:
  // "is there sentence text around this math?"
  function textBeside(root, skip) {
    for (const c of root.childNodes) {
      if (c === skip) continue;
      if (c.nodeType === 3 && c.textContent.trim()) return true;
      if (c.nodeType === 1 && c.tagName.toUpperCase() !== 'SVG'
        && c.getAttribute('aria-hidden') !== 'true' && !c.hasAttribute('hidden')
        && textBeside(c, skip)) return true;
    }
    return false;
  }

  // Google wraps display equations AND occasional inline tokens (a lone variable mid-sentence) in
  // IDENTICAL MathML markup — what differs is whether an ancestor carries sentence text around the
  // formula. Climb the wrapper chain looking for such text (→ inline). Stop as DISPLAY at a
  // paragraph-like ancestor (P/LI/TD/TH) with no such text, or at the first ancestor holding OTHER
  // block children — that's the paragraph's container, past the math widget's own span/div shells;
  // climbing further would find unrelated paragraphs' text and misread every display equation.
  const BLOCKISH = /^(DIV|P|UL|OL|TABLE|BLOCKQUOTE|PRE|HR|H[1-6]|LI|TD|TH)$/;
  function mathIsInline(node) {
    let child = node, n = node.parentElement;
    for (let i = 0; i < 8 && n; i++) {
      for (const c of n.children || []) {                // structural stop FIRST: another block at
        if (c !== child && BLOCKISH.test(c.tagName.toUpperCase())) return false;  // this level means
      }                                                  // any text here belongs to OTHER paragraphs
      if (textBeside(n, node)) return true;
      const t = n.tagName.toUpperCase();
      if (t === 'P' || t === 'LI' || t === 'TD' || t === 'TH') return false;
      child = n; n = n.parentElement;
    }
    return false;
  }

  // One MathML formula → markdown math. Prefer an embedded TeX annotation if one ever appears;
  // else convert the structure. Formulas with sentence text around them emit inline $…$;
  // standalone equations get a $$…$$ block.
  function emitMath(node) {
    let tex = (texOf(node) || mmlToTex(node)).replace(/\s+/g, ' ').trim();
    if (!tex) return '';
    // A matrix flanked by plain fences renders with tiny parens — promote to p/b/vmatrix, which
    // sizes the fences to the matrix. Only DIRECTLY adjacent fences qualify (a grouping brace
    // right before \begin{matrix} is TeX syntax, not a fence, so { } stays out of the map).
    tex = tex.replace(/([([|])\s*\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}\s*([)\]|])/g, (m, l, body, r) => {
      const env = { '(': ')' === r && 'pmatrix', '[': ']' === r && 'bmatrix', '|': '|' === r && 'vmatrix' }[l];
      return env ? `\\begin{${env}}${body}\\end{${env}}` : m;
    });
    return mathIsInline(node) ? `$${tex}$` : `\n\n$$\n${tex}\n$$\n\n`;
  }

  // Reassemble a glyph-SVG formula. Each glyph's translate(x,y) encodes layout: y≈0 is the
  // baseline, raised (y ≤ −0.15em) is a superscript run, lowered (y ≥ 0.15em) a subscript run —
  // that recovers e^{iπ} / x_i structure that the flat glyph string loses. (Fractions/limits in
  // INLINE math would need full 2-D analysis; Google renders those as MathML display blocks.)
  function svgGlyphs(node) {
    let out = '';
    for (const s of node.querySelectorAll('svg')) {
      let level = 0;                                     // 0 baseline, 1 superscript, -1 subscript
      for (const t of s.querySelectorAll('text')) {
        const m = (t.getAttribute('transform') || '').match(/translate\(\s*-?[\d.]+\s*[, ]\s*(-?[\d.]+)/);
        const y = m ? parseFloat(m[1]) : 0;
        const lv = y <= -0.15 ? 1 : (y >= 0.15 ? -1 : 0);
        if (lv !== level) {
          if (level !== 0) out += '}';
          if (lv === 1) out += '^{';
          else if (lv === -1) out += '_{';
          level = lv;
        }
        out += texStr(t.textContent);
      }
      if (level !== 0) out += '}';
    }
    return out.trim() ? out.replace(/\s+/g, ' ').trim() : '';
  }

  function kids(node) {
    let out = '';
    for (const c of node.childNodes) out += walk(c);
    return out;
  }

  function list(node, ordered) {
    let out = '\n', i = 1;
    for (const li of node.children) {
      if (li.tagName !== 'LI' || hidden(li)) continue;
      const body = kids(li).trim().replace(/\n{2,}/g, '\n').replace(/\n/g, '\n  '); // indent wraps + nesting
      out += `${ordered ? `${i++}. ` : '- '}${body}\n`;
    }
    return out + '\n';
  }

  function table(node) {
    const rows = [];
    for (const tr of node.querySelectorAll('tr')) {
      const cells = [];
      for (const cell of tr.children) {
        if (cell.tagName === 'TD' || cell.tagName === 'TH') {
          cells.push(unblockMath(collapse(kids(cell))).trim().replace(/\|/g, '\\|'));
        }
      }
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return '';
    const cols = Math.max(...rows.map((r) => r.length));
    const fill = (r) => { const c = r.slice(); while (c.length < cols) c.push(''); return c; };
    const head = fill(rows[0]);
    const body = rows.slice(1).map((r) => `| ${fill(r).join(' | ')} |`).join('\n');
    return `\n\n| ${head.join(' | ')} |\n| ${head.map(() => '---').join(' | ')} |\n${body}\n\n`;
  }

  function walk(node) {
    if (node.nodeType === 3) {                                    // text node
      const t = collapse(node.textContent);
      // Escape Markdown metacharacters in LITERAL text so an AI answer that prints "# foo" or "* bar"
      // stays literal instead of turning into a heading / bullet. Skip inside code (`<code>`/`<pre>`),
      // where a stray backslash would show. (Structural Markdown the walker emits — "##", "- ", "> ",
      // "[…](…)", "|" — comes from ELEMENT handlers below, never from text nodes, so it's untouched.)
      const inCode = node.parentElement && node.parentElement.closest('code, pre');
      return inCode ? t : escapeMd(t);
    }
    if (node.nodeType !== 1) return '';                           // element gate (skips comments too)
    const tag = node.tagName.toUpperCase();                       // MathML/SVG tagNames are lowercase —
                                                                  // this cost us the MATH handler once
    if (tag === 'IMG' || tag === 'CANVAS' || tag === 'SVG') return image(node); // before hidden():
                                                                  // all three live in SKIP_TAGS
    if (hidden(node)) {
      // A content graphic can hide inside a clickable wrapper — Google serves answer graphs as an
      // <img> inside a span[role=button] that opens a lightbox, and the role check prunes the
      // whole subtree. Rescue sizeable images from VISIBLE button/link wrappers only: the
      // lightbox's duplicate copy sits in a hidden container and stays skipped.
      const role = node.getAttribute('role');
      if ((role === 'button' || role === 'link')
        && node.getAttribute('aria-hidden') !== 'true' && !node.hasAttribute('hidden')) {
        let s = null;
        try { s = getComputedStyle(node); } catch (e) { /* detached */ }
        if (!s || (s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0')) {
          for (const im of node.querySelectorAll('img')) {
            const md = image(im);
            if (md) return md;
          }
        }
      }
      return '';
    }
    // Math widgets (dump-verified): a span/div wrapper with no bare text of its own holding either
    // real MathML (converted structurally — Google embeds no TeX, only a spoken-English annotation)
    // or per-glyph aria-hidden SVGs (reassembled, y-offsets → sub/superscripts). Handled at the
    // WRAPPER so the widget's inner div shells can't inject paragraph breaks around inline math.
    // Exactly-one-math guard: a container of several equations descends so each converts itself.
    if ((tag === 'SPAN' || tag === 'DIV') && !hasBareText(node)) {
      const maths = node.querySelectorAll('math');
      if (maths.length === 1) return emitMath(maths[0]);
      if (!maths.length) {
        const glyphs = svgGlyphs(node);
        if (glyphs) return `$${glyphs}$`;
      }
    }
    if (tag === 'MATH') return emitMath(node);            // MathML outside any qualifying wrapper
    // Headings: answer section titles are often styled DIVs rather than <h1>–<h6> (they saved as
    // plain body text), but accessible markup tags them role="heading" + aria-level — map those to
    // real Markdown headings just like the Hn tags below.
    if (node.getAttribute('role') === 'heading') {
      const lvl = Math.min(6, Math.max(1, parseInt(node.getAttribute('aria-level'), 10) || 2));
      const t = unblockMath(collapse(kids(node))).trim();
      return t ? `\n\n${'#'.repeat(lvl)} ${t}\n\n` : '';
    }
    switch (tag) {
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
        const t = unblockMath(collapse(kids(node))).trim();
        return t ? `\n\n${'#'.repeat(+tag[1])} ${t}\n\n` : '';
      }
      case 'STRONG': case 'B': { const t = kids(node).trim(); return t ? `**${t}**` : ''; }
      case 'EM': case 'I':     { const t = kids(node).trim(); return t ? `*${t}*` : ''; }
      case 'DEL': case 'S': case 'STRIKE': { const t = kids(node).trim(); return t ? `~~${t}~~` : ''; }
      case 'CODE': {
        if (node.closest('pre')) return node.textContent;         // the enclosing PRE emits the fence
        const t = collapse(kids(node)).trim();
        if (!t) return '';
        const runs = t.match(/`+/g);                              // span must out-tick any backtick run inside
        const fence = '`'.repeat(runs ? Math.max(...runs.map((r) => r.length)) + 1 : 1);
        const pad = /^`|`$/.test(t) ? ' ' : '';                   // CommonMark: pad if it starts/ends with `
        return `${fence}${pad}${t}${pad}${fence}`;
      }
      case 'PRE': {
        const t = node.textContent.replace(/\s+$/, '');
        if (!t) return '';
        // Fence must be LONGER than any ``` run in the content, or an inner fence closes ours early and
        // spills the rest (incl. "##" lines) out as live Markdown — the "stray header" bug.
        const runs = t.match(/`+/g);
        const fence = '`'.repeat(Math.max(3, ...(runs ? runs.map((r) => r.length + 1) : [])));
        return `\n\n${fence}\n${t}\n${fence}\n\n`;
      }
      case 'A': {
        const t = collapse(kids(node)).trim();
        const href = node.getAttribute('href') ? node.href : '';  // .href resolves to an absolute URL
        if (!t) {
          // Google's source cards hold their URL in an EMPTY overlay anchor (text lives in sibling
          // divs, title duplicated in aria-label). Emit a "[title](url)" marker line for
          // styleSources to fold into the card's link — the "Opens in new tab" suffix (en-US is
          // pinned) keeps this from firing on other empty anchors.
          const label = collapse(node.getAttribute('aria-label') || '');
          if (href && /opens in new tab\.?\s*$/i.test(label)) {
            const title = escapeMd(label.replace(/\.?\s*opens in new tab\.?\s*$/i, '').trim());
            if (title) return `\n\n[${title}](${cleanUrl(href)})\n\n`;
          }
          return '';
        }
        return (href && !href.startsWith('javascript:')) ? `[${t}](${href})` : t;
      }
      case 'UL': return list(node, false);
      case 'OL': return list(node, true);
      case 'LI': return kids(node);                               // orphan <li> reached outside a list
      case 'BLOCKQUOTE': {
        const t = kids(node).trim();
        return t ? `\n\n> ${t.replace(/\n/g, '\n> ')}\n\n` : '';
      }
      case 'BR': return '  \n';
      case 'HR': return '\n\n---\n\n';
      case 'TABLE': return table(node);
      case 'P': case 'DIV': case 'SECTION': case 'ARTICLE': case 'MAIN':
      case 'DL': case 'DD': case 'DT': case 'FIGURE': case 'FIGCAPTION': {
        const t = kids(node);
        return t.trim() ? `\n\n${t}\n\n` : ''; // leading break too, so a block never glues onto preceding inline text
      }
      default: return kids(node);
    }
  }

  // Cut at the first line that is ONLY a SERP boilerplate label (as a heading or bare text), so
  // "People also ask" / "Related searches" don't trail the saved answer. Whole-line matching
  // avoids truncating an answer that merely mentions such a phrase mid-sentence.
  function trimCruft(md) {
    const lines = md.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const bare = lines[i].replace(/^#{1,6}\s+/, '').replace(/[*_`>]/g, '').trim().toLowerCase();
      if (bare && CUTOFF_LABELS.has(bare)) return lines.slice(0, i).join('\n');
    }
    return md;
  }

  const PEELABLE = new Set(['DIV', 'SECTION', 'ARTICLE', 'MAIN']);

  // AI Mode HIDES the classic SERP main column (#center_col, role="main" → display:none) and
  // renders the answer in a separate VISIBLE container with no ARIA "main" landmark. So role="main"
  // can't be trusted. Start at <body> and PEEL wrapper divs — descending only while a SINGLE
  // visible child holds the content (its siblings being page chrome: top bar, mode tabs, input,
  // footer) — and stop the moment the content fans out across several children (the conversation:
  // each turn + its sources sit side by side). That lands on the tightest wrapper that still holds
  // the WHOLE discussion, and — because we only ever step past chrome siblings — drops no content.
  function pickRoot() {
    const m = document.querySelector('[role="main"]');
    if (m && !hidden(m) && textLen(m) > 60) return m;   // honor a genuine, visible main if present
    let node = document.body;
    if (!node) return null;
    for (let i = 0; i < 40; i++) {
      let heir = null, visible = 0;
      for (const child of node.children) {
        if (hidden(child)) continue;
        heir = child;
        if (++visible > 1) break;
      }
      if (visible === 1 && PEELABLE.has(heir.tagName)) node = heir; else break;
    }
    return node;
  }

  // Residual page chrome that peels through into the content column. Every pattern is anchored at
  // the line start and tested against the trimmed, de-linked line.
  //
  // A line is dropped when it is ENTIRELY chrome — matches are stripped one after another until
  // nothing is left. That is what "whole-line" has to mean here, because Google emits these as
  // separate inline elements that can land CONCATENATED on ONE line: "Skip to main content"
  // immediately followed by the "Accessibility help" link, seen in a real save 2026-07-27. Anchoring
  // each pattern with `$` (as this did from 2026-07-24) misses that; a bare prefix match instead
  // would silently delete a real answer line that merely STARTS with the phrase — plausible for
  // this app, which gets asked about HTML. Leftover text ⇒ the line is prose ⇒ passed through.
  const CHROME_PHRASE = [
    /^skip to main content/i,
    /^accessibility help/i,
    /^ai mode response is ready\.?/i,
    /^generating a guided overview\.{0,3}/i,   // transient loading label under answer graphics
    /^ask about\.{0,3}/i                       // trailing follow-up affordance below the last answer
                                               // (also unbreaks the final Sources rail: a stray line
                                               //  after it defeats styleSources' turn-end/EOF gate)
  ];
  // Prefix by design: Google's own H1, whose text continues with your question.
  const CHROME_PREFIX = [/^#+\s*ai mode conversation:/i];
  function stripChrome(md) {
    const delink = (l) => l.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim(); // see the text, not [text](url)
    const allChrome = (line) => {
      let rest = line;
      if (!rest) return false;                  // a blank line is not chrome
      for (let guard = 0; rest && guard < 20; guard++) {
        const hit = CHROME_PHRASE.find((re) => re.test(rest));
        if (!hit) return false;
        rest = rest.replace(hit, '').trim();
      }
      return rest === '';
    };
    return md.split('\n').filter((l) => {
      const t = delink(l);
      return !CHROME_PREFIX.some((re) => re.test(t)) && !allChrome(t);
    }).join('\n');
  }

  // Google decorates every answer code block with chrome of its own: a bare language-label line
  // above it ("Python", "JSON") and "Use code with caution." below it. Fold the label into the
  // opening fence as a GFM language tag (so viewers syntax-highlight the block) and drop the
  // caution line. Fence-aware on purpose: when the answer is itself a code block CONTAINING that
  // same chrome as literal text (it happened — that's why fences are dynamic-length), lines inside
  // an open fence must pass through untouched. A label only counts as one when it's a single short
  // token AND the next non-blank line is an untagged opening fence, so prose stays prose — and this
  // pass runs AFTER labelTurns, so a short user question right before a code-block answer is already
  // a "> "-prefixed callout line that can't be mistaken for a label.
  const LANG_LABEL = /^[A-Za-z][A-Za-z0-9+#._-]{0,19}$/;
  function stripCodeChrome(md) {
    const lines = md.split('\n');
    const out = [];
    let fence = null;                                   // backtick run that opened the current block
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Leading indentation is captured, not required to be absent: a code block nested in a list
      // item carries our own 2-space-per-level indent, and matching only at column 0 (as this did
      // until 2026-07-27) meant every such block kept its stray label line AND lost its language
      // tag — twelve times in one real save.
      const f = line.match(/^(\s*)(`{3,})(.*)$/);
      // A fence line's info string never contains a backtick (CommonMark) — that's what tells a
      // real fence apart from a line-starting INLINE code span like «````x` ...» inside a paragraph.
      const isFence = f && !f[3].includes('`');
      if (fence) {
        out.push(line);
        if (isFence && f[2].length >= fence.length && !f[3].trim()) fence = null;
        continue;
      }
      if (isFence) { fence = f[2]; out.push(line); continue; }
      if (/^use code with caution\.?$/i.test(line.trim())) continue;
      if (LANG_LABEL.test(line.trim())) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        const open = j < lines.length && lines[j].match(/^(\s*)(`{3,})\s*$/);
        if (open) {
          // Keep the FENCE's own indentation so the list structure survives.
          lines[j] = open[1] + open[2] + line.trim().toLowerCase().replace(/[ .]/g, '');
          continue;                                     // label folded into the fence tag; drop its line
        }
      }
      out.push(line);
    }
    return out.join('\n');
  }

  // Google appends a rail of source-link cards after each answer; the walker captures them as a
  // trailing "- " list — title, mid-word-truncated snippet, site name — that reads as if the AI
  // wrote it. Restyle that list into a labeled "Sources" blockquote of "title — site" lines (the
  // truncated snippets are dropped) so it can't be confused with answer content. Only the cards
  // present in the DOM are captured — the rail's "N sites" total counts ones behind its
  // "show all" click too, so no total is claimed. Match conservatively so a real answer list is
  // never eaten: the list must sit at the END of a turn (only blanks before the next user callout
  // or EOF), every item must be multi-line with a short last line (the site), items must stay
  // flat (a nested "  - " disqualifies), and at least one line must carry the rail's signature
  // "Jun 11, 2024 — " snippet-date prefix (en-US is pinned in harden.js, so the format is stable).
  function styleSources(md) {
    const lines = md.split('\n');
    const out = [];
    let fence = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const f = line.match(/^(`{3,})(.*)$/);
      const isFence = f && !f[2].includes('`');
      if (fence) {
        out.push(line);
        if (isFence && f[1].length >= fence.length && !f[2].trim()) fence = null;
        continue;
      }
      if (isFence) { fence = f[1]; out.push(line); continue; }
      if (!/^- /.test(line)) { out.push(line); continue; }
      let end = i;                                        // the contiguous list block
      while (end < lines.length && (/^- /.test(lines[end]) || /^ {2,}\S/.test(lines[end]))) end++;
      const block = lines.slice(i, end);
      let after = end;                                    // what follows the block (past blanks)?
      while (after < lines.length && !lines[after].trim()) after++;
      let ok = after >= lines.length || lines[after] === '> [!NOTE]';
      const items = [];
      for (const l of block) {
        if (!ok) break;
        if (/^- /.test(l)) items.push({ title: l.slice(2).trim().replace(/^[‎‏⁠﻿]+/, ''), rest: [], url: '' });  // strip Google's invisible LRM/BOM prefix
        else if (/^ {2}\S/.test(l) && !/^ {2}([-*+] |\d+\. )/.test(l) && items.length) items[items.length - 1].rest.push(l.trim());
        else ok = false;                                  // nested / oddly indented → a real list, not cards
      }
      for (const it of items) {
        const lm = it.title.match(/^\[(.+)\]\((\S+)\)$/); // the overlay-anchor marker (see case 'A')
        if (lm) {
          it.title = lm[1]; it.url = lm[2];
          if (it.rest.length > 1) it.rest.shift();        // drop the visible title the marker duplicates
        }
      }
      // Card signals: a snippet date OR an overlay link (Google's rails sometimes omit every date).
      // The link marker only ever comes from a card's "Opens in new tab" anchor, so it's decisive.
      ok = ok && items.length > 0
        && items.every((it) => it.rest.length && it.rest[it.rest.length - 1].length <= 60)
        && (items.some((it) => it.url)
          || items.some((it) => it.rest.some((r) => /^[A-Z][a-z]{2} \d{1,2}, \d{4} — /.test(r))));
      if (ok) {
        out.push('', '> **Sources**');
        for (const it of items) {
          const site = it.rest[it.rest.length - 1];
          out.push(`> - ${it.url ? `[${it.title}](${it.url})` : it.title} — ${site}`);
        }
        out.push('');
      } else {
        out.push(...block);
      }
      i = end - 1;
    }
    return out.join('\n');
  }

  // Label whose turn is whose. main.js passes the exact questions you asked (launcher query +
  // each in-page follow-up); wherever one appears as its own line, mark it as a "Q:" heading and
  // flag the reply — so the transcript reads as a dialogue instead of one undifferentiated wall.
  // Match on alphanumerics only, so curly/straight quotes and stray punctuation don't defeat it.
  // Label who said what: EVERY user turn — the opening included — becomes a "[!NOTE]" callout, which
  // Grimoire renders as a COLORED box so the user's side pops. All turns look identical (consistent),
  // and the opening's full text is always here even though the title truncates it at 120 chars.
  // Collision-proof: AI Mode only emits PLAIN "> " quotes (which stay uncolored), never "[!NOTE]".
  // No "User:"/"AI Mode:" labels — the colored box and the flush-left reply speak for themselves.
  function labelTurns(md, questions) {
    if (!questions || !questions.length) return md;
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const asked = new Map();                          // norm(question) → original verbatim question
    for (const q of questions) { const k = norm(q); if (k && !asked.has(k)) asked.set(k, q); }
    const out = [];
    for (const line of md.split('\n')) {
      const q = asked.get(norm(line));                // match on alnum only (quote/whitespace-insensitive)
      if (q) out.push('', ...renderUserTurn(q));
      else out.push(line);
    }
    return out.join('\n');
  }

  function escapeMd(line) {
    return line
      .replace(/([\\`*_[\]<>$~])/g, '\\$1')  // inline: emphasis, code spans, links, angles, plus $
                                             // and ~ — the walker emits real $…$ math and ~~strike~~,
                                             // so those characters in prose must stay literal
      .replace(/^(\s*)([#+\-])/, '$1\\$2')   // line start: heading / bullet marker
      .replace(/^(\s*\d+)\./, '$1\\.');      // line start: ordered-list "1."
  }

  // The message verbatim: original line breaks kept as 2-space hard breaks, Markdown metacharacters
  // escaped so a stray * / # / - stays literal. (A plain paragraph can't preserve leading indentation.)
  function messageBody(q) {
    const lines = String(q).trim().split('\n').map(escapeMd);
    return lines.map((l, i, a) => (i < a.length - 1 ? `${l}  ` : l)).join('\n');
  }

  // Blockquote every line (blank → ">") so the callout stays one contiguous block.
  function blockquote(text) {
    return text.split('\n').map((l) => (l.trim() ? `> ${l}` : '>')).join('\n');
  }
  function renderUserTurn(q) {
    return ['> [!NOTE]', blockquote(messageBody(q)), ''];
  }

  // Drop a leading horizontal rule (a Google <hr> orphaned once the chrome above it is stripped —
  // it would otherwise double the file header's own "---") and collapse consecutive rules.
  function tidyRules(md) {
    const isRule = (l) => /^-{3,}$/.test(l.trim());
    const out = [];
    let seenContent = false;
    for (const l of md.split('\n')) {
      if (isRule(l)) {
        if (!seenContent) continue;                       // leading rule → drop
        let j = out.length - 1;
        while (j >= 0 && out[j].trim() === '') j--;
        if (j >= 0 && isRule(out[j])) continue;           // consecutive rule → drop
        out.push(l);
      } else {
        if (l.trim() !== '') seenContent = true;
        out.push(l);
      }
    }
    return out.join('\n');
  }

  function buildTranscript(questions) {
    capturedImages = [];                                  // fresh per save; the reply carries them
    const root = pickRoot();
    if (!root) return '';
    let md = trimCruft(walk(root)).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    md = tidyRules(styleSources(stripCodeChrome(labelTurns(stripChrome(md), questions))));
    return md.replace(/\n{3,}/g, '\n\n').trim();
  }

  ipcRenderer.on('build-transcript', (_e, reqId, questions) => {
    let md = '', err = '';
    try { md = buildTranscript(questions); } catch (e) { err = String((e && e.stack) || e); }
    ipcRenderer.send('transcript-content', reqId, md, err, capturedImages);
  });

  // DEBUG (Cmd+Shift+D in main.js): a structural outline of the live answer subtree — tag, classes,
  // the attributes that decide the walker's behavior, text previews, hidden-ness. Google's answer
  // markup can't be inspected from outside the app, so when a construct captures wrong (math,
  // headings, images…) this shows what the walker actually faced. Includes nodes the walker SKIPS
  // (marked) — those are usually exactly the interesting ones.
  function dumpDom() {
    const MAX = 1000000;
    let out = '';
    (function rec(node, depth) {
      if (out.length > MAX) return;
      const pad = '  '.repeat(depth);
      if (node.nodeType === 3) {
        const t = node.textContent.replace(/\s+/g, ' ').trim();
        if (t) out += `${pad}"${t.slice(0, 60)}${t.length > 60 ? '…' : ''}"\n`;
        return;
      }
      if (node.nodeType !== 1) return;
      let line = pad + node.tagName.toLowerCase();
      const cls = (node.getAttribute('class') || '').trim();
      if (cls) line += '.' + cls.split(/\s+/).slice(0, 4).join('.');
      for (const n of ['role', 'aria-level', 'aria-hidden', 'aria-label', 'alt', 'src', 'href', 'encoding',
        'display', 'hidden', 'x', 'y', 'dx', 'dy', 'font-size', 'transform', 'width', 'height']) {
        const v = node.getAttribute(n);
        if (v != null) line += `[${n}=${String(v).slice(0, 80)}]`;
      }
      try {
        const s = getComputedStyle(node);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') line += ' (css-hidden)';
      } catch (e) { /* detached node — ignore */ }
      if (hidden(node)) line += ' (walker-skips)';
      out += line + '\n';
      for (const c of node.childNodes) rec(c, depth + 1);
    })(pickRoot() || document.body, 0);
    return out.slice(0, MAX);
  }
  ipcRenderer.on('dump-dom', (_e, reqId) => {
    let text = '', err = '';
    try { text = dumpDom(); } catch (e) { err = String((e && e.stack) || e); }
    ipcRenderer.send('dom-dump', reqId, text, err);
  });
})();

// ===========================================================================
// 8. Find-in-page (Cmd+F) — NOT here anymore, on purpose. The bar used to be rendered in this
//    page, but webContents.findInPage() steals in-page focus on every call, so an in-page bar
//    loses its input focus each search and fights the page forever (debounce/refocus hacks
//    included — unwinnable). The bar now lives in its own child window: find_bar.html, managed
//    by main.js ("Find-in-page" section). Nothing in this preload takes part in find.
// ===========================================================================
