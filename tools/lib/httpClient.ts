// A small fetch wrapper that manually follows redirects, one hop at a
// time, applying the cookie jar at every hop. Ported from
// server/lib/httpClient.js (unchanged logic, added types).
//
// Why not just use fetch's built-in redirect following? Because when
// fetch follows a redirect internally, it never gives your code access
// to the intermediate response — so any Set-Cookie header on a 302
// along the way is invisible to us. InfoMentor's login involves exactly
// this kind of redirect chain. Following redirects ourselves guarantees
// we never silently lose a session cookie set mid-chain.

import { createCookieJar, type CookieJar } from "./cookieJar.ts";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

export interface Session {
  jar: CookieJar;
  request(url: string, init?: RequestInit, opts?: { maxRedirects?: number }): Promise<Response>;
}

export function createSession(): Session {
  const jar = createCookieJar();

  /**
   * Fetch `url`, following redirects manually and keeping the cookie jar
   * updated at every hop. Mirrors browser-compatible (not strictly
   * spec-compliant) redirect behaviour: 303 always becomes GET, 301/302
   * downgrade a POST to GET (what curl -L and every browser actually do),
   * 307/308 preserve method and body.
   */
  async function request(
    url: string,
    init: RequestInit = {},
    { maxRedirects = 8 }: { maxRedirects?: number } = {},
  ): Promise<Response> {
    let currentUrl = url;
    let currentInit: RequestInit = { ...init };
    let hops = 0;

    for (;;) {
      const headers = new Headers({ ...DEFAULT_HEADERS, ...(currentInit.headers as Record<string, string> | undefined) });
      const cookieHeader = jar.cookieHeaderFor(currentUrl);
      if (cookieHeader) headers.set("Cookie", cookieHeader);

      const response = await fetch(currentUrl, { ...currentInit, headers, redirect: "manual" });
      jar.applyResponse(response, currentUrl);

      const isRedirect = response.status === 0 || REDIRECT_STATUSES.has(response.status);
      // status 0 / type "opaqueredirect" happens if something upstream still
      // intercepts it; treat as a dead end rather than looping forever.
      if (!isRedirect || response.type === "opaqueredirect") return response;

      const location = response.headers.get("location");
      if (!location) return response;
      if (++hops > maxRedirects) throw new Error(`Too many redirects following ${url}`);

      currentUrl = new URL(location, currentUrl).href;
      const method = (currentInit.method || "GET").toUpperCase();
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== "GET" && method !== "HEAD")) {
        currentInit = {};
      }
      // otherwise keep method/body/headers for the next hop (307/308, or a GET redirect chain)
    }
  }

  return { jar, request };
}
