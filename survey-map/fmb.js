// EntryFlow Survey Map – FMB sketch overlay.
// The investigator loads a photo / scan / PDF of a Field Measurement (FMB) sketch, crops the survey
// number's drawing, and the sketch is laid over that survey number's Bhuvan outline. Matching 2–4
// corners (sketch corner → same corner on the outline) fits it closely. Everything stays on this
// phone (IndexedDB); nothing is uploaded anywhere.
"use strict";

// ------------------------------------------------------------------ small 3×3 matrix helpers (row-major)
const M3 = {
  mul(A, B) { const C = new Array(9); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]; return C; },
  app(H, p) { const w = H[6] * p[0] + H[7] * p[1] + H[8]; return [(H[0] * p[0] + H[1] * p[1] + H[2]) / w, (H[3] * p[0] + H[4] * p[1] + H[5]) / w]; },
  inv(m) {
    const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  },
  T(x, y) { return [1, 0, x, 0, 1, y, 0, 0, 1]; },
  S(s) { return [s, 0, 0, 0, s, 0, 0, 0, 1]; },
  R(t) { const c = Math.cos(t), s = Math.sin(t); return [c, -s, 0, s, c, 0, 0, 0, 1]; },
  FLIP: [1, 0, 0, 0, -1, 0, 0, 0, 1],               // image y goes down, north goes up
};
function solve(A, b) {                               // Gaussian elimination with pivoting
  const n = b.length, M = A.map((r, i) => r.concat([b[i]]));
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) throw new Error("points are in a line");
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
function lsq(rows, rhs) {                            // least squares via normal equations
  const n = rows[0].length, A = Array.from({ length: n }, () => new Array(n).fill(0)), b = new Array(n).fill(0);
  rows.forEach((r, k) => { for (let i = 0; i < n; i++) { b[i] += r[i] * rhs[k]; for (let j = 0; j < n; j++) A[i][j] += r[i] * r[j]; } });
  return solve(A, b);
}
function normT(pts) {                                // move to centroid, scale to ~1 (numerically stable fits)
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const d = pts.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / pts.length || 1;
  return M3.mul(M3.S(Math.SQRT2 / d), M3.T(-cx, -cy));
}
function fitSimilarity(src, dst) {                   // 2 pairs: move + turn + scale (sketch y flipped)
  const s = src.map((p) => [p[0], -p[1]]);
  const dsx = s[1][0] - s[0][0], dsy = s[1][1] - s[0][1], ddx = dst[1][0] - dst[0][0], ddy = dst[1][1] - dst[0][1], q = dsx * dsx + dsy * dsy;
  const ar = (ddx * dsx + ddy * dsy) / q, ai = (ddy * dsx - ddx * dsy) / q;
  const bx = dst[0][0] - (ar * s[0][0] - ai * s[0][1]), by = dst[0][1] - (ai * s[0][0] + ar * s[0][1]);
  return M3.mul([ar, -ai, bx, ai, ar, by, 0, 0, 1], M3.FLIP);
}
function fitAffine(src, dst) {                       // 3 pairs
  const Ts = normT(src), Td = normT(dst), s = src.map((p) => M3.app(Ts, p)), d = dst.map((p) => M3.app(Td, p));
  const rows = s.map((p) => [p[0], p[1], 1]);
  const x = lsq(rows, d.map((p) => p[0])), y = lsq(rows, d.map((p) => p[1]));
  return M3.mul(M3.inv(Td), M3.mul([x[0], x[1], x[2], y[0], y[1], y[2], 0, 0, 1], Ts));
}
function fitHomography(src, dst) {                   // 4 or more pairs (also corrects a photo taken at an angle)
  const Ts = normT(src), Td = normT(dst), s = src.map((p) => M3.app(Ts, p)), d = dst.map((p) => M3.app(Td, p));
  const rows = [], rhs = [];
  s.forEach((p, i) => {
    const [u, v] = p, [x, y] = d[i];
    rows.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); rhs.push(x);
    rows.push([0, 0, 0, u, v, 1, -u * y, -v * y]); rhs.push(y);
  });
  const h = s.length === 4 ? solve(rows, rhs) : lsq(rows, rhs);
  return M3.mul(M3.inv(Td), M3.mul(h.concat([1]), Ts));
}
function rectToQuad(w, h, q) {                       // exact homography: image rectangle → 4 screen points
  const src = [[0, 0], [w, 0], [w, h], [0, h]], rows = [], rhs = [];
  src.forEach((p, i) => {
    const [u, v] = p, [x, y] = q[i];
    rows.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); rhs.push(x);
    rows.push([0, 0, 0, u, v, 1, -u * y, -v * y]); rhs.push(y);
  });
  return solve(rows, rhs).concat([1]);
}

