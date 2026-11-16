// Light-leak generation. Every leak is a pure function of (seed, photo light
// analysis), so a saved seed recreates the exact same leak at export time.

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const newSeed = () => (Math.random() * 2 ** 32) >>> 0;

export function hashSeed(str) {
  let h = 2166136261;
  for (const ch of str) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/**
 * Where is the light? Samples the image small and returns the centroid and
 * colour of its brightest pixels (uv 0..1, y down) plus overall brightness.
 */
export function analyseLight(img, size = 64) {
  const w = size, h = Math.max(1, Math.round((size * img.height) / img.width));
  const cv = new OffscreenCanvas(w, h);
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const lums = new Float32Array(w * h);
  let mean = 0;
  for (let i = 0; i < w * h; i++) {
    lums[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
    mean += lums[i];
  }
  mean /= w * h;
  const sorted = Float32Array.from(lums).sort();
  const thresh = Math.max(sorted[Math.floor(sorted.length * 0.97)], mean);
  let sx = 0, sy = 0, sw = 0, r = 0, g = 0, b = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (lums[i] < thresh) continue;
    const wt = lums[i] - thresh + 0.02;
    sx += (x + 0.5) * wt; sy += (y + 0.5) * wt; sw += wt;
    r += d[i * 4] * wt; g += d[i * 4 + 1] * wt; b += d[i * 4 + 2] * wt;
  }
  if (!sw) return { cx: 0.5, cy: 0.5, hue: 0.07, mean };
  return { cx: sx / sw / w, cy: sy / sw / h, hue: rgbHue(r / sw, g / sw, b / sw), mean };
}

function rgbHue(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d < 1e-6) return 0.08;
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return ((h / 6) + 1) % 1;
}

// Warm-range hue (fraction of the colour wheel, red = 0). Leaks are always
// warm-ish: magenta-red through orange to yellow.
const wrapHue = (h) => (h > 0.5 ? h - 1 : h);
const clampWarm = (h) => Math.min(0.06, Math.max(-0.07, wrapHue(h)));

/**
 * Pick the frame edge a leak enters from: 0 left, 1 right, 2 top, 3 bottom.
 * `edges` limits the choice; when following the light, the edge nearest the
 * brightest area wins most of the time.
 */
function pickEdge(r, light, aware, edges = [0, 1, 2, 3]) {
  if (aware && light && r() < 0.8) {
    const dist = [light.cx, 1 - light.cx, light.cy, 1 - light.cy];
    const edge = edges.reduce((a, b) => (dist[b] < dist[a] ? b : a));
    const along = (edge < 2 ? light.cy : light.cx) + (r() - 0.5) * 0.4;
    return { edge, along: Math.min(1, Math.max(0, along)) };
  }
  return { edge: edges[Math.floor(r() * edges.length)], along: r() };
}

/** Generated leak parameters (shader uniforms) in aspect space (x 0..aspect, y 0..1). */
export function generatedLeak(seed, light, aware, aspect) {
  const r = rng(seed);
  const roll = r();
  const type = roll < 0.4 ? 0 : roll < 0.75 ? 1 : 2;
  // Film runs along the frame's long side, so leaks between frames enter from
  // the short edges: left/right of a landscape frame, top/bottom of a portrait.
  const frameEdges = aspect >= 1 ? [0, 1] : [2, 3];
  const { edge, along } = pickEdge(r, light, aware, type === 0 ? undefined : frameEdges);
  const inward = [[1, 0], [-1, 0], [0, 1], [0, -1]][edge];
  const edgePoint = [[0, along], [aspect, along], [along * aspect, 0], [along * aspect, 1]][edge];
  let pos, dir, size;
  if (type === 0) {
    size = 0.5 + r() * 0.7;
    const out = size * (0.05 + r() * 0.3);
    pos = [edgePoint[0] - inward[0] * out, edgePoint[1] - inward[1] * out];
    dir = inward;
  } else if (type === 1) {
    size = 0.06 + r() * 0.16;
    const inset = r() * 0.15;
    pos = [edgePoint[0] + inward[0] * inset, edgePoint[1] + inward[1] * inset];
    dir = edge < 2 ? [0, 1] : [1, 0];
  } else {
    size = 0.25 + r() * 0.45;
    pos = edgePoint;
    dir = inward;
  }
  let hue = -0.05 + r() * 0.1;
  if (aware && light) hue = clampWarm(hue * 0.6 + wrapHue(light.hue) * 0.4);
  return {
    mode: 1, type, pos, dir, size, hue,
    intensity: 0.55 + 0.85 * Math.pow(r(), 1.6),
    noiseSeed: r() * 100,
    edge,
  };
}

