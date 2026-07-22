/* ============ EDGE // TODO ============ */
"use strict";

/* ---------- state ---------- */
const STORE_KEY = "edge-todo-data";
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const DEFAULT_ACCENTS = { dark: "#00e5a0", light: "#00a874" };

let state = {
  theme: "dark",
  particles: true,
  accents: { ...DEFAULT_ACCENTS },
  activeListId: null,
  lists: [] // {id, name, createdAt, items:[{id, text, done, sub:[{id, text, done}]}], notes:[{id, text, createdAt, tags:[{listId, itemId, subId, text}]}]}
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) state = Object.assign(state, JSON.parse(raw));
  } catch (e) { console.warn("Could not load saved data", e); }
  normalizeState();
}

/* enforce the data shape on every load so nested tasks never surface as
   top-level tasks (and malformed nodes can't crash render) */
function normalizeState() {
  if (!Array.isArray(state.lists)) state.lists = [];
  state.lists.forEach((list) => {
    if (!Array.isArray(list.items)) list.items = [];

    /* every id that legitimately lives inside a sublist */
    const subIds = new Set();
    list.items.forEach((it) => {
      if (it && Array.isArray(it.sub)) it.sub.forEach((s) => s && s.id && subIds.add(s.id));
    });

    list.items = list.items
      .filter((it) => it && !subIds.has(it.id)) // drop a top-level copy of a sub-task
      .map((it) => ({
        id: it.id || uid(),
        text: typeof it.text === "string" ? it.text : "",
        done: !!it.done,
        doneAt: it.doneAt || null,
        sub: (Array.isArray(it.sub) ? it.sub : [])
          .filter((s) => s && (typeof s.text === "string"))
          .map((s) => ({ id: s.id || uid(), text: s.text, done: !!s.done, doneAt: s.doneAt || null }))
      }));

    if (!Array.isArray(list.notes)) list.notes = [];
    list.notes = list.notes.map((n) => ({
      id: n.id || uid(),
      text: typeof n.text === "string" ? n.text : "",
      createdAt: n.createdAt || Date.now(),
      tags: (Array.isArray(n.tags) ? n.tags : [])
        .filter((t) => t && t.itemId)
        .map((t) => ({
          listId: t.listId || null,
          itemId: t.itemId,
          subId: t.subId || null,
          text: typeof t.text === "string" ? t.text : ""
        }))
    }));
  });
  state.accents = Object.assign({ ...DEFAULT_ACCENTS }, state.accents);
  if (!getList(state.activeListId)) state.activeListId = state.lists[0] ? state.lists[0].id : null;

  /* one-time migration: move old global state.notes into per-list notes */
  if (Array.isArray(state.notes) && state.notes.length > 0) {
    state.notes.forEach((n) => {
      const targetListId = n.tags && n.tags[0] ? n.tags[0].listId : null;
      const dest = (targetListId ? getList(targetListId) : null) || state.lists[0];
      if (!dest) return;
      if (!Array.isArray(dest.notes)) dest.notes = [];
      dest.notes.push({
        id: n.id || uid(),
        text: typeof n.text === "string" ? n.text : "",
        createdAt: n.createdAt || Date.now(),
        tags: (Array.isArray(n.tags) ? n.tags : [])
          .filter((t) => t && t.itemId)
          .map((t) => ({
            listId: t.listId || null,
            itemId: t.itemId,
            subId: t.subId || null,
            text: typeof t.text === "string" ? t.text : ""
          }))
      });
    });
    delete state.notes;
  }
}

let saveTimer = null;
function saveState() {
  state.updatedAt = Date.now();
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveToDisk, 600); // debounced file write
  scheduleCloudPush(); // debounced Google Drive sync (no-op when signed out)
}

/* ---------- optional: save todos.json into the project folder ---------- */
let dirHandle = null;

