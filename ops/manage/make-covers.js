#!/usr/bin/env node
// Usage:
//   node make-covers.mjs <input.png|input.pdf> [outDir] [--page N]
//
// Produces cover-landscape.png (1280x720) and cover-square.png (1280x1280)
// next to the input (or in outDir).
//
// PDF input: renders page N (default 1), cropped to the PDF's TrimBox
// (i.e. without crop marks / bleed), scaled to fit within 854x1280 without
// cutting anything off, and saves it as cover.png. That image is then used
// as the input for the two covers.
// Requires: npm i sharp mupdf   (pure npm, no system packages)

import sharp from "sharp";
import path from "node:path";
import fs from "node:fs/promises";
import { parseArgs } from "node:util";
import { coverColors, printColors, DARK_L, LIGHTER_L } from "./cover-colors.js";

const VARIANTS = [
  { name: "cover-landscape.png", canvas: [1280, 720], img: [407, 610] },
  { name: "cover-square.png", canvas: [1280, 1280], img: [695, 1042] },
];

// Max size of the cover image generated from a PDF
const PDF_COVER_MAX = [854, 1280];

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: { page: { type: "string", short: "p", default: "1" } },
});
let input = positionals[0];
if (!input) {
  console.error("Usage: node make-covers.mjs <input.png|input.pdf> [outDir] [--page N]");
  process.exit(1);
}
const outDir = positionals[1] ?? path.dirname(input);
await fs.mkdir(outDir, { recursive: true });

// ---------- PDF -> cover.png ----------

async function pdfToCover(pdfPath, pageNum, outFile) {
  const mupdf = await import("mupdf");
  const doc = mupdf.Document.openDocument(await fs.readFile(pdfPath), "application/pdf");
  const count = doc.countPages();
  if (pageNum < 1 || pageNum > count) throw new Error(`Page ${pageNum} out of range (1-${count})`);
  const page = doc.loadPage(pageNum - 1);

  // Boxes come back as [x0, y0, x1, y1] in display space (y down, page rotation applied).
  // The page renders its CropBox; TrimBox = final cut size (no crop marks / bleed).
  // mupdf falls back to the CropBox when no TrimBox is set.
  const crop = page.getBounds("CropBox");
  const trim = page.getBounds("TrimBox");
  const r = [
    Math.max(trim[0], crop[0]), Math.max(trim[1], crop[1]),
    Math.min(trim[2], crop[2]), Math.min(trim[3], crop[3]),
  ];
  const hasTrim = r.some((v, i) => Math.abs(v - crop[i]) > 0.5);
  const [twPt, thPt] = [r[2] - r[0], r[3] - r[1]];

  // render so the trimmed area is 2x the target size (downscaled after for quality)
  const [maxW, maxH] = PDF_COVER_MAX;
  const scale = Math.min(maxW / twPt, maxH / thPt) * 2;
  const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
  const [px0, py0] = pix.getBounds();

  const img = sharp(Buffer.from(pix.asPNG()));
  const { width, height } = await img.metadata();
  const left = Math.max(0, Math.round(r[0] * scale - px0));
  const top = Math.max(0, Math.round(r[1] * scale - py0));
  const region = {
    left, top,
    width: Math.min(Math.round(twPt * scale), width - left),
    height: Math.min(Math.round(thPt * scale), height - top),
  };

  // "inside" = fit within maxW x maxH keeping aspect ratio, nothing cropped
  await img.extract(region).resize(maxW, maxH, { fit: "inside" }).png().toFile(outFile);

  const meta = await sharp(outFile).metadata();
  console.log(`wrote ${outFile} (${meta.width}x${meta.height}, page ${pageNum}${hasTrim ? ", cropped to TrimBox" : ", no TrimBox found"})`);
  return outFile;
}

if (path.extname(input).toLowerCase() === ".pdf") {
  input = await pdfToCover(input, parseInt(opts.page, 10), path.join(outDir, "cover.png"));
}

function gradientSvg(w, h, { h: hue, s }) {
  return Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue},${s}%,${DARK_L}%)"/>
      <stop offset="100%" stop-color="hsl(${hue},${s}%,${LIGHTER_L}%)"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
</svg>`);
}

// Rounded corners & shadow (relative to the placed image width, so both sizes look alike)
const RADIUS = 0.04;          // corner radius
const SHADOW_BLUR = 0.06;     // blur sigma
const SHADOW_OFFSET_Y = 0.03; // pushes shadow down a bit
const SHADOW_OPACITY = 0.6;

const roundedRect = (w, h, x, y, rw, rh, r, fill) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
     <rect x="${x}" y="${y}" width="${rw}" height="${rh}" rx="${r}" ry="${r}" fill="${fill}"/>
   </svg>`);

const color = await coverColors(input);
printColors(color);

for (const { name, canvas: [cw, ch], img: [iw, ih] } of VARIANTS) {
  const left = Math.round((cw - iw) / 2);
  const top = Math.round((ch - ih) / 2);
  const r = Math.round(iw * RADIUS);

  // "cover" fit: scale to fill iw x ih, crop overflow equally from both sides,
  // then cut rounded corners with a mask
  const fitted = await sharp(input)
    .resize(iw, ih, { fit: "cover", position: "centre" })
    .ensureAlpha()
    .composite([{ input: roundedRect(iw, ih, 0, 0, iw, ih, r, "#fff"), blend: "dest-in" }])
    .png()
    .toBuffer();

  // soft drop shadow, rendered on a full-size transparent layer so the blur isn't clipped
  const shadow = await sharp(
    roundedRect(cw, ch, left, top + Math.round(iw * SHADOW_OFFSET_Y), iw, ih, r,
      `rgba(0,0,0,${SHADOW_OPACITY})`))
    .blur(iw * SHADOW_BLUR)
    .png()
    .toBuffer();

  const out = path.join(outDir, name);
  await sharp(gradientSvg(cw, ch, color))
    .composite([
      { input: shadow, left: 0, top: 0 },
      { input: fitted, left, top },
    ])
    .png()
    .toFile(out);
  console.log("wrote", out);
}
