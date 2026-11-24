/**
 * Read only some rows of a binary little-endian .ply, slice by slice, into a new .ply.
 *
 * Browsers cannot read a File over ~2 GB in one piece (`arrayBuffer()` throws
 * NotReadableError — measured: 1.9 GB reads, 2.2 GB fails), and a 3DGS scan is often
 * 5–10 GB. An export only needs the rows it keeps, so the file is read window by window
 * and those rows are copied out byte for byte (every attribute, SH included).
 */
export interface PlyLayout { headerBytes: number; stride: number; count: number; comments: string[]; props: string[] }

const SIZES: Record<string, number> = {
  char: 1, int8: 1, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8,
};

/** The vertex layout of a binary little-endian PLY whose first element is `vertex`, or null for anything else. */
export async function plyLayout(file: Blob): Promise<PlyLayout | null> {
  const head = new Uint8Array(await file.slice(0, Math.min(file.size, 1 << 16)).arrayBuffer());
  const text = new TextDecoder("latin1").decode(head);
  if (!text.startsWith("ply")) return null;
  const end = text.indexOf("end_header");
  if (end < 0) return null;
  const headerBytes = text.indexOf("\n", end) + 1;
  if (headerBytes <= 0) return null;
  const lines = text.slice(0, headerBytes).split(/\r?\n/).map((l) => l.trim());
  if (!lines.includes("format binary_little_endian 1.0")) return null;
  let element = "", first = "", count = 0, stride = 0;
  const comments: string[] = [], props: string[] = [];
  for (const l of lines) {
    const t = l.split(/\s+/);
    if (t[0] === "comment") comments.push(l);
    else if (t[0] === "element") { element = t[1]; if (!first) { first = element; if (element === "vertex") count = Number(t[2]); } }
    else if (t[0] === "property" && element === "vertex" && first === "vertex") {
      if (t[1] === "list" || !(t[1] in SIZES)) return null;
      stride += SIZES[t[1]]; props.push(l);
    }
  }
  if (first !== "vertex" || !count || !stride) return null;
  return { headerBytes, stride, count, comments, props };
}

/**
 * A new PLY holding just `rows` (ascending vertex indices) of `file`. Reads at most
 * `windowBytes` at a time and copies runs of consecutive rows in one go.
 */
export async function plyRows(file: Blob, layout: PlyLayout, rows: Uint32Array, onProgress?: (done: number) => void, windowBytes = 64 << 20): Promise<Uint8Array> {
  const { headerBytes, stride, count } = layout;
  const M = rows.length;
  const head = new TextEncoder().encode(["ply", "format binary_little_endian 1.0", ...layout.comments, `element vertex ${M}`, ...layout.props, "end_header", ""].join("\n"));
  const out = new Uint8Array(head.length + M * stride);
  out.set(head);
  const winRows = Math.max(1, Math.floor(windowBytes / stride));
  let q = 0, dst = head.length;
  while (q < M) {
    const r0 = rows[q];
    if (r0 >= count) throw new Error(`row ${r0} is past the end of the file (${count} rows)`);
    const r1 = Math.min(count, r0 + winRows);
    const buf = new Uint8Array(await file.slice(headerBytes + r0 * stride, headerBytes + r1 * stride).arrayBuffer());
    while (q < M && rows[q] < r1) {
      let e = q + 1;                                   // a run of consecutive rows
      while (e < M && rows[e] === rows[e - 1] + 1 && rows[e] < r1) e++;
      const off = (rows[q] - r0) * stride, len = (e - q) * stride;
      out.set(buf.subarray(off, off + len), dst);
      dst += len; q = e;
    }
    onProgress?.(q / M);
  }
  return out;
}