function idbOpen() {
  return new Promise((res, rej) => {
    const req = indexedDB.open("edge-todo-fs", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("handles");
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function idbSet(key, val) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction("handles", "readwrite");
    tx.objectStore("handles").put(val, key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const req = db.transaction("handles").objectStore("handles").get(key);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function linkFolder() {
  if (!window.showDirectoryPicker) {
    alert("Folder linking needs Chrome or Edge. Data still autosaves in the browser.");
    return;
  }
  try {
    dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    await idbSet("dir", dirHandle);
    /* adopt the folder's existing data instead of overwriting it */
    const loaded = await loadFromDisk(true);
    if (!loaded) await saveToDisk(); // folder had no todos.json yet — seed it
    updateStorageStatus();
  } catch (e) { /* user cancelled */ }
}

/* read todos.json from the linked folder.
   preferDisk=true  -> adopt the folder's data if it has any lists (used when linking)
   preferDisk=false -> adopt only if the folder copy is newer (used on auto-restore) */
async function loadFromDisk(preferDisk) {
  if (!dirHandle) return false;
  try {
    const fh = await dirHandle.getFileHandle("todos.json"); // no create: throws if absent
    const text = await (await fh.getFile()).text();
    if (!text.trim()) return false;
    const disk = JSON.parse(text);
    const hasData = Array.isArray(disk.lists) && disk.lists.length > 0;
    const diskNewer = (disk.updatedAt || 0) > (state.updatedAt || 0);
    if (preferDisk ? hasData : diskNewer) {
      state = Object.assign(state, disk);
      normalizeState();
      applyTheme();
      render();
      return true;
    }
  } catch (e) { /* no file yet, or unreadable */ }
  return false;
}

async function restoreFolder() {
  try {
    const h = await idbGet("dir");
    if (!h) return;
    const perm = await h.queryPermission({ mode: "readwrite" });
    if (perm === "granted") {
      dirHandle = h;
      await loadFromDisk(false); // auto-load newer folder data
    } else if (perm === "prompt") {
      // re-request on first user interaction
      const once = async () => {
        document.removeEventListener("pointerdown", once);
        try {
          if ((await h.requestPermission({ mode: "readwrite" })) === "granted") {
            dirHandle = h;
            await loadFromDisk(false);
            updateStorageStatus();
          }
        } catch (e) {}
      };
      document.addEventListener("pointerdown", once);
    }
  } catch (e) {}
  updateStorageStatus();
}

async function saveToDisk() {
  if (!dirHandle) return;
  try {
    const fh = await dirHandle.getFileHandle("todos.json", { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(state, null, 2));
    await w.close();
  } catch (e) { console.warn("Disk save failed", e); }
}

function updateStorageStatus() {
  const el = document.getElementById("storageStatus");
  if (dirHandle) {
    el.textContent = "Linked — saving todos.json to \"" + dirHandle.name + "\"";
    el.classList.add("linked");
  } else {
    el.textContent = "Browser storage only";
    el.classList.remove("linked");
  }
}

/* ---------- Google sign-in & Drive sync ---------- */
const GOOGLE_CLIENT_ID = "370596124152-bnrhbmtue9eb5876mo4dfa9ov0uf6o5a.apps.googleusercontent.com";
const GAUTH_KEY = "edge-todo-gauth";
const GSCOPES = "https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/userinfo.email";

let gAuth = null;       // {token, expiry, email, fileId, lastSync}
let gTokenClient = null;
let syncTimer = null;

function gAuthValid() { return gAuth && gAuth.token && gAuth.expiry > Date.now(); }

function gAuthSave() {
  if (gAuth) localStorage.setItem(GAUTH_KEY, JSON.stringify(gAuth));
  else localStorage.removeItem(GAUTH_KEY);
}

function setSyncStatus(msg, ok) {
  const el = document.getElementById("gSyncStatus");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("linked", !!ok);
}

function updateGsyncUI() {
  const signedIn = gAuthValid();
  document.getElementById("gSignInBtn").classList.toggle("hidden", signedIn);
  document.getElementById("gSignOutBtn").classList.toggle("hidden", !signedIn);
  document.getElementById("gSyncNowBtn").classList.toggle("hidden", !signedIn);
  const foot = document.getElementById("gFootBtn");
  if (foot) {
    foot.classList.toggle("synced", signedIn);
    foot.innerHTML = signedIn
      ? "G &middot; " + (gAuth.email ? gAuth.email.split("@")[0].toUpperCase().slice(0, 12) : "SYNCED")
      : "G &middot; SIGN IN";
  }
  if (signedIn) {
    const last = gAuth.lastSync ? " · last sync " + fmtDate(gAuth.lastSync) : "";
    setSyncStatus("Signed in as " + (gAuth.email || "…") + last, true);
  } else if (gAuth && gAuth.email) {
    setSyncStatus("Session expired — sign in again to sync (" + gAuth.email + ")");
  } else {
    setSyncStatus("Not signed in");
  }
}

function ensureTokenClient() {
  if (gTokenClient) return true;
  if (!window.google || !google.accounts || !google.accounts.oauth2) return false;
  gTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: GSCOPES,
    callback: onGoogleToken
  });
  return true;
}

function gSignIn() {
  if (location.protocol === "file:") {
    alert("Google sign-in needs the app to run from a web address (e.g. the GitHub Pages site or http://localhost) — it cannot work when opened as a file.");
    return;
  }
  if (!ensureTokenClient()) {
    alert("Google sign-in library has not loaded yet — check your internet connection and try again.");
    return;
  }
  gTokenClient.requestAccessToken({ prompt: gAuth && gAuth.email ? "" : "consent" });
}

async function onGoogleToken(resp) {
  if (resp.error) { setSyncStatus("Sign-in failed: " + resp.error); return; }
  gAuth = Object.assign(gAuth || {}, {
    token: resp.access_token,
    expiry: Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000
  });
  try {
    const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: "Bearer " + gAuth.token }
    });
    if (r.ok) gAuth.email = (await r.json()).email;
  } catch (e) {}
  gAuthSave();
  updateGsyncUI();
  syncNow();
}

function gSignOut() {
  if (gAuth && gAuth.token && window.google?.accounts?.oauth2) {
    try { google.accounts.oauth2.revoke(gAuth.token, () => {}); } catch (e) {}
  }
  gAuth = null;
  gAuthSave();
  updateGsyncUI();
}

async function gFetch(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: Object.assign({ Authorization: "Bearer " + gAuth.token }, opts.headers || {})
  });
  if (r.status === 401 || r.status === 403) {
    gAuth.token = null;
    gAuthSave();
    updateGsyncUI();
    throw new Error("auth-expired");
  }
  if (!r.ok) throw new Error("drive-http-" + r.status);
  return r;
}

