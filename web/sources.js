// Where photos and leak scans come from, and where exports go.
//  - Online (GitHub Pages): the user imports files; exports download.
//  - Local (server.py): the folder's camera JPEGs load automatically and
//    exports are written by the server (default: ~/Downloads).

let local = null; // server info when running under server.py

export async function detectLocal() {
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
