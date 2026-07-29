# TODO

Low-priority leftovers. Nothing here blocks daily use — the app is working on macOS 15.6
Sequoia and 26.5 Tahoe as of 2026-07-28.

Where reasoning already lives in [README.md](README.md), these entries stay short and point
there rather than restating it, so the two files cannot drift apart.

## Unverified

Believed done, never actually confirmed.

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
      on two machines. electron-builder, unsigned is fine for personal use.
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
