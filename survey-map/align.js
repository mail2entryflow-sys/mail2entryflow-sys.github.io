// EntryFlow Survey Map – village corrections for Bhuvan's survey lines, and older satellite pictures.
// Bhuvan's survey lines come from old village sheets fitted by hand, so a whole village is often shifted,
// slightly turned or stretched. Matching 2–3 corners (survey-line corner → the real corner on the satellite
// picture) gives a correction for that village. It moves the drawn lines AND is used for every look-up
// (tap, "You are here", saved plots, FMB sketches), so the survey number shown matches the corrected lines.
// Corrections are kept on this phone, can be shared as a file, and the ones published on the EntryFlow site
// (corrections.json next to this page) are loaded for every investigator.
"use strict";

// ------------------------------------------------------------------ C. older satellite pictures (Esri Wayback)
const WAYBACK = [["2024-10", 56450], ["2023-10", 1034], ["2022-06", 44710], ["2022-02", 26083], ["2021-09", 51313]];
WAYBACK.forEach(([label, id]) => {
  bases["wb" + id] = L.layerGroup([
    L.tileLayer("https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/" + id + "/{z}/{y}/{x}",
      { maxNativeZoom: 19, maxZoom: 21, attribution: "Imagery © Esri (Wayback " + label + ")" }),
    esriRef("World_Transportation"),
  ]);
});
$("wbList").innerHTML = WAYBACK.map(([label, id]) => `<label><input type="radio" name="base" value="wb${id}"> Satellite, Esri ${label} release</label>`).join("");
document.querySelectorAll("#wbList input[name=base]").forEach((r) => {
  r.checked = bases[r.value] === base;
  r.onchange = () => { map.removeLayer(base); base = bases[r.value]; base.addTo(map); store.set("base", r.value); };
});
{ const b = store.get("base", "sat"); if (/^wb/.test(b) && bases[b] && base !== bases[b]) { map.removeLayer(base); base = bases[b]; base.addTo(map); const r = document.querySelector(`input[name=base][value="${b}"]`); if (r) r.checked = true; } }

// ------------------------------------------------------------------ correction maths (Bhuvan metres → true metres, per village)
function cGeo(rec) {
  const kx = 111320 * Math.cos(rec.origin.lat * Math.PI / 180), ky = 110540;
  return { toLL: (p) => L.latLng(rec.origin.lat + p[1] / ky, rec.origin.lng + p[0] / kx), toM: (ll) => [(ll.lng - rec.origin.lng) * kx, (ll.lat - rec.origin.lat) * ky] };
}
function simFit(src, dst) {                          // 2 pairs: move + turn + scale
  const dsx = src[1][0] - src[0][0], dsy = src[1][1] - src[0][1], ddx = dst[1][0] - dst[0][0], ddy = dst[1][1] - dst[0][1], q = dsx * dsx + dsy * dsy;
  const ar = (ddx * dsx + ddy * dsy) / q, ai = (ddy * dsx - ddx * dsy) / q;
  return [ar, -ai, dst[0][0] - (ar * src[0][0] - ai * src[0][1]), ai, ar, dst[0][1] - (ai * src[0][0] + ar * src[0][1]), 0, 0, 1];
}
function corrFit(rec) {
  const s = rec.pairs.map((p) => p.s), d = rec.pairs.map((p) => p.d), n = s.length;
  if (!n) rec.H = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  else if (n === 1) rec.H = M3.T(d[0][0] - s[0][0], d[0][1] - s[0][1]);
  else if (n === 2) rec.H = simFit(s, d);
  else rec.H = fitAffine(s, d);                     // 3 or more: also corrects stretching
  return rec.H;
}
const toTrue = (rec, ll) => { const g = cGeo(rec); return g.toLL(M3.app(rec.H, g.toM(ll))); };
const toBhuvan = (rec, ll) => { const g = cGeo(rec); return g.toLL(M3.app(M3.inv(rec.H), g.toM(ll))); };
function corrGeom(rec, geom) {
  const f = (c) => { const t = toTrue(rec, L.latLng(c[1], c[0])); return [t.lng, t.lat]; };
  if (geom.type === "Polygon") return { type: "Polygon", coordinates: geom.coordinates.map((r) => r.map(f)) };
  if (geom.type === "MultiPolygon") return { type: "MultiPolygon", coordinates: geom.coordinates.map((p) => p.map((r) => r.map(f))) };
  return geom;
}
function shiftText(rec) {                            // how far the village was moved, at its middle
  const t = M3.app(rec.H, [0, 0]); return Math.round(Math.hypot(t[0], t[1])) + " m";
}

