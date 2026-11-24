import { FilmRenderer } from "./gl.js";
import { analyseLight, generatedLeak, hashSeed, newSeed, realLeak, rng } from "./leaks.js";
import { GRAINS, STOCKS, bloomMap, decodeFull, decodeThumb, haloMask, loadGrain, loadLut } from "./pipeline.js";
import { extractExif, withExif } from "./exif.js";
import { ARTIFACT_KINDS, anyArtifacts, artifactParams } from "./artifacts.js";
import * as src from "./sources.js";

const APP_BUILD = "2026-11-24b";
const $ = (sel) => document.querySelector(sel);

// Bump when the default look changes: a saved look from an older build would
// otherwise override the new defaults and the app would open unchanged.
const STATE_VERSION = 5;

// The default look. Everything here is what a first run starts from.
const DEFAULTS = {
  stock: "kodachrome64",
  strength: 1,
  halation: 0.36,
  mist: 0.33,
  vignette: 0.18,
  grain: 1.0,
  grainType: "provia100f", // finest grain, so the Grain dial is what decides
  matchGrain: false,  // pick the grain yourself rather than following the film
  extraGrains: false, // also offer the black-and-white grain scans
  leakMode: "real",   // off | generated | real | mix
  leakAmt: 0.44,
  aware: true,
  artMode: "off", // off | generated | scans | mix — artifacts are opt-in
  artifacts: { dust: true, scratches: true, hairs: false, spots: false },
  artifactAmt: 0.35,
};
const TYPE_NAMES = ["Glow", "Streak", "Wash"];
const EDGE_NAMES = ["left", "right", "top", "bottom"];
const LEAK_PACK_URL = "https://blog.spoongraphics.co.uk/freebies/download-my-free-light-leaks-photo-overlays-to-add-retro-effects-to-your-photos";

const app = {
  photos: [],        // {id, name, getBlob, thumb, halo, light, width, height, ready}
  leakSources: [],   // {id, name, getBlob}
  dustSources: [],   // artifact scans (dust / scratches), same shape
  dust: [],          // decoded artifact scans
  leaks: [],         // decoded scans: {name, img, width, height, light}
  settings: { ...DEFAULTS },
  seeds: {},         // photo name -> {generated, real}
  undo: [],          // [{mode, prev: [[name, seed]]}]
  current: 0,
  before: false,
  full: new Map(),   // photo id -> Promise<ImageBitmap> (small LRU)
  busy: false,
};

let view, thumbs; // renderers

// ---------- photos ----------
async function prepare(photo) {
  if (photo.ready) return photo.ready;
  photo.ready = (async () => {
    const { thumb, peak, width, height } = await decodeThumb(await photo.getBlob());
    Object.assign(photo, { thumb, width, height, halo: haloMask(peak), bloom: bloomMap(peak), light: analyseLight(thumb) });
  })();
  return photo.ready;
}

function fullBitmap(photo) {
  if (!app.full.has(photo.id)) {
    app.full.set(photo.id, photo.getBlob().then(decodeFull));
    while (app.full.size > 2) {
      const [oldId, old] = app.full.entries().next().value;
      app.full.delete(oldId);
      old.then((b) => b.close());
    }
  }
  return app.full.get(photo.id);
}

function clearPhotos() {
  for (const bmp of app.full.values()) bmp.then((b) => b.close()).catch(() => {});
  app.full.clear();
  app.photos = [];
  if (view) view.photoId = null;
}

async function addPhotos(list, { replace = false } = {}) {
  const replaceSamples = replace || (app.photos.length > 0 && app.photos.every((p) => p.sample) && list.some((p) => !p.sample));
  const known = replaceSamples ? new Set() : new Set(app.photos.map((p) => p.id));
  const fresh = list.filter((p) => !known.has(p.id));
  if (!fresh.length) return;
  if (replaceSamples) clearPhotos();
  const first = app.photos.length;
  app.photos.push(...fresh);
  renderStrip();
  syncFolderLabel();
  select(first);
  await Promise.all(fresh.map((p) => prepare(p).catch((e) => toast(`Could not read ${p.label || p.name}: ${e.message}`))));
  scheduleThumbs();
}

/**
 * Decode any not-yet-loaded scans from `sources` into `into` (capped at maxPx).
 * Concurrent callers (main view, thumbnails, export) share one load.
 */