async function driveFindFile() {
  if (gAuth.fileId) return gAuth.fileId;
  const q = encodeURIComponent("name='todos.json'");
  const r = await gFetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name)&q=${q}`);
  const j = await r.json();
  gAuth.fileId = j.files && j.files[0] ? j.files[0].id : null;
  return gAuth.fileId;
}

async function driveDownload(fileId) {
  const r = await gFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  return r.json();
}

async function driveUpload(fileId) {
  const body = JSON.stringify(state);
  if (fileId) {
    await gFetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body
    });
    return fileId;
  }
  const boundary = "bb_todo_" + uid();
  const multi =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name: "todos.json", parents: ["appDataFolder"] }) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const r = await gFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: { "Content-Type": "multipart/related; boundary=" + boundary },
    body: multi
  });
  return (await r.json()).id;
}

/* pull newer cloud state (unless pushOnly), then push local */
async function syncNow(pushOnly = false) {
  if (!gAuthValid()) { updateGsyncUI(); return; }
  setSyncStatus("Syncing…", true);
  try {
    let fileId = await driveFindFile();
    if (fileId && !pushOnly) {
      const cloud = await driveDownload(fileId);
      if (cloud && (cloud.updatedAt || 0) > (state.updatedAt || 0)) {
        state = Object.assign(state, cloud);
        normalizeState();
        applyTheme();
        render(); // re-saves locally and re-schedules a push; harmless
      }
    }
    gAuth.fileId = await driveUpload(fileId);
    gAuth.lastSync = Date.now();
    gAuthSave();
    updateGsyncUI();
  } catch (e) {
    if (e.message !== "auth-expired") setSyncStatus("Sync failed — will retry on next change");
    console.warn("Google sync failed", e);
  }
}

function scheduleCloudPush() {
  if (!gAuthValid()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(true), 2000);
}

function setupGoogleSync() {
  try { gAuth = JSON.parse(localStorage.getItem(GAUTH_KEY)); } catch (e) {}
  document.getElementById("gSignInBtn").addEventListener("click", gSignIn);
  document.getElementById("gSignOutBtn").addEventListener("click", gSignOut);
  document.getElementById("gSyncNowBtn").addEventListener("click", () => syncNow());
  document.getElementById("gFootBtn").addEventListener("click", () => {
    if (gAuthValid()) document.getElementById("settingsModal").classList.remove("hidden");
    else gSignIn();
  });
  updateGsyncUI();
  if (gAuthValid()) syncNow(); // resume session: pull latest from Drive
}

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);
const getList = (id) => state.lists.find((l) => l.id === id);
const activeList = () => getList(state.activeListId);

function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}  ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function findItem(list, itemId) {
  return list.items.find((i) => i.id === itemId);
}
/* remove an item or subitem from wherever it lives; returns the node */
function extractNode(listId, itemId, subId) {
  const list = getList(listId);
  if (!list) return null;
  if (subId) {
    const parent = findItem(list, itemId);
    if (!parent) return null;
    const idx = parent.sub.findIndex((s) => s.id === subId);
    if (idx < 0) return null;
    return parent.sub.splice(idx, 1)[0];
  }
  const idx = list.items.findIndex((i) => i.id === itemId);
  if (idx < 0) return null;
  return list.items.splice(idx, 1)[0];
}

/* stable sort that pushes completed entries to the bottom, keeping the
   relative order within the done / not-done groups intact */
function sortDoneToBottom(arr) {
  arr.sort((a, b) => (a.done === b.done ? 0 : a.done ? 1 : -1));
}

/* ---------- rendering ---------- */
function render() {
  renderSidebar();
  renderBoard();
  renderNotes();
  saveState();
}

function renderSidebar() {
  const nav = $("listNav");
  nav.innerHTML = "";
  state.lists.forEach((list) => {
    const el = document.createElement("div");
    el.className = "list-entry" + (list.id === state.activeListId ? " active" : "");
    el.dataset.listId = list.id;

    const doneCount = list.items.filter((i) => i.done).length;
    el.innerHTML = `
      <div class="list-entry-name"></div>
      <div class="list-entry-date">${fmtDate(list.createdAt)}</div>
      <span class="list-entry-count">${doneCount}/${list.items.length}</span>
      <button class="list-del" title="Delete list">&#10005;</button>`;
    el.querySelector(".list-entry-name").textContent = list.name;

    el.addEventListener("click", (e) => {
      if (e.target.closest(".list-del")) return;
      state.activeListId = list.id;
      render();
    });
    el.querySelector(".list-del").addEventListener("click", () => {
      if (!confirm(`Delete list "${list.name}" and all its tasks?`)) return;
      state.lists = state.lists.filter((l) => l.id !== list.id);
      if (state.activeListId === list.id) state.activeListId = state.lists[0]?.id ?? null;
      render();
    });

    /* drop target: move task into this list */
    el.addEventListener("dragover", (e) => {
      if (!dragData) return;
      if (dragData.listId === list.id && !dragData.subId) return; // already in this list
      e.preventDefault();
      el.classList.add("drop-target");
    });
    el.addEventListener("dragleave", () => el.classList.remove("drop-target"));
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      el.classList.remove("drop-target");
      if (!dragData) return;
      const node = extractNode(dragData.listId, dragData.itemId, dragData.subId);
      if (!node) return;
      if (!node.sub) node.sub = []; // promoted subitem becomes full item
      list.items.push(node);
      dragData = null;
      render();
    });

    nav.appendChild(el);
  });
}

