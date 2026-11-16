// Browser-side image pipeline: decode (EXIF-upright), thumbnails, halation
// mask, film-stock cubes and the grain tile. No server needed.

// Film stocks set the colour (3D LUT in assets/luts/<key>.png).
export const STOCKS = {
  kodachrome64: { label: "Kodachrome", full: "Kodachrome 64" },
  velvia50: { label: "Velvia 50", full: "Fujichrome Velvia 50" },
  ektachrome100vs: { label: "Ektachrome", full: "Ektachrome 100VS" },
  provia100f: { label: "Provia 100F", full: "Fujichrome Provia 100F" },
};

// Grains. Each uses a scanned tile (assets/grain/<tile>.png). size > 1 is
// coarser, amount scales the Grain slider, chroma is how much the grain shows
// as colour dye clouds (colour film) rather than mono silver grain (B&W film).
// The film grains share keys with STOCKS, so "match grain to film" is a lookup.
// Their values follow published RMS granularity: Provia finest, Kodachrome crispest.
export const GRAINS = {
  kodachrome64: { label: "Kodachrome", full: "Kodachrome 64 grain", tile: "tmax400", size: 1.0, amount: 1.0, chroma: 0.18 },
  velvia50: { label: "Velvia 50", full: "Velvia 50 grain", tile: "tmax400", size: 0.85, amount: 0.8, chroma: 0.22 },
  ektachrome100vs: { label: "Ektachrome", full: "Ektachrome 100VS grain", tile: "tmax400", size: 0.85, amount: 0.8, chroma: 0.28 },
  provia100f: { label: "Provia 100F", full: "Provia 100F grain", tile: "tmax400", size: 0.75, amount: 0.65, chroma: 0.15 },
  // More grain types (black-and-white scans), fine to coarse.
  tmax400: { label: "T-Max 400", full: "Kodak T-Max 400", tile: "tmax400", size: 1.0, amount: 0.8, chroma: 0, extra: true },
  orwo_np20: { label: "Orwo NP20", full: "Orwo NP20", tile: "orwo_np20", size: 1.15, amount: 0.9, chroma: 0, extra: true },
  trix1600: { label: "Tri-X 1600", full: "Kodak Tri-X 1600", tile: "trix1600", size: 1.4, amount: 1.1, chroma: 0, extra: true },
  tmax3200: { label: "T-Max 3200", full: "Kodak T-Max 3200", tile: "tmax3200", size: 1.8, amount: 1.35, chroma: 0, extra: true },
};

const LUT_N = 64;
const THUMB_PX = 480;
const lutCache = new Map();

/** Decode a photo upright (EXIF orientation applied). */
export function decodeFull(blob) {
  return createImageBitmap(blob, { imageOrientation: "from-image" });
}

const HALO_PX = 640;

/**
 * Small upright copy for the filmstrip and light analysis, plus a highlight
 * map for halation. The highlight map keeps the BRIGHTEST pixel of each cell
 * of the full-resolution photo, so small lights (candles, fairy lights) that
 * an ordinary downscale would average away still produce a glow.
 */
export async function decodeThumb(blob) {
  const full = await createImageBitmap(blob, { imageOrientation: "from-image" });
  const s = THUMB_PX / Math.max(full.width, full.height);
  const thumb = await createImageBitmap(full, {
    resizeWidth: Math.max(1, Math.round(full.width * s)),
    resizeHeight: Math.max(1, Math.round(full.height * s)),
    resizeQuality: "high",
  });
  const peak = peakLuminance(full, HALO_PX);
  const size = { width: full.width, height: full.height };
  full.close();
  return { thumb, peak, ...size };
}

function peakLuminance(img, maxSide) {
  const W = img.width, H = img.height;
  const cv = new OffscreenCanvas(W, H);
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const src = ctx.getImageData(0, 0, W, H).data;
  const cell = Math.max(1, Math.ceil(Math.max(W, H) / maxSide));
  const w = Math.ceil(W / cell), h = Math.ceil(H / cell);
  const data = new Float32Array(w * h);      // brightest luminance per cell
  const rgb = new Float32Array(w * h * 3);   // colour of that brightest pixel
  const avg = new Float32Array(w * h * 3);   // average colour of the cell
  const count = new Float32Array(w * h);
  for (let y = 0; y < H; y++) {
    const row = Math.floor(y / cell) * w;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const r = src[i] / 255, g = src[i + 1] / 255, b = src[i + 2] / 255;
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      const j = row + Math.floor(x / cell);
      avg[j * 3] += r; avg[j * 3 + 1] += g; avg[j * 3 + 2] += b; count[j]++;
      if (l > data[j]) {
        data[j] = l;
        rgb[j * 3] = r; rgb[j * 3 + 1] = g; rgb[j * 3 + 2] = b;
      }
    }
  }
  for (let j = 0; j < w * h; j++) for (let c = 0; c < 3; c++) avg[j * 3 + c] /= count[j] || 1;
  return { w, h, data, rgb, avg };
}

