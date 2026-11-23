// EntryFlow Survey Map – find a survey number in a village.
// Bhuvan does not allow searching by survey number, but it does tell which survey numbers lie in a small
// area. So the village is checked area by area (about 330 m apart), starting from its middle, and every
// piece with the wanted number inside the village is shown – the first one as soon as it is found.
"use strict";

const SR = {
  STEP: 0.003,          // degrees between look-ups (≈ 330 m) – checked to miss nothing
  WIN: 0.0005,          // size of each look-up window (Bhuvan returns every plot near it)
  PAR: 4,               // look-ups at the same time
  DISTRICTS: ["Thiruvananthapuram", "Kollam", "Pathanamthitta", "Alappuzha", "Kottayam", "Idukki", "Ernakulam",
    "Thrissur", "Palakkad", "Malappuram", "Kozhikode", "Wayanad", "Kannur", "Kasaragod"],
  run: 0, busy: false, found: [], vill: null, rec: null,
};
const srLayer = L.layerGroup().addTo(map);
const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
const normNo = (s) => String(s == null ? "" : s).trim().toUpperCase().replace(/\s+/g, "");

$("srDist").innerHTML = '<option value="">All Kerala</option>' + SR.DISTRICTS.map((d) => `<option>${d}</option>`).join("");
$("srDist").value = store.get("srDist", "");
$("srVillage").value = store.get("srVillage", "");

// ------------------------------------------------------------------ geometry helpers (lng, lat arrays)
function polysOf(g) { return !g ? [] : g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []; }
function inRing(p, r) {
  let ins = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
function inGeom(p, g) { return polysOf(g).some((poly) => inRing(p, poly[0]) && !poly.slice(1).some((h) => inRing(p, h))); }
function bboxOf(g) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  polysOf(g).forEach((poly) => poly[0].forEach(([x, y]) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }));
  return [x0, y0, x1, y1];
}
function insidePoint(g) {                  // a point surely inside the shape (the middle may be outside an L-shape)
  const [x0, y0, x1, y1] = bboxOf(g), c = [(x0 + x1) / 2, (y0 + y1) / 2];
  if (inGeom(c, g)) return c;
  let best = null, bd = 1e9;
  for (let i = 1; i < 12; i++) for (let j = 1; j < 12; j++) {
    const p = [x0 + (x1 - x0) * i / 12, y0 + (y1 - y0) * j / 12];
    const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2;
    if (d < bd && inGeom(p, g)) { best = p; bd = d; }
  }
  return best || polysOf(g)[0][0][0];
}

// ------------------------------------------------------------------ Bhuvan: every plot near a point
async function plotsNear(lng, lat, tries) {
  const s = SR.WIN / 2;
  const p = new URLSearchParams({ request: "GetFeatureInfo", service: "WMS", srs: "EPSG:4326", version: "1.1.1", format: "image/png",
    bbox: [lng - s, lat - s, lng + s, lat + s].join(","), width: 1, height: 1, x: 0, y: 0,
    layers: "v3:cadastral", query_layers: "v3:cadastral", info_format: "application/json", feature_count: 20000 });
  for (let t = 0; ; t++) {
    try {
      const r = await fetch(BHUVAN + "?" + p, { cache: "no-store" });
      if (!r.ok) throw new Error("Bhuvan " + r.status);
      return (await r.json()).features || [];
    } catch (e) { if (t >= (tries || 2)) throw e; await new Promise((ok) => setTimeout(ok, 800 * (t + 1))); }
  }
}

function editDist(a, b) {                   // spelling difference: Sasthamcotta / Sasthamkotta = 1
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[b.length];
}

// ------------------------------------------------------------------ which village
async function villageAt(ll) { const v = await info("v3:village", ll); return v && v.geometry ? v : null; }

/** Village name (+ district) -> Bhuvan villages with that name, found through the place search. */
async function findVillages(name, dist) {
  const q = name + (dist ? ", " + dist : "") + ", Kerala";
  const p = new URLSearchParams({ format: "jsonv2", q, countrycodes: "in", limit: 10, viewbox: "74.8,12.9,77.5,8.1", bounded: 1, "accept-language": "en" });
  const res = await (await fetch("https://nominatim.openstreetmap.org/search?" + p)).json();
  const want = normName(name), out = [], seen = new Set();
  for (const x of res) {
    const v = await villageAt(L.latLng(+x.lat, +x.lon)).catch(() => null);
    const key = v ? (v.properties.gid || [v.properties.vname, v.properties.bpname, v.properties.dtname].join("|")) : null;
    if (!v || seen.has(key)) continue;
    seen.add(key);
    const vn = normName(v.properties.vname);
    v.score = vn === want ? 3 : (vn.includes(want) || want.includes(vn) || editDist(vn, want) <= Math.max(1, Math.floor(want.length / 5))) ? 2 : 0;
    if (dist && normName(v.properties.dtname) !== normName(dist)) v.score -= 1;
    out.push(v);
  }
  return out.sort((a, b) => b.score - a.score);
}

