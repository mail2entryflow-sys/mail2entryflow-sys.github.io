// EntryFlow Survey Map – FMB sketches in the investigator's own Google Drive.
// "Save to my Drive" puts each sketch (picture + its fitting on the map) in a private folder
// "EntryFlow FMB sketches" in the investigator's Google Drive; "Get from my Drive" on another device
// (phone ↔ PC) brings them back. Uses the EntryFlow Google sign-in with permission drive.file:
// EntryFlow can see only the files it created itself – nothing else in the Drive.
"use strict";

const GD = {
  CLIENT: "710425285613-89f1788ejb3bk1581m5ipk31uaptpril.apps.googleusercontent.com",
  SCOPES: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email",
  FOLDER: "EntryFlow FMB sketches",
  token: null, exp: 0, email: store.get("gEmail", ""), folder: null,
};

function loadGis() {
  if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
  return new Promise((ok, bad) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client"; s.onload = ok;
    s.onerror = () => bad(new Error("Google sign-in could not load – check the internet"));
    document.head.appendChild(s);
  });
}

/** A Google access token; shows Google's sign-in window when needed (must start from a button tap). */
async function gToken(chooseAccount) {
  if (!chooseAccount && GD.token && GD.exp > Date.now()) return GD.token;
  await loadGis();
  const r = await new Promise((ok, bad) => {
    const tc = google.accounts.oauth2.initTokenClient({
      client_id: GD.CLIENT, scope: GD.SCOPES,
      callback: (resp) => resp.error ? bad(new Error(resp.error_description || resp.error)) : ok(resp),
      error_callback: (e) => bad(new Error(e.type === "popup_closed" ? "Sign-in window was closed" : e.type === "popup_failed_to_open" ? "Allow pop-ups for this page, then try again" : (e.message || e.type))),
    });
    const o = { prompt: chooseAccount || !GD.email ? "select_account consent" : "" };
    if (GD.email && !chooseAccount) o.login_hint = GD.email;
    tc.requestAccessToken(o);
  });
  if (!google.accounts.oauth2.hasGrantedAllScopes(r, "https://www.googleapis.com/auth/drive.file"))
    throw new Error("Google Drive was not allowed. Tap again and, on Google's screen, tick the box to let EntryFlow use the files it creates.");
  GD.token = r.access_token; GD.exp = Date.now() + (Number(r.expires_in) || 3600) * 1000 - 60000;
  const me = await gfetch("GET", "https://www.googleapis.com/oauth2/v3/userinfo");
  if (me.email !== GD.email) GD.folder = null;
  GD.email = me.email || ""; store.set("gEmail", GD.email);
  gUi();
  return GD.token;
}

async function gfetch(method, url, body, ctype) {
  const h = { Authorization: "Bearer " + GD.token };
  if (ctype) h["Content-Type"] = ctype;
  const r = await fetch(url, { method, headers: h, body });
  const text = await r.text();
  let j = {}; try { j = text ? JSON.parse(text) : {}; } catch (e) { j = { raw: text }; }
  if (!r.ok) { if (r.status === 401) GD.token = null; throw new Error("Google Drive " + r.status + ": " + ((j.error && j.error.message) || r.statusText)); }
  return j;
}
const DRV = "https://www.googleapis.com/drive/v3/files";

async function gFolder() {
  if (GD.folder) return GD.folder;
  const q = "name = '" + GD.FOLDER + "' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
  const l = await gfetch("GET", DRV + "?fields=files(id)&q=" + encodeURIComponent(q));
  if (l.files && l.files.length) return (GD.folder = l.files[0].id);
  const f = await gfetch("POST", DRV + "?fields=id", JSON.stringify({ name: GD.FOLDER, mimeType: "application/vnd.google-apps.folder" }), "application/json");
  return (GD.folder = f.id);
}
async function gList() {                             // the sketches in the Drive folder
  const folder = await gFolder(), out = [];
  let page = "";
  do {
    const q = "'" + folder + "' in parents and trashed = false";
    const l = await gfetch("GET", DRV + "?pageSize=200&fields=nextPageToken,files(id,name,modifiedTime,appProperties)&q=" + encodeURIComponent(q) + (page ? "&pageToken=" + page : ""));
    (l.files || []).forEach((f) => { if (f.appProperties && f.appProperties.efkey) out.push(f); });
    page = l.nextPageToken || "";
  } while (page);
  return out;
}
async function gUpload(meta, json, id) {
  const b = "ef" + Math.random().toString(36).slice(2);
  const body = "--" + b + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(meta) + "\r\n--" + b +
    "\r\nContent-Type: application/json\r\n\r\n" + json + "\r\n--" + b + "--";
  const url = "https://www.googleapis.com/upload/drive/v3/files" + (id ? "/" + id : "") + "?uploadType=multipart&fields=id";
  return gfetch(id ? "PATCH" : "POST", url, body, "multipart/related; boundary=" + b);
}

