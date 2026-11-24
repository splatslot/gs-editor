import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import "@tabler/icons-webfont/dist/tabler-icons.min.css";
import "./style.css";
import { Scene } from "./viewer/Scene";
import { SplatScene } from "./viewer/SplatScene";
import { NavControls, type ViewName } from "./viewer/NavControls";
import { ViewCube } from "./viewer/ViewCube";
import { ScanData, LIGHT_MAX, type SelectMode, type VolDesc } from "./viewer/ScanData";
import { FLAT_STRENGTH } from "./viewer/relightPrep";
import { SceneFrame, type FrameJSON } from "./viewer/SceneFrame";
import { History } from "./viewer/History";
import { HistoryPanel } from "./ui/HistoryPanel";
import { startVfovRad } from "./viewer/startFrame";
import { Editor, type ExportWhat, type ObjectRow, type SelectVariant, type Tool } from "./ui/Editor";
import { IntakePanel } from "./ui/IntakePanel";
import { TransformPanel } from "./ui/TransformPanel";
import { VolumePanel, type ClipVolume, type VolumeKind } from "./ui/VolumePanel";
import { AXIS_TO_THREE, toBlender } from "./ui/blenderAxes";
import { bakeFiles, bakeFromSplats, downloadBlob, type FileSource, type GsFormat, type RelightRows } from "./export/exportGS";
import { plyLayout, plyRows } from "./export/plyRows";
import type { SplatMesh } from "@sparkjsdev/spark";

declare global { interface Window { __gseditor_ready?: boolean; showSaveFilePicker?: (o: any) => Promise<any>; } }

type Axis = "x" | "y" | "z";
const GIZMO_TOOLS: Tool[] = ["move", "rotate", "scale", "origin"];
const VARIANT_ORDER: SelectVariant[] = ["box", "circle", "lasso"];

/** A loaded scan: its own transform (with origin), its splats and its per-splat edit state. */
/**
 * A scan in the scene. `source.rowMap` is set on a piece made by Separate: piece index → row
 * of the source file (the piece re-reads just those rows on export).
 */
interface GsObject { id: number; name: string; source: { url: string; file?: File; name: string; rowMap?: Uint32Array; upZ?: boolean }; mesh: SplatMesh; frame: SceneFrame; data: ScanData; visible: boolean }
type Active = { kind: "object"; obj: GsObject } | { kind: "volume"; vol: ClipVolume } | null;

const HINTS: Record<string, string> = {
  box: "LMB drag: box select (Shift add, Ctrl subtract)   MMB: orbit   Shift+MMB: pan   Wheel: zoom   X: delete   P: separate   W: next select tool   Space: captured look   RMB: menu",
  circle: "LMB drag: paint select (Shift add, Ctrl subtract)   Shift+Wheel or [ ]: radius   MMB: orbit   X: delete   W: next select tool   Space: captured look",
  lasso: "LMB drag: lasso select (Shift add, Ctrl subtract)   MMB: orbit   Shift+MMB: pan   X: delete   W: next select tool   Space: captured look",
  move: "Drag the handles   X / Y / Z: lock an axis   Type a number, Enter   Ctrl: snap   Alt+G: clear   Esc: back to select",
  rotate: "Drag a ring (rotates about the object origin)   X / Y / Z: lock an axis   Type degrees, Enter   Ctrl: 5° steps   Alt+R: clear",
  scale: "Drag a handle (scales about the object origin)   Type a factor, Enter   Ctrl: snap   Alt+S: clear",
  origin: "Drag the handles: move the object origin only   LMB on the scan: set the origin there   Esc: back to select",
  volMove: "Drag the handles to move the clip volume   X / Y / Z: lock an axis   Type a number, Enter",
  volScale: "Drag a handle to resize the clip volume (box: per axis)   Type a factor, Enter",
};