// ------------------------------------------------------------------ storage (IndexedDB – room for many sketches)
const DB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((ok, bad) => {
      const r = indexedDB.open("efmap", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("sketches", { keyPath: "key" });
      r.onsuccess = () => { this.db = r.result; ok(this.db); };
      r.onerror = () => bad(r.error);
    });
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((ok, bad) => {
      const t = db.transaction("sketches", mode), st = t.objectStore("sketches"), req = fn(st);
      t.oncomplete = () => ok(req && req.result); t.onerror = () => bad(t.error);
    });
  },
  put(rec) { return this.tx("readwrite", (s) => s.put(rec)); },
  del(key) { return this.tx("readwrite", (s) => s.delete(key)); },
  all() { return this.tx("readonly", (s) => s.getAll()); },
};

// ------------------------------------------------------------------ local metres around the survey number
function geo(rec) {
  const kx = 111320 * Math.cos(rec.origin.lat * Math.PI / 180), ky = 110540;
  return {
    toLL: (p) => L.latLng(rec.origin.lat + p[1] / ky, rec.origin.lng + p[0] / kx),
    toM: (ll) => [(ll.lng - rec.origin.lng) * kx, (ll.lat - rec.origin.lat) * ky],
  };
}
function outlineM(rec) {                             // outline vertices in metres
  const g = geo(rec), polys = rec.geom.type === "Polygon" ? [rec.geom.coordinates] : rec.geom.coordinates, out = [];
  polys.forEach((p) => p.forEach((ring) => ring.forEach((c) => out.push(g.toM(L.latLng(c[1], c[0]))))));
  return out;
}
function bbox(pts) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0 || 1, h: y1 - y0 || 1 };
}
function placeInitial(rec) {                         // lay the drawn lines over the outline, turned by rec.theta
  const o = bbox(outlineM(rec)), t = rec.theta * Math.PI / 180;
  const turn = M3.mul(M3.R(-t), M3.mul(M3.FLIP, M3.T(-rec.w / 2, -rec.h / 2)));
  const ink = [];                                    // the sketch's line pixels (or its corners when there are none)
  if (rec.ink && rec.ink.length) for (let i = 0; i < rec.ink.length; i += 2) ink.push(M3.app(turn, [rec.ink[i], rec.ink[i + 1]]));
  else [[0, 0], [rec.w, 0], [rec.w, rec.h], [0, rec.h]].forEach((p) => ink.push(M3.app(turn, p)));
  const b = bbox(ink), k = Math.sqrt((o.w / b.w) * (o.h / b.h)) || 1;
  return M3.mul(M3.T(o.cx, o.cy), M3.mul(M3.S(k), M3.mul(M3.T(-b.cx, -b.cy), turn)));
}
function refit(rec) {                                // rec.H from the matched corner pairs
  const n = rec.pairs.length, base = placeInitial(rec);
  if (!n) return (rec.H = base);
  const src = rec.pairs.map((p) => p.s), dst = rec.pairs.map((p) => p.d);
  if (n === 1) { const q = M3.app(base, src[0]); return (rec.H = M3.mul(M3.T(dst[0][0] - q[0], dst[0][1] - q[1]), base)); }
  if (n === 2) return (rec.H = fitSimilarity(src, dst));
  if (n === 3) return (rec.H = fitAffine(src, dst));
  return (rec.H = fitHomography(src, dst));
}

