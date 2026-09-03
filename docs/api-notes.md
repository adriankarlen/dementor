# InfoMentor API notes (confirmed 2026-09-03)

All endpoints below are same-origin on `hub.infomentor.se`, called with
`credentials: "same-origin"` (the normal browser cookie jar — no CORS
issues since a userscript runs in-page). Confirmed against a real
capture; see `captures/` (gitignored) for the source, or `tools/shape.js`
for a structural re-summary.

## Pupil switching

```
GET /Account/PupilSwitcher/SwitchPupil/{switchId}
```

Plain navigation-style GET. Sets server-side session state for "current
pupil"; subsequent calls below are scoped to whichever pupil was last
switched to. Fetching it (rather than navigating) works fine and avoids
reloading the page.

**Important:** InfoMentor uses at least three unrelated ID spaces for
the same child:

| ID | Example | Where it shows up |
|---|---|---|
| pupil switcher ID | `3887588` | `SwitchPupil/{id}` link href |
| `pupilIM2Id` | `2542427` | `consentViewConfig.pupilIM2Id` in `communication/appData`, notifications |
| `pupilSourceId` | `17583\|2103220295\|NEMANDI_SKOLI` | notifications (legacy school-system composite ID) |

These do not map to each other algorithmically — there's no known formula
converting one to another. The dashboard stores the switcher ID (the only
one you can obtain without already being logged in as that pupil) as the
primary key, and records `pupilIM2Id` alongside it after each sync purely
for reference.

## Current pupil context

```
POST /communication/communication/appData
```

Body: none. Response includes `consentViewConfig.pupilIM2Id` and
`.parentIM2Id` — useful to confirm which pupil is currently active after
a switch.

## Lärlogg (learning log / daily posts)

```
GET /learnlog/learnlog/appData
GET /learnlog/learnlog/getlearnlogs?learnLogType=0&pageNumber={n}&pageSize={size}
```

`appData` returns a bootstrap payload (translations, urls, first couple
of entries). `getlearnlogs` is the real paginated feed, `pageNumber`
1-indexed. `learnLogType=0` was captured while the "Alla" (all) filter
tab was active in the UI — the "Barn"/"Grupp" tab values are unconfirmed
(guessing 1/2, not verified).

Entry shape (fields actually used by the dashboard):

```jsonc
{
  "id": 2260370,
  "title": "string",
  "text": "string, actually pre-formatted HTML (e.g. <p style=\"...\">...</p>) — render with innerHTML, not escaped text",
  "groupName": "Eken",
  "lastModifiedOn": "den 2 september 2026 klockan 21:44", // pre-formatted Swedish text, not ISO
  "subjectsCoursesDisplayString": "",
  "media": [
    {
      "fileId": 18737925,
      "fileType": "Image", // "Video" expected too, unconfirmed in this capture
      "fileExtension": "jpeg",
      "thumbnailUrl": "/Resources/Resource/Thumbnail/18737925?api=IM2&ModuleType=LearnLogMedia&ConnectionId=2260370&width=100&height=100",
      "fileUrl": "/Resources/Resource/Download/18737925?api=IM2&moduleType=LearnLogMedia&connectionId=2260370"
    }
  ]
}
```

`thumbnailUrl`/`fileUrl` are relative, same-origin. Point `<img>`/`<video>`
`src` directly at them (resolved to an absolute URL) — InfoMentor's CSP
doesn't allow `blob:` URLs in `img-src`, so an earlier version that routed
thumbnails through `fetch()` + Cache Storage + `createObjectURL` rendered
as broken images. Letting the browser fetch the real same-origin URL
natively avoids that entirely, and still benefits from the browser's own
HTTP cache on repeat views.

**The `width`/`height` query params on the thumbnail URL are NOT freely
rewritable.** This looked plausible (they're just query params) but
turned out wrong: requesting a size InfoMentor's own UI never asked for
(e.g. rewriting `100x100` to `200x200`) returns `200 OK` with an empty
body — confirmed by opening the rewritten URL directly in a browser tab
(plain navigation, no script/CSP/cookies involved, still blank). The
endpoint appears to only serve pre-generated sizes. The dashboard now
uses each entry's `thumbnailUrl` exactly as returned, unmodified.

`id` appears to be monotonically increasing with recency, so it's used
for sort order and for detecting "already synced" entries instead of
trying to parse the Swedish `lastModifiedOn` string.

## Calendar

```
POST /calendarv2/calendarv2/appData
POST /calendarv2/calendarv2/getentries
  body: { "startDate": "2026/08/31", "endDate": "2026/10/18" }  // note: slash-separated, not ISO
```

`appData` includes `calendarEntryTypes`, an array of
`{ id, name, colour, className, isCustomType }` used for the colour chip
per entry type (`calendarEntryTypeId` on each entry references this).

## Newsletter / news

```
POST /Communication/News/GetNewsList
  body: { "pageSize": -1, "sortBy": "lastPublishDate___SORT_DESC" }
```

`pageSize: -1` returns everything (no separate pagination needed at the
volumes we saw — 8 items).

## Documents

```
POST /Communication/Documents/GetDocumentsList
  body: { "typeIds": "", "sortBy": "lastPublishDate___SORT_DESC", "page": 1, "pageSize": 12 }
```

Response includes `totalItemCount` — worth checking against `items.length`
if a family ever has more than one page's worth.

## Notifications (not currently used by the dashboard)

```
POST /NotificationApp/NotificationApp/GetNotifications
  body: { "timestamp": "2026-09-03 20:47:09.054" }  // "YYYY-MM-DD HH:mm:ss.SSS", space not "T"
POST /NotificationApp/NotificationApp/UpdateNotificationState
  body: { "ids": [69452898, ...], "state": "Seen" }
```

Notifications are scoped to whichever pupil is currently selected (all
10 sampled notifications shared one `pupilIM2Id`), so this doesn't help
discover the other child's IDs. Not wired up in the dashboard yet — the
dashboard tracks "new" via locally cached IDs instead.

## Open questions

- `learnLogType` values other than `0`.
- Whether `fileType` ever comes back as `"Video"` (rendering path exists
  in the dashboard, untested against a real video post).
- Exact session/cookie lifetime before `SessionExpiredError` triggers.
