// Where photos and leak scans come from, and where exports go.
//  - Online (GitHub Pages): four example photos load by default; the user can
//    import their own files, and exports download.
//  - Local (server.py): the folder's camera JPEGs load automatically (or the
//    example photos when no folder was given) and exports are written by the
//    server (default: ~/Downloads).

let local = null; // server info when running under server.py

const SAMPLES = [
  { file: "01-umbrellas-surfboards.jpg", label: "Striped umbrellas & surfboards" },
  { file: "02-vw-surfer-van.jpg", label: "1972 VW surfer van" },
  { file: "03-red-beach-cruiser.jpg", label: "Beach cruiser by dunes" },
  { file: "04-sea-breeze-motel-night.jpg", label: "Sea Breeze Motel at night" },
];

export function samplePhotos() {
  return SAMPLES.map((s) => {
    let blobPromise = null;
    return {
      id: `sample:${s.file}`,
      name: s.file,
      label: s.label,
      sample: true,
      getBlob: () => (blobPromise ||= fetch(`assets/samples/${s.file}`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      }).catch((e) => {
        blobPromise = null;
        throw e;
      })),
    };
  });
}

export async function detectLocal() {
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return null;
  if (new URLSearchParams(location.search).has("online")) return null;
  try {
    const res = await fetch("api/photos", { cache: "no-store" });
    if (!res.ok) return null;
    local = await res.json();
    return local;
  } catch {
    return null;
  }
}

export const isLocal = () => !!local;

const stem = (name) => name.replace(/\.[^.]+$/, "");

export function photosFromServer() {
  return (local?.photos || []).map((p) => ({
    id: `srv:${p.name}`,
    name: p.name,
    getBlob: () => fetch(`api/photo/${encodeURIComponent(p.name)}`).then((r) => r.blob()),
  }));
}

export function leaksFromServer() {
  return (local?.leaks || []).map((name) => ({
    id: `srv:${name}`,
    name,
    getBlob: () => fetch(`api/leak/${encodeURIComponent(name)}`).then((r) => r.blob()),
  }));
}

export function dustFromServer() {
  return (local?.dust || []).map((name) => ({
    id: `srv:dust:${name}`,
    name,
    getBlob: () => fetch(`api/dust/${encodeURIComponent(name)}`).then((r) => r.blob()),
  }));
}

const isImage = (f) => /^image\/(jpeg|png|webp)$/.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name);

export function fromFiles(files) {
  return [...files].filter(isImage).map((f) => ({
    id: `file:${f.name}:${f.size}:${f.lastModified}`,
    name: f.name,
    getBlob: async () => f,
  }));
}

/** Save an export: the local server writes it to disk, online it downloads. */
export async function saveExport(name, blob, suffix) {
  const fileName = `${stem(name)}_${suffix}.jpg`;
  if (local) {
    const res = await fetch(`api/export/${encodeURIComponent(fileName)}`, { method: "POST", body: blob });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    return (await res.json()).path;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return fileName;
}

// Settings + leak seeds: the server keeps them in local mode, the browser otherwise.
const KEY = "film-lab-state";
export async function loadState() {
  if (local) return fetch("api/state").then((r) => r.json()).catch(() => ({}));
  try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; }
}

export function saveState(state) {
  if (local) return fetch("api/state", { method: "POST", body: JSON.stringify(state) });
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode */ }
}
