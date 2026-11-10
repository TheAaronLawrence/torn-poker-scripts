// ==UserScript==
// @name         Torn Poker Recorder
// @namespace    torn-poker
// @version      1.0.0
// @match        https://www.torn.com/page.php?sid=holdem*
// @run-at       document-start
// @sandbox      JavaScript
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// ==/UserScript==

"use strict";
(() => {
  // src/recorder/scrub.ts
  var JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
  var SECRET_KEY_RE = /token|secret|passw|jwt|csrf|rfcv|^session(?:id|_id|key)?$|^auth(?:orization|token|_token|key)?$|^sig(?:nature)?$/i;
  var ALREADY_REDACTED_RE = /^<REDACTED(?::[0-9a-f]{8})?>$/;
  var KV_RE = /"([^"\\]*)"(\s*:\s*)("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  var KV_ESC_RE = /\\"([^"\\]*)\\"(\s*:\s*)\\"((?:[^\\]|\\(?!"))*?)\\"/g;
  var redactions = 0;
  function fnv1a(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }
  function tag(value) {
    if (typeof value === "string" && ALREADY_REDACTED_RE.test(value)) return value;
    redactions++;
    const s = typeof value === "string" ? value : String(JSON.stringify(value));
    return `<REDACTED:${fnv1a(s)}>`;
  }
  function decodeJsonString(body, levels) {
    try {
      let s = body;
      for (let i = 0; i < levels; i++) s = JSON.parse(`"${s}"`);
      return s;
    } catch {
      return body;
    }
  }
  function scrubString(s) {
    return s.replace(JWT_RE, (m) => tag(m)).replace(KV_RE, (m, key, sep, raw) => {
      if (!SECRET_KEY_RE.test(key)) return m;
      const value = raw.startsWith('"') ? decodeJsonString(raw.slice(1, -1), 1) : Number(raw);
      return `"${key}"${sep}"${tag(value)}"`;
    }).replace(
      KV_ESC_RE,
      (m, key, sep, raw) => SECRET_KEY_RE.test(key) ? `\\"${key}\\"${sep}\\"${tag(decodeJsonString(raw, 2))}\\"` : m
    );
  }
  function scrubValue(v) {
    if (typeof v === "string") return scrubString(v);
    if (Array.isArray(v)) return v.map(scrubValue);
    if (v !== null && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = SECRET_KEY_RE.test(k) ? tag(val) : scrubValue(val);
      }
      return out;
    }
    return v;
  }
  function scrubUnit(text, fallback) {
    const before = redactions;
    let out;
    try {
      out = JSON.stringify(scrubValue(JSON.parse(text)));
    } catch {
      out = fallback(text);
    }
    return redactions === before ? text : out;
  }
  function scrubText(text) {
    try {
      return scrubUnit(text, (t) => t.split("\n").map((line) => scrubUnit(line, scrubString)).join("\n"));
    } catch (err) {
      console.warn("[torn-poker] scrub failed", err);
      return "<REDACTED:scrub-failed>";
    }
  }

  // src/recorder/log.ts
  var KEY = "capture-log";
  var SAVE_DELAY_MS = 3e4;
  function isEntry(v) {
    if (v === null || typeof v !== "object") return false;
    const e = v;
    return typeof e.t === "number" && Number.isFinite(e.t) && typeof e.data === "string";
  }
  var CaptureLog = class {
    constructor(store2, opts = {}) {
      this.store = store2;
      this.cap = opts.cap ?? 2e4;
      this.maxBytes = opts.maxBytes ?? 15e6;
      let stored;
      try {
        stored = store2.get(KEY);
      } catch (err) {
        console.warn("[torn-poker] failed to read capture log", err);
      }
      if (Array.isArray(stored)) {
        this.entries = stored.filter(isEntry);
        for (const e of this.entries) this.bytes += e.data.length;
        this.trim();
        this.compact();
      }
    }
    store;
    // Live entries are entries[head..]; dropped ones are compacted away in batches.
    entries = [];
    head = 0;
    bytes = 0;
    cap;
    maxBytes;
    timer = null;
    add(e) {
      const data = scrubText(e.data);
      this.entries.push({ ...e, data });
      this.bytes += data.length;
      this.trim();
      if (this.head > 1024 && this.head * 2 > this.entries.length) this.compact();
      if (this.timer === null) this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    }
    trim() {
      while (this.count() > 0 && (this.count() > this.cap || this.bytes > this.maxBytes)) {
        this.bytes -= this.entries[this.head].data.length;
        this.head++;
      }
    }
    compact() {
      if (this.head > 0) {
        this.entries = this.entries.slice(this.head);
        this.head = 0;
      }
    }
    flush() {
      this.cancelTimer();
      this.compact();
      try {
        this.store.set(KEY, this.entries);
      } catch (err) {
        console.warn("[torn-poker] failed to save capture log", err);
      }
    }
    count() {
      return this.entries.length - this.head;
    }
    lastAt() {
      return this.count() ? this.entries[this.entries.length - 1].t : null;
    }
    clear() {
      this.cancelTimer();
      this.entries = [];
      this.head = 0;
      this.bytes = 0;
      try {
        this.store.del(KEY);
      } catch (err) {
        console.warn("[torn-poker] failed to clear capture log", err);
      }
    }
    exportJSON(meta) {
      const out = {
        version: 1,
        exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
        userID: meta.userID,
        bundle: meta.bundle,
        entries: this.entries.slice(this.head)
      };
      return JSON.stringify(JSON.parse(scrubText(JSON.stringify(out))), null, 2);
    }
    cancelTimer() {
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    }
  };

  // src/table/page-source.ts
  var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
  var isStore = (v) => isObj(v) && typeof v.getState === "function" && typeof v.subscribe === "function";
  function findStore(doc) {
    const root = doc.querySelector('[class*="holdemWrapper"]');
    if (!root) return null;
    const key = Object.keys(root).find((k) => k.startsWith("__reactFiber"));
    let fiber = key ? root[key] : null;
    for (let depth = 0; isObj(fiber) && depth < 50; depth++) {
      const props = fiber.memoizedProps;
      if (isObj(props)) {
        if (isStore(props.store)) return props.store;
        if (isObj(props.value) && isStore(props.value.store)) return props.value.store;
      }
      fiber = fiber.return;
    }
    return null;
  }
  var NOISE = /* @__PURE__ */ new Set(["timeleft", "timebank"]);
  function createPageReader() {
    let tableToken = null;
    let last = "";
    let lastToken = null;
    let lastTable = "";
    return {
      read(state) {
        if (!isObj(state) || !isObj(state.table) || !isObj(state.players) || !isObj(state.self)) return null;
        const { table, players, self } = state;
        if (table.tableDataLoaded === false) return null;
        const ids = isObj(self.handIDs) ? self.handIDs : {};
        const current = typeof ids.currentHandID === "string" && ids.currentHandID !== "" ? ids.currentHandID : null;
        if (current === null) return null;
        if (tableToken === null || table.phase !== "ended") tableToken = current;
        const fields = Object.fromEntries(Object.entries(table).filter(([k]) => !NOISE.has(k)));
        const seated = Object.fromEntries(Object.entries(players).filter(([, p]) => isObj(p) && p.userID !== void 0));
        const body = { ...fields, table: table.tableID, token: tableToken, players: seated, hand: self.hand, holeToken: current };
        const key = JSON.stringify(body);
        if (key === last) return null;
        const tableKey = JSON.stringify(fields);
        const moved = tableToken === lastToken && tableKey !== lastTable;
        last = key;
        lastToken = tableToken;
        lastTable = tableKey;
        const eventType = moved && typeof table.userAction === "string" && table.userAction !== "" ? "playerMakeMove" : "getState";
        return { src: "page", url: "store", data: JSON.stringify({ eventType, ...body }) };
      }
    };
  }
  function watchStore(store2, onFrame) {
    const reader = createPageReader();
    const pump = () => {
      try {
        const f = reader.read(store2.getState());
        if (f) onFrame(f);
      } catch (e) {
        console.warn("[torn-poker] page read failed", e);
      }
    };
    pump();
    return store2.subscribe(pump);
  }
  function watchPage(doc, onFrame, everyMs = 500) {
    const attempt = () => {
      const store2 = findStore(doc);
      if (store2) watchStore(store2, onFrame);
      else setTimeout(attempt, everyMs);
    };
    attempt();
  }

  // src/recorder/badge.ts
  var POS_KEY = "tp-recorder-pos";
  var WARN_AFTER_MS = 3e4;
  function loadPos() {
    try {
      const p = JSON.parse(localStorage.getItem(POS_KEY) ?? "null");
      if (p && Number.isFinite(p.left) && Number.isFinite(p.top)) return p;
    } catch {
    }
    return null;
  }
  function savePos(left, top) {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({ left, top }));
    } catch {
    }
  }
  function restorePos(root) {
    const pos = loadPos();
    if (!pos) return;
    try {
      const win = root.ownerDocument.defaultView;
      const maxLeft = Math.max(0, (win?.innerWidth ?? Infinity) - root.offsetWidth);
      const maxTop = Math.max(0, (win?.innerHeight ?? Infinity) - root.offsetHeight);
      root.style.left = `${Math.min(Math.max(0, pos.left), maxLeft)}px`;
      root.style.top = `${Math.min(Math.max(0, pos.top), maxTop)}px`;
      root.style.bottom = "auto";
    } catch (e) {
      console.warn("[torn-poker] badge position restore failed", e);
    }
  }
  function mountBadge(doc, log2, opts) {
    const root = doc.createElement("div");
    root.id = "tp-recorder-badge";
    root.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:2147483000;background:#1b1b1b;color:#eee;font:11px sans-serif;padding:4px 8px;border-radius:4px;display:flex;gap:8px;align-items:center;";
    const label = doc.createElement("span");
    label.style.cssText = "cursor:move;user-select:none;";
    const mkBtn = (text, onClick) => {
      const b = doc.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.style.cssText = "font:11px sans-serif;padding:1px 6px;cursor:pointer;";
      b.addEventListener("click", onClick);
      return b;
    };
    root.append(
      label,
      mkBtn("Export", () => {
        try {
          opts.onExport();
        } catch (e) {
          console.warn("[torn-poker] export failed", e);
        }
      }),
      mkBtn("Clear", () => {
        if (confirm("Clear captured frames?")) {
          log2.clear();
          refresh();
        }
      })
    );
    function refresh() {
      try {
        const n = log2.count();
        const last = log2.lastAt();
        const noneThisLoad = last === null || last < opts.startedAt;
        const warn = noneThisLoad && opts.now() - opts.startedAt > WARN_AFTER_MS;
        label.textContent = warn ? "\u25CF REC no frames yet" : `\u25CF REC ${n.toLocaleString("en-US")} frames`;
        label.style.color = warn ? "#f0a030" : "#eee";
      } catch (e) {
        console.warn("[torn-poker] badge refresh failed", e);
      }
    }
    label.addEventListener("mousedown", (down) => {
      const rect = root.getBoundingClientRect();
      const dx = down.clientX - rect.left;
      const dy = down.clientY - rect.top;
      down.preventDefault();
      down.stopPropagation();
      let moved = false;
      const move = (e) => {
        e.stopPropagation();
        moved = true;
        root.style.left = `${e.clientX - dx}px`;
        root.style.top = `${e.clientY - dy}px`;
        root.style.bottom = "auto";
      };
      const up = (e) => {
        e.stopPropagation();
        doc.removeEventListener("mousemove", move, true);
        doc.removeEventListener("mouseup", up, true);
        if (moved) savePos(parseFloat(root.style.left), parseFloat(root.style.top));
      };
      doc.addEventListener("mousemove", move, true);
      doc.addEventListener("mouseup", up, true);
    });
    doc.body.appendChild(root);
    refresh();
    restorePos(root);
    setInterval(refresh, 1e3);
    return { refresh };
  }

  // src/recorder/main.ts
  console.info("[torn-poker] recorder loaded");
  var store = {
    get: (k) => GM_getValue(k),
    set: (k, v) => GM_setValue(k, v),
    del: (k) => GM_deleteValue(k)
  };
  var log = new CaptureLog(store);
  var startedAt = Date.now();
  watchPage(unsafeWindow.document, (f) => log.add({ ...f, t: Date.now() }));
  function readUserID() {
    try {
      const el = document.getElementById("torn-user");
      if (!el) return null;
      const id = JSON.parse(el.value)?.id;
      return id == null ? null : String(id);
    } catch {
      return null;
    }
  }
  function readBundle() {
    const s = [...document.scripts].find((x) => /\/builds\/holdem\/app\./.test(x.src));
    return s ? s.src : null;
  }
  function exportCapture() {
    const json = log.exportJSON({ userID: readUserID(), bundle: readBundle() });
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `torn-poker-capture-${(/* @__PURE__ */ new Date()).toISOString()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1e3);
  }
  function mount() {
    try {
      mountBadge(document, log, { now: Date.now, startedAt, onExport: exportCapture });
    } catch (e) {
      console.warn("[torn-poker] badge mount failed", e);
    }
  }
  if (document.readyState !== "loading") mount();
  else document.addEventListener("DOMContentLoaded", mount);
  window.addEventListener("pagehide", () => {
    try {
      log.flush();
    } catch (e) {
      console.warn("[torn-poker] flush failed", e);
    }
  });
})();