const scanLoads = new Map();
function loadScans(sources, into, maxPx, label) {
  const pending = scanLoads.get(into);
  if (pending) return pending.then(() => loadScans(sources, into, maxPx, label));
  const have = new Set(into.map((l) => l.name));
  const todo = sources.filter((s) => !have.has(s.name));
  if (!todo.length) return Promise.resolve();
  const job = (async () => {
    setStatus(`Loading ${label}…`);
    for (const s of todo) {
      const full = await createImageBitmap(await s.getBlob());
      const k = Math.min(1, maxPx / Math.max(full.width, full.height));
      const img = await createImageBitmap(full, { resizeWidth: Math.round(full.width * k), resizeHeight: Math.round(full.height * k), resizeQuality: "high" });
      full.close();
      into.push({ name: s.name, label: s.label || s.name, img, width: img.width, height: img.height, light: analyseLight(img) });
    }
    setStatus("");
  })().finally(() => scanLoads.delete(into));
  scanLoads.set(into, job);
  return job;
}

const ensureLeakLibrary = () => loadScans(app.leakSources, app.leaks, 2048, "leak scans");
// Dust specks are tiny, so dust scans keep more resolution.
const ensureDustLibrary = () => loadScans(app.dustSources, app.dust, 4096, "dust scans");

// ---------- look ----------
async function bindStock(r) {
  if (r.lutKey !== app.settings.stock) r.setLut(app.settings.stock, await loadLut(app.settings.stock));
}

/** The grain in use: the film's own grain when matching, else the chosen one. */
const currentGrain = () => (app.settings.matchGrain ? app.settings.stock : app.settings.grainType);

/** Grains offered in the stepper and menu. */
const grainChoices = () => Object.keys(GRAINS).filter((k) => app.settings.extraGrains || !GRAINS[k].extra);

async function bindGrain(r) {
  const tile = GRAINS[currentGrain()].tile;
  if (r.grainKey === tile) return;
  const img = await loadGrain(tile);
  if (GRAINS[currentGrain()].tile !== tile) return; // changed again while loading
  r.setGrain(img);
  r.grainKey = tile;
}

function seedFor(photo, mode) {
  const s = (app.seeds[photo.name] ||= {});
  if (s[mode] === undefined) s[mode] = hashSeed(`${photo.name}:${mode}`);
  return s[mode];
}

async function leakFor(r, photo) {
  const { leakMode, aware, leakAmt } = app.settings;
  if (leakMode === "off") return null;
  const aspect = photo.width / photo.height;
  let seed = seedFor(photo, leakMode);
  let kind = leakMode;
  if (leakMode === "mix") {
    // Mix: the seed decides between a generated leak and a real scan.
    await ensureLeakLibrary();
    const r = rng(seed);
    kind = app.leaks.length && r() < 0.5 ? "real" : "generated";
    seed = Math.floor(r() * 2 ** 32);
  }
  if (kind === "generated") {
    const L = generatedLeak(seed, photo.light, aware, aspect);
    return { ...L, amount: L.intensity * leakAmt, bleed: aware };
  }
  await ensureLeakLibrary();
  if (!app.leaks.length) return null;
  const L = realLeak(seed, app.leaks, photo.light, aware, aspect);
  const scan = app.leaks.find((l) => l.name === L.name);
  if (r.leakName !== L.name) {
    r.setImage("leak", scan.img);
    r.leakName = L.name;
  }
  return { ...L, label: scan?.label || L.name, amount: L.intensity * leakAmt, bleed: aware };
}

/**
 * Artifacts for a photo: generated marks, a scanned overlay, or (Mix) either,
 * decided by the photo's artifact seed. Binds the scan texture on `r`.
 */
async function artifactsFor(r, photo) {
  const s = app.settings;
  const aspect = photo.width / photo.height;
  if (s.artMode === "off") return null;
  let seed = seedFor(photo, "artifacts");
  let kind = s.artMode;
  if (kind === "mix" || kind === "scans") await ensureDustLibrary();
  if (kind === "mix") {
    const pick = rng(seed);
    kind = app.dust.length && pick() < 0.5 ? "scans" : "generated";
    seed = Math.floor(pick() * 2 ** 32);
  }
  if (kind === "generated") {
    return anyArtifacts(s.artifacts) ? { generated: artifactParams(seed, s.artifacts, s.artifactAmt, aspect) } : null;
  }
  if (!app.dust.length) return null;
  // Same random scan / orientation / crop as real leaks, without light-following.
  const L = realLeak(seed, app.dust, null, false, aspect);
  const scan = app.dust.find((d) => d.name === L.name);
  if (r.dustName !== L.name) { r.setImage("dust", scan.img); r.dustName = L.name; }
  return {
    scan: {
      name: L.name,
      matrix: L.matrix,
      blend: scan.light.mean < 0.5 ? 1 : 2, // light marks on black: screen; dark on white: multiply
      // Dust overlays are high-contrast, so ease in: faint at the low end.
      amount: Math.pow(s.artifactAmt, 2.2) * 0.9,
    },
  };
}

