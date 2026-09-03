// ==UserScript==
// @name         InfoMentor Dashboard — Capture (Phase 1)
// @namespace    infomentor-dashboard
// @version      0.1.0
// @description  Logs InfoMentor's own network calls so we can learn the real API shape before building the nice dashboard.
// @match        https://hub.infomentor.se/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * PHASE 1 — DISCOVERY ONLY.
 *
 * This script does not change anything you see on the page. It quietly
 * watches every fetch()/XHR call the InfoMentor site itself makes (to
 * infomentor domains only), and lets you inspect + export that log via a
 * small floating panel in the bottom-right corner.
 *
 * Workflow:
 *   1. Install this in Tampermonkey (see ../README.md).
 *   2. Log into hub.infomentor.se as usual (BankID, same as always).
 *   3. Click around: open Lärlogg, open a single post, switch child (top
 *      right), open Kalender, open Information (newsletter), scroll to
 *      trigger pagination.
 *   4. Click the "🧰 IM Capture" button, then "Export JSON".
 *   5. Share the exported shapes back (redact photos/names first — see
 *      the privacy note in the README) so the real fetch/parse logic in
 *      Phase 2 can be built against actual endpoints instead of guesses.
 */

(function () {
  "use strict";

  const DB_NAME = "im-dashboard";
  const DB_VERSION = 1;
  const STORE_CAPTURES = "captures";
  const MAX_BODY_CHARS = 20000;
  // Only log calls to these hosts — keeps out analytics/ad noise.
  const HOST_FILTER = /infomentor/i;

  /** @type {Array<object>} in-memory mirror of the capture log, newest last */
  const captureLog = [];
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_CAPTURES)) {
          const store = db.createObjectStore(STORE_CAPTURES, {
            keyPath: "id",
            autoIncrement: true,
          });
          store.createIndex("ts", "ts");
        }
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta", { keyPath: "key" });
        }
        // Reserved for Phase 2 (parsed data + cached media metadata).
        if (!db.objectStoreNames.contains("entries")) {
          db.createObjectStore("entries", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("media")) {
          db.createObjectStore("media", { keyPath: "url" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function persistCapture(record) {
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_CAPTURES, "readwrite");
        tx.objectStore(STORE_CAPTURES).add(record);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.error("[IM Capture] failed to persist", err);
    }
  }

  async function loadAllCaptures() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CAPTURES, "readonly");
      const req = tx.objectStore(STORE_CAPTURES).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function clearCaptures() {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CAPTURES, "readwrite");
      tx.objectStore(STORE_CAPTURES).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    captureLog.length = 0;
    renderRows();
  }

  function resolveUrl(url) {
    try {
      return new URL(url, window.location.href).href;
    } catch {
      return String(url);
    }
  }

  function truncate(text) {
    if (typeof text !== "string") return text;
    return text.length > MAX_BODY_CHARS
      ? text.slice(0, MAX_BODY_CHARS) + `\n… [truncated, ${text.length} chars total]`
      : text;
  }

  function looksTextual(contentType) {
    if (!contentType) return false;
    return /json|text|xml|javascript/i.test(contentType);
  }

  function logCapture(record) {
    if (!HOST_FILTER.test(record.url)) return;
    record.id = undefined; // let autoIncrement assign it
    captureLog.push(record);
    persistCapture(record);
    bumpBadge();
    if (panelOpen) renderRows();
  }

  // ---- fetch() patch ----------------------------------------------------
  const origFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = resolveUrl(typeof input === "string" ? input : input.url);
    const method =
      (init && init.method) ||
      (input instanceof Request ? input.method : "GET");
    let reqBodyText = null;
    try {
      if (init && init.body != null) {
        reqBodyText =
          typeof init.body === "string"
            ? init.body
            : init.body instanceof URLSearchParams
              ? init.body.toString()
              : "[non-text request body]";
      } else if (input instanceof Request && method !== "GET" && method !== "HEAD") {
        reqBodyText = await input.clone().text();
      }
    } catch {
      /* ignore */
    }

    const ts = Date.now();
    let response;
    try {
      response = await origFetch(input, init);
    } catch (err) {
      logCapture({
        type: "fetch",
        method,
        url,
        ts,
        requestBody: truncate(reqBodyText),
        error: String(err),
      });
      throw err;
    }

    const clone = response.clone();
    const contentType = clone.headers.get("content-type");
    (async () => {
      let responseBody = null;
      if (looksTextual(contentType)) {
        try {
          responseBody = truncate(await clone.text());
        } catch {
          /* ignore */
        }
      }
      logCapture({
        type: "fetch",
        method,
        url,
        ts,
        status: response.status,
        contentType,
        requestBody: truncate(reqBodyText),
        responseBody,
      });
    })();

    return response;
  };

  // ---- XMLHttpRequest patch ---------------------------------------------
  const OrigXHR = window.XMLHttpRequest;
  const origOpen = OrigXHR.prototype.open;
  const origSend = OrigXHR.prototype.send;

  OrigXHR.prototype.open = function (method, url, ...rest) {
    this.__im_method = method;
    this.__im_url = resolveUrl(url);
    return origOpen.call(this, method, url, ...rest);
  };

  OrigXHR.prototype.send = function (body) {
    const ts = Date.now();
    const reqBodyText =
      typeof body === "string" ? body : body ? "[non-text request body]" : null;
    this.addEventListener("loadend", () => {
      try {
        const contentType = this.getResponseHeader("content-type");
        let responseBody = null;
        if (looksTextual(contentType)) {
          try {
            responseBody = truncate(this.responseText);
          } catch {
            /* responseType may not be text */
          }
        }
        logCapture({
          type: "xhr",
          method: this.__im_method,
          url: this.__im_url,
          ts,
          status: this.status,
          contentType,
          requestBody: truncate(reqBodyText),
          responseBody,
        });
      } catch (err) {
        console.error("[IM Capture] xhr log error", err);
      }
    });
    return origSend.call(this, body);
  };

  // ---- minimal UI ---------------------------------------------------------
  let panelOpen = false;

  const style = document.createElement("style");
  style.textContent = `
    #im-capture-btn {
      position: fixed; bottom: 16px; right: 16px; z-index: 999999;
      background: #4b3f8f; color: #fff; border: none; border-radius: 999px;
      padding: 10px 16px; font: 13px/1.2 system-ui, sans-serif; cursor: pointer;
      box-shadow: 0 2px 10px rgba(0,0,0,.3);
    }
    #im-capture-panel {
      position: fixed; top: 0; right: 0; bottom: 0; width: 460px; max-width: 92vw;
      background: #fff; z-index: 999998; box-shadow: -2px 0 16px rgba(0,0,0,.25);
      display: none; flex-direction: column; font: 12px/1.4 system-ui, sans-serif; color: #222;
    }
    #im-capture-panel.open { display: flex; }
    #im-capture-panel header {
      padding: 10px 12px; background: #4b3f8f; color: #fff; display: flex;
      gap: 8px; align-items: center; flex-wrap: wrap;
    }
    #im-capture-panel header button {
      background: #fff2; border: 1px solid #fff5; color: #fff; border-radius: 6px;
      padding: 4px 8px; cursor: pointer; font-size: 11px;
    }
    #im-capture-panel .note {
      padding: 6px 12px; background: #fff3cd; color: #664d03; font-size: 11px;
    }
    #im-capture-filter { flex: 1; min-width: 80px; padding: 4px 6px; border-radius: 6px; border: 1px solid #ccc; }
    #im-capture-rows { overflow-y: auto; flex: 1; }
    .im-row { border-bottom: 1px solid #eee; padding: 6px 10px; cursor: pointer; }
    .im-row:hover { background: #f7f6fd; }
    .im-row-top { display: flex; gap: 6px; align-items: baseline; }
    .im-row-method { font-weight: 700; width: 42px; flex: none; }
    .im-row-url { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .im-row-status { flex: none; padding: 0 5px; border-radius: 4px; color: #fff; font-size: 10px; }
    .im-status-ok { background: #2e7d32; }
    .im-status-err { background: #c62828; }
    .im-status-none { background: #999; }
    .im-row pre { white-space: pre-wrap; word-break: break-all; background: #f4f4f7; padding: 6px; border-radius: 6px; margin: 6px 0 0; max-height: 240px; overflow: auto; }
  `;
  document.documentElement.appendChild(style);

  const btn = document.createElement("button");
  btn.id = "im-capture-btn";
  btn.textContent = "🧰 IM Capture (0)";
  document.documentElement.appendChild(btn);

  const panel = document.createElement("div");
  panel.id = "im-capture-panel";
  panel.innerHTML = `
    <header>
      <strong>IM Capture</strong>
      <input id="im-capture-filter" placeholder="filter by url…" />
      <button data-act="export">Export JSON</button>
      <button data-act="clear">Clear</button>
      <button data-act="close">✕</button>
    </header>
    <div class="note">Log may contain your kids' names/photo URLs/text. Don't commit or share the raw export — redact first.</div>
    <div id="im-capture-rows"></div>
  `;
  document.documentElement.appendChild(panel);

  btn.addEventListener("click", async () => {
    panelOpen = !panelOpen;
    panel.classList.toggle("open", panelOpen);
    if (panelOpen && captureLog.length === 0) {
      const stored = await loadAllCaptures();
      captureLog.push(...stored);
    }
    renderRows();
  });

  panel.querySelector('[data-act="close"]').addEventListener("click", () => {
    panelOpen = false;
    panel.classList.remove("open");
  });

  panel.querySelector('[data-act="clear"]').addEventListener("click", async () => {
    if (confirm("Clear the whole capture log?")) await clearCaptures();
  });

  panel.querySelector('[data-act="export"]').addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(captureLog, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `im-capture-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  const filterInput = panel.querySelector("#im-capture-filter");
  filterInput.addEventListener("input", renderRows);

  function bumpBadge() {
    btn.textContent = `🧰 IM Capture (${captureLog.length})`;
  }

  function statusClass(status) {
    if (!status) return "im-status-none";
    return status >= 200 && status < 400 ? "im-status-ok" : "im-status-err";
  }

  function renderRows() {
    const rowsEl = panel.querySelector("#im-capture-rows");
    const filter = filterInput.value.trim().toLowerCase();
    rowsEl.innerHTML = "";
    const items = filter
      ? captureLog.filter((c) => c.url.toLowerCase().includes(filter))
      : captureLog;

    for (const c of items.slice().reverse()) {
      const row = document.createElement("div");
      row.className = "im-row";
      const path = c.url.replace(window.location.origin, "");
      row.innerHTML = `
        <div class="im-row-top">
          <span class="im-row-method">${c.method || ""}</span>
          <span class="im-row-url" title="${c.url}">${path}</span>
          <span class="im-row-status ${statusClass(c.status)}">${c.status ?? (c.error ? "ERR" : "…")}</span>
        </div>
      `;
      const details = document.createElement("div");
      details.style.display = "none";
      details.innerHTML = `
        ${c.requestBody ? `<div><em>request:</em><pre>${escapeHtml(pretty(c.requestBody))}</pre></div>` : ""}
        ${c.responseBody ? `<div><em>response:</em><pre>${escapeHtml(pretty(c.responseBody))}</pre></div>` : ""}
        ${c.error ? `<div><em>error:</em><pre>${escapeHtml(c.error)}</pre></div>` : ""}
        ${!c.requestBody && !c.responseBody && !c.error ? `<div style="color:#888">(no captured body — likely binary, e.g. an image/video)</div>` : ""}
      `;
      row.appendChild(details);
      row.addEventListener("click", () => {
        details.style.display = details.style.display === "none" ? "block" : "none";
      });
      rowsEl.appendChild(row);
    }
  }

  function pretty(text) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }

  function escapeHtml(s) {
    return s.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
  }

  bumpBadge();
  console.info("[IM Capture] active — watching infomentor network calls.");
})();