// The 8 rotations/flips of a leak image, as 2x2 matrices acting on centred coords.
const ORIENTS = [
  [1, 0, 0, 1], [0, -1, 1, 0], [-1, 0, 0, -1], [0, 1, -1, 0],
  [-1, 0, 0, 1], [0, 1, 1, 0], [1, 0, 0, -1], [0, -1, -1, 0],
];

/**
 * Real-scan leak: choose a scan, an orientation, a zoomed crop and a hue nudge.
 * `leaks` are {name, width, height, light} (light = analyseLight of the scan).
 * Returns the mat3 mapping photo uv -> leak uv (column-major for WebGL).
 */
export function realLeak(seed, leaks, light, aware, aspect) {
  const r = rng(seed);
  const leak = leaks[Math.floor(r() * leaks.length)];
  const la = leak.width / leak.height;
  // Orientation: when following the light, point the scan's bright side at it.
  let k = Math.floor(r() * 8);
  if (aware && light && leak.light && r() < 0.8) {
    const want = [light.cx - 0.5, light.cy - 0.5];
    const have = [leak.light.cx - 0.5, leak.light.cy - 0.5];
    let best = -Infinity;
    ORIENTS.forEach((m, i) => {
      // Inverse of an orthogonal matrix is its transpose: leak -> photo direction.
      const v = [m[0] * have[0] + m[2] * have[1], m[1] * have[0] + m[3] * have[1]];
      const score = v[0] * want[0] + v[1] * want[1];
      if (score > best) { best = score; k = i; }
    });
  }
  const m = ORIENTS[k];
  // Photo half-extents in aspect space, after rotating into the leak's frame.
  const ex = Math.abs(m[0]) * aspect + Math.abs(m[1]) * 1;
  const ey = Math.abs(m[2]) * aspect + Math.abs(m[3]) * 1;
  const cover = Math.max(ex / la, ey);
  const zoom = 1 + r() * 0.25;
  const s = 1 / (cover * zoom);
  const slack = [0.5 - (ex * s) / (2 * la), 0.5 - (ey * s) / 2];
  // Keep the crop on the scan's bright area: scans are mostly black, so a
  // random crop can miss the leak entirely.
  const bright = leak.light ? [leak.light.cx - 0.5, leak.light.cy - 0.5] : [0, 0];
  const clampTo = (v, lim) => Math.max(-lim, Math.min(lim, v));
  const off = [0, 1].map((i) => clampTo(bright[i] + (r() * 2 - 1) * slack[i] * 0.3, slack[i]));
  const map = (u, v) => {
    const px = (u - 0.5) * aspect, py = v - 0.5;
    const lx = m[0] * px + m[1] * py, ly = m[2] * px + m[3] * py;
    return [(lx * s) / la + 0.5 + off[0], ly * s + 0.5 + off[1]];
  };
  const o = map(0, 0), ux = map(1, 0), vy = map(0, 1);
  const matrix = new Float32Array([
    ux[0] - o[0], ux[1] - o[1], 0,
    vy[0] - o[0], vy[1] - o[1], 0,
    o[0], o[1], 1,
  ]);
  return {
    mode: 2, name: leak.name, matrix,
    hueShift: (r() - 0.5) * 0.35,
    intensity: 0.65 + r() * 0.45,
  };
}
