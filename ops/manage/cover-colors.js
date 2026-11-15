#!/usr/bin/env node
// Usage:
//   node cover-colors.js <image.png|jpg> [more images...]
//
// Prints primaryColor / primaryColorDark for a cover image, ready to paste
// into a resource info.yml. Also used by make-covers.js for the background gradient.
// Requires: npm i sharp

import sharp from "sharp";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Gradient lightness (HSL %), from darker to slightly less dark
export const DARK_L = 10;
export const LIGHTER_L = 22;
// lightness of primaryColor (darker than the gradient's lighter stop)
export const PRIMARY_L = 16;
// cap saturation so the colors don't get garish
const MAX_S = 60;

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

export function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return "#" + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
}

// Pixels darker / lighter than this (HSL L %) or less saturated carry no usable hue
const MIN_L = 8;
const MAX_L = 92;
const MIN_S = 15;
// Below this share of colorful pixels the image is treated as gray
const MIN_COLORFUL_SHARE = 0.12;
const HUE_BINS = 36; // 10° each

/**
 * Finds the image's main hue, ignoring near-black, near-white and grayish pixels
 * (sharp's `dominant` favours large flat dark/light areas, which have no hue).
 * Falls back to gray only when the image has little color.
 * @returns {{h: number, s: number}} hue in degrees, saturation in %
 */
async function mainHue(input) {
  const { data, info } = await sharp(input)
    .resize(128, 128, { fit: "inside" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const total = info.width * info.height;
  const weights = new Array(HUE_BINS).fill(0);
  const sats = new Array(HUE_BINS).fill(0);
  let colorful = 0;

  for (let i = 0; i < data.length; i += info.channels) {
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    if (s < MIN_S || l < MIN_L || l > MAX_L) continue;
    colorful++;
    const bin = Math.floor(h / (360 / HUE_BINS)) % HUE_BINS;
    // more saturated pixels count more
    weights[bin] += s;
    sats[bin] += s * s;
  }

  if (colorful / total < MIN_COLORFUL_SHARE) {
    return { h: 0, s: 0 };
  }

  // smooth over neighbouring bins so a hue split across a bin boundary isn't penalised
  let best = 0, bestWeight = -1;
  for (let b = 0; b < HUE_BINS; b++) {
    const w = weights[(b + HUE_BINS - 1) % HUE_BINS] + weights[b] + weights[(b + 1) % HUE_BINS];
    if (w > bestWeight) { bestWeight = w; best = b; }
  }

  // weighted average hue (circular) and saturation over the winning bin and its neighbours
  let x = 0, y = 0, wSum = 0, sSum = 0;
  for (const b of [best - 1, best, best + 1]) {
    const bin = (b + HUE_BINS) % HUE_BINS;
    const angle = ((bin + 0.5) * (360 / HUE_BINS)) * Math.PI / 180;
    x += Math.cos(angle) * weights[bin];
    y += Math.sin(angle) * weights[bin];
    wSum += weights[bin];
    sSum += sats[bin];
  }
  const h = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return { h, s: sSum / wSum };
}

/**
 * Determines the cover colors from the image's main hue (saturation capped).
 * @param {string|Buffer} input image path or buffer (anything sharp accepts)
 * @returns {Promise<{h: number, s: number, primaryColor: string, primaryColorDark: string}>}
 */
export async function coverColors(input) {
  const { h: hue, s: sat } = await mainHue(input);
  const h = Math.round(hue) % 360;
  const s = Math.round(Math.min(sat, MAX_S));
  return {
    h,
    s,
    primaryColor: hslToHex(h, s, PRIMARY_L),
    primaryColorDark: hslToHex(h, s, DARK_L),
  };
}

export function printColors({ primaryColor, primaryColorDark }) {
  console.log(`primaryColor: "${primaryColor}"`);
  console.log(`primaryColorDark: "${primaryColorDark}"`);
}

// ---------- standalone ----------

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("Usage: node cover-colors.js <image.png|jpg> [more images...]");
    process.exit(1);
  }
  for (const file of files) {
    if (files.length > 1) console.log(`# ${file}`);
    printColors(await coverColors(file));
  }
}
