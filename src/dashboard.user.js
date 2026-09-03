// ==UserScript==
// @name         InfoMentor Dashboard
// @namespace    infomentor-dashboard
// @version      0.1.0
// @description  A faster, calmer view of InfoMentor's Lärlogg, calendar and newsletters, cached locally.
// @match        https://hub.infomentor.se/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * PHASE 2 — the real dashboard.
 *
 * Install this INSTEAD OF src/capture.user.js (disable that one in
 * Tampermonkey; keep the file around in case we need to re-capture
 * something later).
 *
 * Endpoints below were confirmed from a real capture on 2026-09-03.
 * See README.md for the full endpoint reference and the pupil-ID
 * caveat (InfoMentor uses at least two unrelated ID schemes for the
 * same child — see "Multiple pupils" section).
 */

(function () {
  "use strict";

  // ------------------------------------------------------------------
  // CONFIG
  // ------------------------------------------------------------------

  const DB_NAME = "im-dashboard";
  const DB_VERSION = 2;

  const LEARNLOG_PAGE_SIZE = 25;
  const LEARNLOG_MAX_PAGES = 8; // safety cap per sync
  const CALENDAR_DAYS_BACK = 14;
  const CALENDAR_DAYS_FORWARD = 45;

  // ------------------------------------------------------------------
  // IndexedDB layer
  // ------------------------------------------------------------------

  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        const ensure = (name, opts) => {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, opts);
        };
        // Left over from the Phase 1 capture script — harmless if unused.
        ensure("captures", { keyPath: "id", autoIncrement: true });
        ensure("meta", { keyPath: "key" });

        ensure("pupils", { keyPath: "switchId" });

        ensure("learnlogEntries", { keyPath: "id" });
        ensure("calendarEntries", { keyPath: "id" });
        ensure("newsItems", { keyPath: "id" });
        ensure("documents", { keyPath: "id" });

        for (const name of ["learnlogEntries", "calendarEntries", "newsItems", "documents"]) {
          const store = req.transaction.objectStore(name);
          if (!store.indexNames.contains("pupilKey")) {
            store.createIndex("pupilKey", "pupilKey", { unique: false });
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function idbPut(store, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbGet(store, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGetAll(store) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGetAllByIndex(store, indexName, query) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).index(indexName).getAll(query);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbDelete(store, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ------------------------------------------------------------------
  // API client
  // ------------------------------------------------------------------

  class SessionExpiredError extends Error {}

  function assertLoggedIn(res) {
    // A session timeout redirects GET/POST calls to an HTML login page
    // instead of returning JSON.
    const ct = res.headers.get("content-type") || "";
    if (res.status === 401 || res.status === 403) throw new SessionExpiredError();
    if (/text\/html/i.test(ct)) throw new SessionExpiredError();
    return res;
  }

  async function apiGet(path) {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
    assertLoggedIn(res);
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
    return res.json();
  }

  async function apiPost(path, body) {
    const res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    assertLoggedIn(res);
    if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
    return res.json();
  }

  /** Switches the session's "current pupil" — a plain navigation-style GET,
   *  fetched here instead of actually navigating the tab. */
  async function switchPupil(switchId) {
    const res = await fetch(`/Account/PupilSwitcher/SwitchPupil/${switchId}`, {
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error(`switchPupil(${switchId}) failed: ${res.status}`);
    return true;
  }

  async function getCommunicationAppData() {
    return apiPost("/communication/communication/appData");
  }

  async function getLearnlogs(pageNumber, pageSize, learnLogType = 0) {
    return apiGet(
      `/learnlog/learnlog/getlearnlogs?learnLogType=${learnLogType}&pageNumber=${pageNumber}&pageSize=${pageSize}`,
    );
  }

  async function getCalendarAppData() {
    return apiPost("/calendarv2/calendarv2/appData");
  }

  async function getCalendarEntries(startDate, endDate) {
    return apiPost("/calendarv2/calendarv2/getentries", { startDate, endDate });
  }

  async function getNews() {
    return apiPost("/Communication/News/GetNewsList", {
      pageSize: -1,
      sortBy: "lastPublishDate___SORT_DESC",
    });
  }

  async function getDocuments(page, pageSize) {
    return apiPost("/Communication/Documents/GetDocumentsList", {
      typeIds: "",
      sortBy: "lastPublishDate___SORT_DESC",
      page,
      pageSize,
    });
  }

  // ------------------------------------------------------------------
  // Normalizers
  // ------------------------------------------------------------------

  function normalizeLearnlog(e, pupilKey) {
    return {
      id: e.id,
      pupilKey,
      title: e.title,
      text: e.text,
      groupName: e.groupName,
      lastModifiedOn: e.lastModifiedOn,
      subjectsCoursesDisplayString: e.subjectsCoursesDisplayString || "",
      media: (e.media || []).map((m) => ({
        fileId: m.fileId,
        fileType: m.fileType, // "Image" | "Video" (confirm as more data comes in)
        fileExtension: m.fileExtension,
        thumbnailUrl: m.thumbnailUrl,
        fileUrl: m.fileUrl,
      })),
      fetchedAt: Date.now(),
    };
  }

  function normalizeCalendar(e, pupilKey) {
    return {
      id: e.id,
      pupilKey,
      title: e.title,
      text: e.text || "",
      description: e.description || "",
      calendarEntryTypeId: e.calendarEntryTypeId,
      isAllDayEvent: e.isAllDayEvent,
      startDateFull: e.startDateFull,
      endDateFull: e.endDateFull,
      formattedStartDate: e.formattedStartDate,
      formattedEndDate: e.formattedEndDate,
      fetchedAt: Date.now(),
    };
  }

  function normalizeNews(e, pupilKey) {
    return {
      id: e.id,
      pupilKey,
      title: e.title,
      content: e.content,
      publishedDate: e.publishedDate,
      publishedDateString: e.publishedDateString,
      publishedBy: e.publishedBy,
      newsImageUrl: e.newsImageUrl || "",
      newsThumbnailImageUrl: e.newsThumbnailImageUrl || "",
      fetchedAt: Date.now(),
    };
  }

  function normalizeDocument(e, pupilKey) {
    return {
      id: e.id,
      pupilKey,
      title: e.title,
      type: e.type,
      fileType: e.fileType,
      fileSize: e.fileSize,
      fileUrl: e.fileUrl,
      publishedDateString: e.publishedDateString,
      fetchedAt: Date.now(),
    };
  }

  // ------------------------------------------------------------------
  // Sync orchestration
  // ------------------------------------------------------------------

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function fmtCalendarDate(d) {
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  }

  function calendarWindow() {
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - CALENDAR_DAYS_BACK);
    const end = new Date(today);
    end.setDate(end.getDate() + CALENDAR_DAYS_FORWARD);
    return { startDate: fmtCalendarDate(start), endDate: fmtCalendarDate(end) };
  }

  async function syncPupil(pupil) {
    await switchPupil(pupil.switchId);

    const appData = await getCommunicationAppData();
    const im2Id = appData?.consentViewConfig?.pupilIM2Id ?? null;
    await idbPut("pupils", { ...pupil, im2Id, lastSyncedAt: Date.now() });

    // Lärlogg — incremental: stop once a page brings back only entries we
    // already have cached.
    let learnlogNew = 0;
    for (let page = 1; page <= LEARNLOG_MAX_PAGES; page++) {
      const batch = await getLearnlogs(page, LEARNLOG_PAGE_SIZE);
      if (!batch || batch.length === 0) break;
      let allKnown = true;
      for (const e of batch) {
        const existed = await idbGet("learnlogEntries", e.id);
        if (!existed) {
          learnlogNew++;
          allKnown = false;
        }
        await idbPut("learnlogEntries", normalizeLearnlog(e, pupil.switchId));
      }
      if (page > 1 && allKnown) break;
    }

    // Calendar — small bounded window, just replace what's in range.
    const { startDate, endDate } = calendarWindow();
    const calEntries = await getCalendarEntries(startDate, endDate);
    for (const e of calEntries) await idbPut("calendarEntries", normalizeCalendar(e, pupil.switchId));

    // Calendar entry-type colours (cheap, used for chip colours).
    try {
      const calAppData = await getCalendarAppData();
      await idbPut("meta", {
        key: `calendarEntryTypes:${pupil.switchId}`,
        value: calAppData.calendarEntryTypes || [],
      });
    } catch {
      /* non-critical */
    }

    // News
    const news = await getNews();
    for (const n of news.items || []) await idbPut("newsItems", normalizeNews(n, pupil.switchId));

    // Documents
    const docs = await getDocuments(1, 50);
    for (const d of docs.items || []) await idbPut("documents", normalizeDocument(d, pupil.switchId));

    return {
      switchId: pupil.switchId,
      im2Id,
      learnlogNew,
      calendarCount: calEntries.length,
      newsCount: (news.items || []).length,
      docCount: (docs.items || []).length,
    };
  }

  let syncing = false;
  async function syncAll(onStatus) {
    if (syncing) return;
    syncing = true;
    try {
      const pupils = await idbGetAll("pupils");
      const results = [];
      for (const p of pupils) {
        onStatus?.(`Syncing ${p.name || p.switchId}…`);
        try {
          results.push(await syncPupil(p));
        } catch (err) {
          if (err instanceof SessionExpiredError) throw err;
          console.error("[IM Dashboard] sync failed for", p, err);
          results.push({ switchId: p.switchId, error: String(err) });
        }
      }
      await idbPut("meta", { key: "lastFullSyncAt", value: Date.now() });
      return results;
    } finally {
      syncing = false;
    }
  }

  // ------------------------------------------------------------------
  // Media URLs — same-origin, so <img>/<video> can point at them
  // directly and let the browser fetch + cache them natively. (An
  // earlier version routed these through fetch()+Cache Storage+
  // createObjectURL, but InfoMentor's CSP doesn't allow `blob:` in
  // img-src, so that rendered as broken images.)
  //
  // Note: the thumbnail endpoint only serves pre-generated sizes —
  // whatever width/height InfoMentor's own UI happened to request
  // (100x100 in our capture) — not arbitrary on-the-fly resizing.
  // Rewriting width/height to a size it doesn't have returns 200 OK
  // with an empty body instead of an image, so we use each media
  // item's thumbnailUrl exactly as given, unmodified.
  // ------------------------------------------------------------------

  function resolveMediaUrl(relativeUrl) {
    return new URL(relativeUrl, location.origin).href;
  }

  // ------------------------------------------------------------------
  // UI
  // ------------------------------------------------------------------

  const style = document.createElement("style");
  style.textContent = `
    #im-dash-btn {
      position: fixed; bottom: 16px; right: 16px; z-index: 999999;
      background: #4b3f8f; color: #fff; border: none; border-radius: 999px;
      padding: 10px 18px; font: 13px/1.2 system-ui, sans-serif; cursor: pointer;
      box-shadow: 0 2px 10px rgba(0,0,0,.3);
    }
    #im-dash-overlay {
      position: fixed; inset: 0; z-index: 999997; background: #f4f3fa;
      display: none; flex-direction: column; font: 14px/1.5 system-ui, sans-serif; color: #232323;
    }
    #im-dash-overlay.open { display: flex; }
    #im-dash-header {
      background: #4b3f8f; color: #fff; padding: 10px 16px;
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    }
    #im-dash-header h1 { font-size: 15px; margin: 0; font-weight: 700; }
    .im-pupil-tab, .im-section-tab {
      background: #ffffff22; border: 1px solid #ffffff44; color: #fff;
      border-radius: 8px; padding: 5px 12px; cursor: pointer; font-size: 13px;
    }
    .im-pupil-tab.active, .im-section-tab.active { background: #fff; color: #4b3f8f; font-weight: 700; }
    #im-dash-header .spacer { flex: 1; }
    #im-dash-header button.action {
      background: #ffb703; color: #3a2a00; border: none; border-radius: 8px;
      padding: 6px 12px; cursor: pointer; font-weight: 700; font-size: 12px;
    }
    #im-dash-header .status { font-size: 12px; opacity: .85; }
    #im-dash-header button.icon {
      background: transparent; border: none; color: #fff; font-size: 16px; cursor: pointer;
    }
    #im-dash-body { flex: 1; overflow-y: auto; padding: 20px; max-width: 900px; margin: 0 auto; width: 100%; box-sizing: border-box; }
    .im-card {
      background: #fff; border-radius: 12px; padding: 16px 18px; margin-bottom: 14px;
      box-shadow: 0 1px 4px rgba(0,0,0,.08);
    }
    .im-card .im-meta { font-size: 12px; color: #7a7a7a; display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
    .im-pill { background: #ece9fb; color: #4b3f8f; border-radius: 999px; padding: 1px 9px; font-size: 11px; font-weight: 700; }
    .im-new-badge { background: #d81b60; color: #fff; border-radius: 999px; padding: 1px 8px; font-size: 10px; font-weight: 700; }
    .im-card h3 { margin: 0 0 6px; font-size: 15px; }
    .im-card .im-text { }
    .im-media-grid { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .im-media-grid .im-thumb {
      width: 96px; height: 96px; border-radius: 8px; object-fit: cover; cursor: pointer;
      background: #eee;
    }
    .im-media-grid .im-thumb.im-thumb-broken { object-fit: contain; opacity: .4; }
    .im-empty { text-align: center; color: #777; padding: 60px 20px; }
    .im-empty input { padding: 6px 8px; border-radius: 6px; border: 1px solid #ccc; margin: 4px; }
    .im-empty button { padding: 6px 12px; border-radius: 6px; border: none; background: #4b3f8f; color: #fff; cursor: pointer; }
    #im-lightbox {
      position: fixed; inset: 0; background: #000d; z-index: 999999;
      display: none; align-items: center; justify-content: center;
    }
    #im-lightbox.open { display: flex; }
    #im-lightbox img, #im-lightbox video { max-width: 92vw; max-height: 92vh; border-radius: 8px; }
    .im-day-group { margin-bottom: 16px; }
    .im-day-group h4 { margin: 0 0 6px; font-size: 13px; color: #555; text-transform: capitalize; }
    .im-cal-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-top: 1px solid #f0f0f0; }
    .im-cal-row:first-child { border-top: none; }
    .im-cal-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
    .im-doc-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-top: 1px solid #f0f0f0; }
    .im-doc-row:first-child { border-top: none; }
    .im-doc-row a { color: #4b3f8f; font-weight: 600; text-decoration: none; }
    .im-settings-list { display: flex; flex-direction: column; gap: 6px; margin: 10px 0; }
    .im-settings-row { display: flex; gap: 8px; align-items: center; font-size: 13px; }
    .im-settings-row button { border: none; background: #eee; border-radius: 6px; padding: 2px 8px; cursor: pointer; }
  `;
  document.documentElement.appendChild(style);

  const btn = document.createElement("button");
  btn.id = "im-dash-btn";
  btn.textContent = "📋 Dashboard";
  document.documentElement.appendChild(btn);

  const overlay = document.createElement("div");
  overlay.id = "im-dash-overlay";
  overlay.innerHTML = `
    <div id="im-dash-header">
      <h1>InfoMentor Dashboard</h1>
      <div id="im-pupil-tabs"></div>
      <div id="im-section-tabs"></div>
      <div class="spacer"></div>
      <span class="status" id="im-status"></span>
      <button class="action" data-act="sync">🔄 Sync</button>
      <button class="icon" data-act="settings" title="Manage children">⚙️</button>
      <button class="icon" data-act="close" title="Close">✕</button>
    </div>
    <div id="im-dash-body"></div>
  `;
  document.documentElement.appendChild(overlay);

  const lightbox = document.createElement("div");
  lightbox.id = "im-lightbox";
  document.documentElement.appendChild(lightbox);
  lightbox.addEventListener("click", () => {
    lightbox.classList.remove("open");
    lightbox.innerHTML = "";
  });

  let activePupil = null; // switchId
  let activeSection = "learnlog";

  btn.addEventListener("click", async () => {
    overlay.classList.add("open");
    await refreshTabsAndRender();
  });

  overlay.querySelector('[data-act="close"]').addEventListener("click", () => {
    overlay.classList.remove("open");
  });

  overlay.querySelector('[data-act="sync"]').addEventListener("click", async () => {
    const statusEl = overlay.querySelector("#im-status");
    try {
      const results = await syncAll((msg) => (statusEl.textContent = msg));
      statusEl.textContent = "Synced " + new Date().toLocaleTimeString("sv-SE");
      console.info("[IM Dashboard] sync results", results);
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        statusEl.textContent = "⚠️ Session expired — log into InfoMentor in this tab, then sync again.";
      } else {
        statusEl.textContent = "⚠️ Sync failed — see console.";
        console.error(err);
      }
    }
    await refreshTabsAndRender();
  });

  overlay.querySelector('[data-act="settings"]').addEventListener("click", () => {
    renderSettings();
  });

  async function refreshTabsAndRender() {
    const pupils = await idbGetAll("pupils");
    const pupilTabsEl = overlay.querySelector("#im-pupil-tabs");
    pupilTabsEl.innerHTML = "";

    if (pupils.length === 0) {
      renderSettings();
      return;
    }

    if (!activePupil || !pupils.some((p) => p.switchId === activePupil)) {
      activePupil = pupils[0].switchId;
    }

    for (const p of pupils) {
      const tab = document.createElement("button");
      tab.className = "im-pupil-tab" + (p.switchId === activePupil ? " active" : "");
      tab.textContent = p.name || `Pupil ${p.switchId}`;
      tab.addEventListener("click", () => {
        activePupil = p.switchId;
        refreshTabsAndRender();
      });
      pupilTabsEl.appendChild(tab);
    }

    const sectionTabsEl = overlay.querySelector("#im-section-tabs");
    sectionTabsEl.innerHTML = "";
    const sections = [
      ["learnlog", "Lärlogg"],
      ["calendar", "Kalender"],
      ["news", "Nyheter"],
      ["documents", "Dokument"],
    ];
    for (const [key, label] of sections) {
      const tab = document.createElement("button");
      tab.className = "im-section-tab" + (key === activeSection ? " active" : "");
      tab.textContent = label;
      tab.addEventListener("click", () => {
        activeSection = key;
        renderBody();
      });
      sectionTabsEl.appendChild(tab);
    }

    renderBody();
  }

  async function renderBody() {
    const body = overlay.querySelector("#im-dash-body");
    body.innerHTML = "";
    if (!activePupil) return;

    if (activeSection === "learnlog") await renderLearnlog(body, activePupil);
    else if (activeSection === "calendar") await renderCalendar(body, activePupil);
    else if (activeSection === "news") await renderNews(body, activePupil);
    else if (activeSection === "documents") await renderDocuments(body, activePupil);
  }

  async function renderLearnlog(body, pupilKey) {
    const entries = (await idbGetAllByIndex("learnlogEntries", "pupilKey", pupilKey)).sort(
      (a, b) => b.id - a.id,
    );
    if (entries.length === 0) {
      body.innerHTML = `<div class="im-empty">No Lärlogg entries cached yet. Hit 🔄 Sync.</div>`;
      return;
    }
    for (const e of entries) {
      const card = document.createElement("div");
      card.className = "im-card";
      card.innerHTML = `
        <div class="im-meta">
          <span>${escapeHtml(e.lastModifiedOn || "")}</span>
          ${e.groupName ? `<span class="im-pill">${escapeHtml(e.groupName)}</span>` : ""}
        </div>
        <h3>${escapeHtml(e.title || "")}</h3>
        <div class="im-text">${e.text || ""}</div>
        <div class="im-media-grid"></div>
      `;
      const grid = card.querySelector(".im-media-grid");
      for (const m of e.media || []) {
        const img = document.createElement("img");
        img.className = "im-thumb";
        img.loading = "lazy";
        img.alt = m.fileType === "Video" ? "Video" : "Photo";
        img.addEventListener("error", () => img.classList.add("im-thumb-broken"), { once: true });
        lazyLoadThumb(img, m.thumbnailUrl);
        img.addEventListener("click", () => openLightbox(m));
        grid.appendChild(img);
      }
      body.appendChild(card);
    }
  }

  async function renderCalendar(body, pupilKey) {
    const entries = (await idbGetAllByIndex("calendarEntries", "pupilKey", pupilKey)).sort((a, b) =>
      a.startDateFull.localeCompare(b.startDateFull),
    );
    if (entries.length === 0) {
      body.innerHTML = `<div class="im-empty">No calendar entries cached yet. Hit 🔄 Sync.</div>`;
      return;
    }
    const typesMeta = await idbGet("meta", `calendarEntryTypes:${pupilKey}`);
    const colourById = new Map((typesMeta?.value || []).map((t) => [t.id, t.colour]));

    const byDay = new Map();
    for (const e of entries) {
      const day = e.startDate || e.startDateFull.slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(e);
    }

    for (const [day, items] of byDay) {
      const group = document.createElement("div");
      group.className = "im-day-group";
      const label = new Date(day).toLocaleDateString("sv-SE", {
        weekday: "long",
        day: "numeric",
        month: "long",
      });
      group.innerHTML = `<h4>${escapeHtml(label)}</h4>`;
      for (const e of items) {
        const row = document.createElement("div");
        row.className = "im-cal-row";
        const colour = colourById.get(e.calendarEntryTypeId) || "#ccc";
        row.innerHTML = `
          <span class="im-cal-dot" style="background:${colour}"></span>
          <span>${escapeHtml(e.title || "")}</span>
        `;
        group.appendChild(row);
      }
      body.appendChild(group);
    }
  }

  async function renderNews(body, pupilKey) {
    const items = (await idbGetAllByIndex("newsItems", "pupilKey", pupilKey)).sort((a, b) =>
      b.publishedDate.localeCompare(a.publishedDate),
    );
    if (items.length === 0) {
      body.innerHTML = `<div class="im-empty">No newsletters cached yet. Hit 🔄 Sync.</div>`;
      return;
    }
    for (const n of items) {
      const card = document.createElement("div");
      card.className = "im-card";
      card.innerHTML = `
        <div class="im-meta">
          <span>${escapeHtml(n.publishedDateString || "")}</span>
          ${n.publishedBy ? `<span>· ${escapeHtml(n.publishedBy)}</span>` : ""}
        </div>
        <h3>${escapeHtml(n.title || "")}</h3>
        <div class="im-text">${n.content || ""}</div>
      `;
      body.appendChild(card);
    }
  }

  async function renderDocuments(body, pupilKey) {
    const items = (await idbGetAllByIndex("documents", "pupilKey", pupilKey)).sort((a, b) =>
      (b.publishedDateString || "").localeCompare(a.publishedDateString || ""),
    );
    if (items.length === 0) {
      body.innerHTML = `<div class="im-empty">No documents cached yet. Hit 🔄 Sync.</div>`;
      return;
    }
    const wrap = document.createElement("div");
    wrap.className = "im-card";
    for (const d of items) {
      const row = document.createElement("div");
      row.className = "im-doc-row";
      row.innerHTML = `
        <div>
          <div>${escapeHtml(d.title || "")}</div>
          <div class="im-meta"><span>${escapeHtml(d.publishedDateString || "")}</span><span>· ${formatBytes(d.fileSize)}</span></div>
        </div>
        <a href="${escapeHtml(new URL(d.fileUrl, location.origin).href)}" target="_blank" rel="noopener">Open</a>
      `;
      wrap.appendChild(row);
    }
    body.appendChild(wrap);
  }

  function renderSettings() {
    const body = overlay.querySelector("#im-dash-body");
    idbGetAll("pupils").then((pupils) => {
      body.innerHTML = `
        <div class="im-card">
          <h3>Manage children</h3>
          <p style="color:#666">
            Find each child's ID by opening the pupil switcher (top right on the
            real InfoMentor site), right-clicking their name → Inspect, and
            copying the number at the end of the
            <code>/Account/PupilSwitcher/SwitchPupil/&lt;id&gt;</code> link.
          </p>
          <div class="im-settings-list" id="im-settings-list"></div>
          <div>
            <input id="im-new-name" placeholder="Name (e.g. Aston)" />
            <input id="im-new-id" placeholder="Switch ID (e.g. 3887588)" />
            <button id="im-add-pupil">Add</button>
          </div>
        </div>
      `;
      const list = body.querySelector("#im-settings-list");
      for (const p of pupils) {
        const row = document.createElement("div");
        row.className = "im-settings-row";
        row.innerHTML = `<span>${escapeHtml(p.name || "(unnamed)")} — switchId ${p.switchId}</span>`;
        const removeBtn = document.createElement("button");
        removeBtn.textContent = "Remove";
        removeBtn.addEventListener("click", async () => {
          await idbDelete("pupils", p.switchId);
          renderSettings();
        });
        row.appendChild(removeBtn);
        list.appendChild(row);
      }
      body.querySelector("#im-add-pupil").addEventListener("click", async () => {
        const name = body.querySelector("#im-new-name").value.trim();
        const switchId = Number(body.querySelector("#im-new-id").value.trim());
        if (!switchId) return;
        await idbPut("pupils", { switchId, name, im2Id: null, addedAt: Date.now() });
        await refreshTabsAndRender();
      });
    });
  }

  function openLightbox(media) {
    lightbox.innerHTML = "";
    lightbox.classList.add("open");
    const url = resolveMediaUrl(media.fileUrl);
    if (media.fileType === "Video") {
      const video = document.createElement("video");
      video.src = url;
      video.controls = true;
      video.autoplay = true;
      lightbox.appendChild(video);
    } else {
      const img = document.createElement("img");
      img.src = url;
      lightbox.appendChild(img);
    }
  }

  const thumbObserver = new IntersectionObserver(
    (entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target;
        obs.unobserve(img);
        img.src = resolveMediaUrl(img.dataset.imSrc);
      }
    },
    { root: null, rootMargin: "200px" },
  );

  function lazyLoadThumb(img, relativeUrl) {
    img.dataset.imSrc = relativeUrl;
    thumbObserver.observe(img);
  }

  function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
  }

  console.info("[IM Dashboard] ready — click 📋 Dashboard bottom-right.");
})();