function params(photo, leak, { grain = true, art = null } = {}) {
  const s = app.settings;
  const g = GRAINS[currentGrain()];
  return {
    aspect: photo.width / photo.height,
    imageWidth: photo.width, imageHeight: photo.height,
    strength: s.strength, halation: s.halation, mist: s.mist, vignette: s.vignette,
    grain: grain ? s.grain * g.amount : 0, grainSize: g.size, grainChroma: g.chroma,
    before: app.before, leak,
    artifacts: art,
  };
}

// ---------- rendering ----------
let frameQueued = false;
function requestRender() {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(async () => {
    frameQueued = false;
    const photo = app.photos[app.current];
    syncEmpty();
    if (!photo) return;
    try {
      await prepare(photo);
      await bindStock(view);
      await bindGrain(view);
      // Show the thumbnail-resolution render at once, then swap in full resolution.
      if (view.photoId !== photo.id) {
        view.setImage("orig", photo.thumb);
        view.setImage("halo", photo.halo);
        view.setImage("bloom", photo.bloom);
        view.photoId = photo.id;
        view.isFull = false;
        fullBitmap(photo).then((bmp) => {
          if (view.photoId !== photo.id) return;
          view.setImage("orig", bmp);
          view.isFull = true;
          requestRender();
        });
      }
      sizeCanvas(photo);
      const leak = await leakFor(view, photo);
      view.render(params(photo, leak, { art: await artifactsFor(view, photo) }));
      describeLeak(leak);
      drawCurrentThumb();
      scheduleThumbs();
    } catch (e) {
      window.__showError(e.stack || e);
    }
  });
}

function sizeCanvas(photo) {
  const vp = $("#stage-viewport") || $("#stage");
  // Phones: the page scrolls, so fit the photo to the stage width with room for
  // the Hold to compare bar underneath. Desktop: fit inside the stage viewport.
  const phone = matchMedia("(max-width: 840px)").matches;
  const maxW = Math.max(1, vp.clientWidth - (phone ? 0 : 32));
  const maxH = Math.max(1, phone ? window.innerHeight * 0.62 : vp.clientHeight - 24);
  const scale = Math.min(maxW / photo.width, maxH / photo.height);
  const cssW = Math.max(1, Math.floor(photo.width * scale)), cssH = Math.max(1, Math.floor(photo.height * scale));
  const dpr = window.devicePixelRatio || 1;
  const cv = $("#view");
  cv.style.width = `${cssW}px`;
  cv.style.height = `${cssH}px`;
  const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
}

// The edited photo's thumbnail updates in the same frame as the big view.
function drawCurrentThumb() {
  const cv = document.querySelector(`.thumb[data-index="${app.current}"] canvas`);
  const source = $("#view");
  if (!cv || !source) return;
  const w = Math.round(cv.clientWidth * (window.devicePixelRatio || 1)) || 300;
  const h = Math.round((w * source.height) / source.width);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, w, h);
}

// ...and the rest of the filmstrip follows a moment later.
let thumbTimer, thumbRun = 0;
function scheduleThumbs() {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(renderThumbs, 120);
}

async function renderThumbs() {
  const run = ++thumbRun;
  const dpr = window.devicePixelRatio || 1;
  for (const [i, photo] of app.photos.entries()) {
    if (i === app.current || !photo.thumb) continue;
    const cv = document.querySelector(`.thumb[data-index="${i}"] canvas`);
    if (!cv) continue;
    await bindStock(thumbs);
    const leak = await leakFor(thumbs, photo);
    if (run !== thumbRun) return; // superseded by a newer change
    thumbs.setImage("orig", photo.thumb);
    thumbs.setImage("halo", photo.halo);
    thumbs.setImage("bloom", photo.bloom);
    const w = Math.round(cv.clientWidth * dpr) || 300;
    const h = Math.round((w * photo.height) / photo.width);
    thumbs.canvas.width = w;
    thumbs.canvas.height = h;
    const art = await artifactsFor(thumbs, photo);
    if (run !== thumbRun) return;
    thumbs.render({ ...params(photo, leak, { grain: false, art }), before: false });
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    cv.getContext("2d").drawImage(thumbs.canvas, 0, 0);
  }
}

// ---------- UI ----------
function describeLeak(leak) {
  const el = $("#leak-info");
  if (!el) return;
  if (app.settings.leakMode === "real" && !app.leakSources.length) el.textContent = "No leak scans added yet.";
  else if (leak && app.settings.leakMode === "mix") el.textContent = `Mix: ${leak.mode === 1 ? `generated ${TYPE_NAMES[leak.type].toLowerCase()}` : (leak.label || leak.name)}`;
  else if (!leak) el.textContent = "";
  else if (leak.mode === 1) el.textContent = `${TYPE_NAMES[leak.type]} from the ${EDGE_NAMES[leak.edge]}, ${Math.round(leak.intensity * 100)}% intensity`;
  else el.textContent = leak.label || leak.name;
}

