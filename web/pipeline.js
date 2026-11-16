// Browser-side image pipeline: decode (EXIF-upright), thumbnails, halation
// mask, film-stock cubes and the grain tile. No server needed.

// Film stocks set the colour; `chroma` is how much the grain shows as colour
// dye clouds rather than mono silver grain.
export const STOCKS = {
  kodachrome64: { label: "Kodachrome", full: "Kodachrome 64", chroma: 0.18 },
  velvia50: { label: "Velvia 50", full: "Fujichrome Velvia 50", chroma: 0.22 },
  ektachrome100vs: { label: "Ektachrome", full: "Ektachrome 100VS", chroma: 0.28 },
  provia100f: { label: "Provia 100F", full: "Fujichrome Provia 100F", chroma: 0.15 },
};

// Scanned grain samples (G'MIC), fine to coarse. size > 1 is coarser;
// amount scales the Grain slider.
export const GRAINS = {
  tmax400: { label: "T-Max 400", size: 1.0, amount: 0.8 },
  orwo_np20: { label: "Orwo NP20", size: 1.15, amount: 0.9 },
  trix1600: { label: "Tri-X 1600", size: 1.4, amount: 1.1 },
  tmax3200: { label: "T-Max 3200", size: 1.8, amount: 1.35 },
};

const LUT_N = 64;
const THUMB_PX = 480;
const lutCache = new Map();

/** Decode a photo upright (EXIF orientation applied). */
export function decodeFull(blob) {
  return createImageBitmap(blob, { imageOrientation: "from-image" });
}

/** Small upright copy for the filmstrip, light analysis and halation. */
export async function decodeThumb(blob) {
  const full = await createImageBitmap(blob, { imageOrientation: "from-image" });
  const s = THUMB_PX / Math.max(full.width, full.height);
  const thumb = await createImageBitmap(full, {
    resizeWidth: Math.max(1, Math.round(full.width * s)),
    resizeHeight: Math.max(1, Math.round(full.height * s)),
    resizeQuality: "high",
  });
  const size = { width: full.width, height: full.height };
  full.close();
  return { thumb, ...size };
}

/** Blurred mask of the brightest highlights; the shader tints it red-orange. */
export function haloMask(img) {
  const w = img.width, h = img.height;
  const cv = new OffscreenCanvas(w, h);
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, w, h);
  let m = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const l = (0.299 * d.data[i * 4] + 0.587 * d.data[i * 4 + 1] + 0.114 * d.data[i * 4 + 2]) / 255;
    m[i] = Math.pow(Math.max(0, (l - 0.8) / 0.2), 1.4);
  }
  const r = Math.max(1, Math.round(Math.max(w, h) * 0.009));
  for (let pass = 0; pass < 3; pass++) m = boxBlur(boxBlur(m, w, h, r, true), w, h, r, false);
  for (let i = 0; i < w * h; i++) {
    const v = Math.min(255, m[i] * 255);
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