// ------------------------------------------------------------------ the corrections we know (this phone + EntryFlow site)
const corr = { local: store.get("corr", {}), shared: {}, use: store.get("useCorr", true), active: null };
const vKey = (v) => (v.vname || "") + "|" + (v.dtname || "");
function corrFor(v) { if (!v || !corr.use) return null; const k = vKey(v); return corr.local[k] || corr.shared[k] || null; }
fetch("corrections.json?" + Date.now()).then((r) => r.ok ? r.json() : null).then((j) => {
  ((j && j.corrections) || []).forEach((c) => { c.by = "EntryFlow"; corr.shared[c.key] = c; });
  listCorr(); checkActive();
}).catch(() => { });

// every look-up goes through the village's correction (tap, You are here, saved plots, FMB sketches)
lookup = async function (ll) {
  const [c0, v] = await Promise.all([info("v3:cadastral", ll).catch(() => undefined), info("v3:village", ll).catch(() => undefined)]);
  if (c0 === undefined && v === undefined) throw new Error("offline");
  const rec = corrFor(v && v.properties);
  let plot = c0 || null;
  if (rec) {
    const c = await info("v3:cadastral", toBhuvan(rec, ll)).catch(() => undefined);
    plot = c ? Object.assign({}, c, { geometry: corrGeom(rec, c.geometry) }) : null;
  }
  return { plot, vill: v ? v.properties : null, corrected: rec ? (rec.by === "EntryFlow" ? "EntryFlow correction" : "your correction") : "" };
};

// ------------------------------------------------------------------ drawing the corrected lines (moves the survey + village layers)
function applyPanes() {
  const rec = al.rec || corr.active, panes = [map.getPane("survey"), map.getPane("village")];
  if (!rec || !corr.use && !al.rec) { panes.forEach((p) => p.style.transform = ""); $("corrNote").style.display = "none"; return; }
  const c = map.latLngToLayerPoint(map.getCenter());  // three points around the view (works whatever the window size)
  const s = [c, c.add([300, 0]), c.add([0, 300])], d = s.map((p) => map.latLngToLayerPoint(toTrue(rec, map.layerPointToLatLng(p))));
  // affine from 3 points: x' = a x + c y + e, y' = b x + d y + f
  const A = [[s[0].x, s[0].y, 1], [s[1].x, s[1].y, 1], [s[2].x, s[2].y, 1]];
  const X = solve(A, d.map((p) => p.x)), Y = solve(A, d.map((p) => p.y));
  panes.forEach((p) => { p.style.transformOrigin = "0 0"; p.style.transform = `matrix(${X[0]},${Y[0]},${X[1]},${Y[1]},${X[2]},${Y[2]})`; });
  $("corrNote").style.display = al.rec ? "none" : "block";
  $("corrNote").innerHTML = "📐 Survey lines corrected for <b>" + esc(rec.vname) + "</b>";
}
map.on("zoomend viewreset resize", applyPanes);
let activeTimer = null;
function checkActive() {                             // which village's correction applies to what is on screen
  clearTimeout(activeTimer);
  activeTimer = setTimeout(async () => {
    if (al.rec) return applyPanes();
    let v = null;
    try { const f = await info("v3:village", map.getCenter()); v = f && f.properties; } catch (e) { }
    corr.active = map.getZoom() >= 13 ? corrFor(v) : null;
    applyPanes();
  }, 350);
}
map.on("moveend", checkActive);

