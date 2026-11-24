import { describe, expect, it } from "vitest";
import { plyLayout, plyRows } from "./plyRows";

/** A tiny binary PLY: n rows of (x, y, z, a uchar tag), plus a trailing face element that must be dropped. */
function makePly(n: number) {
  const head = `ply\nformat binary_little_endian 1.0\ncomment test\nelement vertex ${n}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar tag\nelement face 0\nproperty list uchar int vertex_indices\nend_header\n`;
  const h = new TextEncoder().encode(head), stride = 13;
  const body = new Uint8Array(n * stride), dv = new DataView(body.buffer);
  for (let i = 0; i < n; i++) { dv.setFloat32(i * stride, i, true); dv.setFloat32(i * stride + 4, -i, true); dv.setFloat32(i * stride + 8, i * 0.5, true); body[i * stride + 12] = i & 255; }
  return new Blob([h, body]);
}
const read = (ply: Uint8Array) => {
  const text = new TextDecoder("latin1").decode(ply.subarray(0, 400));
  const hb = text.indexOf("end_header\n") + 11, n = Number(/element vertex (\d+)/.exec(text)![1]);
  const dv = new DataView(ply.buffer, ply.byteOffset + hb);
  return { n, x: Array.from({ length: n }, (_, i) => dv.getFloat32(i * 13, true)), tag: Array.from({ length: n }, (_, i) => dv.getUint8(i * 13 + 12)), text };
};

describe("plyRows", () => {
  it("reads the vertex layout", async () => {
    const L = (await plyLayout(makePly(10)))!;
    expect(L.count).toBe(10); expect(L.stride).toBe(13); expect(L.props.length).toBe(4);
  });
  it("copies just the asked rows, across windows and runs", async () => {
    const f = makePly(1000), L = (await plyLayout(f))!;
    const rows = Uint32Array.from([0, 1, 2, 3, 50, 51, 52, 400, 998, 999]);
    const out = read(await plyRows(f, L, rows, undefined, 13 * 7)); // tiny windows: runs cross window edges
    expect(out.n).toBe(rows.length);
    expect(out.x).toEqual(Array.from(rows));
    expect(out.tag).toEqual(Array.from(rows, (r) => r & 255));
    expect(out.text).toContain("comment test");
    expect(out.text).not.toContain("element face");
  });
  it("refuses ASCII PLY", async () => {
    expect(await plyLayout(new Blob(["ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nend_header\n0\n"]))).toBeNull();
  });
});