// ------------------------------------------------------------------ save all sketches to the Drive
async function gSaveAll() {
  const recs = await DB.all();
  if (!recs.length) { toast("No FMB sketches on this device yet"); return; }
  try { await gToken(false); } catch (e) { toast(e.message, 5000); return; }
  showSheet('<div class="sy" style="font-size:19px">Saving to Google Drive…</div><div id="gProg" class="muted"></div>');
  try {
    const existing = {}; (await gList()).forEach((f) => existing[f.appProperties.efkey] = f.id);
    const folder = await gFolder();
    let n = 0;
    for (const r of recs) {
      $("gProg").textContent = (n + 1) + " of " + recs.length + " – Survey No. " + r.sy;
      const c = Object.assign({}, r); c.png = await blobToDataUrl(r.blob); delete c.blob; delete c.url;
      const json = JSON.stringify({ app: "EntryFlow Survey Map", kind: "FMB sketch", version: 1, sketch: c });
      const meta = { name: "FMB " + r.sy + " " + r.village + ".json", mimeType: "application/json", appProperties: { efkey: r.key.slice(0, 100), ef: "fmb" } };
      if (existing[r.key.slice(0, 100)]) await gUpload({ name: meta.name, appProperties: meta.appProperties }, json, existing[r.key.slice(0, 100)]);
      else await gUpload(Object.assign(meta, { parents: [folder] }), json);
      n++;
    }
    showSheet(`<div class="sy" style="font-size:19px">☁ Saved to Google Drive</div>
      <div style="margin-top:6px">${n} FMB sketch${n === 1 ? "" : "es"} saved in the folder <b>${esc(GD.FOLDER)}</b> of <b>${esc(GD.email)}</b>.</div>
      <div class="muted" style="margin-top:6px">On your phone or another computer: open this map, ⭐ → <b>☁ Get from my Drive</b>, with the same Google account.</div>`);
  } catch (e) { showSheet(`<div class="sy" style="font-size:19px">Not saved</div><div class="warn">${esc(e.message)}</div>`); }
}

// ------------------------------------------------------------------ get sketches from the Drive
let gFiles = [];
async function gGet() {
  try { await gToken(false); } catch (e) { toast(e.message, 5000); return; }
  closePanels();
  showSheet('<div class="sy" style="font-size:19px">Your sketches in Google Drive</div><div style="padding:8px 0"><span class="spin"></span> Looking…</div>');
  try { gFiles = (await gList()).sort((a, b) => a.name.localeCompare(b.name)); }
  catch (e) { showSheet(`<div class="sy" style="font-size:19px">Could not read Google Drive</div><div class="warn">${esc(e.message)}</div>`); return; }
  if (!gFiles.length) {
    showSheet(`<div class="sy" style="font-size:19px">No sketches in Google Drive yet</div>
      <div class="muted" style="margin-top:6px">Signed in as ${esc(GD.email)}. On the device where you made the sketches, tap ⭐ → <b>☁ Save to my Drive</b> with this same account.</div>`);
    return;
  }
  showSheet(`<div class="sy" style="font-size:19px">Your sketches in Google Drive<span>${esc(GD.email)}</span></div>
    <label style="display:flex;gap:8px;align-items:center;margin-top:8px;font-size:13px"><input type="checkbox" id="gAll" checked style="accent-color:#558B2F;width:17px;height:17px"> All</label>
    <div id="gPick">${gFiles.map((f, i) => `<label class="plot" style="cursor:pointer"><input type="checkbox" class="gpk" value="${i}" checked style="accent-color:#558B2F;width:17px;height:17px">
      <div class="t"><b>📄 ${esc(f.name.replace(/^FMB /, "").replace(/\.json$/, ""))}</b>${sketches[f.appProperties.efkey] ? ' <span class="muted">(already on this device – will be replaced)</span>' : ""}<br>
      <span class="muted">saved ${esc(new Date(f.modifiedTime).toLocaleString())}</span></div></label>`).join("")}</div>
    <div class="row"><button class="btn" id="gGetGo">☁ Get selected</button></div>`);
}
$("sheetBody").addEventListener("change", (e) => {
  if (e.target.id === "gAll") document.querySelectorAll(".gpk").forEach((c) => c.checked = e.target.checked);
});
$("sheetBody").addEventListener("click", async (e) => {
  if (e.target.id !== "gGetGo") return;
  const pick = [...document.querySelectorAll(".gpk:checked")].map((c) => gFiles[+c.value]);
  if (!pick.length) { toast("Tick the sketches to get"); return; }
  e.target.disabled = true; e.target.textContent = "Getting…";
  let n = 0, last = null;
  try {
    await gToken(false);
    for (const f of pick) {
      const r = await fetch(DRV + "/" + f.id + "?alt=media", { headers: { Authorization: "Bearer " + GD.token } });
      if (!r.ok) throw new Error("Google Drive " + r.status);
      const s = (await r.json()).sketch;
      s.blob = await (await fetch(s.png)).blob(); delete s.png;
      if (sketches[s.key] && sketches[s.key].rec.url) URL.revokeObjectURL(sketches[s.key].rec.url);
      delete s.url;
      await DB.put(s); showSketch(s); last = s; n++;
    }
  } catch (err) { toast("Stopped: " + err.message, 5000); }
  listSketches();
  hideSheet();
  if (last) map.fitBounds(L.geoJSON(last.geom).getBounds(), { padding: [40, 40], maxZoom: 19 });
  toast("Got " + n + " sketch" + (n === 1 ? "" : "es") + " from Google Drive", 3500);
});

// ------------------------------------------------------------------ account line and buttons (in ⭐ My saved plots)
function gUi() {
  const el = $("gAcct"); if (!el) return;
  el.innerHTML = GD.email ? "Google Drive: <b>" + esc(GD.email) + "</b>" : "Google Drive: not signed in yet";
  $("gChange").textContent = GD.email ? "Change account" : "Sign in";
}
$("gSave").onclick = gSaveAll;
$("gGet").onclick = gGet;
$("gChange").onclick = async () => { try { GD.token = null; GD.folder = null; await gToken(true); toast("Signed in as " + GD.email); } catch (e) { toast(e.message, 5000); } };
gUi();