// ------------------------------------------------------------------ A. align a village
const al = { rec: null, pending: null, marks: L.layerGroup(), backup: null, poly: null };
function startAlign() {
  closePanels(); hideSheet();
  if (typeof sk !== "undefined" && sk.rec) closeSketchBar();
  al.rec = null; al.pending = null; al.backup = null; al.poly = null;
  al.marks.clearLayers().addTo(map);
  $("alTitle").textContent = "Align survey lines";
  $("alBar").classList.add("show");
  alStatus();
}
function alStatus() {
  const n = al.rec ? al.rec.pairs.length : 0;
  $("alUndo").disabled = !n; $("alSave").disabled = !n;
  $("alHint").innerHTML = al.pending ? "<b>2.</b> Now tap the <b>same corner on the satellite picture</b> – where it really is (a field bund, wall, pond bank, road edge)."
    : n === 0 ? "<b>1.</b> Zoom in and tap a clear <b>corner of the orange survey lines</b> – one you can also see on the satellite picture."
    : (n === 1 ? "1 corner matched – the lines moved. " : n === 2 ? "2 corners matched – moved, turned and sized. " : n + " corners matched – also corrects stretching. ") +
      "Tap another survey-line corner far from the others, or <b>Save</b>. Spread the corners around the village.";
}
async function onAlignTap(e) {
  if (!al.pending) {
    // 1. a corner of the survey lines: find the Bhuvan plot under the tap and snap to its nearest corner
    toast("Finding the corner…", 1500);
    const cur = al.rec;
    const llB = cur ? toBhuvan(cur, e.latlng) : e.latlng;
    let c, v;
    try { [c, v] = await Promise.all([info("v3:cadastral", llB), info("v3:village", llB)]); } catch (err) { toast("Could not reach Bhuvan – check the internet"); return; }
    if (!c || !v) { toast("No survey lines here – tap on a corner of the orange lines"); return; }
    const vp = v.properties;
    if (cur && vKey(vp) !== cur.key) { toast("That corner is in " + vp.vname + " village. Align one village at a time.", 4000); return; }
    const polys = c.geometry.type === "Polygon" ? [c.geometry.coordinates] : c.geometry.coordinates;
    const tp = map.latLngToContainerPoint(e.latlng);
    let best = null, bd = 40;
    polys.forEach((p) => p.forEach((ring) => ring.forEach((q) => {
      const b = L.latLng(q[1], q[0]), shown = cur ? toTrue(cur, b) : b, d = map.latLngToContainerPoint(shown).distanceTo(tp);
      if (d < bd) { bd = d; best = b; }
    })));
    if (!best) { toast("Tap closer to a corner of the orange lines (zoom in more)", 3500); return; }
    if (!al.rec) {
      const existing = corr.local[vKey(vp)] || corr.shared[vKey(vp)];
      al.backup = existing ? JSON.parse(JSON.stringify(existing)) : null;
      al.rec = existing ? JSON.parse(JSON.stringify(existing)) :
        { key: vKey(vp), vname: vp.vname, dtname: vp.dtname, origin: { lat: best.lat, lng: best.lng }, pairs: [], H: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
      delete al.rec.by;
      $("alTitle").textContent = "Align survey lines · " + vp.vname;
    }
    al.pending = cGeo(al.rec).toM(best);
  } else {
    // 2. the same corner on the satellite picture
    al.rec.pairs.push({ s: al.pending, d: cGeo(al.rec).toM(e.latlng) });
    al.pending = null;
    try { corrFit(al.rec); } catch (err) { al.rec.pairs.pop(); corrFit(al.rec); toast("Those corners are in a line – choose corners spread around", 4000); }
  }
  drawAlMarks(); applyPanes(); alStatus();
}
function drawAlMarks() {
  al.marks.clearLayers();
  if (!al.rec) return;
  const g = cGeo(al.rec);
  al.rec.pairs.forEach((p, i) => {
    L.circleMarker(g.toLL(p.d), { radius: 7, color: "#fff", weight: 2, fillColor: "#2E7D32", fillOpacity: 1, pane: "hl", interactive: false })
      .bindTooltip(String(i + 1), { permanent: true, direction: "right", className: "vlabel" }).addTo(al.marks);
  });
  if (al.pending) L.circleMarker(toTrue(al.rec, g.toLL(al.pending)), { radius: 7, color: "#fff", weight: 2, fillColor: "#C62828", fillOpacity: 1, pane: "hl", interactive: false }).addTo(al.marks);
}
function closeAlign() {
  $("alBar").classList.remove("show"); al.marks.clearLayers(); map.removeLayer(al.marks);
  al.rec = null; al.pending = null; checkActive();
}
$("alUndo").onclick = () => { if (!al.rec) return; al.rec.pairs.pop(); al.pending = null; corrFit(al.rec); drawAlMarks(); applyPanes(); alStatus(); };
$("alReset").onclick = () => { if (!al.rec) return; al.rec.pairs = []; al.pending = null; corrFit(al.rec); drawAlMarks(); applyPanes(); alStatus(); };
$("alClose").onclick = () => closeAlign();
$("alSave").onclick = () => {
  const r = al.rec; r.t = Date.now();
  corr.local[r.key] = r;
  if (!store.set("corr", corr.local)) toast("Could not save – browser storage is blocked");
  else toast("Correction saved for " + r.vname + " (moved " + shiftText(r) + ")", 3500);
  closeAlign(); listCorr();
  hilite.clearLayers();
};

// ------------------------------------------------------------------ B. list, share and import corrections
function listCorr() {
  const box = $("corrList"); if (!box) return;
  const all = Object.assign({}, corr.shared, corr.local);
  const ks = Object.keys(all).sort();
  box.innerHTML = ks.length ? ks.map((k) => {
    const r = all[k], mine = !!corr.local[k];
    return `<div class="plot"><div class="t"><b>${esc(r.vname)}</b> · ${esc(r.dtname || "")}<br><span class="muted">${mine ? "Yours" : "EntryFlow"} · ${r.pairs.length} corners · moved ${shiftText(r)}</span></div>
      ${mine ? `<button class="btn red" data-cdel="${esc(k)}">✕</button>` : ""}</div>`;
  }).join("") : '<div class="muted">No corrections yet.</div>';
}
$("corrList").addEventListener("click", (e) => {
  const d = e.target.closest("[data-cdel]"); if (!d) return;
  const r = corr.local[d.dataset.cdel];
  if (!confirm("Remove your correction for " + r.vname + "?")) return;
  delete corr.local[d.dataset.cdel]; store.set("corr", corr.local); listCorr(); checkActive();
});
$("useCorr").checked = corr.use;
$("useCorr").onchange = (e) => { corr.use = e.target.checked; store.set("useCorr", corr.use); hilite.clearLayers(); checkActive(); };
$("alStart").onclick = startAlign;
$("corrShare").onclick = async () => {
  const list = Object.values(corr.local);
  if (!list.length) { toast("You have no corrections of your own yet"); return; }
  const json = JSON.stringify({ app: "EntryFlow Survey Map", kind: "survey corrections", version: 1, corrections: list }, null, 1);
  const file = new File([json], "EntryFlow survey corrections.json", { type: "application/json" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "EntryFlow survey corrections", text: "Survey-line corrections for " + list.map((r) => r.vname).join(", ") }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = file.name; a.click();
};
$("corrImport").onclick = () => $("corrFile").click();
$("corrFile").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const j = JSON.parse(await f.text()); let n = 0;
    (j.corrections || []).forEach((c) => { if (c.key && c.H && c.origin) { delete c.by; corr.local[c.key] = c; n++; } });
    if (!n) throw new Error();
    store.set("corr", corr.local); listCorr(); checkActive(); toast("Added " + n + " village correction" + (n === 1 ? "" : "s"));
  } catch (err) { toast("This is not an EntryFlow corrections file", 4000); }
};

listCorr(); checkActive();
