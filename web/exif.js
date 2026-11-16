// Carry the camera's EXIF (date, settings) from the original JPEG into the
// export. The export is already upright, so Orientation is reset to 1.

/** Return the original's EXIF APP1 segment (with Orientation = 1), or null. */
export function extractExif(buf) {
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null; // not a JPEG
  let p = 2;
  while (p + 4 <= v.byteLength) {
    const marker = v.getUint16(p);
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break; // start of scan
    const len = v.getUint16(p + 2);
    if (marker === 0xffe1 && v.getUint32(p + 4) === 0x45786966) { // "Exif"
      const seg = new Uint8Array(buf.slice(p, p + 2 + len));
      resetOrientation(seg);
      return seg;
    }
    p += 2 + len;
  }
  return null;
}

function resetOrientation(seg) {
  const v = new DataView(seg.buffer);
  const tiff = 10; // FFE1, length(2), "Exif\0\0"
  const le = v.getUint16(tiff) === 0x4949;
  const ifd0 = tiff + v.getUint32(tiff + 4, le);
  if (ifd0 + 2 > v.byteLength) return;
  const n = v.getUint16(ifd0, le);
  for (let i = 0; i < n; i++) {
    const e = ifd0 + 2 + i * 12;
    if (e + 12 > v.byteLength) return;
    if (v.getUint16(e, le) === 0x0112) v.setUint16(e + 8, 1, le);
  }
}

/** Insert an APP1 segment after SOI (and after a JFIF APP0, which must stay first). */
export async function withExif(jpeg, app1) {
  if (!app1) return jpeg;
  const bytes = new Uint8Array(await jpeg.arrayBuffer());
  let at = 2;
  if (bytes[2] === 0xff && bytes[3] === 0xe0) at = 4 + ((bytes[4] << 8) | bytes[5]);
  return new Blob([bytes.subarray(0, at), app1, bytes.subarray(at)], { type: "image/jpeg" });
}
