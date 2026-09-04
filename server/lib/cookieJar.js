// A minimal, dependency-free cookie jar. Good enough for one InfoMentor
// session spanning a couple of related domains (infomentor.se and
// hub.infomentor.se) — not a full RFC 6265 implementation, but handles
// the two things that actually matter here: the Domain attribute (so a
// cookie set for infomentor.se is sent to hub.infomentor.se too) and
// host-only cookies (sent only to the exact host that set them).

function parseSetCookie(setCookieStr, fallbackHost) {
  const parts = setCookieStr.split(";").map((p) => p.trim());
  const nameValue = parts[0];
  const eq = nameValue.indexOf("=");
  if (eq === -1) return null;
  const name = nameValue.slice(0, eq).trim();
  const value = nameValue.slice(eq + 1).trim();

  let domain = fallbackHost.toLowerCase();
  let hostOnly = true;
  for (const attr of parts.slice(1)) {
    const aeq = attr.indexOf("=");
    const key = (aeq === -1 ? attr : attr.slice(0, aeq)).trim().toLowerCase();
    const val = aeq === -1 ? "" : attr.slice(aeq + 1).trim();
    if (key === "domain" && val) {
      domain = val.replace(/^\./, "").toLowerCase();
      hostOnly = false;
    }
  }
  return { name, value, domain, hostOnly };
}

export function createCookieJar() {
  const store = new Map(); // key: `${domain}|${hostOnly}|${name}`

  return {
    applyResponse(response, requestUrl) {
      const host = new URL(requestUrl).hostname.toLowerCase();
      const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
      for (const raw of setCookies) {
        const parsed = parseSetCookie(raw, host);
        if (!parsed) continue;
        store.set(`${parsed.domain}|${parsed.hostOnly}|${parsed.name}`, parsed);
      }
    },
    cookieHeaderFor(url) {
      const host = new URL(url).hostname.toLowerCase();
      const matches = [];
      for (const c of store.values()) {
        const hostMatches = c.hostOnly ? host === c.domain : host === c.domain || host.endsWith("." + c.domain);
        if (hostMatches) matches.push(`${c.name}=${c.value}`);
      }
      return matches.join("; ");
    },
    clear() {
      store.clear();
    },
    dump() {
      return [...store.values()];
    },
  };
}