function setStatus(text) {
  const el = $("#status");
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

function toast(text) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 3500);
}

let saveTimer;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => src.saveState({ version: STATE_VERSION, settings: app.settings, seeds: app.seeds }), 400);
}

function renderStrip() {
  $("#strip").replaceChildren(...app.photos.map((p, i) => {
    const label = p.label || p.name;
    const b = document.createElement("button");
    b.className = "thumb";
    b.dataset.index = i;
    b.title = label;
    b.setAttribute("aria-label", label);
    const cv = document.createElement("canvas");
    cv.className = "thumb-canvas";
    cv.width = 300;
    cv.height = 200;
    b.append(cv);
    return b;
  }));
  syncStrip();
}

function syncFolderLabel() {
  const el = $("#folder-label");
  if (!el) return;
  if (app.localInfo?.inDir && app.localInfo.photos.length) {
    el.textContent = `${app.localInfo.photos.length} photos from ${app.localInfo.inDir}`;
    return;
  }
  if (app.photos.length && app.photos.every((p) => p.sample)) {
    el.textContent = "Example photos — import or drop your own";
    return;
  }
  if (app.photos.some((p) => !p.sample)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-text";
    btn.textContent = "Example photos";
    btn.addEventListener("click", () => addPhotos(src.samplePhotos(), { replace: true }));
    el.replaceChildren(btn);
    return;
  }
  el.textContent = "";
}

function syncStrip() {
  document.querySelectorAll(".thumb").forEach((b) => b.classList.toggle("active", Number(b.dataset.index) === app.current));
}

function syncEmpty() {
  const empty = !app.photos.length;
  $("#empty").hidden = !empty;
  $("#view").hidden = empty;
  const bar = $("#stage-bar");
  if (bar) bar.hidden = empty;
  ["#export-one", "#export-all"].forEach((id) => { $(id).disabled = empty; });
}

// Film and grain steppers: ‹ value ›, wrapping from last to first and back.
// Clicking the value opens a menu of every choice.
const STEPPERS = {
  stock: {
    options: STOCKS,
    choices: () => Object.keys(STOCKS),
    current: () => app.settings.stock,
    set: (k) => { app.settings.stock = k; },
    locked: () => false,
  },
  grain: {
    options: GRAINS,
    choices: grainChoices,
    current: currentGrain,
    set: (k) => { app.settings.grainType = k; },
    locked: () => app.settings.matchGrain,
  },
};

function choose(name, key) {
  STEPPERS[name].set(key);
  syncControls(); // label updates at once; the render follows
  persist();
  requestRender();
}

function step(name, dir) {
  const st = STEPPERS[name];
  if (st.locked()) return;
  const keys = st.choices();
  const i = keys.indexOf(st.current());
  choose(name, keys[(i + dir + keys.length) % keys.length]);
}

// ---- dropdown menu ----
function closeMenu() {
  const menu = $("#menu");
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  document.querySelectorAll(".stepper-value[aria-expanded]").forEach((b) => b.setAttribute("aria-expanded", "false"));
}

function openMenu(name, anchor) {
  const st = STEPPERS[name];
  const menu = $("#menu");
  if (!menu || st.locked()) return;
  if (!menu.hidden && menu.dataset.for === name) return closeMenu();
  const items = [];
  st.choices().forEach((k, i, keys) => {
    const opt = st.options[k];
    if (opt.extra && (i === 0 || !st.options[keys[i - 1]].extra)) {
      const h = document.createElement("li");
      h.className = "menu-heading";
      h.textContent = "More grain types";
      items.push(h);
    }
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.className = "menu-item";
    b.dataset.key = k;
    b.setAttribute("role", "menuitemradio");
    b.setAttribute("aria-checked", String(k === st.current()));
    const tick = document.createElement("span");
    tick.className = "material-symbols-outlined menu-tick";
    tick.textContent = "check";
    const label = document.createElement("span");
    label.textContent = opt.full || opt.label;
    b.append(tick, label);
    li.append(b);
    items.push(li);
  });
  menu.replaceChildren(...items);
  menu.dataset.for = name;
  menu.hidden = false;
  anchor.setAttribute("aria-expanded", "true");
  // Fixed position under the anchor, kept on screen.
  const r = anchor.getBoundingClientRect();
  const w = Math.max(220, r.width);
  menu.style.width = `${w}px`;
  menu.style.left = `${Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8)}px`;
  const below = window.innerHeight - r.bottom;
  const h = menu.offsetHeight;
  menu.style.top = `${below > h + 8 ? r.bottom + 4 : Math.max(8, r.top - h - 4)}px`;
}

