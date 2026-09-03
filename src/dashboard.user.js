// ==UserScript==
// @name         InfoMentor Dashboard
// @namespace    infomentor-dashboard
// @version      0.2.0
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
 * See docs/api-notes.md for the full endpoint reference and the
 * pupil-ID caveat (InfoMentor uses at least three unrelated ID
 * schemes for the same child).
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
  // Design tokens
  //
  // This is a private daily journal for two kids, not a SaaS product,
  // so it deliberately avoids generic dashboard chrome: a Nordic/autumn
  // palette instead of corporate blue-purple, a warm editorial serif
  // for dates and titles, and one real signature — each child gets a
  // consistent identity colour (a "spine" + initial badge on every
  // card) so you always know whose entry you're looking at, even mid-
  // scroll, without re-reading the header. Fonts are system-only
  // (Georgia/ui-serif + system sans): loading a web font risks hitting
  // the same CSP wall that broke the blob: image URLs earlier.
  // ------------------------------------------------------------------

  const PUPIL_COLORS = ["#D98A34", "#2F6B63", "#6E5AA8", "#A23B49", "#3E7CB1"];

  function computePupilColors(pupils) {
    const sorted = [...pupils].sort((a, b) => a.switchId - b.switchId);
    const map = new Map();
    sorted.forEach((p, i) => map.set(p.switchId, PUPIL_COLORS[i % PUPIL_COLORS.length]));
    return map;
  }

  function initials(name, switchId) {
    const trimmed = (name || "").trim();
    if (trimmed) return trimmed[0].toUpperCase();
    return String(switchId).slice(-1);
  }

  // ------------------------------------------------------------------
  // UI — styles
  // ------------------------------------------------------------------

  const style = document.createElement("style");
  style.textContent = `
    #im-dash-btn, #im-dash-overlay, #im-lightbox {
      --im-ink: #23241d;
      --im-ink-muted: #6b6d61;
      --im-linen: #eceee5;
      --im-surface: #ffffff;
      --im-hairline: #dfe1d6;
      --im-moss: #4b5d45;
      --im-moss-dark: #394630;
      --im-lingon: #a23b49;
      --im-font-display: Georgia, "Iowan Old Style", "Palatino Linotype", ui-serif, serif;
      --im-font-body: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }

    @media (prefers-reduced-motion: reduce) {
      #im-dash-overlay *, #im-lightbox * { transition: none !important; animation: none !important; }
    }

    #im-dash-btn {
      position: fixed; bottom: 20px; right: 20px; z-index: 999999;
      background: var(--im-ink); color: #fff; border: none; border-radius: 999px;
      padding: 12px 20px 12px 16px; font: 600 13px/1 var(--im-font-body); letter-spacing: .02em;
      cursor: pointer; display: flex; align-items: center; gap: 8px;
      box-shadow: 0 8px 24px rgba(35,36,29,.28);
      transition: transform .15s ease, box-shadow .15s ease;
    }
    #im-dash-btn:hover { transform: translateY(-2px); box-shadow: 0 12px 28px rgba(35,36,29,.34); }
    #im-dash-btn .im-dot { width: 8px; height: 8px; border-radius: 50%; background: #e8a24a; flex: none; }

    #im-dash-overlay {
      position: fixed; inset: 0; z-index: 999997; background: var(--im-linen);
      display: none; flex-direction: column;
      font: 15px/1.55 var(--im-font-body); color: var(--im-ink);
    }
    #im-dash-overlay.open { display: flex; }

    #im-dash-header {
      background: var(--im-surface); border-bottom: 1px solid var(--im-hairline);
      padding: 14px 22px; display: flex; flex-direction: column; gap: 12px;
    }
    .im-header-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    .im-header-row .spacer { flex: 1; }
    #im-dash-header .im-wordmark { display: flex; flex-direction: column; }
    #im-dash-header h1 { font: 700 20px/1 var(--im-font-display); margin: 0; letter-spacing: -.01em; }
    #im-dash-header .im-subtitle { font-size: 12px; color: var(--im-ink-muted); margin-top: 3px; }
    #im-dash-header .status { font-size: 12px; color: var(--im-ink-muted); }

    button.im-btn-primary {
      background: var(--im-moss); color: #fff; border: none; border-radius: 8px;
      padding: 8px 16px; cursor: pointer; font: 600 12.5px/1 var(--im-font-body);
      transition: background .15s ease;
    }
    button.im-btn-primary:hover { background: var(--im-moss-dark); }
    button.im-btn-icon {
      background: transparent; border: 1px solid var(--im-hairline); color: var(--im-ink);
      border-radius: 8px; width: 32px; height: 32px; cursor: pointer; font-size: 15px;
      display: flex; align-items: center; justify-content: center; transition: background .15s ease;
    }
    button.im-btn-icon:hover { background: var(--im-linen); }

    #im-pupil-tabs { display: flex; gap: 8px; }
    .im-pupil-avatar {
      width: 38px; height: 38px; border-radius: 50%; border: 2px solid transparent;
      display: flex; align-items: center; justify-content: center;
      font: 700 14px/1 var(--im-font-display); color: #fff; cursor: pointer;
      opacity: .55; transition: opacity .15s ease, transform .15s ease;
    }
    .im-pupil-avatar:hover { opacity: .85; }
    .im-pupil-avatar.active { opacity: 1; border-color: var(--im-ink); transform: scale(1.08); }

    #im-section-tabs { display: flex; gap: 20px; overflow-x: auto; }
    .im-section-tab {
      background: none; border: none; border-bottom: 2px solid transparent;
      color: var(--im-ink-muted); padding: 4px 0; cursor: pointer; white-space: nowrap;
      font: 600 12.5px/1 var(--im-font-body); text-transform: uppercase; letter-spacing: .06em;
    }
    .im-section-tab.active { color: var(--im-ink); border-bottom-color: var(--im-moss); }

    #im-dash-body {
      flex: 1; overflow-y: auto; padding: 28px 22px 70px; max-width: 720px;
      margin: 0 auto; width: 100%; box-sizing: border-box;
    }

    .im-card {
      position: relative; background: var(--im-surface); border-radius: 14px;
      padding: 20px 22px 20px 30px; margin-bottom: 18px; overflow: visible;
      box-shadow: 0 1px 2px rgba(35,36,29,.06), 0 8px 20px rgba(35,36,29,.05);
      border: 1px solid var(--im-hairline);
      transition: transform .15s ease, box-shadow .15s ease;
    }
    .im-card:hover { transform: translateY(-1px); box-shadow: 0 2px 4px rgba(35,36,29,.08), 0 14px 28px rgba(35,36,29,.08); }
    .im-card-spine {
      position: absolute; left: 0; top: 0; bottom: 0; width: 6px;
      background: var(--im-accent, var(--im-moss)); border-radius: 14px 0 0 14px;
    }
    .im-card-badge {
      position: absolute; left: 8px; top: 18px; width: 26px; height: 26px; border-radius: 50%;
      background: var(--im-accent, var(--im-moss)); color: #fff; display: flex; align-items: center;
      justify-content: center; font: 700 12px/1 var(--im-font-display);
      box-shadow: 0 2px 5px rgba(35,36,29,.3); border: 2px solid var(--im-linen);
    }
    .im-card .im-meta { font-size: 12.5px; color: var(--im-ink-muted); display: flex; gap: 10px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
    .im-card .im-date { font-family: var(--im-font-display); }
    .im-pill {
      background: var(--im-linen); color: var(--im-ink); border-radius: 999px;
      padding: 2px 10px; font-size: 11px; font-weight: 700; letter-spacing: .02em;
    }
    .im-new-badge { background: var(--im-lingon); color: #fff; border-radius: 999px; padding: 2px 9px; font-size: 10px; font-weight: 700; }
    .im-card h3 { margin: 0 0 8px; font: 700 17px/1.3 var(--im-font-display); }
    .im-card .im-text { color: #33342b; }
    .im-card .im-text p:first-child { margin-top: 0; }
    .im-card .im-text p:last-child { margin-bottom: 0; }

    .im-media-grid { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    .im-media-grid .im-thumb {
      width: 92px; height: 92px; border-radius: 10px; object-fit: cover; cursor: pointer;
      background: var(--im-linen); border: 1px solid var(--im-hairline);
      transition: transform .15s ease;
    }
    .im-media-grid .im-thumb:hover { transform: scale(1.04); }
    .im-media-grid .im-thumb.im-thumb-broken { object-fit: contain; opacity: .4; }

    .im-empty {
      text-align: center; color: var(--im-ink-muted); padding: 70px 20px;
      font-family: var(--im-font-display); font-size: 15px;
    }
    .im-empty input {
      padding: 8px 10px; border-radius: 8px; border: 1px solid var(--im-hairline);
      margin: 4px; font: 13px var(--im-font-body);
    }
    .im-empty button.im-btn-primary { margin: 4px; }

    .im-day-group { margin-bottom: 20px; }
    .im-day-group h4 { margin: 0 0 8px; font: 700 13px/1 var(--im-font-body); color: var(--im-ink-muted); text-transform: capitalize; letter-spacing: .02em; }
    .im-cal-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid var(--im-hairline); }
    .im-cal-row:first-child { border-top: none; }
    .im-cal-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }

    .im-doc-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-top: 1px solid var(--im-hairline); }
    .im-doc-row:first-child { border-top: none; }
    .im-doc-row a { color: var(--im-moss); font-weight: 700; text-decoration: none; }
    .im-doc-row a:hover { text-decoration: underline; }

    .im-settings-list { display: flex; flex-direction: column; gap: 8px; margin: 14px 0; }
    .im-settings-row { display: flex; gap: 10px; align-items: center; font-size: 13.5px; justify-content: space-between; }
    .im-settings-row button { border: 1px solid var(--im-hairline); background: var(--im-surface); border-radius: 8px; padding: 3px 10px; cursor: pointer; }

    #im-dash-overlay *:focus-visible, #im-lightbox *:focus-visible {
      outline: 2px solid var(--im-moss); outline-offset: 2px;
    }

    @media (max-width: 640px) {
      #im-dash-body { padding: 20px 14px 70px; }
      .im-card { padding: 16px 16px 16px 26px; }
    }

    /* ---- Lightbox / carousel ---- */
    #im-lightbox {
      position: fixed; inset: 0; background: rgba(20,20,16,.94); z-index: 999999;
      display: none; align-items: center; justify-content: center; flex-direction: column;
    }
    #im-lightbox.open { display: flex; }
    .im-lb-stage { position: relative; width: 100%; flex: 1; overflow: hidden; display: flex; touch-action: pan-y; }
    .im-lb-track { display: flex; width: 100%; height: 100%; transition: transform .32s cubic-bezier(.22,.8,.24,1); }
    .im-lb-track.dragging { transition: none; }
    .im-lb-slide { flex: 0 0 100%; display: flex; align-items: center; justify-content: center; padding: 20px; box-sizing: border-box; }
    .im-lb-slide img, .im-lb-slide video {
      max-width: 100%; max-height: 100%; border-radius: 10px; -webkit-user-drag: none; user-select: none;
      box-shadow: 0 20px 60px rgba(0,0,0,.5);
    }
    .im-lb-nav {
      position: absolute; top: 50%; transform: translateY(-50%); z-index: 2;
      background: rgba(255,255,255,.12); color: #fff; border: none; border-radius: 50%;
      width: 44px; height: 44px; font-size: 22px; cursor: pointer; line-height: 1;
      transition: background .15s ease;
    }
    .im-lb-nav:hover { background: rgba(255,255,255,.24); }
    .im-lb-prev { left: 16px; }
    .im-lb-next { right: 16px; }
    .im-lb-close {
      position: absolute; top: 16px; right: 16px; z-index: 2;
      background: rgba(255,255,255,.12); color: #fff; border: none; border-radius: 50%;
      width: 36px; height: 36px; font-size: 16px; cursor: pointer; line-height: 1;
      transition: background .15s ease;
    }
    .im-lb-close:hover { background: rgba(255,255,255,.24); }
    .im-lb-counter { color: rgba(255,255,255,.6); font: 600 12px/1 var(--im-font-body); letter-spacing: .04em; margin: 10px 0 6px; }
    .im-lb-filmstrip { display: flex; gap: 6px; padding-bottom: 18px; max-width: 90vw; overflow-x: auto; }
    .im-lb-film-thumb {
      width: 48px; height: 48px; border-radius: 8px; object-fit: cover; cursor: pointer;
      opacity: .45; border: 2px solid transparent; transition: opacity .15s ease;
    }
    .im-lb-film-thumb.active { opacity: 1; border-color: #fff; }
  `;
  document.documentElement.appendChild(style);

  // ------------------------------------------------------------------
  // UI — floating trigger + overlay shell
  // ------------------------------------------------------------------

  const btn = document.createElement("button");
  btn.id = "im-dash-btn";
  btn.innerHTML = `<span class="im-dot"></span>Dagbok`;
  document.documentElement.appendChild(btn);

  const overlay = document.createElement("div");
  overlay.id = "im-dash-overlay";
  overlay.innerHTML = `
    <div id="im-dash-header">
      <div class="im-header-row">
        <div class="im-wordmark">
          <h1>Dagbok</h1>
          <span class="im-subtitle" id="im-subtitle"></span>
        </div>
        <div class="spacer"></div>
        <span class="status" id="im-status"></span>
        <button class="im-btn-primary" data-act="sync">Sync</button>
        <button class="im-btn-icon" data-act="settings" title="Manage children" aria-label="Manage children">⚙</button>
        <button class="im-btn-icon" data-act="close" title="Close" aria-label="Close">✕</button>
      </div>
      <div class="im-header-row">
        <div id="im-pupil-tabs"></div>
        <div id="im-section-tabs"></div>
      </div>
    </div>
    <div id="im-dash-body"></div>
  `;
  document.documentElement.appendChild(overlay);

  // ------------------------------------------------------------------
  // UI — lightbox / carousel
  // ------------------------------------------------------------------

  const lightbox = document.createElement("div");
  lightbox.id = "im-lightbox";
  lightbox.innerHTML = `
    <button class="im-lb-close" data-act="lb-close" title="Close" aria-label="Close">✕</button>
    <button class="im-lb-nav im-lb-prev" data-act="lb-prev" title="Previous" aria-label="Previous">‹</button>
    <div class="im-lb-stage">
      <div class="im-lb-track"></div>
    </div>
    <button class="im-lb-nav im-lb-next" data-act="lb-next" title="Next" aria-label="Next">›</button>
    <div class="im-lb-counter"></div>
    <div class="im-lb-filmstrip"></div>
  `;
  document.documentElement.appendChild(lightbox);

  const lbStage = lightbox.querySelector(".im-lb-stage");
  const lbTrack = lightbox.querySelector(".im-lb-track");
  let lightboxItems = [];
  let lightboxIndex = 0;
  let lbDrag = null;

  function openLightbox(items, startIndex) {
    lightboxItems = items || [];
    lightboxIndex = startIndex || 0;
    lbTrack.innerHTML = "";
    for (const m of lightboxItems) {
      const slide = document.createElement("div");
      slide.className = "im-lb-slide";
      const url = resolveMediaUrl(m.fileUrl);
      if (m.fileType === "Video") {
        const video = document.createElement("video");
        video.src = url;
        video.controls = true;
        video.playsInline = true;
        slide.appendChild(video);
      } else {
        const img = document.createElement("img");
        img.src = url;
        img.alt = "";
        slide.appendChild(img);
      }
      lbTrack.appendChild(slide);
    }
    renderLightboxFilmstrip();
    updateLightboxPosition();
    lightbox.classList.add("open");
    document.addEventListener("keydown", onLightboxKeydown);
  }

  function closeLightbox() {
    lightbox.classList.remove("open");
    lbTrack.innerHTML = "";
    document.removeEventListener("keydown", onLightboxKeydown);
  }

  function lbGoTo(index) {
    const len = lightboxItems.length;
    if (len === 0) return;
    lightboxIndex = ((index % len) + len) % len;
    updateLightboxPosition();
  }
  function lbPrev() {
    lbGoTo(lightboxIndex - 1);
  }
  function lbNext() {
    lbGoTo(lightboxIndex + 1);
  }

  function updateLightboxPosition() {
    lbTrack.style.transform = `translateX(${-lightboxIndex * 100}%)`;
    lightbox.querySelector(".im-lb-counter").textContent =
      lightboxItems.length > 1 ? `${lightboxIndex + 1} / ${lightboxItems.length}` : "";
    lbTrack.querySelectorAll(".im-lb-slide video").forEach((video, i) => {
      if (i === lightboxIndex) video.play().catch(() => {});
      else video.pause();
    });
    lightbox.querySelectorAll(".im-lb-film-thumb").forEach((el, i) => {
      el.classList.toggle("active", i === lightboxIndex);
    });
    const multi = lightboxItems.length > 1;
    lightbox.querySelector(".im-lb-prev").style.display = multi ? "" : "none";
    lightbox.querySelector(".im-lb-next").style.display = multi ? "" : "none";
  }

  function renderLightboxFilmstrip() {
    const strip = lightbox.querySelector(".im-lb-filmstrip");
    strip.innerHTML = "";
    if (lightboxItems.length <= 1) return;
    lightboxItems.forEach((m, i) => {
      const thumb = document.createElement("img");
      thumb.className = "im-lb-film-thumb";
      thumb.src = resolveMediaUrl(m.thumbnailUrl || m.fileUrl);
      thumb.alt = "";
      thumb.addEventListener("click", (ev) => {
        ev.stopPropagation();
        lbGoTo(i);
      });
      strip.appendChild(thumb);
    });
  }

  function onLightboxKeydown(ev) {
    if (ev.key === "Escape") closeLightbox();
    else if (ev.key === "ArrowLeft") lbPrev();
    else if (ev.key === "ArrowRight") lbNext();
  }

  lightbox.querySelector('[data-act="lb-close"]').addEventListener("click", closeLightbox);
  lightbox.querySelector('[data-act="lb-prev"]').addEventListener("click", (e) => {
    e.stopPropagation();
    lbPrev();
  });
  lightbox.querySelector('[data-act="lb-next"]').addEventListener("click", (e) => {
    e.stopPropagation();
    lbNext();
  });
  lightbox.addEventListener("click", (e) => {
    if (e.target === lightbox) closeLightbox();
  });

  // Drag / swipe to change slides (mouse, trackpad, and touch via Pointer Events).
  lbStage.addEventListener("pointerdown", (e) => {
    if (lightboxItems.length <= 1) return;
    lbDrag = { startX: e.clientX, width: lbStage.clientWidth };
    lbTrack.classList.add("dragging");
    lbStage.setPointerCapture(e.pointerId);
  });
  lbStage.addEventListener("pointermove", (e) => {
    if (!lbDrag) return;
    const dx = e.clientX - lbDrag.startX;
    lbTrack.style.transform = `translateX(calc(${-lightboxIndex * 100}% + ${dx}px))`;
  });
  function lbEndDrag(e) {
    if (!lbDrag) return;
    const dx = e.clientX - lbDrag.startX;
    const threshold = lbDrag.width * 0.18;
    lbTrack.classList.remove("dragging");
    lbDrag = null;
    if (dx > threshold) lbPrev();
    else if (dx < -threshold) lbNext();
    else updateLightboxPosition();
  }
  lbStage.addEventListener("pointerup", lbEndDrag);
  lbStage.addEventListener("pointercancel", lbEndDrag);

  // ------------------------------------------------------------------
  // UI — state + wiring
  // ------------------------------------------------------------------

  let activePupil = null; // switchId
  let activeSection = "learnlog";
  let pupilColors = new Map();

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
    pupilColors = computePupilColors(pupils);

    overlay.querySelector("#im-subtitle").textContent = pupils.length
      ? pupils.map((p) => p.name || `Pupil ${p.switchId}`).join(" & ")
      : "Add your child to get started";

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
      tab.className = "im-pupil-avatar" + (p.switchId === activePupil ? " active" : "");
      tab.style.background = pupilColors.get(p.switchId);
      tab.textContent = initials(p.name, p.switchId);
      tab.title = p.name || `Pupil ${p.switchId}`;
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
      body.innerHTML = `<div class="im-empty">No Lärlogg entries cached yet. Hit Sync.</div>`;
      return;
    }
    const pupil = await idbGet("pupils", pupilKey);
    const accent = pupilColors.get(pupilKey) || "#4b5d45";
    const badgeLetter = initials(pupil?.name, pupilKey);

    for (const e of entries) {
      const card = document.createElement("div");
      card.className = "im-card";
      card.style.setProperty("--im-accent", accent);
      card.innerHTML = `
        <div class="im-card-spine"></div>
        <div class="im-card-badge">${escapeHtml(badgeLetter)}</div>
        <div class="im-meta">
          <span class="im-date">${escapeHtml(e.lastModifiedOn || "")}</span>
          ${e.groupName ? `<span class="im-pill">${escapeHtml(e.groupName)}</span>` : ""}
        </div>
        <h3>${escapeHtml(e.title || "")}</h3>
        <div class="im-text">${e.text || ""}</div>
        <div class="im-media-grid"></div>
      `;
      const grid = card.querySelector(".im-media-grid");
      const media = e.media || [];
      media.forEach((m, idx) => {
        const img = document.createElement("img");
        img.className = "im-thumb";
        img.loading = "lazy";
        img.alt = m.fileType === "Video" ? "Video" : "Photo";
        img.addEventListener("error", () => img.classList.add("im-thumb-broken"), { once: true });
        lazyLoadThumb(img, m.thumbnailUrl);
        img.addEventListener("click", () => openLightbox(media, idx));
        grid.appendChild(img);
      });
      body.appendChild(card);
    }
  }

  async function renderCalendar(body, pupilKey) {
    const entries = (await idbGetAllByIndex("calendarEntries", "pupilKey", pupilKey)).sort((a, b) =>
      a.startDateFull.localeCompare(b.startDateFull),
    );
    if (entries.length === 0) {
      body.innerHTML = `<div class="im-empty">No calendar entries cached yet. Hit Sync.</div>`;
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
      body.innerHTML = `<div class="im-empty">No newsletters cached yet. Hit Sync.</div>`;
      return;
    }
    for (const n of items) {
      const card = document.createElement("div");
      card.className = "im-card";
      card.style.setProperty("--im-accent", "#8a8f3d");
      card.innerHTML = `
        <div class="im-card-spine"></div>
        <div class="im-meta">
          <span class="im-date">${escapeHtml(n.publishedDateString || "")}</span>
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
      body.innerHTML = `<div class="im-empty">No documents cached yet. Hit Sync.</div>`;
      return;
    }
    const wrap = document.createElement("div");
    wrap.className = "im-card";
    wrap.style.setProperty("--im-accent", "#3e7cb1");
    wrap.innerHTML = `<div class="im-card-spine"></div>`;
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
          <div class="im-card-spine"></div>
          <h3>Manage children</h3>
          <p style="color:var(--im-ink-muted)">
            Find each child's ID by opening the pupil switcher (top right on the
            real InfoMentor site), right-clicking their name → Inspect, and
            copying the number at the end of the
            <code>/Account/PupilSwitcher/SwitchPupil/&lt;id&gt;</code> link.
          </p>
          <div class="im-settings-list" id="im-settings-list"></div>
          <div>
            <input id="im-new-name" placeholder="Name (e.g. Aston)" />
            <input id="im-new-id" placeholder="Switch ID (e.g. 3887588)" />
            <button class="im-btn-primary" id="im-add-pupil">Add</button>
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

  console.info("[IM Dashboard] ready — click the Dagbok button, bottom-right.");
})();
