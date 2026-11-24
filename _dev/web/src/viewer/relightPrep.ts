/**
 * Relight preparation for one scan, at full resolution (runs inside the scan's worker).
 *
 * A captured scan has the lighting of the shoot baked into its colours and no surface
 * directions. Before any cutting (the darkness under a tree was made by that tree), this
 * works out, per splat:
 *   - a surface normal: the flattest direction of the splats around it, and
 *   - the baked light: how bright its surroundings are, so dividing by it flattens the colour,
 * after first dropping floaters (they are not real occluders). Cell sizes come from the
 * splats themselves, so nothing assumes metres.
 *
 * Written for GSEditor (MIT) from the method description; no code from other projects.
 */

/** Removal thresholds for the automatic floater cleanup — conservative on purpose. */
export const CLEAN = {
  /** opacity byte below this (≈ 0.02) — practically invisible */
  faint: 5,
  /** further out than this share of the scan's largest (robust) size beyond its bounds, on any axis */
  farPad: 0.25,
  /** fewer splats than this in the 3×3×3 cells around it */
  isolated: 3,
};
/**
 * How strongly the baked light is divided out: flat = colour / baked^FLAT_STRENGTH (in linear light).
 * The Blender add-on (GS Relight) opens with this already applied, so keep it fixed.
 */
export const FLAT_STRENGTH = 0.6;
/** Cells finer than this many would not fit comfortably in memory; the cell grows instead. */
const MAX_CELLS = 8_000_000;
/** The light is averaged over cells this many times the normal cell. */
export const LIGHT_CELLS = 7;

export interface PrepInput {
  n: number;
  /** centres as IEEE halves, xyz per splat (file space) */
  halves: Uint16Array;
  /** half → float table */
  H: Float32Array;
  /** Spark's colour word per splat: r, g, b, opacity bytes (r lowest) */
  word0: Uint32Array;
  rgbMin: number;
  rgbMax: number;
  /** fine cell size in file units (≈ 4 × the typical splat size) */
  h: number;
  /** splats already gone (deleted); bit 1 set = ignore */
  state: Uint8Array;
  clean: boolean;
}
export interface PrepResult {
  /** splats the cleanup removed (ascending) */
  removed: Uint32Array;
  counts: { far: number; faint: number; isolated: number };
  /** unsigned unit normal per splat ×127 (0,0,0 = unknown → use "up") */
  nrm: Int8Array;
  /** baked light per splat: opacity-weighted mean 1, at least 0.02 */
  baked: Float32Array;
  /** how much surface faces along each file axis — the vertical axis wins outdoors */
  votes: [number, number, number];
  h: number;
}