// ---- 270° SVG rotary dials (Look controls) ----
function dialPoint(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function dialArc(cx, cy, r, startDeg, endDeg) {
  const span = Math.max(0.25, endDeg - startDeg);
  const start = dialPoint(cx, cy, r, startDeg + span);
  const end = dialPoint(cx, cy, r, startDeg);
  const largeArc = span <= 180 ? "0" : "1";
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 0 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

const DIAL_TRACK_D = dialArc(28, 28, 21, -135, 135);

function updateRotaryDial(row, rawVal) {
  const inp = row.querySelector('input[type="range"]');
  const widget = row.querySelector(".m3-rotary-dial");
  const track = row.querySelector(".rotary-dial-track-arc");
  const arc = row.querySelector(".rotary-dial-value-arc");
  const tick = row.querySelector(".rotary-dial-tick");
  const out = row.querySelector(".control-value");
  if (!inp || !track || !arc) return;
  const min = Number(inp.min || 0), max = Number(inp.max || 1);
  const val = Math.max(min, Math.min(max, Number(rawVal ?? inp.value ?? 0)));
  const norm = max > min ? (val - min) / (max - min) : 0;
  const deg = -135 + norm * 270;
  if (track.getAttribute("d") !== DIAL_TRACK_D) track.setAttribute("d", DIAL_TRACK_D);
  arc.setAttribute("d", dialArc(28, 28, 21, -135, -135 + Math.max(0.002, norm) * 270));
  arc.style.opacity = norm <= 0.002 ? "0" : "1";
  if (tick) {
    const p0 = dialPoint(28, 28, 4.2, deg), p1 = dialPoint(28, 28, 11.2, deg);
    tick.setAttribute("x1", p0.x.toFixed(2));
    tick.setAttribute("y1", p0.y.toFixed(2));
    tick.setAttribute("x2", p1.x.toFixed(2));
    tick.setAttribute("y2", p1.y.toFixed(2));
  }
  const pct = Math.round(norm * 100);
  if (out) out.textContent = `${pct}%`;
  if (widget) {
    widget.setAttribute("aria-valuenow", String(pct));
    widget.setAttribute("aria-valuetext", `${pct}%`);
  }
}

function bindRotaryDials() {
  document.querySelectorAll(".rotary-dial-card").forEach((row) => {
    const widget = row.querySelector(".m3-rotary-dial");
    const inp = row.querySelector('input[type="range"]');
    if (!widget || !inp) return;
    const key = inp.dataset.setting;
    const min = Number(inp.min || 0), max = Number(inp.max || 1), stepSize = Number(inp.step || 0.01);

    const apply = (next) => {
      const stepped = Math.round(next / stepSize) * stepSize;
      const clamped = Math.max(min, Math.min(max, Number(stepped.toFixed(4))));
      if (app.settings[key] === clamped) {
        updateRotaryDial(row, clamped);
        return;
      }
      app.settings[key] = clamped;
      inp.value = String(clamped);
      updateRotaryDial(row, clamped);
      persist();
      requestRender();
    };

    let startY = 0, startVal = 0, dragged = false, lastTap = 0;

    row.addEventListener("pointerdown", (e) => {
      if (e.button && e.button !== 0) return;
      e.preventDefault();
      try { widget.focus({ preventScroll: true }); } catch {}
      startY = e.clientY;
      startVal = Number(app.settings[key] ?? DEFAULTS[key] ?? 0);
      dragged = false;
      row.classList.add("dragging");
      try { row.setPointerCapture(e.pointerId); } catch {}

      const onMove = (ev) => {
        const dy = startY - ev.clientY;
        if (Math.abs(dy) > 2) dragged = true;
        const sens = ev.shiftKey ? 520 : 140;
        apply(startVal + (dy / sens) * (max - min));
      };
      const onEnd = (ev) => {
        row.classList.remove("dragging");
        row.removeEventListener("pointermove", onMove);
        row.removeEventListener("pointerup", onEnd);
        row.removeEventListener("pointercancel", onEnd);
        if (!dragged && ev.type === "pointerup" && ev.pointerType === "touch") {
          const now = performance.now();
          if (now - lastTap < 300) {
            lastTap = 0;
            apply(DEFAULTS[key]);
          } else {
            lastTap = now;
          }
        }
      };
      row.addEventListener("pointermove", onMove);
      row.addEventListener("pointerup", onEnd);
      row.addEventListener("pointercancel", onEnd);
    });

    row.addEventListener("dblclick", (e) => {
      e.preventDefault();
      apply(DEFAULTS[key]);
    });

    row.addEventListener("wheel", (e) => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      apply(Number(app.settings[key]) + dir * stepSize * (e.shiftKey ? 1 : 2));
    }, { passive: false });

    widget.addEventListener("keydown", (e) => {
      const cur = Number(app.settings[key]);
      const coarse = e.shiftKey ? stepSize * 5 : stepSize;
      if (e.key === "ArrowUp" || e.key === "ArrowRight") { e.preventDefault(); apply(cur + coarse); }
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft") { e.preventDefault(); apply(cur - coarse); }
      else if (e.key === "PageUp") { e.preventDefault(); apply(cur + stepSize * 10); }
      else if (e.key === "PageDown") { e.preventDefault(); apply(cur - stepSize * 10); }
      else if (e.key === "Home") { e.preventDefault(); apply(min); }
      else if (e.key === "End") { e.preventDefault(); apply(max); }
    });
  });
}

function syncControls() {
  const s = app.settings;
  // Turning extra grains off while one is chosen falls back to the film's grain.
  if (!grainChoices().includes(s.grainType)) s.grainType = s.stock;
  document.querySelectorAll("[data-stepper]").forEach((el) => {
    const st = STEPPERS[el.dataset.stepper];
    const opt = st.options[st.current()];
    const value = el.querySelector(".stepper-value");
    if (!value || !opt) return;
    value.textContent = opt.label;
    value.title = opt.full || opt.label;
    const locked = st.locked();
    el.classList.toggle("locked", locked);
    el.querySelectorAll("button").forEach((b) => { b.disabled = locked; });
  });
  document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === s.leakMode)));
  document.querySelectorAll("input[data-setting]").forEach((inp) => {
    const v = s[inp.dataset.setting];
    if (inp.type === "checkbox") { inp.checked = !!v; return; }
    inp.value = v;
    const dialRow = inp.closest(".rotary-dial-card");
    if (dialRow) { updateRotaryDial(dialRow, v); return; }
    const out = inp.parentElement.querySelector("output");
    if (out) out.textContent = `${Math.round(v * 100)}%`;
  });
  document.querySelectorAll("[data-artifact]").forEach((b) => b.setAttribute("aria-pressed", String(!!s.artifacts[b.dataset.artifact])));
  document.querySelectorAll("[data-art-mode]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.artMode === s.artMode)));
  const artOn = s.artMode !== "off";
  document.querySelectorAll('[data-action="reroll-art"], [data-action="reroll-art-all"]').forEach((b) => { b.disabled = !artOn; });
  $("#artifact-kinds").hidden = s.artMode !== "generated" && s.artMode !== "mix";
  $("#dust-tools").hidden = s.artMode !== "scans" && s.artMode !== "mix";
  const artInfo = $("#art-info");
  if (artInfo) artInfo.textContent = (s.artMode === "scans" && !app.dustSources.length) ? "No dust scans added yet." : "";
  const leaksOn = s.leakMode !== "off";
  $("#aware-row").hidden = !leaksOn;
  document.querySelectorAll('[data-action="reroll"], [data-action="reroll-all"]').forEach((b) => { b.disabled = !leaksOn; });
  document.querySelectorAll('[data-action="undo"]').forEach((b) => { b.disabled = !app.undo.length; });
  $("#real-tools").hidden = s.leakMode !== "real" && s.leakMode !== "mix";
}

