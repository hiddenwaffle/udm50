'use strict';
// Builds assets/icon.png — the macOS app icon, used for the running Dock icon (src/main.js)
// and, once packaging exists, as the source for the bundle's .icns.
//
// Two modes, one command:
//   * Source art present (assets/icon.src.png / .jpg / .jpeg) → that art is fit into the
//     macOS shape.
//   * No source art → the built-in mark is drawn: the ✦ the tray already wears, in the
//     launcher's own palette (blue caret #4c8dff → forget-mode violet #c39bff on near-black).
//     A placeholder with the app's identity rather than a stranger's, and replaced simply by
//     dropping your art in assets/ and re-running.
//
// The shape is baked into the PNG because macOS rounds and pads nothing for you: art fit into
// an 824x824 rounded square (radius 185), centred on a transparent 1024x1024 canvas.
//
// Needs ImageMagick (brew install imagemagick). Run: npm run icon

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'assets');
const OUT = path.join(assets, 'icon.png');

const CANVAS = 1024; // what macOS wants at the top of an .icns
const ART = 824;     // the art square inside it — the rest is the mandatory margin
const RADIUS = 185;  // corner radius at ART size, matching the platform's rounded square

// Palette lifted from src/launcher.html so the icon can't drift from the app it stands for.
const INK_TOP = '#2b2b30';    // near-black panel, lifted slightly at the top
const INK_BOTTOM = '#121214';
const SPARK_TOP = '#5b9bff';  // the caret blue
const SPARK_BOTTOM = '#c39bff'; // forget mode's violet

// A four-point sparkle, drawn rather than typeset: the ✦ glyph varies by font, and at icon size
// the arms have to be thinner than any of them. Four tips at TIP from the centre, joined by
// concave curves whose control points sit at (A, B) and (B, A) off the centre — the pair is what
// sets how thin the waist is, so both are here to be tuned. Smaller = sharper.
const TIP = 320;  // centre to tip; leaves the arms clear of the rounded corners
const A = 26;
const B = 62;
const SPARKLE = (() => {
  const c = ART / 2;
  const p = (x, y) => `${c + x} ${c + y}`;
  // Clockwise from the top tip. Each quadrant mirrors the last, so the arms stay identical.
  return [
    `M ${p(0, -TIP)}`,
    `C ${p(A, -B)}, ${p(B, -A)}, ${p(TIP, 0)}`,
    `C ${p(B, A)}, ${p(A, B)}, ${p(0, TIP)}`,
    `C ${p(-A, B)}, ${p(-B, A)}, ${p(-TIP, 0)}`,
    `C ${p(-B, -A)}, ${p(-A, -B)}, ${p(0, -TIP)}`,
    'Z',
  ].join(' ');
})();

function magick(args) {
  execFileSync('magick', args, { stdio: 'ignore' });
}

// Opaque black/white, never transparent: a transparent mask with DstIn does NOT round here (it
// yields a full square). Luminance copied into alpha with CopyAlpha is what actually rounds.
function roundedMask(file) {
  magick(['-size', `${ART}x${ART}`, 'xc:black', '-fill', 'white',
    '-draw', `roundrectangle 0,0,${ART - 1},${ART - 1},${RADIUS},${RADIUS}`, file]);
}

// Fit any art into the art square: fill, then centre-crop whatever overflows.
function fitToSquare(src, out) {
  magick([src, '-resize', `${ART}x${ART}^`, '-gravity', 'center', '-extent', `${ART}x${ART}`, out]);
}

// The built-in mark, in the absence of source art.
function drawMark(work, out) {
  const bg = path.join(work, 'bg.png');
  const grad = path.join(work, 'grad.png');
  const mask = path.join(work, 'sparkle_mask.png');
  const spark = path.join(work, 'sparkle.png');
  magick(['-size', `${ART}x${ART}`, `gradient:${INK_TOP}-${INK_BOTTOM}`, bg]);
  magick(['-size', `${ART}x${ART}`, `gradient:${SPARK_TOP}-${SPARK_BOTTOM}`, grad]);
  magick(['-size', `${ART}x${ART}`, 'xc:black', '-fill', 'white', '-draw', `path '${SPARKLE}'`, mask]);
  // Same CopyAlpha trick as the corners: the mask decides the shape, the gradient keeps the colour.
  magick([grad, mask, '-alpha', 'off', '-compose', 'CopyAlpha', '-composite', spark]);
  magick([bg, spark, '-compose', 'Over', '-composite', out]);
}

function main() {
  try {
    execFileSync('magick', ['-version'], { stdio: 'ignore' });
  } catch (_) {
    console.error(
      'ImageMagick not found — install it (brew install imagemagick) to build the icon,\n' +
      'or drop a ready-made square 1024x1024 PNG at assets/icon.png yourself and skip this step.'
    );
    process.exit(1);
  }

  // Anything but icon.png, which is our OUTPUT — never reshape our own result.
  const src = ['icon.src.png', 'icon.src.jpg', 'icon.jpg', 'icon.jpeg']
    .map((n) => path.join(assets, n))
    .find((p) => fs.existsSync(p));

  // .scratch/ rather than the system temp dir: this repo keeps its working files in-tree. It is
  // gitignored and may not exist in a fresh clone, so make it rather than assume it.
  const scratch = path.join(root, '.scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const work = fs.mkdtempSync(path.join(scratch, 'icon_'));
  try {
    const art = path.join(work, 'art.png');
    if (src) fitToSquare(src, art);
    else drawMark(work, art);

    const mask = path.join(work, 'corner_mask.png');
    roundedMask(mask);
    // Reset -compose to Over after CopyAlpha or it persists into -extent and composites the
    // whole thing away.
    // -strip so the result is DETERMINISTIC: ImageMagick otherwise stamps a creation date into
    // the PNG, and a binary file that changes on every rebuild shows up as a git diff when
    // nothing about the icon changed at all.
    magick([art, mask, '-alpha', 'off', '-compose', 'CopyAlpha', '-composite',
      '-compose', 'Over', '-background', 'none', '-gravity', 'center',
      '-extent', `${CANVAS}x${CANVAS}`, '-strip', OUT]);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  console.log(src
    ? `Shaped ${path.relative(root, src)} → assets/icon.png (rounded + inset, ${CANVAS}x${CANVAS}).`
    : `Drew the built-in ✦ mark → assets/icon.png (${CANVAS}x${CANVAS}). Drop your own art at ` +
      'assets/icon.src.png and re-run to replace it.');
}

main();