export function prepareRelight(inp: PrepInput): PrepResult {
  const { n, halves: c, H, word0, state } = inp;
  const gone = (i: number) => (state[i] & 1) !== 0;
  const X = (i: number) => H[c[i * 3]], Y = (i: number) => H[c[i * 3 + 1]], Z = (i: number) => H[c[i * 3 + 2]];

  // ── robust bounds from an even sample ──
  const step = Math.max(1, Math.floor(n / 1_000_000));
  const sx: number[] = [], sy: number[] = [], sz: number[] = [];
  for (let i = 0; i < n; i += step) if (!gone(i)) { sx.push(X(i)); sy.push(Y(i)); sz.push(Z(i)); }
  const pct = (a: number[], q: number) => { const s = Float64Array.from(a).sort(); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };
  const lo = [pct(sx, 0.005), pct(sy, 0.005), pct(sz, 0.005)], hi = [pct(sx, 0.995), pct(sy, 0.995), pct(sz, 0.995)];
  const ext = [0, 1, 2].map((a) => Math.max(1e-6, hi[a] - lo[a]));
  // "far" is measured against the scan's largest size on every axis: a flat site (a car park) must
  // not lose its streetlights just because few splats are high up
  const pad = CLEAN.farPad * Math.max(...ext);
  const padLo = [0, 1, 2].map((a) => lo[a] - pad), padHi = [0, 1, 2].map((a) => hi[a] + pad);

  // ── fine grid (normals, isolation) ──
  let h = Math.max(inp.h, Math.max(...ext) / 4096);
  let dims = [0, 1, 2].map((a) => Math.ceil(ext[a] / h) + 3);
  const cellsOf = (d: number[]) => d[0] * d[1] * d[2];
  if (cellsOf(dims) > MAX_CELLS) { h *= Math.cbrt(cellsOf(dims) / MAX_CELLS) * 1.01; dims = [0, 1, 2].map((a) => Math.ceil(ext[a] / h) + 3); }
  const [gx, gy, gz] = dims, cells = gx * gy * gz;
  const o0 = lo[0] - h, o1 = lo[1] - h, o2 = lo[2] - h; // one cell of margin
  const clampI = (v: number, g: number) => (v < 0 ? 0 : v >= g ? g - 1 : v);
  const cellOf = (x: number, y: number, z: number) => clampI(Math.floor((x - o0) / h), gx) + gx * (clampI(Math.floor((y - o1) / h), gy) + gy * clampI(Math.floor((z - o2) / h), gz));

  // ── cleanup: far, faint, then isolated ──
  const drop = new Uint8Array(n); // 1 far, 2 faint, 3 isolated
  const counts = { far: 0, faint: 0, isolated: 0 };
  if (inp.clean) {
    for (let i = 0; i < n; i++) {
      if (gone(i)) continue;
      const x = X(i), y = Y(i), z = Z(i);
      if (x < padLo[0] || x > padHi[0] || y < padLo[1] || y > padHi[1] || z < padLo[2] || z > padHi[2]) { drop[i] = 1; counts.far++; }
      else if ((word0[i] >>> 24) < CLEAN.faint) { drop[i] = 2; counts.faint++; }
    }
  }
  const live = (i: number) => !gone(i) && !drop[i];
  const cnt = new Uint32Array(cells);
  for (let i = 0; i < n; i++) if (live(i)) cnt[cellOf(X(i), Y(i), Z(i))]++;
  // splats in the 3×3×3 cells around each occupied cell
  const near = new Uint32Array(cells);
  const sum27 = (arr: Uint32Array, ix: number, iy: number, iz: number) => {
    let s = 0;
    for (let dz = -1; dz <= 1; dz++) { const zz = iz + dz; if (zz < 0 || zz >= gz) continue;
      for (let dy = -1; dy <= 1; dy++) { const yy = iy + dy; if (yy < 0 || yy >= gy) continue;
        const row = gx * (yy + gy * zz);
        for (let dx = -1; dx <= 1; dx++) { const xx = ix + dx; if (xx >= 0 && xx < gx) s += arr[row + xx]; } } }
    return s;
  };
  for (let iz = 0, k = 0; iz < gz; iz++) for (let iy = 0; iy < gy; iy++) for (let ix = 0; ix < gx; ix++, k++) if (cnt[k]) near[k] = sum27(cnt, ix, iy, iz);
  if (inp.clean) {
    for (let i = 0; i < n; i++) {
      if (!live(i)) continue;
      const k = cellOf(X(i), Y(i), Z(i));
      if (near[k] < CLEAN.isolated) { drop[i] = 3; counts.isolated++; cnt[k]--; }
    }
  }
  let nRemoved = 0; for (let i = 0; i < n; i++) if (drop[i]) nRemoved++;
  const removed = new Uint32Array(nRemoved); for (let i = 0, q = 0; i < n; i++) if (drop[i]) removed[q++] = i;

  // ── colour → linear luminance (Spark keeps the display colour, gamma-encoded) ──
  const lin = new Float32Array(256);
  for (let b = 0; b < 256; b++) { const d = Math.min(1, Math.max(0, inp.rgbMin + (b / 255) * (inp.rgbMax - inp.rgbMin))); lin[b] = Math.pow(d, 2.2); }
  const lum = (w: number) => 0.2126 * lin[w & 255] + 0.7152 * lin[(w >>> 8) & 255] + 0.0722 * lin[(w >>> 16) & 255];

  // ── per-cell opacity-weighted moments about the cell centre (small numbers stay precise in float32) ──
  const M = new Float32Array(cells * 10); // W, Sx, Sy, Sz, Sxx, Sxy, Sxz, Syy, Syz, Szz
  const Hc = h * LIGHT_CELLS;
  const bdims = [0, 1, 2].map((a) => Math.ceil((ext[a] + 2 * h) / Hc) + 2);
  const [bx, by, bz] = bdims, bcells = bx * by * bz;
  const b0 = lo[0] - h, b1 = lo[1] - h, b2 = lo[2] - h;
  const bigOf = (x: number, y: number, z: number) => clampI(Math.floor((x - b0) / Hc), bx) + bx * (clampI(Math.floor((y - b1) / Hc), by) + by * clampI(Math.floor((z - b2) / Hc), bz));
  const LW = new Float64Array(bcells), LS = new Float64Array(bcells);
  for (let i = 0; i < n; i++) {
    if (!live(i)) continue;
    const x = X(i), y = Y(i), z = Z(i), w = (word0[i] >>> 24) / 255;
    const ix = clampI(Math.floor((x - o0) / h), gx), iy = clampI(Math.floor((y - o1) / h), gy), iz = clampI(Math.floor((z - o2) / h), gz);
    const k = (ix + gx * (iy + gy * iz)) * 10;
    const lx = x - (o0 + (ix + 0.5) * h), ly = y - (o1 + (iy + 0.5) * h), lz = z - (o2 + (iz + 0.5) * h);
    M[k] += w; M[k + 1] += w * lx; M[k + 2] += w * ly; M[k + 3] += w * lz;
    M[k + 4] += w * lx * lx; M[k + 5] += w * lx * ly; M[k + 6] += w * lx * lz; M[k + 7] += w * ly * ly; M[k + 8] += w * ly * lz; M[k + 9] += w * lz * lz;
    const B = bigOf(x, y, z); LW[B] += w; LS[B] += w * lum(word0[i]);
  }

  // ── normal per occupied cell: smallest-eigenvalue direction of the 3×3×3 neighbourhood ──
  const cellN = new Int8Array(cells * 3);
  const votes: [number, number, number] = [0, 0, 0];
  const cov = new Float64Array(6), ev = new Float64Array(3);
  for (let iz = 0, k = 0; iz < gz; iz++) for (let iy = 0; iy < gy; iy++) for (let ix = 0; ix < gx; ix++, k++) {
    if (!cnt[k] || near[k] < 4) continue;
    let W = 0, Sx = 0, Sy = 0, Sz = 0, Sxx = 0, Sxy = 0, Sxz = 0, Syy = 0, Syz = 0, Szz = 0;
    for (let dz = -1; dz <= 1; dz++) { const zz = iz + dz; if (zz < 0 || zz >= gz) continue;
      for (let dy = -1; dy <= 1; dy++) { const yy = iy + dy; if (yy < 0 || yy >= gy) continue;
        for (let dx = -1; dx <= 1; dx++) { const xx = ix + dx; if (xx < 0 || xx >= gx) continue;
          const m = (xx + gx * (yy + gy * zz)) * 10, w = M[m]; if (!w) continue;
          const ox = dx * h, oy = dy * h, oz = dz * h, mx = M[m + 1], my = M[m + 2], mz = M[m + 3];
          W += w; Sx += mx + ox * w; Sy += my + oy * w; Sz += mz + oz * w;
          Sxx += M[m + 4] + 2 * ox * mx + ox * ox * w; Syy += M[m + 7] + 2 * oy * my + oy * oy * w; Szz += M[m + 9] + 2 * oz * mz + oz * oz * w;
          Sxy += M[m + 5] + ox * my + oy * mx + ox * oy * w; Sxz += M[m + 6] + ox * mz + oz * mx + ox * oz * w; Syz += M[m + 8] + oy * mz + oz * my + oy * oz * w;
        } } }
    if (W <= 0) continue;
    const ax = Sx / W, ay = Sy / W, az = Sz / W;
    cov[0] = Sxx / W - ax * ax; cov[1] = Sxy / W - ax * ay; cov[2] = Sxz / W - ax * az; cov[3] = Syy / W - ay * ay; cov[4] = Syz / W - ay * az; cov[5] = Szz / W - az * az;
    if (!smallestEigvec(cov, ev)) continue;
    cellN[k * 3] = Math.round(ev[0] * 127); cellN[k * 3 + 1] = Math.round(ev[1] * 127); cellN[k * 3 + 2] = Math.round(ev[2] * 127);
    const ex = Math.abs(ev[0]), ey = Math.abs(ev[1]), ez = Math.abs(ev[2]);
    if (ex > 0.9) votes[0] += cnt[k]; else if (ey > 0.9) votes[1] += cnt[k]; else if (ez > 0.9) votes[2] += cnt[k];
  }

  // ── baked light: 3×3×3 blur of the big cells, then mean 1 over the splats ──
  const L = new Float32Array(bcells);
  for (let iz = 0, k = 0; iz < bz; iz++) for (let iy = 0; iy < by; iy++) for (let ix = 0; ix < bx; ix++, k++) {
    let w = 0, s = 0;
    for (let dz = -1; dz <= 1; dz++) { const zz = iz + dz; if (zz < 0 || zz >= bz) continue;
      for (let dy = -1; dy <= 1; dy++) { const yy = iy + dy; if (yy < 0 || yy >= by) continue;
        for (let dx = -1; dx <= 1; dx++) { const xx = ix + dx; if (xx < 0 || xx >= bx) continue; const q = xx + bx * (yy + by * zz); w += LW[q]; s += LS[q]; } } }
    L[k] = w > 0 ? s / w : -1;
  }
  const baked = new Float32Array(n), nrm = new Int8Array(n * 3);
  let mw = 0, ms = 0;
  for (let i = 0; i < n; i++) {
    const x = X(i), y = Y(i), z = Z(i);
    const v = L[bigOf(x, y, z)];
    baked[i] = v;
    if (live(i) && v >= 0) { const w = (word0[i] >>> 24) / 255; mw += w; ms += w * v; }
    const k = cellOf(x, y, z) * 3;
    nrm[i * 3] = cellN[k]; nrm[i * 3 + 1] = cellN[k + 1]; nrm[i * 3 + 2] = cellN[k + 2];
  }
  const mean = mw > 0 && ms > 0 ? ms / mw : 1;
  for (let i = 0; i < n; i++) baked[i] = baked[i] < 0 ? 1 : Math.max(0.02, baked[i] / mean);
  return { removed, counts, nrm, baked, votes, h };
}