// ------------------------------------------------------------------ the panel
function srHint(html) { $("srMsg").innerHTML = html || ""; }
$("srGo").onclick = async () => {
  const no = normNo($("srNo").value), name = $("srVillage").value.trim(), dist = $("srDist").value;
  store.set("srVillage", name); store.set("srDist", dist);
  if (!no) { srHint('<div class="warn">Type the survey number.</div>'); $("srNo").focus(); return; }
  const run = ++SR.run;
  if (!name) {                                       // the village in the middle of the map
    srHint('<span class="spin"></span> Finding the village on the map…');
    const v = await villageAt(map.getCenter()).catch(() => null);
    if (run !== SR.run) return;
    if (!v) { srHint('<div class="warn">No village at the middle of the map. Move the map to the village, or type the village name.</div>'); return; }
    return startScan(v, no);
  }
  srHint('<span class="spin"></span> Finding ' + esc(name) + '…');
  let vs;
  try { vs = await findVillages(name, dist); } catch (e) { vs = null; }
  if (run !== SR.run) return;
  if (!vs) { srHint('<div class="warn">Search is not available now. Check the internet.</div>'); return; }
  const good = vs.filter((v) => v.score >= 2);
  if (good.length === 1) return startScan(good[0], no);
  const list = good.length ? good : vs.slice(0, 5);
  if (!list.length) {
    srHint(`<div class="warn">Village "${esc(name)}" was not found. Check the spelling, or move the map to the village and leave the village box empty.</div>`);
    return;
  }
  srHint((good.length ? "More than one village has this name – choose:" : `No village named exactly "${esc(name)}". Did you mean:`) +
    '<div class="chips" style="margin-top:6px">' + list.map((v, i) =>
      `<button class="chip" data-v="${i}">${esc(v.properties.vname)} <span class="muted">· ${esc(v.properties.bpname || "")}, ${esc(v.properties.dtname || "")}</span></button>`).join("") + "</div>");
  $("srMsg").onclick = (e) => { const c = e.target.closest("[data-v]"); if (c) startScan(list[+c.dataset.v], no); };
};
$("srNo").addEventListener("keydown", (e) => { if (e.key === "Enter") $("srGo").click(); });
$("srVillage").addEventListener("keydown", (e) => { if (e.key === "Enter") $("srGo").click(); });
$("srHere").onclick = () => { $("srVillage").value = ""; store.set("srVillage", ""); srHint("The village in the middle of the map will be searched."); };

// ------------------------------------------------------------------ the scan
async function startScan(v, no) {
  const run = ++SR.run, vp = v.properties, vg = v.geometry;
  SR.busy = true; SR.found = []; SR.vill = vp; SR.no = no;
  SR.rec = typeof corrFor === "function" ? corrFor(vp) : null;
  srHint(""); closePanels(); hideSheet(); srLayer.clearLayers();
  const base = no.split(/[\/\-]/)[0];                // Bhuvan has whole survey numbers only (no 191/2)
  const part = base !== no;
  L.geoJSON(SR.rec && typeof corrGeom === "function" ? corrGeom(SR.rec, vg) : vg,
    { style: { color: "#1E88E5", weight: 2, dashArray: "6 5", fill: false }, interactive: false }).addTo(srLayer);

  // look-up points: a grid over the village, nearest to its middle first
  const [x0, y0, x1, y1] = bboxOf(vg), st = SR.STEP, pts = [];
  const verts = []; polysOf(vg).forEach((poly) => poly[0].forEach((p) => verts.push(p)));
  for (let x = x0 - st / 2; x <= x1 + st / 2; x += st) for (let y = y0 - st / 2; y <= y1 + st / 2; y += st) {
    const c = [x + st / 2, y + st / 2], h = st / 2;
    const near = inGeom(c, vg) || [[-h, -h], [h, -h], [-h, h], [h, h]].some(([a, b]) => inGeom([c[0] + a, c[1] + b], vg)) ||
      verts.some((p) => Math.abs(p[0] - c[0]) <= h && Math.abs(p[1] - c[1]) <= h);
    if (near) pts.push(c);
  }
  const mid = insidePoint(vg);
  pts.sort((a, b) => ((a[0] - mid[0]) ** 2 + (a[1] - mid[1]) ** 2) - ((b[0] - mid[0]) ** 2 + (b[1] - mid[1]) ** 2));
  const midLL = L.latLng(mid[1], mid[0]);
  map.fitBounds(L.geoJSON(vg).getBounds(), { padding: [30, 30] });

  const seen = new Set(), others = new Set();
  let done = 0, failed = 0, next = 0;
  srBar(run, pts.length, 0, part ? base : null);
  const worker = async () => {
    while (next < pts.length && run === SR.run) {
      const [lng, lat] = pts[next++];
      let fs;
      try { fs = await plotsNear(lng, lat); } catch (e) { failed++; fs = []; }
      if (run !== SR.run) return;
      for (const f of fs) {
        if (seen.has(f.id) || normNo(f.properties && f.properties.par_num) !== base) continue;
        seen.add(f.id);
        const ip = insidePoint(f.geometry);
        if (!inGeom(ip, vg)) { others.add(f.id); continue; }     // same number in a neighbouring village
        const piece = { id: f.id, geom: f.geometry, p: ip };
        SR.found.push(piece);
        drawPiece(piece, SR.found.length);
        refinePiece(piece, SR.found.length, run);
        if (SR.found.length === 1) openPiece(0);
      }
      done++;
      srBar(run, pts.length, done, part ? base : null);
    }
  };
  await Promise.all(Array.from({ length: SR.PAR }, worker));
  if (run !== SR.run) return;
  SR.busy = false;
  srDone(failed, others.size, part ? base : null);
}

