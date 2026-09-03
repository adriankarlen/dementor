#!/usr/bin/env node
// Dev tool: print a *structural* summary of a captured network log without
// echoing personal text (names, message bodies, etc). Safe to run and to
// paste its output into chat/issues.
//
// Usage: node tools/shape.js captures/im-capture-....json [urlSubstring]

const fs = require("fs");

const file = process.argv[2];
const filterSubstr = process.argv[3];
if (!file) {
  console.error("usage: node tools/shape.js <capture.json> [urlSubstring]");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(file, "utf8"));

const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/;
const URL_RE = /^https?:\/\//;

function shapeValue(v, depth = 0) {
  if (depth > 6) return "…";
  if (v === null) return "null";
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return [`Array(${v.length}) of`, shapeValue(v[0], depth + 1)];
  }
  const t = typeof v;
  if (t === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = shapeValue(v[k], depth + 1);
    return out;
  }
  if (t === "string") {
    if (URL_RE.test(v)) return `string(url, e.g. "${v.slice(0, 80)}")`;
    if (DATE_RE.test(v)) return `string(date-like, e.g. "${v}")`;
    if (v.length <= 3) return `string(short, e.g. "${v}")`;
    return `string(len=${v.length})`; // redact actual content
  }
  if (t === "number") return `number(e.g. ${v})`;
  if (t === "boolean") return `boolean(e.g. ${v})`;
  return t;
}

function tryParse(text) {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const byKey = new Map();
for (const r of data) {
  const path = r.url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  if (filterSubstr && !path.includes(filterSubstr)) continue;
  const key = `${r.method || "GET"} ${path}`;
  if (!byKey.has(key)) byKey.set(key, r); // first sample is enough
}

for (const [key, r] of [...byKey.entries()].sort()) {
  console.log("\n" + "=".repeat(80));
  console.log(key, `(status ${r.status}, content-type: ${r.contentType})`);
  const reqJson = tryParse(r.requestBody);
  if (reqJson) {
    console.log("-- request body shape --");
    console.log(JSON.stringify(shapeValue(reqJson), null, 2));
  } else if (r.requestBody) {
    console.log("-- request body (raw, non-JSON) --", r.requestBody.slice(0, 200));
  }
  const resJson = tryParse(r.responseBody);
  if (resJson) {
    console.log("-- response body shape --");
    console.log(JSON.stringify(shapeValue(resJson), null, 2));
  } else if (r.responseBody) {
    console.log("-- response body (raw, non-JSON, truncated) --", r.responseBody.slice(0, 200));
  }
}