// ------------------------------------------------------------------ the sketch on the map
map.createPane("sketch"); map.getPane("sketch").style.zIndex = 425; map.getPane("sketch").style.pointerEvents = "none";
map.createPane("hl"); map.getPane("hl").style.zIndex = 445;
const SketchLayer = L.Layer.extend({
  initialize(rec) { this.rec = rec; },
  onAdd(m) {
    const img = (this.img = L.DomUtil.create("img", "leaflet-zoom-hide", m.getPane("sketch")));
    Object.assign(img.style, { position: "absolute", left: "0", top: "0", transformOrigin: "0 0", pointerEvents: "none", maxWidth: "none" });
    img.width = this.rec.w; img.height = this.rec.h;
    img.src = this.rec.url;
    m.on("zoomend viewreset", this.update, this);
    this.update();
  },
  onRemove(m) { L.DomUtil.remove(this.img); m.off("zoomend viewreset", this.update, this); },
  update() {
    const r = this.rec, g = geo(r);
    const q = [[0, 0], [r.w, 0], [r.w, r.h], [0, r.h]].map((p) => { const lp = map.latLngToLayerPoint(g.toLL(M3.app(r.H, p))); return [lp.x, lp.y]; });
    const H = rectToQuad(r.w, r.h, q);
    this.img.style.transform = `matrix3d(${H[0]},${H[3]},0,${H[6]},${H[1]},${H[4]},0,${H[7]},0,0,1,0,${H[2]},${H[5]},0,${H[8]})`;
    this.img.style.opacity = r.opacity;
  },
});
const sketchGroup = L.layerGroup().addTo(map);
const sketches = {};                                 // key → { rec, layer }
function showSketch(rec) {
  if (sketches[rec.key]) sketchGroup.removeLayer(sketches[rec.key].layer);
  if (!rec.url) rec.url = URL.createObjectURL(rec.blob);
  const layer = new SketchLayer(rec);
  sketchGroup.addLayer(layer);
  sketches[rec.key] = { rec, layer };
}
async function loadSketches() {
  try { (await DB.all()).forEach(showSketch); } catch (e) { }
  listSketches();
}

// ------------------------------------------------------------------ 1. choose the file (photo, scan or PDF)
let skCtx = null;                                    // { key, sy, village, geom, centre } of the survey number being worked on
function sketchKey(sy, village) { return sy + "|" + village; }
function startSketch(r, ll) {
  const sy = r.plot.properties.par_num, village = (r.vill && r.vill.vname) || "";
  const key = sketchKey(sy, village);
  if (sketches[key]) { editSketch(sketches[key].rec); return; }
  skCtx = { key, sy, village, geom: r.plot.geometry, ll };
  $("skFile").click();
}
$("skFile").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  toast("Opening " + f.name + "…", 4000);
  try {
    const canvas = /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name) ? await pdfToCanvas(f) : await imageToCanvas(f);
    if (canvas) openCrop(canvas);
  } catch (err) { toast("Could not open this file: " + err.message, 5000); }
};
async function imageToCanvas(f) {
  const url = URL.createObjectURL(f);
  try {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error("not a picture")); i.src = url; });
    return scaledCanvas(img, img.naturalWidth, img.naturalHeight, 2400);
  } finally { URL.revokeObjectURL(url); }
}
function scaledCanvas(src, w, h, max) {
  const k = Math.min(1, max / Math.max(w, h)), c = document.createElement("canvas");
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
function loadScript(src) {
  return new Promise((ok, bad) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => bad(new Error("PDF reader could not load – check internet")); document.head.appendChild(s); });
}
async function pdfToCanvas(f) {
  const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
  if (!window.pdfjsLib) { await loadScript(PDFJS + "pdf.min.js"); pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.js"; }
  const pdf = await pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise;
  let n = 1;
  if (pdf.numPages > 1) {
    const a = prompt("This PDF has " + pdf.numPages + " pages. Which page has the sketch?", "1");
    if (a === null) return null;
    n = Math.min(pdf.numPages, Math.max(1, parseInt(a, 10) || 1));
  }
  const page = await pdf.getPage(n), v1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: Math.min(4, 2400 / Math.max(v1.width, v1.height)) });
  const c = document.createElement("canvas"); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: g, viewport: vp }).promise;
  return c;
}