function select(i) {
  if (!app.photos.length) return;
  app.current = (i + app.photos.length) % app.photos.length;
  syncStrip();
  requestRender();
}

/** Re-roll leaks (default) or artifacts ("artifacts") for this photo or all. */
function reroll(all, mode = app.settings.leakMode) {
  if (mode === "off" || !app.photos.length) return;
  if (mode === "artifacts" && app.settings.artMode === "off") return;
  const targets = all ? app.photos : [app.photos[app.current]];
  app.undo.push({ mode, prev: targets.map((p) => [p.name, seedFor(p, mode)]) });
  if (app.undo.length > 100) app.undo.shift();
  targets.forEach((p) => { app.seeds[p.name][mode] = newSeed(); });
  afterSeedChange();
}

/** One undo for every kind of re-roll, newest first. */
function undoReroll() {
  const step = app.undo.pop();
  if (!step) return;
  step.prev.forEach(([name, seed]) => { (app.seeds[name] ||= {})[step.mode] = seed; });
  if (step.mode !== "artifacts" && app.settings.leakMode !== step.mode) app.settings.leakMode = step.mode;
  afterSeedChange();
}

function afterSeedChange() {
  syncControls();
  persist();
  requestRender();
}

async function exportPhotos(list) {
  if (app.busy || !list.length) return;
  app.busy = true;
  const off = new FilmRenderer(document.createElement("canvas"));
  let last = "";
  try {
    await bindGrain(off);
    await bindStock(off);
    for (const [n, photo] of list.entries()) {
      setStatus(`Exporting ${n + 1} of ${list.length}`);
      await prepare(photo);
      const blob = await photo.getBlob();
      const full = await decodeFull(blob);
      off.setImage("orig", full);
      off.setImage("halo", photo.halo);
      off.setImage("bloom", photo.bloom);
      const leak = await leakFor(off, photo);
      const art = await artifactsFor(off, photo);
      const jpeg = await off.exportJpeg(full.width, full.height, { ...params(photo, leak, { art }), before: false });
      full.close();
      const out = await withExif(jpeg, extractExif(await blob.arrayBuffer()));
      last = await src.saveExport(photo.name, out, `${app.settings.stock}${leak ? "-leak" : ""}`);
      if (!src.isLocal()) await new Promise((r) => setTimeout(r, 300)); // let each download start
    }
    toast(src.isLocal() ? `Saved ${list.length === 1 ? last : `${list.length} photos`} ` : `Downloaded ${list.length} photo${list.length > 1 ? "s" : ""}`);
  } finally {
    off.dispose();
    app.busy = false;
    setStatus("");
  }
}

