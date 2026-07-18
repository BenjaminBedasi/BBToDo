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
  lists: [] // {id, name, createdAt, items:[{id, text, done, sub:[{id, text, done}]}]}
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) state = Object.assign(state, JSON.parse(raw));
  } catch (e) { console.warn("Could not load saved data", e); }
  state.accents = Object.assign({ ...DEFAULT_ACCENTS }, state.accents);
}

let saveTimer = null;
function saveState() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveToDisk, 600); // debounced file write
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
    await saveToDisk();
    updateStorageStatus();
  } catch (e) { /* user cancelled */ }
}

async function restoreFolder() {
  try {
    const h = await idbGet("dir");
    if (!h) return;
    const perm = await h.queryPermission({ mode: "readwrite" });
    if (perm === "granted") dirHandle = h;
    else if (perm === "prompt") {
      // re-request on first user interaction
      const once = async () => {
        document.removeEventListener("pointerdown", once);
        try {
          if ((await h.requestPermission({ mode: "readwrite" })) === "granted") {
            dirHandle = h;
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

/* ---------- rendering ---------- */
function render() {
  renderSidebar();
  renderBoard();
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
    render();
  });
  row.querySelector(".del").addEventListener("click", () => {
    list.items = list.items.filter((i) => i.id !== item.id);
    render();
  });
  makeEditable(row.querySelector(".item-text"), (txt) => { item.text = txt; render(); });

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
    <div class="item-actions">
      <button class="act-btn del" title="Delete">DEL</button>
    </div>`;
  el.querySelector(".item-text").textContent = s.text;

  el.querySelector(".chk").addEventListener("change", (e) => {
    s.done = e.target.checked;
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
    const list = { id: uid(), name, createdAt: Date.now(), items: [] };
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