/**
 * Mist (Black Pro-Mist style) bloom map: highlights in their own colour,
 * spread by a tight and a very wide glow. Starts lower than halation, since
 * a mist filter softens bright midtones too, not just light sources.
 */
export function bloomMap(peak) {
  const { w, h, data, rgb, avg } = peak;
  const side = Math.max(w, h);
  const ch = [0, 1, 2].map(() => new Float32Array(w * h));
  const ss = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  for (let i = 0; i < w * h; i++) {
    // Large bright areas bloom by their average light (soft); small point
    // lights add a little extra from their peak so they still sparkle.
    const la = 0.299 * avg[i * 3] + 0.587 * avg[i * 3 + 1] + 0.114 * avg[i * 3 + 2];
    const ka = ss(0.62, 1.0, la), kp = ss(0.85, 1.0, data[i]) * 0.35;
    for (let c = 0; c < 3; c++) ch[c][i] = avg[i * 3 + c] * ka + rgb[i * 3 + c] * kp;
  }
  const blur = (src, r) => {
    let out = src;
    for (let pass = 0; pass < 3; pass++) out = boxBlur(boxBlur(out, w, h, r, true), w, h, r, false);
    return out;
  };
  const rt = Math.max(1, Math.round(side * 0.006)), rw = Math.max(2, Math.round(side * 0.03));
  const d = new ImageData(w, h);
  const tight = ch.map((c) => blur(c, rt));
  const wide = ch.map((c) => blur(c, rw));
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) d.data[i * 4 + c] = Math.min(1, tight[c][i] * 0.6 + wide[c][i] * 1.7) * 255;
    d.data[i * 4 + 3] = 255;
  }
  return d;
}

/**
 * Halation mask from the highlight map: a tight glow plus a wide one, the way
 * light scatters back through the film base. The shader tints it red-orange.
 */
export function haloMask(peak) {
  const { w, h, data } = peak;
  const m = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const t = Math.min(1, Math.max(0, (data[i] - 0.72) / 0.26));
    m[i] = t * t * (3 - 2 * t); // smoothstep(0.72, 0.98)
  }
  const blur = (src, r) => {
    let out = src;
    for (let pass = 0; pass < 3; pass++) out = boxBlur(boxBlur(out, w, h, r, true), w, h, r, false);
    return out;
  };
  const side = Math.max(w, h);
  const tight = blur(m, Math.max(1, Math.round(side * 0.004)));
  const wide = blur(m, Math.max(1, Math.round(side * 0.018)));
  const bleed = blur(m, Math.max(2, Math.round(side * 0.045))); // long red bleed
  const d = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = Math.min(1, tight[i] * 2.2 + wide[i] * 3.5 + bleed[i] * 4.5) * 255;
    d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = v;
    d.data[i * 4 + 3] = 255;
  }
  return d;
}

function boxBlur(src, w, h, r, horizontal) {
  const out = new Float32Array(w * h);
  const [len, lines] = horizontal ? [w, h] : [h, w];
  const at = (line, k) => (horizontal ? line * w + k : k * w + line);
  for (let line = 0; line < lines; line++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[at(line, Math.min(len - 1, Math.max(0, k)))];
    for (let k = 0; k < len; k++) {
      out[at(line, k)] = acc / (2 * r + 1);
      acc += src[at(line, Math.min(len - 1, k + r + 1))] - src[at(line, Math.max(0, k - r))];
    }
  }
  return out;
}

async function loadBitmap(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url}`);
  return createImageBitmap(await res.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
}

/** Unpack an 8x8 tile sheet (tile = blue, x = red, y = green) into RGBA cube bytes. */
export function loadLut(key) {
  if (!lutCache.has(key)) {
    lutCache.set(key, (async () => {
      const img = await loadBitmap(`assets/luts/${key}.png`);
      const cv = new OffscreenCanvas(img.width, img.height);
      const ctx = cv.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
      ctx.drawImage(img, 0, 0);
      const sheet = ctx.getImageData(0, 0, img.width, img.height).data;
      const tiles = img.width / LUT_N;
      const out = new Uint8Array(LUT_N * LUT_N * LUT_N * 4);
      for (let b = 0; b < LUT_N; b++) {
        const tx = (b % tiles) * LUT_N, ty = Math.floor(b / tiles) * LUT_N;
        for (let g = 0; g < LUT_N; g++) {
          const src = ((ty + g) * img.width + tx) * 4;
          out.set(sheet.subarray(src, src + LUT_N * 4), (b * LUT_N + g) * LUT_N * 4);
        }
      }
      return out;
    })());
  }
  return lutCache.get(key);
}

const grainCache = new Map();
export function loadGrain(key) {
  if (!grainCache.has(key)) grainCache.set(key, loadBitmap(`assets/grain/${key}.png`));
  return grainCache.get(key);
}
