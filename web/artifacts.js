// Film artifacts: dust, scratches, hairs and water spots, all generated from a
// seed so a re-roll is repeatable and the export matches the preview.
//
// The generator always draws the same sequence of random numbers, whichever
// kinds are on and whatever the amount, so toggling a kind or moving the
// slider adds or removes marks without reshuffling the others.

import { rng } from "./leaks.js";

export const ARTIFACT_KINDS = {
  dust: "Dust",
  scratches: "Scratches",
  hairs: "Hairs",
  spots: "Water spots",
};

export const MAX_SCRATCHES = 8;
export const MAX_HAIRS = 4;
export const MAX_SPOTS = 5;

/**
 * Shader parameters for one photo. Positions are in aspect space
 * (x 0..aspect, y 0..1); sizes are fractions of the image height.
 */
export function artifactParams(seed, kinds, amount, aspect) {
  const r = rng(seed);
  const p = {
    dustSeed: r() * 1000,
    dustDensity: kinds.dust ? 0.03 * amount : 0,
    // Scratches run along the film strip: the frame's long side.
    axis: aspect >= 1 ? 0 : 1,
    scratches: [], // [across 0..1, start 0..1, end 0..1, width (+bright / -dark)]
    scratchAux: [], // [wobble seed, opacity]
    hairs: [], // [p0.x, p0.y, p1.x, p1.y] + [p2.x, p2.y, width, opacity]
    hairsB: [],
    spots: [], // [x, y, radius, strength]
  };

  for (let i = 0; i < MAX_SCRATCHES; i++) {
    const keep = r(), across = r(), start = r() * 0.7, len = 0.25 + r() * 0.9;
    const width = 0.00025 + Math.pow(r(), 2) * 0.001;
    const bright = r() < 0.6, wobble = r() * 100, opacity = 0.35 + 0.65 * r();
    if (kinds.scratches && keep < amount * 0.85) {
      p.scratches.push(across, start, Math.min(1, start + len), bright ? width : -width);
      p.scratchAux.push(wobble, opacity);
    }
  }

  for (let i = 0; i < MAX_HAIRS; i++) {
    const keep = r();
    const x0 = r() * aspect, y0 = r();
    const ang = r() * Math.PI * 2, len = 0.03 + r() * 0.1, bend = (r() - 0.5) * 0.12;
    const width = 0.0003 + r() * 0.0005, opacity = 0.6 + 0.4 * r();
    if (kinds.hairs && keep < amount * 0.7) {
      const x2 = x0 + Math.cos(ang) * len, y2 = y0 + Math.sin(ang) * len;
      const mx = (x0 + x2) / 2 - Math.sin(ang) * bend, my = (y0 + y2) / 2 + Math.cos(ang) * bend;
      p.hairs.push(x0, y0, mx, my);
      p.hairsB.push(x2, y2, width, opacity);
    }
  }

  for (let i = 0; i < MAX_SPOTS; i++) {
    const keep = r(), x = r() * aspect, y = r(), radius = 0.02 + r() * 0.07, strength = 0.35 + 0.65 * r();
    if (kinds.spots && keep < amount * 0.75) p.spots.push(x, y, radius, strength);
  }

  p.opacity = Math.min(1, 0.4 + amount * 0.8);
  return p;
}

export const anyArtifacts = (kinds) => Object.values(kinds).some(Boolean);
