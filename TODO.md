# TODO

Low-priority leftovers. Nothing here blocks daily use — the app is working on macOS 15.6
Sequoia and 26.5 Tahoe as of 2026-07-28.

Where reasoning already lives in [README.md](README.md), these entries stay short and point
there rather than restating it, so the two files cannot drift apart.

## Unverified

Believed done, never actually confirmed.

- [ ] **The shortcuts carried over from Electron's default menu.** The ⌘Q fix itself is CONFIRMED
      (2026-07-29: ⌘Q with Settings focused closes only Settings — that window has no key handler of
      its own, so before the fix it took the whole app down every time). Untested is the rest of the
      authored menu: ⌘C, ⌘V, ⌘Z, ⌘R, ⌘H, zoom and full screen were transcribed from the default by
      hand, so any one of them could have been dropped on the way. They surface in ordinary use —
      no test needed, just notice.
- [ ] **The Dock icon has never been seen on screen.** `applyDockIcon` reads `assets/icon.png`
      on each `setRegular()`, which is the only moment a Dock icon exists at all. Confirmed to
      decode as a 1024x1024 PNG, not confirmed to appear: ask any question and look at the Dock.
      A blank slot there means `nativeImage` refused the file, and the log carries an `[icon]`
      warning if it did.
- [ ] **Forget mode cookie seeding.** Rewritten after the first version turned out to copy a
      cookie that does not exist; not run since. First forget-mode query prints
      `[private] seeded N/M google.com cookies` — `0` means it is still broken. See README,
      "Known gaps".
- [ ] **Bar over a full-screen app on Tahoe.** Confirmed on Sequoia only. The explicit
      `setVisibleOnAllWorkspaces` call was dropped on macOS because a panel force-ORs that
      collection behaviour itself; if the bar fails to appear over a full-screen app, restore
      that line unconditionally in `createLauncher`.
- [ ] **Clicking near the bar's top edge on Tahoe.** Electron panels have a known leak where a
      hidden titlebar activates the app. `roundedCorners: false` is already in as the reported
      fix, but nobody has tried to trigger it.

## Open on Tahoe

Seen on macOS 26 and not on 15.6, both reported 2026-08-28. Neither is a new bug: they are
existing choices that Sequoia was hiding.

- [ ] **The bar lags between the hotkey and appearing.** Every summon destroys the old bar and
      builds a new window plus renderer, by design, so it is born on the current Space. The
      suspicion is narrower than that though: the reveal has a primary trigger (`ready-to-show`)
      and a fallback (`did-finish-load` plus a 250 ms timer). If the primary never fires for a
      transparent panel on Tahoe, every summon pays that fixed quarter second. `showLauncher` now
      logs which trigger won and the total milliseconds to `.userdata/diagnostics.log`, so one
      press on the Tahoe machine settles it. A log full of `fallback` means the timer is the lag.
- [ ] **A faint translucent rectangle shows at the bar's corners.** `roundedCorners: false`
      (added as the titlebar-click fix) means the window really is a hard rectangle and only CSS
      rounds it, so the corner notches are not empty: `#panel`'s `box-shadow` paints into them,
      and `hasShadow` is unset so macOS also draws its own rectangular window shadow. Three
      one-line tests, each isolating one source: `hasShadow: false`; drop the CSS `box-shadow`;
      `roundedCorners: true` (diagnostic only, it reverts the titlebar fix).

## Decisions, one line each

- [ ] **Should `⌘S` update the remembered save folder while in forget mode?** It currently
      does. Saving is an explicit act so this is defensible, but it does leave a trace of a
      forget-mode session in `settings.json`.
- [ ] **Delete the `pre-squash` branch?** It is the only surviving copy of the pre-publish
      60-commit history, and it exists on one laptop only. Keep it deliberately or drop it.

## Small cleanups

- [ ] **The test harness is not in the repo.** README says to run
      `node .scratch/test_walker.js`, but `.scratch/` is gitignored, so a fresh clone cannot
      run the tests at all. Either move it to `test/` and commit it, or stop advertising it.
- [ ] **Vestigial `onReset` / `launcher-reset` IPC.** The renderer still registers a handler
      main never sends, left over from when the bar was hidden rather than destroyed. Dead
      code that implies a lifecycle that no longer exists.
- [ ] **`hasRso` is collected and never read.** `SURFACE_PROBE` gathers it; `diagnoseLoad`
      only looks at `hasResultStats`. Either use it as a second SERP tell or stop collecting.
- [ ] **Draft whitespace.** `draft:save` uses `trim()` only as a test and stashes the raw
      string, so `"  foo "` is restored verbatim with the caret after the trailing space.

## Needs a DOM dump first

All blocked on the same thing: `⌘⇧D` in an AI Mode window writes the answer DOM outline next
to your transcripts. Doing these from guesswork is how selectors rot.

- [ ] **Positive signal for the load-health check.** It can recognise an ordinary results page
      but not an AI Mode answer, so it only catches the common failure. See README,
      "Known gaps".
- [ ] **Generalise the "Ask about" chrome strip.** Currently a conservative exact-match that
      would miss an `Ask about <something>` variant. Never dump-confirmed.
- [ ] **Task-list checkboxes vanish** in saved transcripts — they are real
      `<input type=checkbox>` elements and land in `SKIP_TAGS`.
- [ ] **`<br>` inside table cells flattens.** GFM cells cannot hold line breaks anyway, so
      this may be unfixable rather than unfixed.

## Not built

- [ ] **Package as a real `.app`.** Currently launched with `npm start` from a terminal.
      Packaging gets launch-at-login and no terminal window, and matters more now that it runs
      on two machines. electron-builder, unsigned is fine for personal use. It is also the only
      way to fix the icon everywhere it is still wrong: `assets/icon.png` covers the running Dock
      icon, but Cmd+Tab, Finder and Spotlight read the bundle, which is Electron's. The pieces to
      copy are in the Grimoire repo (`scripts/package_app.js` and `scripts/png_to_icns.js`), which
      packages with `@electron/packager`, converts the same PNG to `.icns` with `sips` +
      `iconutil`, sets `CFBundleIconFile` by hand because packager v20 ignores the icon option,
      and ad-hoc signs the bundle last.
- [ ] **Model selection.** A Reddit post claims `arv=1` selected Gemini 2.5 Pro alongside
      `udm=50`. That post is old and the value is probably stale, but if a current equivalent
      exists it would let the launcher request a better model than the default.
- [ ] **Tab on a highlighted history row prefills it for editing**, rather than re-running it
      verbatim. Parked when history-to-file linking was rejected.
- [ ] **`index.md` for the save folder**, and a teach-then-fade indicator after the first save.

## Parked, needs native code

- [ ] **Surface the mini browser on the current desktop.** Needs `NSWindow.isOnActiveSpace`,
      which Electron does not expose. A reused AI window on another Space jumps you there,
      Cmd+Tab style, which is the accepted behaviour for now.

## Standing risks

Not tasks, but the things most likely to break the app without warning.

- **`udm=50` is undocumented** and could stop selecting AI Mode at any time. The load-health
  check exists for this. See README, "The udm=50 parameter".
- **Electron's panel is not a real `NSPanel`** — it fakes non-activation by overriding the
  `styleMask` getter. If a future macOS stops consulting that getter, the launcher stops
  taking keyboard focus and there is no non-native fallback.
- **macOS will not let an app take the foreground**, only keep it. Any new window handoff has
  to overlap an existing window, or the app drops to zero windows and loses the foreground
  with no way to ask for it back.