function trueLL(p) {                                  // Bhuvan position -> position on the picture (village correction)
  const ll = L.latLng(p[1], p[0]);
  return SR.rec && typeof toTrue === "function" ? toTrue(SR.rec, ll) : ll;
}
/** The scan gets Bhuvan's simplified outline; the exact one comes from a look-up at the piece itself. */
async function refinePiece(piece, n, run) {
  const f = await info("v3:cadastral", L.latLng(piece.p[1], piece.p[0])).catch(() => null);
  if (run !== SR.run || !f || !f.geometry || normNo(f.properties.par_num) !== normNo(SR.no).split(/[\/\-]/)[0]) return;
  piece.geom = f.geometry; piece.p = insidePoint(f.geometry);
  if (piece.layer) srLayer.removeLayer(piece.layer);
  drawPiece(piece, n);
}
function drawPiece(piece, n) {
  const g = SR.rec && typeof corrGeom === "function" ? corrGeom(SR.rec, piece.geom) : piece.geom;
  const l = L.geoJSON(g, { style: { color: "#E65100", weight: 3, fillColor: "#FF9800", fillOpacity: .25 } });
  l.bindTooltip(esc(SR.no) + (n > 1 ? " (" + n + ")" : ""), { permanent: true, direction: "center", className: "vlabel" });
  l.on("click", (e) => { L.DomEvent.stop(e); openPiece(n - 1); });
  l.addTo(srLayer);
  piece.layer = l;
}
function openPiece(i) {
  const pc = SR.found[i]; if (!pc) return;
  const g = SR.rec && typeof corrGeom === "function" ? corrGeom(SR.rec, pc.geom) : pc.geom;
  map.fitBounds(L.geoJSON(g).getBounds(), { padding: [40, 40], maxZoom: 19 });
  const ll = trueLL(pc.p);
  if (tapMarker) tapMarker.setLatLng(ll); else tapMarker = L.circleMarker(ll, { radius: 6, color: "#fff", weight: 2, fillColor: "#C62828", fillOpacity: 1 }).addTo(map);
  showPlace(ll, "Found: survey No. " + SR.no + (SR.found.length > 1 ? " – piece " + (i + 1) + " of " + SR.found.length : "") + " · " + (SR.vill.vname || ""));
}

// ------------------------------------------------------------------ the bar at the top
function srBar(run, total, done, base) {
  const n = SR.found.length, pct = total ? Math.round(done * 100 / total) : 0;
  $("srBar").classList.add("show"); document.body.classList.add("searching");
  $("srBarText").innerHTML = `<b>${esc(SR.no)}</b> in ${esc(SR.vill.vname || "")}` +
    ` · ${n ? `<b style="color:#E65100">found ${n}</b>` : "searching"} <span class="muted">${pct}%</span>`;
  $("srProg").style.width = pct + "%";
  $("srPieces").innerHTML = "";
  $("srStop").textContent = "Stop";
}
function srDone(failed, others, base) {
  const n = SR.found.length, v = SR.vill.vname || "";
  $("srProg").style.width = "100%";
  let t = n ? `<b>${esc(SR.no)}</b> in ${esc(v)}: <b style="color:#E65100">${n} piece${n > 1 ? "s" : ""}</b>`
            : `<b>${esc(SR.no)}</b> not found in ${esc(v)}`;
  if (failed) t += ` <span class="muted">· ${failed} part${failed > 1 ? "s" : ""} not checked (internet)</span>`;
  $("srBarText").innerHTML = t;
  $("srPieces").innerHTML = (n > 1 ? SR.found.map((p, i) => `<button class="chip" data-p="${i}">${i + 1}</button>`).join("") : "") +
    (base ? `<div class="muted" style="width:100%">Bhuvan has whole survey numbers only – showing ${esc(base)}.</div>` : "") +
    (!n && others ? `<div class="muted" style="width:100%">${esc(SR.no)} is in a neighbouring village. Check the village name.</div>` : "") +
    (!n && !others ? `<div class="muted" style="width:100%">Bhuvan may not have this number here (resurvey numbers can differ).</div>` : "");
  $("srStop").textContent = "Close";
}
$("srPieces").onclick = (e) => { const c = e.target.closest("[data-p]"); if (c) openPiece(+c.dataset.p); };
$("srStop").onclick = () => {
  if (SR.busy) { SR.run++; SR.busy = false; srDone(0, 0, null); $("srBarText").insertAdjacentHTML("beforeend", ' <span class="muted">· stopped</span>'); return; }
  $("srBar").classList.remove("show"); document.body.classList.remove("searching"); srLayer.clearLayers();
};
