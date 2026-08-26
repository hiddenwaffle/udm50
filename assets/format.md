# Icon source format

Files here:

- **`icon.png`** — the macOS-shaped app icon: the mark in a rounded square, inset on a
  transparent 1024x1024 canvas. macOS rounds and pads nothing for you, so the shape is baked
  into the image. **This is the file the app reads.** Generated, not hand-drawn: `npm run icon`
  writes it.
- **`icon.src.png`** (optional, absent by default) — your own art. Drop a square image here and
  `npm run icon` fits it into the same shape instead of drawing the built-in mark.
  `icon.src.jpg`, `icon.jpg` and `icon.jpeg` also work.

The other files in this folder are the README's diagrams, unrelated to the icon.

## Rebuilding it

```bash
npm run icon      # needs ImageMagick: brew install imagemagick
```

With no source art present it draws the built-in mark: the same `✦` the menu bar wears, filled
with a gradient from the launcher's caret blue to forget mode's violet, on the panel's
near-black. The point is that the icon carries the app's own palette rather than a stranger's.
With source art present it fits that art into an 824x824 rounded square (radius 185) centred on
the 1024 canvas, filling and centre-cropping whatever does not fit.

Prefer a ready-made icon? Drop your own square 1024x1024 PNG straight in as `icon.png` and skip
the script entirely.

## How the icon is used

- **`src/main.js`** loads `icon.png` for the running **Dock** icon (`app.dock.setIcon`, in
  `applyDockIcon`). It is applied on each `setRegular()`, which is the moment the Dock icon
  appears at all: this app is an accessory with no Dock icon until an AI Mode window opens.
- **Packaging** is not built yet (see TODO.md). When it is, the same `icon.png` becomes the
  bundle's `.icns` via `sips` + `iconutil`, and that bundle icon is what Finder, Spotlight and
  the Cmd+Tab switcher read.

> [!NOTE]
> Under `npm start` the app runs out of Electron's own bundle. Anything that reads the *bundle*
> icon rather than the running app's still shows Electron's icon: Cmd+Tab most likely, Finder and
> Spotlight certainly. Only packaging fixes those.
