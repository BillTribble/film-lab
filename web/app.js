import { FilmRenderer } from "./gl.js";
import { analyseLight, generatedLeak, hashSeed, newSeed, realLeak, rng } from "./leaks.js";
import { GRAINS, STOCKS, decodeFull, decodeThumb, haloMask, loadGrain, loadLut } from "./pipeline.js";
import { extractExif, withExif } from "./exif.js";
import * as src from "./sources.js";

const APP_BUILD = "2026-11-16b";
const $ = (sel) => document.querySelector(sel);

const DEFAULTS = {
  stock: "kodachrome64",
  strength: 0.85,
  halation: 0.25,
  vignette: 0.3,
  grain: 0.35,
  grainType: "tmax400",
  leakMode: "generated", // off | generated | real | mix
  leakAmt: 1.0,
  aware: true,
};
const TYPE_NAMES = ["Glow", "Streak", "Wash"];
const EDGE_NAMES = ["left", "right", "top", "bottom"];
const LEAK_PACK_URL = "https://blog.spoongraphics.co.uk/freebies/download-my-free-light-leaks-photo-overlays-to-add-retro-effects-to-your-photos";

const app = {
  photos: [],        // {id, name, getBlob, thumb, halo, light, width, height, ready}
  leakSources: [],   // {id, name, getBlob}
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
    const { thumb, width, height } = await decodeThumb(await photo.getBlob());
    Object.assign(photo, { thumb, width, height, halo: haloMask(thumb), light: analyseLight(thumb) });
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

async function addPhotos(list) {
  const known = new Set(app.photos.map((p) => p.id));
  const fresh = list.filter((p) => !known.has(p.id));
  if (!fresh.length) return;
  const first = app.photos.length;
  app.photos.push(...fresh);
  renderStrip();
  select(first);
  for (const p of fresh) await prepare(p).catch((e) => toast(`Could not read ${p.name}: ${e.message}`));
  scheduleThumbs();
}

async function ensureLeakLibrary() {
  const have = new Set(app.leaks.map((l) => l.name));
  const todo = app.leakSources.filter((s) => !have.has(s.name));
  if (!todo.length) return;
  setStatus("Loading leak scans…");
  for (const s of todo) {
    const blob = await s.getBlob();
    const full = await createImageBitmap(blob);
    const k = Math.min(1, 2048 / Math.max(full.width, full.height));
    const img = await createImageBitmap(full, { resizeWidth: Math.round(full.width * k), resizeHeight: Math.round(full.height * k), resizeQuality: "high" });
    full.close();
    app.leaks.push({ name: s.name, img, width: img.width, height: img.height, light: analyseLight(img) });
  }
  setStatus("");
}

// ---------- look ----------
async function bindStock(r) {
  if (r.lutKey !== app.settings.stock) r.setLut(app.settings.stock, await loadLut(app.settings.stock));
}

async function bindGrain(r) {
  const key = app.settings.grainType;
  if (r.grainKey === key) return;
  const tile = await loadGrain(key);
  if (app.settings.grainType !== key) return; // changed again while loading
  r.setGrain(tile);
  r.grainKey = key;
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
  if (r.leakName !== L.name) {
    r.setImage("leak", app.leaks.find((l) => l.name === L.name).img);
    r.leakName = L.name;
  }
  return { ...L, amount: L.intensity * leakAmt, bleed: aware };
}

function params(photo, leak, { grain = true } = {}) {
  const s = app.settings;
  const g = GRAINS[s.grainType];
  return {
    aspect: photo.width / photo.height,
    imageWidth: photo.width, imageHeight: photo.height,
    strength: s.strength, halation: s.halation, vignette: s.vignette,
    grain: grain ? s.grain * g.amount : 0, grainSize: g.size, grainChroma: STOCKS[s.stock].chroma,
    before: app.before, leak,
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
      view.render(params(photo, leak));
      describeLeak(leak);
      drawCurrentThumb();
      scheduleThumbs();
    } catch (e) {
      window.__showError(e.stack || e);
    }
  });
}

function sizeCanvas(photo) {
  const stage = $("#stage");
  const pad = 16;
  // Phones: the page scrolls, so fit the photo to the width (capped at 75% of the
  // screen height). Desktop: fit inside the stage.
  const phone = matchMedia("(max-width: 840px)").matches;
  const maxH = phone ? window.innerHeight * 0.75 : stage.clientHeight - pad * 2;
  const scale = Math.min((stage.clientWidth - pad * 2) / photo.width, maxH / photo.height);
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
    const w = Math.round(cv.clientWidth * dpr) || 300;
    const h = Math.round((w * photo.height) / photo.width);
    thumbs.canvas.width = w;
    thumbs.canvas.height = h;
    thumbs.render({ ...params(photo, leak, { grain: false }), before: false });
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    cv.getContext("2d").drawImage(thumbs.canvas, 0, 0);
  }
}

// ---------- UI ----------
function describeLeak(leak) {
  const el = $("#leak-info");
  if (!el) return;
  if (app.settings.leakMode === "real" && !app.leakSources.length) el.textContent = "No leak scans added yet.";
  else if (leak && app.settings.leakMode === "mix") el.textContent = `Mix: ${leak.mode === 1 ? `generated ${TYPE_NAMES[leak.type].toLowerCase()}` : leak.name}`;
  else if (!leak) el.textContent = "";
  else if (leak.mode === 1) el.textContent = `${TYPE_NAMES[leak.type]} from the ${EDGE_NAMES[leak.edge]}, ${Math.round(leak.intensity * 100)}% intensity`;
  else el.textContent = leak.name;
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
  saveTimer = setTimeout(() => src.saveState({ settings: app.settings, seeds: app.seeds }), 400);
}