/**
 * Unit eigenvector of the smallest eigenvalue of a symmetric 3×3 matrix
 * [a b c; b d e; c e f] given as (a, b, c, d, e, f). Closed form for the eigenvalues, then the
 * direction orthogonal to two rows of (A − λI). False when the matrix is degenerate.
 */
export function smallestEigvec(m: Float64Array, out: Float64Array): boolean {
  const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5];
  const p1 = b * b + c * c + e * e;
  const q = (a + d + f) / 3;
  const p2 = (a - q) ** 2 + (d - q) ** 2 + (f - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  if (!(p > 1e-20)) return false; // isotropic or empty: no direction
  const B0 = (a - q) / p, B1 = b / p, B2 = c / p, B3 = (d - q) / p, B4 = e / p, B5 = (f - q) / p;
  const detB = B0 * (B3 * B5 - B4 * B4) - B1 * (B1 * B5 - B4 * B2) + B2 * (B1 * B4 - B3 * B2);
  const r = Math.max(-1, Math.min(1, detB / 2));
  const phi = Math.acos(r) / 3;
  const lmin = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3); // smallest of the three
  // rows of A − λI; their cross products are parallel to the eigenvector
  const r0x = a - lmin, r0y = b, r0z = c, r1x = b, r1y = d - lmin, r1z = e, r2x = c, r2y = e, r2z = f - lmin;
  const c01 = [r0y * r1z - r0z * r1y, r0z * r1x - r0x * r1z, r0x * r1y - r0y * r1x];
  const c02 = [r0y * r2z - r0z * r2y, r0z * r2x - r0x * r2z, r0x * r2y - r0y * r2x];
  const c12 = [r1y * r2z - r1z * r2y, r1z * r2x - r1x * r2z, r1x * r2y - r1y * r2x];
  const len = (v: number[]) => v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  let best = c01; if (len(c02) > len(best)) best = c02; if (len(c12) > len(best)) best = c12;
  const L = Math.sqrt(len(best));
  if (!(L > 1e-30)) return false;
  out[0] = best[0] / L; out[1] = best[1] / L; out[2] = best[2] / L;
  return true;
}