function bindEvents() {
  const run = (fn) => (...a) => Promise.resolve(fn(...a)).catch((e) => window.__showError(e.stack || e));
  $("#strip").addEventListener("click", (e) => {
    const b = e.target.closest(".thumb");
    if (b) select(Number(b.dataset.index));
  });
  document.querySelectorAll("[data-stepper]").forEach((el) => {
    el.addEventListener("click", (e) => {
      const arrow = e.target.closest("[data-step]");
      if (arrow) { closeMenu(); step(el.dataset.stepper, Number(arrow.dataset.step)); return; }
      const value = e.target.closest(".stepper-value");
      if (value) openMenu(el.dataset.stepper, value);
    });
  });
  $("#menu").addEventListener("click", (e) => {
    const item = e.target.closest(".menu-item");
    if (!item) return;
    choose($("#menu").dataset.for, item.dataset.key);
    closeMenu();
  });
  // Dismiss: click outside, Escape, scroll or resize.
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest("#menu, .stepper-value")) closeMenu();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
  window.addEventListener("resize", closeMenu);
  document.addEventListener("scroll", closeMenu, true);
  $("#leak-mode").addEventListener("click", (e) => {
    const b = e.target.closest("[data-mode]");
    if (!b) return;
    app.settings.leakMode = b.dataset.mode;
    syncControls();
    persist();
    requestRender();
  });
  document.querySelectorAll("input[data-setting]").forEach((inp) => {
    inp.addEventListener("input", () => {
      app.settings[inp.dataset.setting] = inp.type === "checkbox" ? inp.checked : Number(inp.value);
      // Unmatching starts the grain picker from the film's own grain.
      if (inp.dataset.setting === "matchGrain" && !inp.checked) app.settings.grainType = app.settings.stock;
      syncControls();
      persist();
      requestRender();
    });
  });
  const actions = {
    reroll: () => reroll(false),
    "reroll-all": () => reroll(true),
    "reroll-art": () => reroll(false, "artifacts"),
    "reroll-art-all": () => reroll(true, "artifacts"),
    undo: undoReroll,
  };
  $("#art-mode").addEventListener("click", (e) => {
    const b = e.target.closest("[data-art-mode]");
    if (!b) return;
    app.settings.artMode = b.dataset.artMode;
    syncControls();
    persist();
    requestRender();
  });
  $("#artifact-kinds").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-artifact]");
    if (!chip) return;
    const k = chip.dataset.artifact;
    app.settings.artifacts = { ...app.settings.artifacts, [k]: !app.settings.artifacts[k] };
    syncControls();
    persist();
    requestRender();
  });
  document.querySelectorAll("[data-action]").forEach((b) => b.addEventListener("click", () => actions[b.dataset.action]?.()));
  $("#export-one").addEventListener("click", run(() => exportPhotos([app.photos[app.current]].filter(Boolean))));
  $("#export-all").addEventListener("click", run(() => exportPhotos(app.photos)));

  // Import: buttons, plus drag and drop anywhere on the page.
  const pick = (input, onFiles) => {
    input.addEventListener("change", run(async () => { await onFiles(input.files); input.value = ""; }));
  };
  const addLeakFiles = async (files) => {
    app.leakSources.push(...src.fromFiles(files));
    if (app.settings.leakMode !== "real" && app.settings.leakMode !== "mix") app.settings.leakMode = "real";
    syncControls();
    persist();
    requestRender();
  };
  pick($("#photo-input"), (files) => addPhotos(src.fromFiles(files)));
  pick($("#leak-input"), addLeakFiles);
  pick($("#dust-input"), async (files) => {
    app.dustSources.push(...src.fromFiles(files));
    if (app.settings.artMode !== "scans" && app.settings.artMode !== "mix") app.settings.artMode = "scans";
    syncControls();
    persist();
    requestRender();
  });
  document.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => $(`#${b.dataset.pick}`).click()));
  document.addEventListener("dragover", (e) => { e.preventDefault(); document.body.classList.add("dragging"); });
  document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("dragging"); });
  document.addEventListener("drop", run(async (e) => {
    e.preventDefault();
    document.body.classList.remove("dragging");
    await addPhotos(src.fromFiles(e.dataTransfer.files));
  }));

  bindRotaryDials();

  const cmp = $("#compare");
  const hold = (v) => {
    if (app.before === v) return;
    app.before = v;
    cmp.setAttribute("aria-pressed", String(v));
    requestRender();
  };
  cmp.addEventListener("pointerdown", (e) => {
    if (e.button && e.button !== 0) return;
    e.preventDefault();
    try { cmp.setPointerCapture(e.pointerId); } catch {}
    hold(true);
  });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((t) => cmp.addEventListener(t, () => hold(false)));
  cmp.addEventListener("keydown", (e) => {
    if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); hold(true); }
  });
  cmp.addEventListener("keyup", (e) => {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); hold(false); }
  });
  cmp.addEventListener("blur", () => hold(false));

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undoReroll(); return; }
    if (e.target.matches?.('input[type="range"], [role="slider"]') && (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End" || e.key.startsWith("Page"))) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); select(app.current + 1); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); select(app.current - 1); }
    else if (e.key === "r" || e.key === "R") reroll(e.shiftKey);
    else if (e.key === "d" || e.key === "D") reroll(e.shiftKey, "artifacts");
    else if (e.key === "\\" && !e.repeat) hold(true);
  });
  document.addEventListener("keyup", (e) => { if (e.key === "\\") hold(false); });
  new ResizeObserver(() => requestRender()).observe($("#stage"));

  const mq = matchMedia("(prefers-color-scheme: dark)");
  const theme = () => document.documentElement.setAttribute("data-theme", mq.matches ? "dark" : "light");
  mq.addEventListener("change", theme);
  theme();
}