// ------------------------------------------------------------------ 2. crop, turn, clean the background
const crop = { src: null, rect: null, k: 1, ox: 0, oy: 0, thr: 200, clear: true, colour: "red", drag: null };
const COLOURS = { original: null, red: [229, 57, 53], yellow: [255, 235, 59], white: [255, 255, 255], blue: [30, 136, 229] };
function openCrop(canvas) {
  crop.src = canvas; crop.rect = [0, 0, canvas.width, canvas.height];
  $("cropTitle").textContent = "FMB sketch – Survey No. " + skCtx.sy + (skCtx.village ? ", " + skCtx.village : "");
  $("crop").classList.add("show");
  requestAnimationFrame(drawCrop);
}
function rotateCrop(dir) {
  const s = crop.src, c = document.createElement("canvas"); c.width = s.height; c.height = s.width;
  const g = c.getContext("2d"); g.translate(c.width / 2, c.height / 2); g.rotate(dir * Math.PI / 2); g.drawImage(s, -s.width / 2, -s.height / 2);
  crop.src = c; crop.rect = [0, 0, c.width, c.height]; drawCrop();
}
function clean(data) {                               // white → transparent, lines → chosen colour
  const d = data.data, col = COLOURS[crop.colour];
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (crop.clear && lum > crop.thr) { d[i + 3] = 0; continue; }
    if (col) { d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = 255; }
  }
  return data;
}
function drawCrop() {
  const cv = $("cropCanvas"), box = cv.parentElement, W = box.clientWidth, Hh = box.clientHeight, s = crop.src;
  cv.width = W; cv.height = Hh;
  const k = (crop.k = Math.min(W / s.width, Hh / s.height)), ox = (crop.ox = (W - s.width * k) / 2), oy = (crop.oy = (Hh - s.height * k) / 2);
  const g = cv.getContext("2d");
  // preview with the cleaning applied, over a grey chequer so the transparent parts show
  for (let y = 0; y < Hh; y += 16) for (let x = 0; x < W; x += 16) { g.fillStyle = ((x + y) / 16) % 2 ? "#cfd8c8" : "#e8efe2"; g.fillRect(x, y, 16, 16); }
  const t = document.createElement("canvas"); t.width = Math.max(1, Math.round(s.width * k)); t.height = Math.max(1, Math.round(s.height * k));
  const tg = t.getContext("2d"); tg.drawImage(s, 0, 0, t.width, t.height);
  tg.putImageData(clean(tg.getImageData(0, 0, t.width, t.height)), 0, 0);
  g.drawImage(t, ox, oy);
  const [x, y, w, h] = crop.rect;
  g.fillStyle = "rgba(0,0,0,.45)";
  g.fillRect(ox, oy, s.width * k, y * k); g.fillRect(ox, oy + (y + h) * k, s.width * k, (s.height - y - h) * k);
  g.fillRect(ox, oy + y * k, x * k, h * k); g.fillRect(ox + (x + w) * k, oy + y * k, (s.width - x - w) * k, h * k);
  g.strokeStyle = "#FBC02D"; g.lineWidth = 3; g.setLineDash([8, 6]); g.strokeRect(ox + x * k, oy + y * k, w * k, h * k); g.setLineDash([]);
}
function cropPt(e) {
  const b = $("cropCanvas").getBoundingClientRect(), s = crop.src;
  return [Math.max(0, Math.min(s.width, (e.clientX - b.left - crop.ox) / crop.k)), Math.max(0, Math.min(s.height, (e.clientY - b.top - crop.oy) / crop.k))];
}
$("cropCanvas").addEventListener("pointerdown", (e) => { e.preventDefault(); $("cropCanvas").setPointerCapture(e.pointerId); crop.drag = cropPt(e); });
$("cropCanvas").addEventListener("pointermove", (e) => {
  if (!crop.drag) return;
  const p = cropPt(e), a = crop.drag;
  if (Math.abs(p[0] - a[0]) * crop.k < 8 && Math.abs(p[1] - a[1]) * crop.k < 8) return;
  crop.rect = [Math.min(a[0], p[0]), Math.min(a[1], p[1]), Math.abs(p[0] - a[0]), Math.abs(p[1] - a[1])];
  drawCrop();
});
$("cropCanvas").addEventListener("pointerup", () => { crop.drag = null; });
$("cropRotL").onclick = () => rotateCrop(-1);
$("cropRotR").onclick = () => rotateCrop(1);
$("cropAll").onclick = () => { crop.rect = [0, 0, crop.src.width, crop.src.height]; drawCrop(); };
$("cropClear").onchange = (e) => { crop.clear = e.target.checked; drawCrop(); };
$("cropThr").oninput = (e) => { crop.thr = +e.target.value; drawCrop(); };
$("cropCol").onclick = (e) => {
  const c = e.target.closest("[data-c]"); if (!c) return;
  crop.colour = c.dataset.c; document.querySelectorAll("#cropCol .chip").forEach((x) => x.classList.toggle("on", x === c)); drawCrop();
};
$("cropCancel").onclick = () => { $("crop").classList.remove("show"); crop.src = null; };
window.addEventListener("resize", () => { if ($("crop").classList.contains("show")) drawCrop(); });