async function boot() {
  const stage = document.getElementById("stage")!;
  const view = document.getElementById("view")!;
  const ui = document.getElementById("ui")!;
  const scene = new Scene(view);
  const cam = scene.camera;
  cam.fov = THREE.MathUtils.radToDeg(startVfovRad()); cam.updateProjectionMatrix(); // same lens as the Layouter's first picture
  const nav = new NavControls(cam, scene.renderer.domElement);
  const splat = new SplatScene(scene.renderer, scene.scene);
  const history = new History();
  const dom = scene.renderer.domElement;

  // Big scans are drawn thinned (ScanData). Dev: ?light=<max drawn splats> to try it on a small file.
  const devQ = new URLSearchParams(import.meta.env.DEV ? location.search : "");
  const lightMax = Number(devQ.get("light")) || LIGHT_MAX;
  if (devQ.get("thin") === "stride") ScanData.thin = "stride";
  if (devQ.get("bump")) ScanData.bumpExp = Number(devQ.get("bump"));

  // ── scene contents ──
  const objects: GsObject[] = [];
  const volumes: ClipVolume[] = [];
  const volumeHelpers = new Map<number, THREE.Object3D>();
  let active: Active = null;
  let nextId = 1;
  const activeObj = () => (active?.kind === "object" ? active.obj : null);
  const activeVol = () => (active?.kind === "volume" ? active.vol : null);
  const shownObjects = () => objects.filter((o) => o.visible);

  // ── UI shell ──
  let tool: Tool = "select";
  let variant: SelectVariant = "box";
  const editor = new Editor({
    onTool: (t) => setTool(t),
    onSelectVariant: (v) => { variant = v; setTool("select"); },
    onReplaceFile: (f) => { const o = activeObj(); if (o) void replaceObject(o, URL.createObjectURL(f), f.name, f); else editor.setMessage("Make an object active first"); },
    onExport: (fmt, what, keep) => void exportGS(fmt, what, keep),
    onTheme: (t) => scene.setBackground(t === "light" ? 0xd9dad4 : 0x0e110d),
    onContext: (a) => {
      if (a === "delete") void deleteSelection();
      else if (a === "separate") void separateSelection();
      else if (a === "invert") void selOp((o) => o.data.invert());
      else if (a === "deselect") void deselectAll();
      else if (a === "selectAll") void selOp((o) => o.data.selectAll());
      else if (a === "focus") { const p = pickAt(ctxAt.x, ctxAt.y); if (p) nav.focusOn(p.point); }
      else if (a === "setOrigin") { const p = pickAt(ctxAt.x, ctxAt.y); const o = activeObj(); if (p && o) setOriginAt(o, p.point); else editor.setMessage(o ? "Nothing under the cursor — right-click on the scan" : "Make an object active first"); }
    },
    onObject: (a, id, value) => {
      const o = objects.find((x) => x.id === id), v = volumes.find((x) => x.id === id);
      if (a === "rename") { const t = o ?? v; if (t && value) { t.name = value; refreshOutliner(); updateInfo(); if (v && activeVol() === v) volPanel.set(v); } return; }
      if (a === "activate") setActive(o ? { kind: "object", obj: o } : v ? { kind: "volume", vol: v } : null);
      else if (a === "toggle") { if (o) { o.visible = !o.visible; o.frame.root.visible = o.visible; void o.data.deselectAll().then(syncSelection); } if (v) v.enabled = !v.enabled; scheduleClip(); refreshOutliner(); syncSelection(); }
      else if (a === "remove") { if (o) removeObject(o); if (v) removeVolume(v); }
    },
    onAddVolume: (kind) => addVolume(kind),
    onDimsVisible: () => { dimsBox.visible = editor.dimsVisible && !!lastBox; },
    onVolumeShow: (on) => { const v = activeVol(); if (v) { v.showBounds = on; volumeChanged(v, true); } },
    onDisplay: (full) => { const o = activeObj(); if (o) void setDisplay(o, full); },
    onUpAxis: (z) => { const o = activeObj(); if (o) setUpAxis(o, z); },
  }, stage, ui);
  const intake = new IntakePanel(editor.mounts.intake, (url, file) => void addObject(url, file.name, file), (t) => editor.setMessage(t));
  stage.addEventListener("dragover", (e) => e.preventDefault());
  stage.addEventListener("drop", (e) => { e.preventDefault(); const files = Array.from(e.dataTransfer?.files ?? []); if (files.length) intake.handleFiles(files); });

  // a note while a big scan is being worked on (selecting, deleting, clipping run in workers)
  ScanData.onBusy = (busy) => editor.setBusy(busy);

  // ── view cube / axis views / ortho / guides ──
  let cubeDrag: { x: number; y: number } | null = null;
  const viewCube = new ViewCube(stage, (v) => viewFrom(v), (phase, x, y) => {
    if (phase === "down") cubeDrag = { x, y };
    else if (phase === "move" && cubeDrag) { nav.rotateBy(x - cubeDrag.x, y - cubeDrag.y); cubeDrag = { x, y }; }
    else cubeDrag = null;
  });
  const setOrtho = (on: boolean) => scene.setOrtho(on);
  const viewFrom = (v: ViewName) => {
    nav.viewFrom(v); setOrtho(true);
    scene.setViewMode(v === "top" || v === "bottom" ? "top" : v === "front" || v === "back" ? "front" : "side");
  };
  nav.onRotateStart = () => { setOrtho(false); scene.setViewMode("persp"); };   // Blender's auto-perspective
  scene.setViewMode("persp");

  // ── gizmo: a proxy at the active item's origin ──
  const gizmo = new TransformControls(cam, dom);
  scene.scene.add(gizmo.getHelper());
  gizmo.getHelper().traverse((o) => o.layers.set(1));
  const tcRay = (gizmo as any).getRaycaster ? (gizmo as any).getRaycaster() : (gizmo as any)._raycaster;
  if (tcRay?.layers) tcRay.layers.enable(1);
  gizmo.size = 0.9;
  gizmo.detach();
  const proxy = new THREE.Object3D(); proxy.name = "gizmoProxy"; scene.scene.add(proxy);
  let drag: { state: FrameJSON | null; vol: { center: THREE.Vector3; size: THREE.Vector3; radius: number } | null; lastP: THREE.Vector3; lastQ: THREE.Quaternion; lastS: THREE.Vector3 } | null = null;
  const anchor = () => { const o = activeObj(); if (o) return o.frame.worldPivot(); const v = activeVol(); return v ? v.center.clone() : null; };
  const syncProxy = () => { if (gizmo.dragging) return; const a = anchor(); if (a) proxy.position.copy(a); proxy.quaternion.identity(); proxy.scale.setScalar(1); };
  // where the last press happened and whether it moved — a press on a gizmo handle that never
  // moves is a click (the Origin tool then sets the origin there, as anywhere else)
  let press: { x: number; y: number; moved: boolean } | null = null;
  window.addEventListener("pointerdown", (e) => { press = { x: e.clientX, y: e.clientY, moved: false }; }, { capture: true });
  window.addEventListener("pointermove", (e) => { if (press && e.buttons && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 3) press.moved = true; }, { capture: true });
  gizmo.addEventListener("dragging-changed", (e) => {
    const on = !!(e as any).value;
    nav.setGizmoDragging(on);
    const o = activeObj(), v = activeVol();
    if (on) drag = { state: o ? o.frame.toJSON() : null, vol: v ? { center: v.center.clone(), size: v.size.clone(), radius: v.radius } : null, lastP: proxy.position.clone(), lastQ: proxy.quaternion.clone(), lastS: proxy.scale.clone() };
    else {
      // a fine drag of a pixel or two still moves the origin: only a press that changed nothing is a click
      const untouched = !!drag?.state && !!o && JSON.stringify(drag.state) === JSON.stringify(o.frame.toJSON());
      if (drag?.state && o) recordFrameStep(o, drag.state, o.frame.toJSON(), tool === "origin" ? "原点を移動" : undefined);
      if (drag?.vol && v) volumeChanged(v, true);
      drag = null; syncProxy();
      if (tool === "origin" && o && untouched && press && !press.moved) { const hit = pickAt(press.x, press.y); if (hit) setOriginAt(o, hit.point); }
    }
  });
  gizmo.addEventListener("objectChange", () => {
    if (!drag) return;
    const o = activeObj(), v = activeVol();
    if (gizmo.mode === "translate") {
      const d = proxy.position.clone().sub(drag.lastP); drag.lastP.copy(proxy.position);
      if (o) { if (tool === "origin") o.frame.movePivotWorld(d); else o.frame.translateWorld(d); }
      else if (v) { v.center.add(d); volumeChanged(v, false); }
    } else if (gizmo.mode === "rotate") {
      const dq = proxy.quaternion.clone().multiply(drag.lastQ.clone().invert()); drag.lastQ.copy(proxy.quaternion);
      if (o) o.frame.rotateAboutPivot(dq);
    } else {
      const s = proxy.scale, l = drag.lastS;
      const ks = [s.x / l.x, s.y / l.y, s.z / l.z];
      drag.lastS.copy(s);
      if (o) { const k = ks.reduce((a, b) => (Math.abs(b - 1) > Math.abs(a - 1) ? b : a), 1); if (k > 0 && isFinite(k)) o.frame.scaleAboutPivot(k); }
      else if (v) {
        if (v.kind === "box") { v.size.x *= ks[0] > 0 ? ks[0] : 1; v.size.y *= ks[1] > 0 ? ks[1] : 1; v.size.z *= ks[2] > 0 ? ks[2] : 1; }
        else { const k = ks.reduce((a, b) => (Math.abs(b - 1) > Math.abs(a - 1) ? b : a), 1); if (k > 0) v.radius *= k; }
        volumeChanged(v, false);
      }
    }
  });
  const setSnap = (on: boolean) => { gizmo.setTranslationSnap(on ? 0.1 : null); gizmo.setRotationSnap(on ? THREE.MathUtils.degToRad(5) : null); gizmo.setScaleSnap(on ? 0.1 : null); };
  window.addEventListener("keydown", (e) => { if (e.key === "Control") setSnap(true); });
  window.addEventListener("keyup", (e) => { if (e.key === "Control") setSnap(false); });
  window.addEventListener("blur", () => setSnap(false));
  let axisLock: Axis | null = null;
  const applyAxisLock = () => {
    const show = axisLock ? AXIS_TO_THREE[axisLock].show : null;
    gizmo.showX = !show || show === "x"; gizmo.showY = !show || show === "y"; gizmo.showZ = !show || show === "z";
  };

  // ── tools ──
  function setTool(t: Tool) {
    if (tool !== t) { cancelNumeric(); axisLock = null; }
    tool = t;
    const v = activeVol();
    if (v && (t === "rotate" || t === "origin")) { editor.setMessage("Clip volumes only move and scale"); t = tool = "move"; }
    editor.setTool(t, variant);
    editor.setHint(HINTS[t === "select" ? variant : v ? (t === "scale" ? "volScale" : "volMove") : t]);
    if (GIZMO_TOOLS.includes(t) && active) { gizmo.setMode(t === "rotate" ? "rotate" : t === "scale" ? "scale" : "translate"); gizmo.attach(proxy); applyAxisLock(); syncProxy(); }
    else gizmo.detach();
    editor.hideCircle(); editor.hideRect(); editor.hideLasso();
  }
  const cycleSelect = () => { if (tool !== "select") setTool("select"); else { variant = VARIANT_ORDER[(VARIANT_ORDER.indexOf(variant) + 1) % VARIANT_ORDER.length]; setTool("select"); } };

  // ── picking (nearest surface under the cursor across the shown objects) ──
  const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2();
  const viewRect = () => dom.getBoundingClientRect();
  const pickAt = (clientX: number, clientY: number): { point: THREE.Vector3; obj: GsObject } | null => {
    const r = viewRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, scene.activeCamera);
    let best: { point: THREE.Vector3; obj: GsObject } | null = null, bestD = Infinity;
    for (const o of shownObjects()) {
      if (!o.data.ready) continue;
      o.mesh.updateMatrixWorld(true);
      const p = o.data.pickRay(ray.ray, o.mesh.matrixWorld);
      if (!p) continue;
      const d = p.distanceTo(ray.ray.origin);
      if (d < bestD) { bestD = d; best = { point: p, obj: o }; }
    }
    return best;
  };
  nav.pivotProvider = (x, y) => {
    const c = new THREE.Vector3(); let n = 0;
    for (const o of shownObjects()) { const s = o.data.selectionCenter(o.mesh.matrixWorld); if (s) { c.addScaledVector(s, o.data.selected); n += o.data.selected; } }
    if (n) return c.multiplyScalar(1 / n);
    return pickAt(x, y)?.point ?? null;
  };

  // ── selection gestures (left button) — on every shown object, decided at full resolution in each scan's worker ──
  type Pt = { x: number; y: number };
  type Gesture = { kind: SelectVariant; x0: number; y0: number; mode: SelectMode; pts: Pt[]; moved: boolean; caught: number; ops: Promise<unknown>[]; dabs: number[]; last: Pt; painting: boolean };
  let gesture: Gesture | null = null;
  let circleR = 40;
  const local = (e: PointerEvent) => { const r = viewRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const modeOf = (e: PointerEvent): SelectMode => (e.ctrlKey ? "sub" : e.shiftKey ? "add" : "set");
  /** Project every shown scan for the current camera (queued in each worker ahead of the tests that use it). */
  const projectNow = () => { const r = viewRect(); for (const o of shownObjects()) { o.mesh.updateMatrixWorld(true); void o.data.project(scene.activeCamera, o.mesh.matrixWorld, r.width, r.height); } };
  const selectedCount = () => objects.reduce((a, o) => a + o.data.selected, 0);
  const syncSelection = () => editor.setSelection(selectedCount());
  /** Wait for every scan's queued work (counts and selection are current afterwards). */
  const settle = () => Promise.all(objects.map((o) => o.data.idle()));
  const deselectAll = async () => { await Promise.all(objects.map((o) => o.data.deselectAll())); syncSelection(); };
  const selOp = async (fn: (o: GsObject) => Promise<unknown>) => { await Promise.all(shownObjects().map(fn)); syncSelection(); activateSelectionOwner(); };
  /**
   * Which scan is under a click, from the projected splats (projectNow() first) — every
   * splat, not a sample. "busy" while a scan is still being prepared: then a click must
   * not count as empty space.
   */
  const objectUnder = async (clientX: number, clientY: number): Promise<GsObject | null | "busy"> => {
    const list = shownObjects();
    if (list.some((o) => !o.data.ready)) return "busy";
    const r = viewRect(), x = clientX - r.left, y = clientY - r.top;
    const flags = await Promise.all(list.map((o) => o.data.hit(x, y, 6)));
    const hits = list.filter((_, i) => flags[i]);
    const near = pickAt(clientX, clientY)?.obj ?? null;   // nearest along the ray, when the sampled pick finds one
    if (!hits.length) return near;
    return near && hits.includes(near) ? near : hits[0];
  };
  // ── clip volumes are picked by their outline (what is drawn), like a wire in Blender ──
  const RING = Array.from({ length: 65 }, (_, i) => [Math.cos((i / 64) * Math.PI * 2), Math.sin((i / 64) * Math.PI * 2)]);
  const BOX_EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  /** The outline of a volume as world-space segments (box: 12 edges; sphere: the three drawn great circles). */
  const outlineOf = (v: ClipVolume): [THREE.Vector3, THREE.Vector3][] => {
    const c = v.center, out: [THREE.Vector3, THREE.Vector3][] = [];
    if (v.kind === "box") {
      const h = v.size.clone().multiplyScalar(0.5);
      const k = Array.from({ length: 8 }, (_, i) => new THREE.Vector3(c.x + (i & 1 ? h.x : -h.x), c.y + (i & 2 ? h.y : -h.y), c.z + (i & 4 ? h.z : -h.z)));
      for (const [a, b] of BOX_EDGES) out.push([k[a], k[b]]);
    } else {
      const r = v.radius;
      const planes = [(a: number, b: number) => new THREE.Vector3(c.x + a * r, c.y + b * r, c.z), (a: number, b: number) => new THREE.Vector3(c.x + a * r, c.y, c.z + b * r), (a: number, b: number) => new THREE.Vector3(c.x, c.y + b * r, c.z + a * r)];
      for (const f of planes) for (let i = 0; i < 64; i++) out.push([f(RING[i][0], RING[i][1]), f(RING[i + 1][0], RING[i + 1][1])]);
    }
    return out;
  };
  /** The shown volume whose outline passes within `tol` px of the cursor (nearest wins). */
  const volumeAt = (clientX: number, clientY: number, tol = 7): ClipVolume | null => {
    const r = viewRect(), x = clientX - r.left, y = clientY - r.top, cam = scene.activeCamera, t = new THREE.Vector3();
    const px = (w: THREE.Vector3) => { t.copy(w).project(cam); return t.z < -1 || t.z > 1 ? null : [(t.x * 0.5 + 0.5) * r.width, (-t.y * 0.5 + 0.5) * r.height]; };
    let best: ClipVolume | null = null, bestD = tol;
    for (const v of volumes) {
      if (!v.enabled || !v.showBounds) continue;
      for (const [a, b] of outlineOf(v)) {
        const pa = px(a), pb = px(b); if (!pa || !pb) continue;
        const dx = pb[0] - pa[0], dy = pb[1] - pa[1], L = dx * dx + dy * dy;
        const u = L ? Math.max(0, Math.min(1, ((x - pa[0]) * dx + (y - pa[1]) * dy) / L)) : 0;
        const d = Math.hypot(pa[0] + u * dx - x, pa[1] + u * dy - y);
        if (d < bestD) { bestD = d; best = v; }
      }
    }
    return best;
  };
  let hoverVol: ClipVolume | null = null;
  const setHoverVol = (v: ClipVolume | null) => { if (v === hoverVol) return; hoverVol = v; dom.style.cursor = v ? "pointer" : ""; refreshVolumeLook(); };
  /**
   * A plain click: drop the splat selection; what is under the cursor becomes active —
   * a volume's outline first (it is drawn on top), then a scan; empty space clears it.
   */
  const clickAt = async (clientX: number, clientY: number) => {
    const v = volumeAt(clientX, clientY);
    if (v) { await deselectAll(); if (activeVol() !== v) setActive({ kind: "volume", vol: v }); return; }
    await deselectAll();
    const u = await objectUnder(clientX, clientY);
    if (u === "busy") return;
    if (u) { if (activeObj() !== u) setActive({ kind: "object", obj: u }); }
    else setActive(null);
  };
  /**
   * After splats get selected, the scan they belong to is the active one (unless the
   * active scan already has a selection) — so the panels never point elsewhere while
   * the user is cleaning a scan, whatever was active before (nothing, or a volume).
   */
  const activateSelectionOwner = () => {
    const cur = activeObj();
    if (cur && cur.data.selected) return;
    let best: GsObject | null = null;
    for (const o of shownObjects()) if (o.data.selected && (!best || o.data.selected > best.data.selected)) best = o;
    if (best) setActive({ kind: "object", obj: best });
  };
  /**
   * Circle painting: dabs are sent in batches — while one batch is in the workers, new
   * dabs collect and go out together — and a fast stroke is filled in between events so
   * it leaves no gaps.
   */
  const paint = (g: Gesture, p?: Pt) => {
    if (p) {
      const dx = p.x - g.last.x, dy = p.y - g.last.y, steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (circleR * 0.5)));
      for (let i = 1; i <= steps; i++) g.dabs.push(g.last.x + (dx * i) / steps, g.last.y + (dy * i) / steps);
      g.last = p;
    }
    if (g.painting || !g.dabs.length) return;
    const pts = g.dabs; g.dabs = []; g.painting = true;
    const mode = g.mode === "sub" ? "sub" : "add";
    g.ops.push(Promise.all(shownObjects().map((o) => o.data.select({ kind: "circles", pts, r: circleR }, mode).then((d) => { g.caught += d.changed; })))
      .then(() => { g.painting = false; syncSelection(); paint(g); }));
  };
  let clickDown: { x: number; y: number } | null = null;
  let outlineDown: { x: number; y: number; mode: SelectMode } | null = null;
  const beginGesture = (clientX: number, clientY: number, mode: SelectMode) => {
    const r = viewRect(), p = { x: clientX - r.left, y: clientY - r.top };
    projectNow();
    const g: Gesture = { kind: variant, x0: p.x, y0: p.y, mode, pts: [p], moved: false, caught: 0, ops: [], dabs: [], last: p, painting: false };
    gesture = g;
    if (g.mode === "set") g.ops.push(...objects.map((o) => o.data.deselectAll()));   // plain drag starts a fresh selection
    if (g.kind === "circle") { g.dabs.push(p.x, p.y); paint(g); }
  };
  dom.addEventListener("pointerdown", (e) => {
    editor.hideContextMenu();
    if (e.button !== 0 || nav.isBlocked() || (!objects.length && !volumes.length)) return;
    if (GIZMO_TOOLS.includes(tool)) { if ((gizmo as any).axis == null) clickDown = { x: e.clientX, y: e.clientY }; return; }
    try { dom.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    if (volumeAt(e.clientX, e.clientY)) outlineDown = { x: e.clientX, y: e.clientY, mode: modeOf(e) };
    else beginGesture(e.clientX, e.clientY, modeOf(e));
    e.preventDefault();
  });
  dom.addEventListener("pointermove", (e) => {
    if (tool === "select" && variant === "circle" && !nav.isBlocked()) { const p = local(e); editor.showCircle(p.x, p.y, circleR); }
    if (!e.buttons && !gesture && !outlineDown) setHoverVol(nav.isBlocked() ? null : volumeAt(e.clientX, e.clientY));
    if (outlineDown) {
      if (Math.hypot(e.clientX - outlineDown.x, e.clientY - outlineDown.y) < 3) return;
      const o = outlineDown; outlineDown = null;
      beginGesture(o.x, o.y, o.mode);   // it was a drag after all: select splats from where it started
    }
    if (!gesture) return;
    const p = local(e);
    if (!gesture.moved && Math.hypot(p.x - gesture.x0, p.y - gesture.y0) < 3) return;
    gesture.moved = true;
    if (gesture.kind === "box") editor.showRect(gesture.x0, gesture.y0, p.x, p.y);
    else if (gesture.kind === "lasso") { gesture.pts.push(p); editor.showLasso(gesture.pts); }
    else paint(gesture, p);
  });
  const endGesture = async (e: PointerEvent) => {
    if (clickDown) { // a plain click with a gizmo tool: set the origin (origin tool) or pick / clear the active scan
      const c = clickDown; clickDown = null;
      if (Math.hypot(e.clientX - c.x, e.clientY - c.y) < 4 && !gizmo.dragging) {
        if (tool === "origin") { const hit = pickAt(e.clientX, e.clientY); const o = activeObj(); if (hit && o) setOriginAt(o, hit.point); }
        else { projectNow(); await clickAt(e.clientX, e.clientY); }
      }
    }
    if (outlineDown) { outlineDown = null; await clickAt(e.clientX, e.clientY); return; }   // a click on a volume's outline
    const g = gesture; if (!g) return; gesture = null;
    const p = local(e);
    editor.hideRect(); editor.hideLasso();
    const shown = shownObjects();
    if (g.kind === "box") {
      if (g.moved) { const rect = { kind: "rect" as const, l: Math.min(g.x0, p.x), t: Math.min(g.y0, p.y), r: Math.max(g.x0, p.x), b: Math.max(g.y0, p.y) }; g.ops.push(...shown.map((o) => o.data.select(rect, g.mode))); }
      else if (g.mode === "set") g.ops.push(clickAt(e.clientX, e.clientY));
    } else if (g.kind === "lasso") {
      if (g.moved && g.pts.length >= 3) { const pts = g.pts.flatMap((q) => [q.x, q.y]); g.ops.push(...shown.map((o) => o.data.select({ kind: "lasso", pts }, g.mode))); }
      else if (!g.moved && g.mode === "set") g.ops.push(clickAt(e.clientX, e.clientY));
    } else {
      let seen: number;
      do { seen = g.ops.length; await Promise.all(g.ops); } while (g.ops.length !== seen || g.painting || g.dabs.length);
      if (!g.moved && g.mode === "set" && !g.caught) g.ops.push(clickAt(e.clientX, e.clientY));   // a dab that caught splats keeps them
    }
    await Promise.all(g.ops);
    syncSelection();
    activateSelectionOwner();
  };
  // a scan removed mid-gesture rejects its queued work: nothing to do then
  const endSafely = (e: PointerEvent) => { endGesture(e).catch((err) => { if (!/disposed/.test(String(err))) console.error(err); }); };
  dom.addEventListener("pointerup", endSafely);
  dom.addEventListener("pointercancel", endSafely);
  dom.addEventListener("pointerleave", () => { editor.hideCircle(); setHoverVol(null); });
  dom.addEventListener("wheel", (e) => {
    if (!(tool === "select" && variant === "circle" && e.shiftKey)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    circleR = Math.min(400, Math.max(6, circleR * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    const r = viewRect(); editor.showCircle(e.clientX - r.left, e.clientY - r.top, circleR);
  }, { capture: true, passive: false });
  dom.addEventListener("dblclick", (e) => { const hit = pickAt(e.clientX, e.clientY); if (hit) nav.focusOn(hit.point); });
  let ctxAt = { x: 0, y: 0 };
  dom.addEventListener("contextmenu", (e) => {
    e.preventDefault(); ctxAt = { x: e.clientX, y: e.clientY };
    editor.showContextMenu(e.clientX, e.clientY, selectedCount() > 0, objects.length > 0);
    void settle().then(() => editor.setContextSelection(selectedCount() > 0));   // a selection may still be on its way from the workers
  });

  // ── delete / restore ──
  async function deleteSelection() {
    await settle();
    const list = shownObjects().filter((o) => o.data.selected > 0);
    if (!list.length) { editor.setMessage("Nothing selected"); return; }
    const owner = list.reduce((a, b) => (b.data.selected > a.data.selected ? b : a));
    const cur = activeObj();
    if (!cur || !list.includes(cur)) setActive({ kind: "object", obj: owner });
    const done = await Promise.all(list.map(async (o) => ({ o, batch: await o.data.hideSelected() })));
    const n = done.reduce((a, b) => a + b.batch.length, 0);
    history.push({ label: `削除 (${n.toLocaleString()} 粒)`,
      undo: () => { void Promise.all(done.map((d) => d.o.data.restore(d.batch))).then(afterEdit); },
      redo: () => { void Promise.all(done.map((d) => d.o.data.hide(d.batch))).then(afterEdit); } });
    afterEdit();
    editor.setMessage(`Deleted ${n.toLocaleString()} splats (Ctrl+Z to undo)`);
  }
  const afterEdit = () => { splat.prepare(scene.activeCamera); syncSelection(); scheduleDims(); updateInfo(); refreshOutliner(); };

  // ── history ──
  const histPanel = new HistoryPanel(editor.mounts.history, (i) => { history.goTo(i); editor.setMessage(i === 0 ? "Back to the loaded state" : `History: up to "${history.currentLabel}"`); });
  history.setOnChange(() => histPanel.render(history));
  histPanel.render(history);
  const undo = () => { const l = history.currentLabel; if (history.undo()) editor.setMessage(`Undo: ${l}`); };
  const redo = () => { if (history.redo()) editor.setMessage(`Redo: ${history.currentLabel}`); };
  /** A transform step on one object (labels in Japanese like the rest of the history, numbers in Blender terms). */
  function recordFrameStep(o: GsObject, before: FrameJSON, after: FrameJSON, label?: string) {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    if (!label) {
      const stateOf = (j: FrameJSON) => { const save = o.frame.toJSON(); o.frame.fromJSON(j); const s = toBlender(o.frame.state); o.frame.fromJSON(save); return s; };
      const b = stateOf(before), a = stateOf(after), ax = ["X", "Y", "Z"];
      label = Math.abs(a.scale - b.scale) > 1e-9 ? `大きさ ×${(a.scale / b.scale).toFixed(3)}`
        : a.rotDeg.some((v, i) => Math.abs(v - b.rotDeg[i]) > 1e-6) ? `回転 ${a.rotDeg.map((v, i) => (Math.abs(v - b.rotDeg[i]) > 1e-6 ? `${ax[i]} ${v.toFixed(1)}°` : "")).filter(Boolean).join(" ")}`
        : a.pos.some((v, i) => Math.abs(v - b.pos[i]) > 1e-9) ? `位置 ${a.pos.map((v, i) => (Math.abs(v - b.pos[i]) > 1e-9 ? `${ax[i]} ${v.toFixed(3)} m` : "")).filter(Boolean).join(" ")}`
        : "原点を移動";
      if (objects.length > 1) label = `${o.name}: ${label}`;
    }
    history.push({ label, undo: () => o.frame.fromJSON(before), redo: () => o.frame.fromJSON(after) });
  }
  const frameOp = (o: GsObject, label: string | undefined, op: () => void) => { const before = o.frame.toJSON(); op(); recordFrameStep(o, before, o.frame.toJSON(), label); };
  const setOriginAt = (o: GsObject, p: THREE.Vector3) => { frameOp(o, "原点を設定", () => o.frame.setPivotWorld(p)); editor.setMessage("Object origin set — Alt+G puts it on the world origin"); };

  // ── transform panel (active object) ──
  let fieldBefore: FrameJSON | null = null;
  const panel = new TransformPanel(editor.mounts.transform, {
    onState: (s, commit) => {
      const o = activeObj(); if (!o) return;
      if (!fieldBefore) fieldBefore = o.frame.toJSON();
      const cur = o.frame.state;
      if (s.rotDeg.some((v, i) => Math.abs(v - cur.rotDeg[i]) > 1e-6)) o.frame.setRotationDeg(s.rotDeg[0], s.rotDeg[1], s.rotDeg[2]);
      else if (Math.abs(s.scale - cur.scale) > 1e-9) o.frame.setScale(s.scale);
      else o.frame.setLocationWorld(new THREE.Vector3(s.pos[0], s.pos[1], s.pos[2]));
      if (commit) { const b = fieldBefore; fieldBefore = null; recordFrameStep(o, b, o.frame.toJSON()); }
    },
    onClear: (what) => clearTransform(what),
    onApply: () => { const o = activeObj(); if (!o) return; frameOp(o, "トランスフォームを適用", () => o.frame.applyTransform()); editor.setMessage("Applied: this placement is now 0 / 0 / 1 — later edits are relative to it"); },
    onReset: () => { const o = activeObj(); if (!o) return; frameOp(o, "リセット", () => o.frame.reset()); editor.setMessage("Transform reset to the file as loaded"); },
  });
  const clearTransform = (what: "location" | "rotation" | "scale") => {
    const o = activeObj(); if (!o) return;
    if (what === "location") frameOp(o, "位置をクリア", () => o.frame.clearLocation());
    else if (what === "rotation") frameOp(o, "回転をクリア", () => o.frame.clearRotation());
    else frameOp(o, "大きさをクリア", () => o.frame.clearScale());
  };
  const volPanel = new VolumePanel(editor.mounts.volume, { onChange: (commit) => { const v = activeVol(); if (v) volumeChanged(v, commit); } });

  // ── clip volumes ──
  const VOL_BLUE = 0x1c7fb0; // C4D-ish deep blue
  const VOL_HOVER = 0x62c2ee; // the same blue, lit: the outline under the cursor (click to select)
  function addVolume(kind: VolumeKind) {
    const n = volumes.filter((x) => x.kind === kind).length + 1;
    const v: ClipVolume = { id: nextId++, name: `${kind === "box" ? "BoxVolume" : "SphereVolume"} ${n}`, kind, center: new THREE.Vector3(), size: new THREE.Vector3(2, 2, 2), radius: 1, mode: "inside", enabled: true, showBounds: true };
    volumes.push(v);
    // outline always (while bounds are on); the translucent body only while the volume is active
    const helper = new THREE.Group();
    const lineMat = new THREE.LineBasicMaterial({ color: VOL_BLUE, transparent: true, opacity: 0.95, depthTest: false });
    const fillMat = new THREE.MeshBasicMaterial({ color: VOL_BLUE, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide });
    if (kind === "box") {
      helper.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), lineMat));
      const fill = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), fillMat); fill.name = "fill"; helper.add(fill);
    } else {
      // three great circles read as a sphere without the wireframe mesh
      const ring = () => new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 64 }, (_, i) => new THREE.Vector3(Math.cos((i / 64) * Math.PI * 2), Math.sin((i / 64) * Math.PI * 2), 0))), lineMat);
      const r1 = ring(), r2 = ring(), r3 = ring(); r2.rotation.x = Math.PI / 2; r3.rotation.y = Math.PI / 2;
      helper.add(r1, r2, r3);
      const fill = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), fillMat); fill.name = "fill"; helper.add(fill);
    }
    helper.traverse((o) => { o.layers.set(1); o.renderOrder = 996; });
    scene.scene.add(helper);
    volumeHelpers.set(v.id, helper);
    setActive({ kind: "volume", vol: v });
    volumeChanged(v, true);
    setTool("move");
    editor.setMessage(`${v.name} added — move / scale it with G / S`);
  }
  function removeVolume(v: ClipVolume) {
    volumes.splice(volumes.indexOf(v), 1);
    const h = volumeHelpers.get(v.id); if (h) { scene.scene.remove(h); volumeHelpers.delete(v.id); }
    if (activeVol() === v) setActive(objects.length ? { kind: "object", obj: objects[objects.length - 1] } : null);
    scheduleClip(); refreshOutliner();
  }
  const refreshVolumeLook = () => {
    for (const v of volumes) {
      const h = volumeHelpers.get(v.id); if (!h) continue;
      h.visible = v.showBounds && v.enabled;
      const fill = h.getObjectByName("fill"); if (fill) fill.visible = activeVol() === v;
      h.traverse((c) => { if ((c as THREE.Line).isLine) ((c as THREE.Line).material as THREE.LineBasicMaterial).color.setHex(hoverVol === v ? VOL_HOVER : VOL_BLUE); });
    }
    const av = activeVol(); if (av) editor.setVolumeShow(av.showBounds);
  };
  function volumeChanged(v: ClipVolume, _commit: boolean) {
    const h = volumeHelpers.get(v.id);
    if (h) { h.position.copy(v.center); if (v.kind === "box") h.scale.copy(v.size); else h.scale.setScalar(v.radius); }
    refreshVolumeLook();
    if (activeVol() === v && !volPanel.busy) volPanel.set(v);
    if (activeVol() === v) syncProxy();
    scheduleClip(); refreshOutliner();
  }
  let clipTimer = 0, clipRunning = false, clipAgain = false;
  const scheduleClip = () => { window.clearTimeout(clipTimer); clipTimer = window.setTimeout(() => void applyClip(), 30); };
  /** Re-evaluate the clip volumes in every scan's worker; a request during a run is folded into one more run. */
  async function applyClip() {
    if (clipRunning) { clipAgain = true; return; }
    clipRunning = true;
    try {
      do {
        clipAgain = false;
        const vols: VolDesc[] = volumes.filter((v) => v.enabled).map((v) => ({ kind: v.kind, cx: v.center.x, cy: v.center.y, cz: v.center.z, sx: v.size.x, sy: v.size.y, sz: v.size.z, r: v.radius, inside: v.mode === "inside" }));
        const list = objects.filter((o) => o.data.ready && (vols.length || o.data.clipped));
        const res = await Promise.all(list.map((o) => { o.mesh.updateMatrixWorld(true); return o.data.clip(o.mesh.matrixWorld.clone(), vols); }));
        if (res.some(Boolean)) { splat.prepare(scene.activeCamera); syncSelection(); scheduleDims(); updateInfo(); }
      } while (clipAgain);
    } finally { clipRunning = false; }
  }

  // ── numeric input (G X 1.5 ⏎ …) ──
  let numText = "";
  const numLabel = () => {
    const t = tool === "move" ? "Move" : tool === "rotate" ? "Rotate" : tool === "scale" ? "Scale" : "Move origin";
    const ax = axisLock ? axisLock.toUpperCase() : tool === "scale" ? "" : tool === "rotate" ? "Z" : "X";
    const unit = tool === "rotate" ? "°" : tool === "scale" ? " ×" : " m";
    return `${t} ${ax}: ${numText || "…"}${unit}`;
  };
  const showNumeric = () => editor.setNumInput(GIZMO_TOOLS.includes(tool) && (numText || axisLock) ? numLabel() : null);
  const cancelNumeric = () => { numText = ""; editor.setNumInput(null); };
  const applyNumeric = () => {
    const val = parseFloat(numText); cancelNumeric();
    if (!isFinite(val)) return;
    const axis: Axis = axisLock ?? (tool === "rotate" ? "z" : "x");
    const a = AXIS_TO_THREE[axis];
    const o = activeObj(), v = activeVol();
    if (o) {
      if (tool === "move") frameOp(o, undefined, () => o.frame.translateWorld(a.v.clone().multiplyScalar(val)));
      else if (tool === "origin") frameOp(o, "原点を移動", () => o.frame.movePivotWorld(a.v.clone().multiplyScalar(val)));
      else if (tool === "rotate") frameOp(o, undefined, () => o.frame.rotateAboutPivot(new THREE.Quaternion().setFromAxisAngle(a.v, THREE.MathUtils.degToRad(val))));
      else if (tool === "scale" && val > 0) frameOp(o, undefined, () => o.frame.scaleAboutPivot(val));
    } else if (v) {
      if (tool === "move") v.center.addScaledVector(a.v, val);
      else if (tool === "scale" && val > 0) { if (v.kind === "box") v.size.multiplyScalar(val); else v.radius *= val; }
      volumeChanged(v, true);
    }
  };

  // ── dimensions (the active object's body box, outliers excluded) + labels in the viewport ──
  const dimsBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0xffa028, transparent: true, opacity: 0.8, depthTest: false }));
  dimsBox.layers.set(1); dimsBox.renderOrder = 997; dimsBox.visible = false; scene.scene.add(dimsBox);
  let dimsTimer = 0, lastBox: THREE.Box3 | null = null;
  const scheduleDims = () => { window.clearTimeout(dimsTimer); dimsTimer = window.setTimeout(() => void computeDims(), 180); };
  let dimsSeq = 0;
  async function computeDims() {
    const o = activeObj(), my = ++dimsSeq;
    if (!o || !o.data.ready) { editor.setDims(null); lastBox = null; dimsBox.visible = false; return; }
    o.mesh.updateMatrixWorld(true);
    const pts = await o.data.sample(o.mesh.matrixWorld.clone(), 60000);
    if (my !== dimsSeq || activeObj() !== o) return;   // superseded while the worker sampled
    const n = pts.length / 3;
    if (n < 10) { editor.setDims(null); lastBox = null; dimsBox.visible = false; return; }
    const lo = new THREE.Vector3(), hi = new THREE.Vector3();
    const col = new Float32Array(n);
    for (let a = 0; a < 3; a++) {
      for (let i = 0; i < n; i++) col[i] = pts[i * 3 + a];
      col.sort();
      lo.setComponent(a, col[Math.floor(n * 0.02)]); hi.setComponent(a, col[Math.min(n - 1, Math.floor(n * 0.98))]);
    }
    lastBox = new THREE.Box3(lo, hi);
    const size = lastBox.getSize(new THREE.Vector3()), c = lastBox.getCenter(new THREE.Vector3());
    editor.setDims({ w: size.x, d: size.z, h: size.y });   // Blender: X width, Y depth (three −Z), Z height (three Y)
    dimsBox.position.copy(c); dimsBox.scale.copy(size);
    dimsBox.visible = editor.dimsVisible;
  }
  const tmpV = new THREE.Vector3();
  function updateDimLabels() {
    if (!lastBox || !dimsBox.visible) { editor.setDimLabels([null, null, null]); return; }
    const b = lastBox, r = viewRect();
    const camPos = scene.activeCamera.position;
    const nx = camPos.x > (b.min.x + b.max.x) / 2 ? b.max.x : b.min.x;
    const nz = camPos.z > (b.min.z + b.max.z) / 2 ? b.max.z : b.min.z;
    const size = b.getSize(new THREE.Vector3());
    const pts = [
      { p: new THREE.Vector3((b.min.x + b.max.x) / 2, b.min.y, nz), text: `W ${size.x.toFixed(2)} m` },
      { p: new THREE.Vector3(nx, b.min.y, (b.min.z + b.max.z) / 2), text: `D ${size.z.toFixed(2)} m` },
      { p: new THREE.Vector3(nx, (b.min.y + b.max.y) / 2, nz), text: `H ${size.y.toFixed(2)} m` },
    ];
    editor.setDimLabels(pts.map(({ p, text }) => {
      tmpV.copy(p).project(scene.activeCamera);
      if (tmpV.z < -1 || tmpV.z > 1) return null;
      return { x: (tmpV.x * 0.5 + 0.5) * r.width, y: (-tmpV.y * 0.5 + 0.5) * r.height, text };
    }));
  }

  // ── info / outliner ──
  const updateInfo = () => {
    const o = activeObj();
    if (!o) { editor.setInfo(null); return; }
    const d = o.data, drawn = d.drawnCount;
    editor.setInfo({ name: o.source.name, format: (o.source.name.split(".").pop() || "").toLowerCase(), bytes: o.source.rowMap ? 0 : o.source.file?.size ?? 0, total: d.n, visible: d.n - d.hidden,
      sceneTotal: objects.reduce((a, x) => a + x.data.n, 0), sceneDrawn: shownObjects().reduce((a, x) => a + x.data.drawnCount, 0),
      drawn, light: d.n > lightMax ? d.light : null, upZ: !!o.source.upZ, relight: d.prepared });
  };
  const refreshOutliner = () => {
    const rows: ObjectRow[] = [
      ...objects.map((o) => ({ id: o.id, name: o.name, visible: o.visible, active: activeObj() === o, splats: o.data.n, kind: "object" as const })),
      ...volumes.map((v) => ({ id: v.id, name: `${v.name}${v.mode === "outside" ? " (keep outside)" : ""}`, visible: v.enabled, active: activeVol() === v, splats: 0, kind: v.kind })),
    ];
    editor.setObjects(rows);
  };
  function setActive(a: Active) {
    active = a;
    editor.setActiveKind(a ? a.kind : null);
    const o = activeObj(), v = activeVol();
    if (o) panel.setState(o.frame.state);
    volPanel.set(v);
    if (v && (tool === "rotate" || tool === "origin")) setTool("move");
    if (GIZMO_TOOLS.includes(tool)) { if (a) { gizmo.attach(proxy); syncProxy(); } else gizmo.detach(); }
    scene.objOrigin.visible = !!o;
    refreshVolumeLook();
    void computeDims(); updateInfo(); refreshOutliner();
  }

  // ── keyboard ──
  const isTyping = (e: Event) => { const t = e.target as HTMLElement | null; return !!t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable); };
  // flattened colours are the normal view; holding Space shows the scans as captured
  let flatView = true;
  const setFlatAll = (on: boolean) => {
    if (flatView === on) return;
    flatView = on;
    for (const o of objects) o.data.setShowFlat(on);
    if (on) editor.setMessage("", 1); else editor.setMessage("Captured look — release Space for the flattened colours", 0);
  };
  window.addEventListener("keyup", (e) => { if (e.code === "Space") setFlatAll(true); });
  window.addEventListener("blur", () => setFlatAll(true));
  window.addEventListener("keydown", (e) => {
    if (isTyping(e)) return;
    if (e.code === "Space") { e.preventDefault(); if (!e.repeat) setFlatAll(false); return; }
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.code === "KeyZ") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (ctrl && e.code === "KeyY") { e.preventDefault(); redo(); return; }
    if (ctrl && e.code === "KeyI") { e.preventDefault(); void selOp((o) => o.data.invert()); return; }
    if (ctrl && e.code === "KeyA") { e.preventDefault(); const o = activeObj(); if (o) { frameOp(o, "トランスフォームを適用", () => o.frame.applyTransform()); editor.setMessage("Applied: this placement is now 0 / 0 / 1"); } return; }
    if (ctrl && e.code === "Numpad1") { viewFrom("back"); return; }
    if (ctrl && e.code === "Numpad3") { viewFrom("left"); return; }
    if (ctrl && e.code === "Numpad7") { viewFrom("bottom"); return; }
    if (ctrl) return;
    if (e.altKey) {
      if (e.code === "KeyA") { void deselectAll(); e.preventDefault(); }
      else if (e.code === "KeyG") { clearTransform("location"); e.preventDefault(); }
      else if (e.code === "KeyR") { clearTransform("rotation"); e.preventDefault(); }
      else if (e.code === "KeyS") { clearTransform("scale"); e.preventDefault(); }
      return;
    }
    const inGizmo = GIZMO_TOOLS.includes(tool);
    if (inGizmo && /^(Digit\d|Numpad\d|Period|NumpadDecimal|Minus|NumpadSubtract)$/.test(e.code)) {
      const ch = e.code === "Period" || e.code === "NumpadDecimal" ? "." : e.code === "Minus" || e.code === "NumpadSubtract" ? "-" : e.code.slice(-1);
      numText += ch; showNumeric(); e.preventDefault(); return;
    }
    if (inGizmo && e.code === "Backspace" && numText) { numText = numText.slice(0, -1); showNumeric(); return; }
    if (inGizmo && e.code === "Enter" && numText) { applyNumeric(); return; }
    if (inGizmo && /^Key[XYZ]$/.test(e.code)) { const a = e.code.slice(-1).toLowerCase() as Axis; axisLock = axisLock === a ? null : a; applyAxisLock(); showNumeric(); return; }
    switch (e.code) {
      case "Escape":
        editor.hideContextMenu();
        if (numText) cancelNumeric();
        else if (axisLock) { axisLock = null; applyAxisLock(); showNumeric(); }
        else if (tool !== "select") setTool("select");
        else void deselectAll();
        return;
      case "KeyW": cycleSelect(); return;
      case "KeyB": variant = "box"; setTool("select"); return;
      case "KeyC": variant = "circle"; setTool("select"); return;
      case "KeyL": variant = "lasso"; setTool("select"); return;
      case "KeyG": setTool("move"); return;
      case "KeyR": setTool("rotate"); return;
      case "KeyS": setTool("scale"); return;
      case "KeyO": setTool("origin"); return;
      case "KeyA": void selOp((o) => o.data.selectAll()); return;
      case "KeyX": case "Delete": void deleteSelection(); return;
      case "KeyP": void separateSelection(); return;
      case "F2": { const id = activeObj()?.id ?? activeVol()?.id; if (id != null) { e.preventDefault(); editor.startRename(id); } return; }
      case "BracketLeft": circleR = Math.max(6, circleR / 1.2); return;
      case "BracketRight": circleR = Math.min(400, circleR * 1.2); return;
      case "Home": frameAll(); return;
      case "Numpad1": viewFrom(e.shiftKey ? "back" : "front"); return;
      case "Numpad3": viewFrom(e.shiftKey ? "left" : "right"); return;
      case "Numpad7": viewFrom(e.shiftKey ? "bottom" : "top"); return;
      case "Numpad5": setOrtho(!scene.isOrtho); return;
    }
    if (!inGizmo) { // top-row digits stand in for the numpad (laptops)
      if (e.code === "Digit1") viewFrom(e.shiftKey ? "back" : "front");
      else if (e.code === "Digit3") viewFrom(e.shiftKey ? "left" : "right");
      else if (e.code === "Digit7") viewFrom(e.shiftKey ? "bottom" : "top");
      else if (e.code === "Digit5") setOrtho(!scene.isOrtho);
    }
  });

  // Nothing is remembered between sessions: a reload or a new file always starts from the
  // file as it is. (Older builds restored the last transform per file; drop those entries.)
  try { for (const k of Object.keys(localStorage)) if (k.startsWith("gseditor-frame:")) localStorage.removeItem(k); } catch { /* ignore */ }

  // ── export: all shown objects into one file, saved where the user picks ──
  const FILE_FLIP_INV = new THREE.Matrix4().makeRotationFromQuaternion(SplatScene.FILE_FLIP.clone().invert());
  /**
   * Export. `what`: each object to its own file (the pieces made with Separate), all visible
   * objects into one file, or the active one only. `keep` < 1 thins by coverage (the
   * largest, most opaque splats stay). Each file re-reads its source — a PLY only the rows
   * it needs, slice by slice, so sources over 2 GB still export at full quality.
   */
  /** three's view (Y up) → Blender (Z up): (x, y, z) → (x, −z, y). */
  const VIEW_TO_BLENDER = new THREE.Matrix4().makeRotationX(Math.PI / 2);
  async function exportGS(choice: string, what: ExportWhat, keep: number) {
    const forBlender = choice === "plyz";
    const fmt = (forBlender ? "ply" : choice) as GsFormat;
    const list = what === "active" ? (activeObj() ? [activeObj()!] : []) : shownObjects();
    if (!list.length) { editor.setMessage(what === "active" ? "Make an object active first" : "Nothing to export"); return; }
    const each = what === "each" && list.length > 1;
    const safe = (s: string) => s.replace(/\.(ply|spz|splat|ksplat|sog)$/i, "").replace(/_fixed$/, "").replace(/[\\/:*?"<>|]+/g, "_").trim() || "scene";
    const fileName = (objs: GsObject[]) => `${objs.length === 1 ? safe(objs[0].name) : "scene"}${keep < 1 ? `_${Math.round(keep * 100)}pct` : ""}_fixed.${fmt}`;
    const types = [{ description: `Gaussian splats (.${fmt})`, accept: { "application/octet-stream": [`.${fmt}`] } }];
    // ask WHERE first (the pickers need the click's user activation; baking takes a while)
    let dir: any = null, handle: any = null;
    const w = window as any;
    if (each && w.showDirectoryPicker) {
      try { dir = await w.showDirectoryPicker({ id: "gseditor-export", mode: "readwrite" }); }
      catch (e: any) { if (e?.name === "AbortError") { editor.setMessage("Export cancelled"); return; } dir = null; }
    } else if (!each && window.showSaveFilePicker) {
      try { handle = await window.showSaveFilePicker({ suggestedName: fileName(list), types }); }
      catch (e: any) { if (e?.name === "AbortError") { editor.setMessage("Export cancelled"); return; } handle = null; }
    }
    editor.setLoading(true);
    const log = (t: string) => editor.setMessage(t, 0);
    try {
      await settle();
      const groups = each ? list.map((o) => [o]) : [list];
      let bytes = 0;
      const lowQ: string[] = [];
      for (let g = 0; g < groups.length; g++) {
        const name = g === 0 && handle?.name ? handle.name : fileName(groups[g]);
        const tag = groups.length > 1 ? ` (${g + 1}/${groups.length})` : "";
        log(`Exporting ${name}${tag}…`);
        const { blob, lowQuality } = await bakeGroup(groups[g], fmt, keep, name, (t) => log(`${t}${tag}`), forBlender);
        if (lowQuality) lowQ.push(name);
        const h = dir ? await dir.getFileHandle(name, { create: true }) : g === 0 ? handle : null;
        if (h) { const out = await h.createWritable(); await out.write(blob); await out.close(); } else downloadBlob(blob, name);
        bytes += blob.size;
      }
      editor.setMessage(`Exported ${groups.length} file${groups.length > 1 ? "s" : ""} (${(bytes / 1048576).toFixed(1)} MB)${dir ? ` into ${dir.name}` : handle ? "" : " — downloaded"}`
        + (lowQ.length ? ` — base colour only for ${lowQ.join(", ")}: the source could not be re-read` : ""), lowQ.length ? 0 : 12000);
    } catch (e) {
      console.error(e);
      editor.setMessage(`Export failed: ${e}`, 0);
    } finally { editor.setLoading(false); }
  }

  /** One output file from these objects: re-read their sources and bake; if that fails, bake the viewer data. */
  async function bakeGroup(objs: GsObject[], fmt: GsFormat, keep: number, outName: string, log: (t: string) => void, forBlender = false): Promise<{ blob: Blob; lowQuality: boolean }> {
    // the baked matrix maps file rows → output: back to the 3DGS axes, or to Blender's Z up
    const toOut = forBlender ? VIEW_TO_BLENDER : FILE_FLIP_INV;
    const comments = forBlender ? [SplatScene.UP_Z_MARK] : [];
    const parts: { o: GsObject; rows: Uint32Array; matrix: THREE.Matrix4 }[] = [];
    for (const o of objs) {
      o.mesh.updateMatrixWorld(true);
      let rows = await o.data.exportRows();
      if (keep < 1) rows = o.data.thin(rows, keep);
      parts.push({ o, rows, matrix: toOut.clone().multiply(o.mesh.matrixWorld) });
    }
    const relight = await relightFor(parts);
    // tells the GS Relight add-on how much light is already divided out of these colours
    if (relight) comments.push(`gs_relight 1 delight=${FLAT_STRENGTH}`);
    // the object origin, in the file's axes: the splats stay where they are in the map (a plain
    // import is unchanged) and the GS Relight add-on moves the Blender object's origin there
    if (objs.length === 1) {
      const p = objs[0].frame.worldPivot().applyMatrix4(toOut);
      comments.push(`gs_origin ${[p.x, p.y, p.z].map((v) => +v.toFixed(6)).join(" ")}`);
    }
    try {
      const sources: FileSource[] = [];
      for (const pt of parts) sources.push(await readSource(pt.o, pt.rows, pt.matrix, log));
      log("Baking…");
      return { blob: await bakeFiles(sources, fmt, outName, log, comments, relight), lowQuality: false };
    } catch (e) {
      console.warn("full-quality export failed, using viewer data:", e);
      // the full splats, with any selection tint / delete marks taken off while baking
      const bake = (i: number): Promise<Blob> => i < parts.length ? parts[i].o.data.withPristine(() => bake(i + 1))
        : bakeFromSplats(parts.map((pt) => ({ packed: pt.o.data.full as any, rows: pt.rows, matrix: pt.matrix })), fmt, outName, log, comments, relight);
      return { blob: await bake(0), lowQuality: true };
    }
  }

  /**
   * Normals and baked light for the exported rows, in the same order. A normal is turned the way
   * the positions are (into the output axes) and made to face up in the view; where none could be
   * worked out (too few splats around) it is "up". Null when a scan was not prepared.
   */
  async function relightFor(parts: { o: GsObject; rows: Uint32Array; matrix: THREE.Matrix4 }[]): Promise<RelightRows | null> {
    const got: { nrm: Int8Array; baked: Float32Array }[] = [];
    for (const pt of parts) { const r = pt.o.data.prepared ? await pt.o.data.relightRows(pt.rows) : null; if (!r) return null; got.push(r); }
    const total = parts.reduce((a, pt) => a + pt.rows.length, 0);
    const normals = new Float32Array(total * 3), baked = new Float32Array(total);
    const p = new THREE.Vector3(), s = new THREE.Vector3(), q = new THREE.Quaternion();
    let off = 0;
    parts.forEach((pt, k) => {
      const r = got[k];
      pt.matrix.decompose(p, q, s); const mo = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q)).elements;
      pt.o.mesh.matrixWorld.decompose(p, q, s); const mv = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q)).elements;
      const ux = mv[1], uy = mv[4], uz = mv[7];   // the view's up, in file axes
      for (let i = 0; i < pt.rows.length; i++) {
        let x = r.nrm[i * 3], y = r.nrm[i * 3 + 1], z = r.nrm[i * 3 + 2];
        const L = Math.hypot(x, y, z);
        if (L < 64) { x = ux; y = uy; z = uz; } else { x /= L; y /= L; z /= L; if (mv[1] * x + mv[4] * y + mv[7] * z < 0) { x = -x; y = -y; z = -z; } }
        const j = (off + i) * 3;
        normals[j] = mo[0] * x + mo[3] * y + mo[6] * z; normals[j + 1] = mo[1] * x + mo[4] * y + mo[7] * z; normals[j + 2] = mo[2] * x + mo[5] * y + mo[8] * z;
        baked[off + i] = r.baked[i];
      }
      off += pt.rows.length;
    });
    return { normals, baked };
  }

  /**
   * The source bytes for one object's rows. A binary PLY is cut down to just those rows,
   * read in slices (any file size — browsers cannot read a file over ~2 GB in one piece);
   * other formats (.spz / .splat / .ksplat, small by nature) are read whole.
   */
  async function readSource(o: GsObject, rows: Uint32Array, matrix: THREE.Matrix4, log: (t: string) => void): Promise<FileSource> {
    const file: Blob = o.source.file ?? await (await fetch(o.source.url)).blob();
    const map = o.source.rowMap;
    const fileRows = map ? rows.map((r) => map[r]) : rows;
    // reference points spread over the rows: the reader's row order is checked against them
    const pick = Uint32Array.from({ length: Math.min(64, rows.length) }, (_, k) => Math.floor((k * rows.length) / Math.min(64, rows.length)));
    const xyz = await o.data.centresAt(pick.map((q) => rows[q]));
    const ref = (index: number, k: number) => ({ index, x: xyz[k * 3], y: xyz[k * 3 + 1], z: xyz[k * 3 + 2] });
    const layout = /\.ply$/i.test(o.source.name) ? await plyLayout(file) : null;
    if (layout) {
      const data = await plyRows(file, layout, fileRows, (f) => log(`Reading ${o.name}… ${Math.round(f * 100)}%`));
      return { data, filename: o.source.name, parts: [{ rows: null, matrix }], refs: Array.from(pick, (q, k) => ref(q, k)) };
    }
    const data = new Uint8Array(await file.arrayBuffer());
    return { data, filename: o.source.name, parts: [{ rows: fileRows, matrix }], refs: Array.from(pick, (q, k) => ref(fileRows[q], k)) };
  }

  // ── objects: add / replace / remove ──
  function frameStart() {
    const f = splat.startFrame; if (!f) return;
    nav.setStart(f.position.clone(), f.target.clone(), f.size);
  }
  function frameAll() { const b = splat.getBoundsWorld(); if (b) nav.frameBox(b); }
  function wireFrame(o: GsObject) {
    o.frame.setOnChange(() => { if (activeObj() === o) { panel.setState(o.frame.state); syncProxy(); } scheduleDims(); scheduleClip(); });
  }
  const M = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1000)}k`);
  /** Read a file, hand it to its worker, and draw it (thinned when big). */
  async function readScan(url: string, name: string, file?: File) {
    const upZ = /\.ply$/i.test(name) && await isZUp(url, file);
    const full = await splat.read(url, name);
    const data = new ScanData(full, true, lightMax);
    try { await data.init(); } catch (e) { data.dispose(); throw e; }
    // floaters out, normals and baked light in — on the whole scan, before any cut
    editor.setMessage(`Preparing ${name}: removing floaters, working out normals and the baked light…`, 0);
    let prep: Awaited<ReturnType<ScanData["prepare"]>> | null = null;
    try { prep = await data.prepare(true); } catch (e) { console.warn("relight preparation failed:", e); }
    data.setShowFlat(flatView);
    // a PLY without the mark: trust the surfaces — most of a site (ground, roofs) faces up, so when
    // nearly all flat surfaces face along Z, the file is Z up. Other formats have fixed axes, and a
    // single object (no ground) is left alone unless the evidence is overwhelming.
    const v = prep?.votes ?? [0, 0, 0];
    const detected = !upZ && /\.ply$/i.test(name) && v[2] > 3 * Math.max(v[0], v[1]);
    return { data, upZ: upZ || detected, detected, prep };
  }
  /** The floater cleanup as the scan's first history step (Ctrl+Z brings them back). */
  const recordCleanup = (o: GsObject, prep: Awaited<ReturnType<ScanData["prepare"]>> | null) => {
    const removed = prep?.removed;
    if (!removed?.length) return "";
    history.push({ label: `自動掃除 (${removed.length.toLocaleString()} 粒)`, undo: () => { void o.data.restore(removed).then(afterEdit); }, redo: () => { void o.data.hide(removed).then(afterEdit); } });
    const c = prep!.counts;
    return ` — removed ${removed.length.toLocaleString()} floaters (${c.far.toLocaleString()} far, ${c.faint.toLocaleString()} faint, ${c.isolated.toLocaleString()} isolated; Ctrl+Z brings them back)`;
  };
  /** Up axis of one scan's file (Info → Up axis): turn its mesh; the transform and origin stay. */
  function setUpAxis(o: GsObject, z: boolean) {
    if (!!o.source.upZ === z) return;
    o.source.upZ = z;
    o.mesh.quaternion.copy(orientOf(o.source)); o.mesh.updateMatrixWorld(true);
    scheduleClip(); scheduleDims(); updateInfo(); frameAll();
    editor.setMessage(z ? "Up axis: Z — the file is read as Z up" : "Up axis: Y down — the usual 3DGS axes");
  }
  /** Does this PLY say it was written Z-up for Blender (see SplatScene.UP_Z_MARK)? Reads the header only. */
  async function isZUp(url: string, file?: File): Promise<boolean> {
    try {
      let head = "";
      if (file) head = await file.slice(0, 1 << 16).text();
      else {
        const rd = (await fetch(url, { headers: { Range: "bytes=0-65535" } })).body?.getReader();
        const first = rd ? await rd.read() : null; await rd?.cancel();
        head = first?.value ? new TextDecoder("latin1").decode(first.value) : "";
      }
      const end = head.indexOf("end_header");
      return end > 0 && head.slice(0, end).includes(SplatScene.UP_Z_MARK);
    } catch { return false; }
  }
  const orientOf = (src: { upZ?: boolean }) => (src.upZ ? SplatScene.Z_UP : SplatScene.FILE_FLIP);
  const loadedNote = (name: string, d: ScanData, extra = "") => editor.setMessage(`Loaded ${name}${extra}`
    + (d.prepared ? " — colours flattened for relighting (hold Space for the captured look)" : "")
    + (d.light ? ` — ${M(d.n)} splats: drawing the ${M(d.drawnCount)} largest so the view stays smooth (Info → Display)` : ""), 20000);
  async function addObject(url: string, name: string, file?: File) {
    editor.setLoading(true);
    const frame = new SceneFrame(scene.scene);
    let data: ScanData | null = null;
    try {
      const read = await readScan(url, name, file);
      data = read.data;
      const upNote = read.detected ? " — up axis detected: Z up (Info → Up axis)" : "";
      const mesh = await splat.add(data.display, frame.root, orientOf(read));
      const o: GsObject = { id: nextId++, name, source: { url, file, name, upZ: read.upZ }, mesh, frame, data, visible: true };
      objects.push(o);
      wireFrame(o);
      if (objects.length === 1) { splat.computeStart(data.display, mesh); frameStart(); setOrtho(false); scene.setViewMode("persp"); }
      setActive({ kind: "object", obj: o });
      setTool("select");
      scheduleClip();
      loadedNote(name, data, recordCleanup(o, read.prep) + upNote);
    } catch (e) {
      data?.dispose();
      scene.scene.remove(frame.root);
      console.warn("GS load failed:", e);
      editor.setMessage(`Could not load ${name} (damaged, or not a supported format: .ply / .spz / .splat / .ksplat)`, 0);
    } finally {
      editor.setLoading(false);
      if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    }
  }
  async function replaceObject(o: GsObject, url: string, name: string, file?: File) {
    editor.setLoading(true);
    try {
      const { data, upZ, prep, detected } = await readScan(url, name, file);
      const mesh = await splat.add(data.display, o.frame.root, orientOf({ upZ }));
      splat.remove(o.mesh); o.data.dispose();
      o.mesh = mesh; o.data = data; o.name = name; o.source = { url, file, name, upZ };
      history.clear();
      setActive({ kind: "object", obj: o });
      scheduleClip();
      loadedNote(name, data, " — transform and origin kept" + recordCleanup(o, prep) + (detected ? " — up axis detected: Z up" : ""));
    } catch (e) {
      console.warn("GS load failed:", e);
      editor.setMessage(`Could not load ${name}`, 0);
    } finally { editor.setLoading(false); if (url.startsWith("blob:")) URL.revokeObjectURL(url); }
  }
  function removeObject(o: GsObject) {
    splat.remove(o.mesh);
    o.data.dispose();
    scene.scene.remove(o.frame.root);
    objects.splice(objects.indexOf(o), 1);
    history.clear();
    if (activeObj() === o) setActive(objects.length ? { kind: "object", obj: objects[objects.length - 1] } : null);
    else refreshOutliner();
    updateInfo(); scheduleDims();
  }
  /** Light ⇄ Full for one scan: rebuild the drawn copy (selection and deletions carry over). */
  async function setDisplay(o: GsObject, full: boolean) {
    if (o.data.light === !full || o.data.n <= lightMax) return;
    editor.setLoading(true);
    try {
      const old = o.data.display;
      const packed = await o.data.setLight(!full);
      const mesh = await splat.add(packed, o.frame.root, orientOf(o.source));
      splat.remove(o.mesh); o.data.release(old);
      o.mesh = mesh;
      editor.setMessage(full ? `Drawing all ${M(o.data.n)} splats — expect the view to be slow` : `Drawing the ${M(o.data.drawnCount)} largest of ${M(o.data.n)} splats so the view stays smooth`, 6000);
    } catch (e) {
      console.error(e); editor.setMessage(`Could not switch the display: ${e}`, 0);
    } finally { editor.setLoading(false); updateInfo(); }
  }

  // ── Separate (Blender's P): the selected splats become an object of their own ──
  const detachObject = (o: GsObject) => {
    const i = objects.indexOf(o); if (i >= 0) objects.splice(i, 1);
    scene.scene.remove(o.frame.root);
    const m = splat.meshes.indexOf(o.mesh); if (m >= 0) splat.meshes.splice(m, 1);
  };
  const attachObject = (o: GsObject) => { objects.push(o); scene.scene.add(o.frame.root); splat.meshes.push(o.mesh); };
  let partNo = 1;
  /**
   * Each shown scan with a selection gives its selected splats to a new object: same place,
   * a copy of the transform and origin, named <scan>_001… (rename: double-click or F2).
   * The new object re-reads just those rows of the source file on export.
   */
  async function separateSelection() {
    await settle();
    const srcs = shownObjects().filter((o) => o.data.selected > 0);
    if (!srcs.length) { editor.setMessage("Select splats first, then P to separate them into their own object"); return; }
    editor.setLoading(true);
    try {
      const made: { from: GsObject; to: GsObject; batch: Uint32Array }[] = [];
      for (const from of srcs) {
        const sel = await from.data.selectedIndices();
        const data = new ScanData(from.data.extract(sel), true, lightMax);
        try { await data.init(); } catch (e) { data.dispose(); throw e; }
        const rl = from.data.prepared ? await from.data.relightRows(sel) : null;   // computed on the whole scan, before this cut
        if (rl) await data.adoptRelight(rl.nrm, rl.baked);
        data.setShowFlat(flatView);
        const frame = new SceneFrame(scene.scene);
        frame.fromJSON(from.frame.toJSON());
        const mesh = await splat.add(data.display, frame.root, orientOf(from.source));
        const map = from.source.rowMap;
        const base = from.name.replace(/\.(ply|spz|splat|ksplat|sog)$/i, "").replace(/_\d{3}$/, "");
        const to: GsObject = { id: nextId++, name: `${base}_${String(partNo++).padStart(3, "0")}`, source: { ...from.source, rowMap: map ? sel.map((i) => map[i]) : sel }, mesh, frame, data, visible: true };
        objects.push(to);
        wireFrame(to);
        made.push({ from, to, batch: await from.data.hideSelected() });   // the splats now live in the new object
      }
      const last = made[made.length - 1].to;
      setActive({ kind: "object", obj: last });
      afterEdit(); scheduleClip();
      history.push({
        label: `分離 → ${made.map((m) => m.to.name).join(", ")}`,
        undo: () => {
          for (const m of made) { detachObject(m.to); void m.from.data.restore(m.batch).then(afterEdit); }
          if (made.some((m) => activeObj() === m.to)) setActive({ kind: "object", obj: made[0].from }); else refreshOutliner();
        },
        redo: () => { for (const m of made) { attachObject(m.to); void m.from.data.hide(m.batch).then(afterEdit); } setActive({ kind: "object", obj: last }); },
        // dropped while undone: the pieces are detached for good — free them
        discard: (applied) => { if (!applied) for (const m of made) { splat.remove(m.to.mesh); m.to.data.dispose(); } },
      });
      const n = made.reduce((a, m) => a + m.to.data.n, 0);
      editor.setMessage(`Separated ${n.toLocaleString()} splats into ${made.map((m) => m.to.name).join(", ")} — set its origin with O, rename with F2 or a double-click in the Outliner`, 10000);
    } catch (e) {
      console.error(e);
      editor.setMessage(`Could not separate: ${e}`, 0);
    } finally { editor.setLoading(false); }
  }

  setTool("select"); setActive(null);
  const wanted = import.meta.env.DEV ? new URLSearchParams(location.search).get("gs") : null;
  if (wanted) { for (const w of wanted.split(",")) { const startUrl = `/${w.replace(/^\/+/, "")}`; await addObject(startUrl, decodeURIComponent(startUrl.split("/").pop() || "scene")); } }
  else editor.setMessage("Drop GS files (.ply / .spz / .splat / .ksplat) anywhere, or use ファイルを選択 on the right", 0);

  scene.onUpdate((dt) => {
    nav.update(dt);
    scene.syncOrtho(nav.getTarget());
    (gizmo as any).camera = scene.activeCamera;
    const o = activeObj();
    if (o) scene.objOrigin.position.copy(o.frame.worldPivot());
    syncProxy();
    splat.prepare(scene.activeCamera);
    viewCube.update(cam);
    updateDimLabels();
  });
  scene.start();

  if (import.meta.env.DEV) {
    (window as any).__pl = { scene, splat, nav, editor, gizmo, cam, history, panel, volPanel, setTool, viewFrom, addObject, addVolume, objects, volumes, exportGS, THREE, bakeFiles, bakeFromSplats, FILE_FLIP_INV, setDisplay, settle, lightMax, separateSelection, bakeGroup, readSource,
      get tool() { return tool; }, get variant() { return variant; }, get active() { return active; }, get obj() { return activeObj(); } };
  }
  window.__gseditor_ready = true;
}

boot();
