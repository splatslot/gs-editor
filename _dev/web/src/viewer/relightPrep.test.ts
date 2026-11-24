import { describe, expect, it } from "vitest";
import { prepareRelight, smallestEigvec, CLEAN } from "./relightPrep";
import { halfTable } from "./half";

/** float → IEEE half (round to nearest), enough for test data */
function toHalf(v: number): number {
  const f = new Float32Array(1), u = new Uint32Array(f.buffer); f[0] = v;
  const x = u[0], sign = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 127 + 15, m = x & 0x7fffff;
  if (e <= 0) return sign;
  if (e >= 31) return sign | 0x7c00;
  return sign | (e << 10) | ((m + 0x1000) >>> 13);
}
const word = (r: number, g: number, b: number, a: number) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;

/** A 10 × 10 floor in the file's X-Y plane (Z is its normal): left half dark, right half bright, plus floaters. */
function scene() {
  const pts: number[][] = [], cols: number[] = [];
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 20000; i++) {
    const x = rnd() * 10 - 5, y = rnd() * 10 - 5, z = (rnd() - 0.5) * 0.01;
    pts.push([x, y, z]); cols.push(x < 0 ? word(60, 60, 60, 255) : word(200, 200, 200, 255));
  }
  const far = pts.length; pts.push([1000, 0, 0]); cols.push(word(255, 255, 255, 255));
  const faint = pts.length; for (let i = 0; i < 3; i++) { pts.push([1 + i * 0.1, 1, 0]); cols.push(word(128, 128, 128, 2)); }
  const lone = pts.length; pts.push([0, 0, 1.5]); cols.push(word(128, 128, 128, 255)); // alone, but well inside the scan's reach
  const n = pts.length, halves = new Uint16Array(n * 3), word0 = new Uint32Array(n);
  pts.forEach((p, i) => { halves[i * 3] = toHalf(p[0]); halves[i * 3 + 1] = toHalf(p[1]); halves[i * 3 + 2] = toHalf(p[2]); word0[i] = cols[i]; });
  return { n, halves, word0, far, faint, lone };
}

describe("relightPrep", () => {
  it("finds the smallest-eigenvalue direction", () => {
    const out = new Float64Array(3);
    expect(smallestEigvec(Float64Array.from([3, 0, 0, 2, 0, 1]), out)).toBe(true);
    expect(Math.abs(out[2])).toBeCloseTo(1, 6);
    expect(smallestEigvec(Float64Array.from([1, 0, 0, 1, 0, 1]), out)).toBe(false); // isotropic: no direction
  });

  it("cleans floaters, finds the floor's normals and a darker baked light on the dark half", () => {
    const s = scene();
    const r = prepareRelight({ n: s.n, halves: s.halves, H: halfTable(), word0: s.word0, rgbMin: 0, rgbMax: 1, h: 0.3, state: new Uint8Array(s.n), clean: true });
    const removed = new Set(r.removed);
    expect(removed.has(s.far)).toBe(true);
    for (let i = 0; i < 3; i++) expect(removed.has(s.faint + i)).toBe(true);
    expect(removed.has(s.lone)).toBe(true);
    expect(r.counts.far).toBe(1); expect(r.counts.faint).toBe(3); expect(r.counts.isolated).toBe(1);
    expect(r.removed.length).toBe(5); // nothing on the floor itself
    // a tall thin thing on a flat site is not "far": only isolated counts against it

    let up = 0;
    for (let i = 0; i < 20000; i++) if (Math.abs(r.nrm[i * 3 + 2]) > 0.9 * 127) up++;
    expect(up / 20000).toBeGreaterThan(0.95);
    expect(r.votes[2]).toBeGreaterThan(r.votes[0] * 10);
    expect(r.votes[2]).toBeGreaterThan(r.votes[1] * 10);

    let dark = 0, bright = 0, nd = 0, nb = 0, mean = 0;
    for (let i = 0; i < 20000; i++) {
      mean += r.baked[i];
      const x = halfTable()[s.halves[i * 3]];
      if (x < -2) { dark += r.baked[i]; nd++; } else if (x > 2) { bright += r.baked[i]; nb++; }
    }
    expect(mean / 20000).toBeCloseTo(1, 1);
    expect(dark / nd).toBeLessThan(bright / nb * 0.5);
    expect(Math.min(...r.baked)).toBeGreaterThanOrEqual(0.02);
  });

  it("leaves everything when cleanup is off", () => {
    const s = scene();
    const r = prepareRelight({ n: s.n, halves: s.halves, H: halfTable(), word0: s.word0, rgbMin: 0, rgbMax: 1, h: 0.3, state: new Uint8Array(s.n), clean: false });
    expect(r.removed.length).toBe(0);
    expect(CLEAN.faint).toBeGreaterThan(0);
  });
});