$("cropOk").onclick = async () => {
  let [x, y, w, h] = crop.rect.map(Math.round);
  if (w < 20 || h < 20) { toast("Drag a box around the survey number's drawing first"); return; }
  const k = Math.min(1, 1600 / Math.max(w, h)), c = document.createElement("canvas");
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  const g = c.getContext("2d"); g.drawImage(crop.src, x, y, w, h, 0, 0, c.width, c.height);
  g.putImageData(clean(g.getImageData(0, 0, c.width, c.height)), 0, 0);
  const blob = await new Promise((ok) => c.toBlob(ok, "image/png"));
  const px = g.getImageData(0, 0, c.width, c.height).data, ink = [];  // sample of line pixels, for the first placing
  let total = 0; for (let i = 3; i < px.length; i += 4) if (px[i] > 0) total++;
  const step = Math.max(1, Math.ceil(total / 3000));
  for (let i = 3, n = 0; i < px.length; i += 4) if (px[i] > 0 && n++ % step === 0) { const q = (i - 3) / 4; ink.push(q % c.width, Math.floor(q / c.width)); }
  $("crop").classList.remove("show"); crop.src = null;
  const c0 = L.geoJSON(skCtx.geom).getBounds().getCenter();
  const rec = { key: skCtx.key, sy: skCtx.sy, village: skCtx.village, geom: skCtx.geom, origin: { lat: c0.lat, lng: c0.lng },
    w: c.width, h: c.height, theta: 0, pairs: [], opacity: 0.85, blob, ink, t: Date.now() };
  refit(rec);
  showSketch(rec);
  editSketch(rec, true);
};