async function init() {
  console.log(`[film-lab] boot ${APP_BUILD}`);
  view = new FilmRenderer($("#view"));
  view.setGrain(null); // neutral until the grain tile arrives
  thumbs = new FilmRenderer(document.createElement("canvas"));
  thumbs.setGrain(null);
  const local = await src.detectLocal();
  const state = await src.loadState();
  // An older build's saved look is dropped when the defaults change, so the
  // app opens on the current default look instead of the previous one. Leak
  // seeds and re-rolls are kept; only the look itself is refreshed.
  if ((state.version || 0) < STATE_VERSION) state.settings = null;
  Object.assign(app.settings, state.settings || {});
  app.settings.artifacts = { ...DEFAULTS.artifacts, ...(state.settings?.artifacts || {}) };
  // Bundled camera-gate & hinge light-leak scans work both online and locally;
  // dust/scratch scan packs remain a local-mode extra.
  document.body.classList.toggle("online", !local);
  if (!local) {
    if (app.settings.artMode === "scans" || app.settings.artMode === "mix") app.settings.artMode = "generated";
  }
  $("#artifact-kinds").replaceChildren(...Object.entries(ARTIFACT_KINDS).map(([key, label]) => {
    const b = document.createElement("button");
    b.className = "chip";
    b.dataset.artifact = key;
    b.textContent = label;
    return b;
  }));
  if (!STOCKS[app.settings.stock]) app.settings.stock = DEFAULTS.stock;
  if (!GRAINS[app.settings.grainType]) app.settings.grainType = app.settings.stock;
  app.seeds = state.seeds || {};
  app.localInfo = local;
  app.leakSources = src.allLeakSources();
  syncFolderLabel();
  syncControls();
  bindEvents();
  window.__APP_LOADED__ = true;
  window.filmLab = app; // for debugging from the console
  if (local) {
    app.dustSources = src.dustFromServer();
    const serverPhotos = src.photosFromServer();
    await addPhotos(serverPhotos.length ? serverPhotos : src.samplePhotos());
  } else {
    await addPhotos(src.samplePhotos());
  }
  syncEmpty();
}

init().catch((e) => window.__showError(e.stack || e));