function renderBoard() {
  const list = activeList();
  $("emptyState").classList.toggle("hidden", !!list);
  $("board").classList.toggle("hidden", !list);
  if (!list) return;

  $("boardTitle").textContent = list.name;
  $("boardMeta").textContent = "CREATED " + fmtDate(list.createdAt);
  const done = list.items.filter((i) => i.done).length;
  $("boardStats").textContent = `${done} / ${list.items.length} DONE`;

  const wrap = $("items");
  wrap.innerHTML = "";
  list.items.forEach((item) => wrap.appendChild(renderItem(list, item)));
}

function renderItem(list, item) {
  const el = document.createElement("div");
  el.className = "item" + (item.done ? " done" : "");
  el.draggable = true;
  el.dataset.itemId = item.id;

  const row = document.createElement("div");
  row.className = "item-row";
  row.innerHTML = `
    <span class="drag-handle" title="Drag to move">&#8942;&#8942;</span>
    <input type="checkbox" class="chk" ${item.done ? "checked" : ""}>
    <div class="item-text" title="Double-click to edit"></div>
    <div class="item-actions">
      <button class="act-btn sub" title="Add sub-task">+SUB</button>
      <button class="act-btn del" title="Delete">DEL</button>
    </div>`;
  row.querySelector(".item-text").textContent = item.text;
  el.appendChild(row);

  row.querySelector(".chk").addEventListener("change", (e) => {
    item.done = e.target.checked;
    item.doneAt = e.target.checked ? Date.now() : null;
    sortDoneToBottom(list.items); // completed tasks drop to the bottom
    render();
  });
  row.querySelector(".del").addEventListener("click", () => {
    list.items = list.items.filter((i) => i.id !== item.id);
    render();
  });
  makeEditable(row.querySelector(".item-text"), (txt) => { item.text = txt; render(); });

  if (item.done && item.doneAt) {
    const doneEl = document.createElement("div");
    doneEl.className = "done-at";
    doneEl.textContent = "COMPLETED " + fmtDate(item.doneAt);
    el.appendChild(doneEl);
  }

  /* sublist */
  const sub = document.createElement("div");
  sub.className = "sublist";
  sub.dataset.itemId = item.id;
  item.sub.forEach((s) => sub.appendChild(renderSubitem(list, item, s)));
  el.appendChild(sub);

  /* add-sub control */
  const subAdd = document.createElement("button");
  subAdd.className = "sub-add";
  subAdd.style.marginLeft = "44px";
  subAdd.innerHTML = "+ SUB-TASK";
  subAdd.addEventListener("click", () => showSubInput(el, list, item, subAdd));
  el.appendChild(subAdd);
  row.querySelector(".sub").addEventListener("click", () => showSubInput(el, list, item, subAdd));

  /* drag */
  el.addEventListener("dragstart", (e) => {
    e.stopPropagation();
    dragData = { listId: list.id, itemId: item.id, subId: null, hasSub: item.sub.length > 0 };
    el.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  el.addEventListener("dragend", () => {
    el.classList.remove("dragging");
    clearDropUI();
    dragData = null;
  });

  return el;
}

function renderSubitem(list, item, s) {
  const el = document.createElement("div");
  el.className = "subitem" + (s.done ? " done" : "");
  el.draggable = true;
  el.dataset.subId = s.id;
  el.innerHTML = `
    <span class="drag-handle" title="Drag to move">&#8942;&#8942;</span>
    <input type="checkbox" class="chk" ${s.done ? "checked" : ""}>
    <div class="item-text" title="Double-click to edit"></div>
    ${s.done && s.doneAt ? `<span class="done-at-inline">${fmtDate(s.doneAt)}</span>` : ""}
    <div class="item-actions">
      <button class="act-btn del" title="Delete">DEL</button>
    </div>`;
  el.querySelector(".item-text").textContent = s.text;

  el.querySelector(".chk").addEventListener("change", (e) => {
    s.done = e.target.checked;
    s.doneAt = e.target.checked ? Date.now() : null;
    sortDoneToBottom(item.sub); // completed sub-tasks drop to the bottom
    render();
  });
  el.querySelector(".del").addEventListener("click", () => {
    item.sub = item.sub.filter((x) => x.id !== s.id);
    render();
  });
  makeEditable(el.querySelector(".item-text"), (txt) => { s.text = txt; render(); });

  el.addEventListener("dragstart", (e) => {
    e.stopPropagation();
    dragData = { listId: list.id, itemId: item.id, subId: s.id, hasSub: false };
    el.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  el.addEventListener("dragend", (e) => {
    e.stopPropagation();
    el.classList.remove("dragging");
    clearDropUI();
    dragData = null;
  });

  return el;
}

function showSubInput(itemEl, list, item, beforeEl) {
  if (itemEl.querySelector(".sub-input-row")) {
    itemEl.querySelector(".sub-input-row input").focus();
    return;
  }
  const rowEl = document.createElement("div");
  rowEl.className = "sub-input-row";
  rowEl.style.marginLeft = "44px";
  rowEl.innerHTML = `<input type="text" placeholder="Sub-task..." maxlength="200">
    <button class="mini-btn accent">ADD</button>`;
  itemEl.insertBefore(rowEl, beforeEl);
  const input = rowEl.querySelector("input");
  input.focus();
  const commit = () => {
    const v = input.value.trim();
    if (v) {
      item.sub.push({ id: uid(), text: v, done: false });
      render();
    } else rowEl.remove();
  };
  rowEl.querySelector("button").addEventListener("click", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") rowEl.remove();
  });
}

function makeEditable(el, onDone) {
  el.addEventListener("dblclick", () => {
    el.contentEditable = "true";
    el.focus();
    document.getSelection().selectAllChildren(el);
    const finish = () => {
      el.contentEditable = "false";
      const txt = el.textContent.trim();
      if (txt) onDone(txt);
      else render();
    };
    el.addEventListener("blur", finish, { once: true });
    el.addEventListener("keydown", function kd(e) {
      if (e.key === "Enter") { e.preventDefault(); el.blur(); }
      if (e.key === "Escape") { el.removeEventListener("blur", finish); el.contentEditable = "false"; render(); }
    });
  });
}

/* ---------- sticky notes ---------- */
/* resolve a tag against live state so chips track renames / deletions */
function resolveTag(tag) {
  const list = getList(tag.listId);
  if (list) {
    const item = findItem(list, tag.itemId);
    if (item) {
      if (tag.subId) {
        const s = item.sub.find((x) => x.id === tag.subId);
        if (s) return { text: s.text, done: s.done, exists: true, listId: list.id };
      } else {
        return { text: item.text, done: item.done, exists: true, listId: list.id };
      }
    }
  }
  return { text: tag.text, done: false, exists: false, listId: tag.listId };
}

function openNotes() {
  $("notesDock").classList.add("open");
  $("notesReveal").classList.add("hidden");
}
function closeNotes() {
  $("notesDock").classList.remove("open");
  $("notesReveal").classList.remove("hidden");
}

function flashItem(itemId, subId) {
  requestAnimationFrame(() => {
    const target = subId
      ? document.querySelector(`.subitem[data-sub-id="${subId}"]`)
      : document.querySelector(`.item[data-item-id="${itemId}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("flash");
    setTimeout(() => target.classList.remove("flash"), 1200);
  });
}

/* add a task reference to a note from a drag payload (never moves the task) */
function addTagFromDrag(note, d) {
  const list = getList(d.listId);
  if (!list) return;
  const item = findItem(list, d.itemId);
  if (!item) return;
  let text = item.text, subId = null;
  if (d.subId) {
    const s = item.sub.find((x) => x.id === d.subId);
    if (!s) return;
    text = s.text;
    subId = d.subId;
  }
  const dup = note.tags.some((t) => t.itemId === d.itemId && (t.subId || null) === subId);
  if (dup) return;
  note.tags.push({ listId: d.listId, itemId: d.itemId, subId, text });
}

function renderTag(note, tag) {
  const r = resolveTag(tag);
  const chip = document.createElement("span");
  chip.className = "note-tag" + (r.exists ? "" : " gone") + (r.done ? " done" : "");

  const label = document.createElement("span");
  label.className = "note-tag-text";
  label.textContent = r.exists ? r.text : (tag.text || "removed task");
  chip.appendChild(label);

  if (r.exists) {
    chip.title = "Jump to this task";
    label.addEventListener("click", () => {
      state.activeListId = r.listId;
      render();
      flashItem(tag.itemId, tag.subId);
    });
  }

  const x = document.createElement("button");
  x.className = "note-tag-x";
  x.innerHTML = "&#10005;";
  x.title = "Remove tag";
  x.addEventListener("click", (e) => {
    e.stopPropagation();
    note.tags = note.tags.filter((t) => t !== tag);
    render();
  });
  chip.appendChild(x);

  return chip;
}

function renderNote(note) {
  const el = document.createElement("div");
  el.className = "note";
  el.dataset.noteId = note.id;

  const bar = document.createElement("div");
  bar.className = "note-bar";
  const del = document.createElement("button");
  del.className = "note-del";
  del.innerHTML = "&#10005;";
  del.title = "Delete note";
  del.addEventListener("click", () => {
    if (!confirm("Delete this sticky note?")) return;
    const list = activeList();
    if (list) list.notes = list.notes.filter((n) => n.id !== note.id);
    render();
  });
  bar.appendChild(del);
  el.appendChild(bar);

  const ta = document.createElement("textarea");
  ta.className = "note-text";
  ta.dataset.noteId = note.id;
  ta.placeholder = "Write a note…";
  ta.value = note.text;
  ta.addEventListener("input", () => { note.text = ta.value; saveState(); });
  el.appendChild(ta);

  const tags = document.createElement("div");
  tags.className = "note-tags";
  note.tags.forEach((tag) => tags.appendChild(renderTag(note, tag)));
  el.appendChild(tags);

  const hint = document.createElement("div");
  hint.className = "note-drophint";
  hint.textContent = "Drop a task here to tag it";
  el.appendChild(hint);

  /* whole card is a drop target for tagging (does NOT move the task) */
  el.addEventListener("dragover", (e) => {
    if (!dragData) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move"; // match dragstart's effectAllowed so the drop is permitted
    el.classList.add("note-drag-over");
  });
  el.addEventListener("dragleave", (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove("note-drag-over");
  });
  el.addEventListener("drop", (e) => {
    if (!dragData) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove("note-drag-over");
    addTagFromDrag(note, dragData);
    dragData = null;
    render();
  });

  return el;
}

function renderNotes() {
  const scroll = $("notesScroll");
  if (!scroll) return;

  /* keep caret position if a note textarea is focused during a re-render */
  let focus = null;
  const ae = document.activeElement;
  if (ae && ae.classList && ae.classList.contains("note-text")) {
    focus = { id: ae.dataset.noteId, start: ae.selectionStart, end: ae.selectionEnd };
  }

  scroll.innerHTML = "";
  const list = activeList();
  const notes = list ? list.notes : [];
  if (!notes.length) {
    const empty = document.createElement("div");
    empty.className = "notes-empty";
    empty.textContent = list ? "No notes yet — press + to add one." : "Select a list to see its notes.";
    scroll.appendChild(empty);
    return;
  }
  notes.forEach((note) => scroll.appendChild(renderNote(note)));

  if (focus) {
    const ta = scroll.querySelector(`.note-text[data-note-id="${focus.id}"]`);
    if (ta) { ta.focus(); try { ta.setSelectionRange(focus.start, focus.end); } catch (e) {} }
  }
}

function setupNotes() {
  $("addNoteBtn").addEventListener("click", () => {
    const list = activeList();
    if (!list) return;
    list.notes.unshift({ id: uid(), text: "", createdAt: Date.now(), tags: [] });
    openNotes();
    render();
    requestAnimationFrame(() => {
      const ta = $("notesScroll").querySelector(".note-text");
      if (ta) ta.focus();
    });
  });
  $("closeNotesBtn").addEventListener("click", closeNotes);
  $("notesReveal").addEventListener("click", openNotes);
}

/* ---------- drag & drop ---------- */
let dragData = null;
const dropLine = document.createElement("div");
dropLine.className = "drop-line";

function clearDropUI() {
  dropLine.remove();
  document.querySelectorAll(".drop-target, .drop-target-zone")
    .forEach((n) => n.classList.remove("drop-target", "drop-target-zone"));
}

/* insertion index among container's direct children matching selector */
function insertIndex(container, selector, y) {
  const kids = [...container.querySelectorAll(":scope > " + selector)].filter(
    (k) => !k.classList.contains("dragging")
  );
  for (let i = 0; i < kids.length; i++) {
    const r = kids[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) return { index: i, before: kids[i] };
  }
  return { index: kids.length, before: null };
}

function setupBoardDnD() {
  const itemsEl = $("items");

  itemsEl.addEventListener("dragover", (e) => {
    if (!dragData) return;
    const subZone = e.target.closest(".sublist");
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    clearDropUI();

    if (subZone) {
      /* dropping INTO a sublist (nest / move / reorder sub) */
      if (dragData.hasSub) return; // an item that owns sub-tasks can't be nested
      const pos = insertIndex(subZone, ".subitem", e.clientY);
      subZone.classList.add("drop-target-zone");
      if (pos.before) subZone.insertBefore(dropLine, pos.before);
      else subZone.appendChild(dropLine);
    } else {
      /* top level reorder / promote */
      const pos = insertIndex(itemsEl, ".item", e.clientY);
      if (pos.before) itemsEl.insertBefore(dropLine, pos.before);
      else itemsEl.appendChild(dropLine);
    }
  });

  itemsEl.addEventListener("dragleave", (e) => {
    if (!itemsEl.contains(e.relatedTarget)) clearDropUI();
  });

  itemsEl.addEventListener("drop", (e) => {
    if (!dragData) return;
    e.preventDefault();
    const list = activeList();
    const subZone = e.target.closest(".sublist");

    if (subZone) {
      if (dragData.hasSub) { clearDropUI(); return; }
      const targetItem = findItem(list, subZone.dataset.itemId);
      if (!targetItem || (dragData.subId === null && dragData.itemId === targetItem.id)) { clearDropUI(); return; }
      const pos = insertIndex(subZone, ".subitem", e.clientY);
      const node = extractNode(dragData.listId, dragData.itemId, dragData.subId);
      if (node) {
        delete node.sub; // subitems carry no nested lists
        targetItem.sub.splice(pos.index, 0, { id: node.id, text: node.text, done: node.done });
      }
    } else {
      const pos = insertIndex(itemsEl, ".item", e.clientY);
      const node = extractNode(dragData.listId, dragData.itemId, dragData.subId);
      if (node) {
        if (!node.sub) node.sub = []; // promoted sub-task becomes a full task
        list.items.splice(pos.index, 0, node);
      }
    }
    dragData = null;
    clearDropUI();
    render();
  });
}

/* ---------- list creation / rename ---------- */
function setupSidebar() {
  const form = $("newListForm");
  const input = $("newListInput");

  $("newListBtn").addEventListener("click", () => {
    form.classList.remove("hidden");
    input.value = fmtDate(Date.now());
    input.focus();
    input.select();
  });
  $("cancelListBtn").addEventListener("click", () => form.classList.add("hidden"));

  const create = () => {
    const name = input.value.trim() || fmtDate(Date.now());
    const list = { id: uid(), name, createdAt: Date.now(), items: [], notes: [] };
    state.lists.unshift(list);
    state.activeListId = list.id;
    form.classList.add("hidden");
    render();
  };
  $("createListBtn").addEventListener("click", create);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") create();
    if (e.key === "Escape") form.classList.add("hidden");
  });

  $("collapseBtn").addEventListener("click", () => {
    $("sidebar").classList.add("collapsed");
    $("revealBtn").classList.remove("hidden");
  });
  $("revealBtn").addEventListener("click", () => {
    $("sidebar").classList.remove("collapsed");
    $("revealBtn").classList.add("hidden");
  });

  makeEditable($("boardTitle"), (txt) => {
    const list = activeList();
    if (list) list.name = txt;
    render();
  });
}

/* ---------- add items ---------- */
function setupAddItem() {
  const input = $("addItemInput");
  const add = () => {
    const v = input.value.trim();
    const list = activeList();
    if (!v || !list) return;
    list.items.push({ id: uid(), text: v, done: false, sub: [] });
    input.value = "";
    render();
    input.focus();
  };
  $("addItemBtn").addEventListener("click", add);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
}

/* ---------- theme & settings ---------- */
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  document.querySelectorAll("[data-theme-pick]").forEach((c) =>
    c.classList.toggle("selected", c.dataset.themePick === state.theme)
  );

  /* per-theme accent colour override */
  const accent = state.accents[state.theme] || DEFAULT_ACCENTS[state.theme];
  const rgb = hexToRgb(accent);
  const root = document.documentElement.style;
  root.setProperty("--accent", accent);
  root.setProperty("--accent-dim", `rgba(${rgb}, ${state.theme === "dark" ? 0.12 : 0.10})`);
  root.setProperty("--particle", rgb);

  /* keep pickers and theme swatches in sync */
  const pickL = $("accentLight"), pickD = $("accentDark");
  if (pickL) pickL.value = state.accents.light;
  if (pickD) pickD.value = state.accents.dark;
  const swL = document.querySelector(".swatch-light");
  const swD = document.querySelector(".swatch-dark");
  if (swL) swL.style.background = `linear-gradient(135deg, #f2f4f8 50%, ${state.accents.light} 50%)`;
  if (swD) swD.style.background = `linear-gradient(135deg, #0b0d12 50%, ${state.accents.dark} 50%)`;

  refreshParticleColor();
}

function setupSettings() {
  $("settingsBtn").addEventListener("click", () => $("settingsModal").classList.remove("hidden"));
  $("closeSettingsBtn").addEventListener("click", () => $("settingsModal").classList.add("hidden"));
  $("settingsModal").addEventListener("click", (e) => {
    if (e.target === $("settingsModal")) $("settingsModal").classList.add("hidden");
  });

  document.querySelectorAll("[data-theme-pick]").forEach((card) =>
    card.addEventListener("click", () => {
      state.theme = card.dataset.themePick;
      applyTheme();
      saveState();
    })
  );

  $("themeQuickBtn").addEventListener("click", () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    applyTheme();
    saveState();
  });

  /* accent colour pickers */
  $("accentLight").addEventListener("input", (e) => {
    state.accents.light = e.target.value;
    applyTheme();
    saveState();
  });
  $("accentDark").addEventListener("input", (e) => {
    state.accents.dark = e.target.value;
    applyTheme();
    saveState();
  });
  $("accentResetBtn").addEventListener("click", () => {
    state.accents = { ...DEFAULT_ACCENTS };
    applyTheme();
    saveState();
  });

  const pToggle = $("particlesToggle");
  pToggle.checked = state.particles;
  pToggle.addEventListener("change", () => {
    state.particles = pToggle.checked;
    saveState();
  });

  $("linkFolderBtn").addEventListener("click", linkFolder);
}

/* ---------- particles (sharp connected lines) ---------- */
const canvas = $("particles");
const ctx = canvas.getContext("2d");
let particles = [];
let particleRGB = "0, 229, 160";
const COUNT = 70;
const LINK_DIST = 140;

function refreshParticleColor() {
  particleRGB = getComputedStyle(document.documentElement).getPropertyValue("--particle").trim() || particleRGB;
}

function resizeCanvas() {
  const wasZero = canvas.width === 0 || canvas.height === 0;
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  if (wasZero && particles.length && canvas.width) initParticles();
}

function initParticles() {
  particles = Array.from({ length: COUNT }, () => ({
    x: Math.random() * canvas.width,
    y: Math.random() * canvas.height,
    vx: (Math.random() - 0.5) * 0.4,
    vy: (Math.random() - 0.5) * 0.4,
    s: Math.random() * 2 + 1
  }));
}

function tick() {
  if (canvas.width !== innerWidth || canvas.height !== innerHeight) resizeCanvas();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (state.particles) {
    for (const p of particles) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
      if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
      /* sharp square particles */
      ctx.fillStyle = `rgba(${particleRGB}, 0.55)`;
      ctx.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
    }
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const a = particles[i], b = particles[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const d = Math.hypot(dx, dy);
        if (d < LINK_DIST) {
          ctx.strokeStyle = `rgba(${particleRGB}, ${0.18 * (1 - d / LINK_DIST)})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
  }
  requestAnimationFrame(tick);
}

/* ---------- boot ---------- */
loadState();
applyTheme();
setupSidebar();
setupAddItem();
setupBoardDnD();
setupSettings();
setupNotes();
setupGoogleSync();
resizeCanvas();
initParticles();
tick();
addEventListener("resize", resizeCanvas);
restoreFolder();

/* seed a starter list on very first run */
if (state.lists.length === 0) {
  const list = {
    id: uid(),
    name: "My First List",
    createdAt: Date.now(),
    notes: [],
    items: [
      { id: uid(), text: "Drag me to reorder", done: false, sub: [] },
      {
        id: uid(), text: "This task has a sublist", done: false,
        sub: [
          { id: uid(), text: "Drag sub-tasks between tasks", done: false },
          { id: uid(), text: "Or drag them out to promote them", done: false }
        ]
      },
      { id: uid(), text: "Drag a task onto a list in the side panel to move it", done: false, sub: [] },
      { id: uid(), text: "Open Settings for themes", done: true, sub: [] }
    ]
  };
  state.lists.push(list);
  state.activeListId = list.id;
}
render();