// ------------------------------------------------------------------ 3. adjust: turn, match corners, opacity
const sk = { rec: null, matching: false, pending: null, marks: L.layerGroup(), outline: null, isNew: false };
function editSketch(rec, isNew) {
  closePanels(); hideSheet();
  sk.rec = rec; sk.isNew = !!isNew; sk.matching = false; sk.pending = null;
  if (sk.outline) map.removeLayer(sk.outline);
  sk.outline = L.geoJSON(rec.geom, { pane: "hl", style: { color: "#FBC02D", weight: 3, fill: false, dashArray: "1 0" }, interactive: false }).addTo(map);
  sk.marks.addTo(map);
  map.fitBounds(sk.outline.getBounds(), { padding: [40, 40], maxZoom: 20 });
  $("skTitle").textContent = "FMB sketch · Survey No. " + rec.sy;
  $("skOpacity").value = Math.round(rec.opacity * 100);
  $("skTurn").value = rec.theta;
  $("skBar").classList.add("show");
  drawMarks(); skStatus();
}
function skStatus() {
  const r = sk.rec, n = r.pairs.length;
  $("skTurnRow").style.display = n >= 2 ? "none" : "";
  $("skMatch").textContent = sk.matching ? "Stop matching" : n ? "Match more corners" : "Match corners";
  $("skMatch").classList.toggle("on", sk.matching);
  $("skUndo").disabled = !n;
  let t;
  if (sk.matching) t = sk.pending ? "<b>2.</b> Now tap the <b>same corner on the yellow outline</b>." : "<b>1.</b> Tap a clear <b>corner on the sketch</b> (red lines).";
  else if (!n) t = "Turn the sketch so north matches (use its north arrow), then <b>Match corners</b> for a close fit.";
  else t = n + " corner" + (n > 1 ? "s" : "") + " matched" + (n === 1 ? " – sketch moved. Match one more to turn and size it." :
    n === 2 ? " – moved, turned and sized. A 3rd and 4th corner fit it even better." : n === 3 ? " – a 4th corner also corrects a photo taken at an angle." : ".");
  $("skHint").innerHTML = t;
}
function drawMarks() {
  sk.marks.clearLayers();
  const r = sk.rec, g = geo(r);
  r.pairs.forEach((p, i) => {
    const a = g.toLL(M3.app(r.H, p.s)), b = g.toLL(p.d);
    L.polyline([a, b], { color: "#fff", weight: 2, dashArray: "4 4", interactive: false }).addTo(sk.marks);
    L.circleMarker(b, { radius: 7, color: "#fff", weight: 2, fillColor: "#2E7D32", fillOpacity: 1, interactive: false, pane: "hl" })
      .bindTooltip(String(i + 1), { permanent: true, direction: "right", className: "vlabel" }).addTo(sk.marks);
  });
  if (sk.pending) L.circleMarker(g.toLL(M3.app(r.H, sk.pending)), { radius: 7, color: "#fff", weight: 2, fillColor: "#C62828", fillOpacity: 1, interactive: false, pane: "hl" }).addTo(sk.marks);
}
function nearestCorner(ll) {                         // snap to a corner of the Bhuvan outline (within 24 px)
  const p = map.latLngToContainerPoint(ll), polys = sk.rec.geom.type === "Polygon" ? [sk.rec.geom.coordinates] : sk.rec.geom.coordinates;
  let best = null, bd = 24;
  polys.forEach((poly) => poly.forEach((ring) => ring.forEach((c) => {
    const q = map.latLngToContainerPoint([c[1], c[0]]), d = q.distanceTo(p);
    if (d < bd) { bd = d; best = L.latLng(c[1], c[0]); }
  })));
  return best || ll;
}
function onSketchTap(e) {                            // called by the map's click handler while a sketch is being adjusted
  if (!sk.matching) return;
  const r = sk.rec, g = geo(r);
  if (!sk.pending) {
    const u = M3.app(M3.inv(r.H), g.toM(e.latlng));
    if (u[0] < -r.w * 0.05 || u[1] < -r.h * 0.05 || u[0] > r.w * 1.05 || u[1] > r.h * 1.05) { toast("Tap on the sketch itself (the red lines)"); return; }
    sk.pending = u;
  } else {
    const t = nearestCorner(e.latlng);
    r.pairs.push({ s: sk.pending, d: g.toM(t) });
    sk.pending = null;
    try { refit(r); } catch (err) { r.pairs.pop(); refit(r); toast("Those corners are in a straight line – choose corners spread around the plot", 4000); }
    sketches[r.key].layer.update();
  }
  drawMarks(); skStatus();
}
$("skMatch").onclick = () => { sk.matching = !sk.matching; sk.pending = null; drawMarks(); skStatus(); };
$("skUndo").onclick = () => { sk.rec.pairs.pop(); sk.pending = null; refit(sk.rec); sketches[sk.rec.key].layer.update(); drawMarks(); skStatus(); };
$("skReset").onclick = () => { sk.rec.pairs = []; sk.rec.theta = 0; $("skTurn").value = 0; sk.pending = null; refit(sk.rec); sketches[sk.rec.key].layer.update(); drawMarks(); skStatus(); };
$("skTurn").oninput = (e) => { sk.rec.theta = +e.target.value; refit(sk.rec); sketches[sk.rec.key].layer.update(); drawMarks(); };
$("skOpacity").oninput = (e) => { sk.rec.opacity = e.target.value / 100; sketches[sk.rec.key].layer.update(); };
function closeSketchBar() {
  $("skBar").classList.remove("show");
  sk.marks.clearLayers(); map.removeLayer(sk.marks);
  if (sk.outline) { map.removeLayer(sk.outline); sk.outline = null; }
  sk.rec = null; sk.matching = false; sk.pending = null;
}
$("skSave").onclick = async () => {
  const r = sk.rec, copy = Object.assign({}, r); delete copy.url;
  try { await DB.put(copy); toast("Sketch saved on this phone"); } catch (e) { toast("Could not save – browser storage is blocked or full", 4000); return; }
  closeSketchBar(); listSketches();
};
$("skClose").onclick = async () => {                 // close without saving: go back to the saved version (or drop a new one)
  const r = sk.rec;
  closeSketchBar();
  if (sk.isNew) { sketchGroup.removeLayer(sketches[r.key].layer); delete sketches[r.key]; return; }
  try { const saved = (await DB.all()).find((x) => x.key === r.key); if (saved) { saved.url = r.url; showSketch(saved); } } catch (e) { }
};
$("skDelete").onclick = async () => {
  const r = sk.rec;
  if (!confirm("Remove the FMB sketch of survey No. " + r.sy + " from this phone?")) return;
  closeSketchBar();
  sketchGroup.removeLayer(sketches[r.key].layer); delete sketches[r.key];
  try { await DB.del(r.key); } catch (e) { }
  listSketches(); toast("Sketch removed");
};
$("skReplace").onclick = () => {
  const r = sk.rec;
  skCtx = { key: r.key, sy: r.sy, village: r.village, geom: r.geom };
  closeSketchBar();
  sketchGroup.removeLayer(sketches[r.key].layer); delete sketches[r.key];
  $("skFile").click();
};

