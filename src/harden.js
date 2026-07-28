'use strict';
// Session/browser hardening for the AI Mode wrapper, factored out so it can be
// unit-verified independently of the app shell. Applies:
//   1. Deny ALL permissions (mic, camera, geolocation, notifications, devices, ...).
//   2. Force en-US only (locale + Accept-Language) and a clean Chrome UA string.
//   (spellcheck is a per-window webPreferences flag — set in main.js.)
//
// On UA Client Hints: we deliberately do NOT try to rewrite `sec-ch-ua*`. Chromium
// adds client-hint headers in its network service, downstream of webRequest, so they
// are not visible or modifiable here (an on-the-wire capture confirmed they never
// reach onBeforeSendHeaders). It also isn't needed: this Electron build's default CH
// brand list is Chromium + a GREASE brand with NO "Electron" token, so there is no
// leak to close. The only residual is CH says "Chromium" while the UA says "Chrome" —
// a mild Chromium-vs-Chrome signal, not an Electron giveaway.

const CHROME_VER = process.versions.chrome; // e.g. "150.0.7871.114"

// Clean Chrome UA — strips the "Electron/<app>" tokens the default UA exposes.
const CHROME_UA =
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${CHROME_VER} Safari/537.36`;

const ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

// --- case-insensitive header helper (Electron preserves the sender's casing) ---
function setHeader(headers, name, value) {
  const lower = name.toLowerCase();
  const existing = Object.keys(headers).find((k) => k.toLowerCase() === lower);
  if (existing) delete headers[existing];
  headers[name] = value;
}

// Pure header policy: force en-US. Mutates and returns `headers`.
// (Client Hints are intentionally untouched — see the note at the top of this file.)
function applyHeaderPolicy(headers) {
  setHeader(headers, 'Accept-Language', ACCEPT_LANGUAGE);
  return headers;
}

// Chromium command-line switches. MUST be called before app 'ready'.
function applyChromiumSwitches(app) {
  app.commandLine.appendSwitch('lang', 'en-US');                // UI locale
  app.commandLine.appendSwitch('accept-lang', ACCEPT_LANGUAGE); // navigator.languages + default header
}

// Apply all runtime policies to a session. Safe to call once per session.
function hardenSession(ses) {
  ses.setUserAgent(CHROME_UA);

  // (1) Deny every permission request and every synchronous permission check.
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  if (typeof ses.setDevicePermissionHandler === 'function') {
    ses.setDevicePermissionHandler(() => false); // WebUSB / Serial / HID device selection
  }

  // (2) Force English on every request (belt-and-suspenders with --accept-lang).
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: applyHeaderPolicy(details.requestHeaders) });
  });
}

module.exports = { CHROME_UA, ACCEPT_LANGUAGE, applyHeaderPolicy, applyChromiumSwitches, hardenSession };