function renderStrip() {
  $("#strip").replaceChildren(...app.photos.map((p, i) => {
    const b = document.createElement("button");
    b.className = "thumb";
    b.dataset.index = i;
    b.title = p.name;
    b.setAttribute("aria-label", p.name);
    const cv = document.createElement("canvas");
    cv.className = "thumb-canvas";
    b.append(cv);
    return b;
  }));
  syncStrip();
}

function syncStrip() {
  document.querySelectorAll(".thumb").forEach((b) => b.classList.toggle("active", Number(b.dataset.index) === app.current));
}

function syncEmpty() {
  const empty = !app.photos.length;
  $("#empty").hidden = !empty;
  $("#view").hidden = empty;
  ["#export-one", "#export-all"].forEach((id) => { $(id).disabled = empty; });
}

// Film and grain steppers: ‹ value ›, wrapping from last to first and back.
const STEPPERS = { stock: { options: STOCKS, setting: "stock" }, grain: { options: GRAINS, setting: "grainType" } };

function step(name, dir) {
  const { options, setting } = STEPPERS[name];
  const keys = Object.keys(options);
  const i = keys.indexOf(app.settings[setting]);
  app.settings[setting] = keys[(i + dir + keys.length) % keys.length];
  syncControls(); // label updates at once; the render follows
  persist();
  requestRender();
}

function syncControls() {
  const s = app.settings;
  document.querySelectorAll("[data-stepper]").forEach((el) => {
    const { options, setting } = STEPPERS[el.dataset.stepper];
    const opt = options[s[setting]];
    const value = el.querySelector(".stepper-value");
    if (!value || !opt) return;
    value.textContent = opt.label;
    value.title = opt.full || opt.label;
  });
  document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === s.leakMode)));
  document.querySelectorAll("input[data-setting]").forEach((inp) => {
    const v = s[inp.dataset.setting];
    if (inp.type === "checkbox") { inp.checked = !!v; return; }
    inp.value = v;
    const out = inp.parentElement.querySelector("output");
    if (out) out.textContent = `${Math.round(v * 100)}%`;
  });
  const leaksOn = s.leakMode !== "off";
  document.querySelectorAll('[data-action="reroll"], [data-action="reroll-all"]').forEach((b) => { b.disabled = !leaksOn; });
  document.querySelectorAll('[data-action="undo"]').forEach((b) => { b.disabled = !app.undo.length; });
  $("#real-tools").hidden = s.leakMode !== "real" && s.leakMode !== "mix";
  $("#leak-pack-link").hidden = src.isLocal();
}

function select(i) {
  if (!app.photos.length) return;
  app.current = (i + app.photos.length) % app.photos.length;
  syncStrip();
  requestRender();
}

function reroll(all) {
  const mode = app.settings.leakMode;
  if (mode === "off" || !app.photos.length) return;
  const targets = all ? app.photos : [app.photos[app.current]];
  app.undo.push({ mode, prev: targets.map((p) => [p.name, seedFor(p, mode)]) });
  if (app.undo.length > 100) app.undo.shift();
  targets.forEach((p) => { app.seeds[p.name][mode] = newSeed(); });
  afterSeedChange();
}

function undoReroll() {
  const step = app.undo.pop();
  if (!step) return;
  step.prev.forEach(([name, seed]) => { (app.seeds[name] ||= {})[step.mode] = seed; });
  if (app.settings.leakMode !== step.mode) app.settings.leakMode = step.mode;
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
      const leak = await leakFor(off, photo);
      const jpeg = await off.exportJpeg(full.width, full.height, { ...params(photo, leak), before: false });
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
      const b = e.target.closest("[data-step]");
      if (b) step(el.dataset.stepper, Number(b.dataset.step));
    });
  });
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
      syncControls();
      persist();
      requestRender();
    });
  });
  const actions = { reroll: () => reroll(false), "reroll-all": () => reroll(true), undo: undoReroll };
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
  document.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => $(`#${b.dataset.pick}`).click()));
  document.addEventListener("dragover", (e) => { e.preventDefault(); document.body.classList.add("dragging"); });
  document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("dragging"); });
  document.addEventListener("drop", run(async (e) => {
    e.preventDefault();
    document.body.classList.remove("dragging");
    await addPhotos(src.fromFiles(e.dataTransfer.files));
  }));

  const cmp = $("#compare");
  const hold = (v) => { app.before = v; requestRender(); };
  cmp.addEventListener("pointerdown", (e) => { e.preventDefault(); hold(true); });
  ["pointerup", "pointerleave", "pointercancel"].forEach((t) => cmp.addEventListener(t, () => hold(false)));

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undoReroll(); return; }
    if (e.target.matches("input[type=range]") && e.key.startsWith("Arrow")) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); select(app.current + 1); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); select(app.current - 1); }
    else if (e.key === "r" || e.key === "R") reroll(e.shiftKey);
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
  Object.assign(app.settings, state.settings || {});
  if (!STOCKS[app.settings.stock]) app.settings.stock = DEFAULTS.stock;
  if (!GRAINS[app.settings.grainType]) app.settings.grainType = DEFAULTS.grainType;
  app.seeds = state.seeds || {};
  $("#folder-label").textContent = local?.inDir ? `${local.photos.length} photos from ${local.inDir}` : "";
  syncControls();
  bindEvents();
  window.__APP_LOADED__ = true;
  window.filmLab = app; // for debugging from the console
  if (local) {
    app.leakSources = src.leaksFromServer();
    await addPhotos(src.photosFromServer());
  }
  syncEmpty();
}

init().catch((e) => window.__showError(e.stack || e));