// ------------------------------------------------------------------ 4. list, backup and restore
function listSketches() {
  const box = $("sketchList"); if (!box) return;
  const recs = Object.values(sketches).map((x) => x.rec).sort((a, b) => b.t - a.t);
  box.innerHTML = (recs.length ? recs.map((r) => `<div class="plot"><div class="t" data-sk="${esc(r.key)}"><b>📄 ${esc(r.sy)}</b> · ${esc(r.village)}<br>
      <span class="muted">${r.pairs.length} corner${r.pairs.length === 1 ? "" : "s"} matched</span></div>
      <button class="btn light" data-ska="${esc(r.key)}">Adjust</button></div>`).join("")
    : '<div class="muted">No FMB sketches yet. Tap a survey number on the map, then 📄 FMB sketch.</div>') +
    `<div class="row"><button class="btn light" id="skBackup" ${recs.length ? "" : "disabled"}>⬇ Backup sketches</button><button class="btn light" id="skRestore">⬆ Restore backup</button></div>`;
}
$("pPlots").addEventListener("click", async (e) => {
  const a = e.target.closest("[data-ska]") || e.target.closest("[data-sk]");
  if (a) { const k = a.dataset.ska || a.dataset.sk; if (sketches[k]) editSketch(sketches[k].rec); return; }
  if (e.target.id === "skBackup") backupSketches();
  if (e.target.id === "skRestore") $("skRestoreFile").click();
});
function blobToDataUrl(b) { return new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(b); }); }
async function backupSketches() {
  const recs = await DB.all(), out = [];
  for (const r of recs) { const c = Object.assign({}, r); c.png = await blobToDataUrl(r.blob); delete c.blob; delete c.url; out.push(c); }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ app: "EntryFlow Survey Map", version: 1, sketches: out })], { type: "application/json" }));
  a.download = "EntryFlow FMB sketches.json"; a.click();
}
$("skRestoreFile").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const j = JSON.parse(await f.text()); let n = 0;
    for (const s of j.sketches || []) {
      s.blob = await (await fetch(s.png)).blob(); delete s.png;
      await DB.put(s); showSketch(s); n++;
    }
    listSketches(); toast("Restored " + n + " sketch" + (n === 1 ? "" : "es"));
  } catch (err) { toast("This is not an EntryFlow sketches backup", 4000); }
};
$("lSketch").onchange = (e) => e.target.checked ? sketchGroup.addTo(map) : map.removeLayer(sketchGroup);

loadSketches();
