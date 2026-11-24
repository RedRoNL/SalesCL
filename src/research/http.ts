import { isIP } from "node:net";
import { promises as dnsp } from "node:dns";
import type { FetchProvider, FetchedPage, PageLink } from "./types";
import { FetchBlockedError, ThinContentError } from "./types";

/**
 * Direct HTTP fetch provider (free). Respects robots.txt, identifies itself
 * with a descriptive User-Agent, enforces timeouts and size limits, never
 * submits forms, never authenticates and never attempts to bypass CAPTCHAs or
 * bot protection: a 401/403/429 or challenge page is simply reported back.
 */
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i;

export function assertPublicHttpUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchBlockedError("Ongeldige URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new FetchBlockedError("Alleen http(s) toegestaan");
  if (u.username || u.password) throw new FetchBlockedError("URL met inloggegevens geweigerd");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (PRIVATE_HOST.test(host)) throw new FetchBlockedError("Interne host geweigerd");
  if (isIP(host) && isPrivateIp(host)) throw new FetchBlockedError("Privé IP-adres geweigerd");
  if (u.port && !["80", "443"].includes(u.port)) throw new FetchBlockedError("Niet-standaard poort geweigerd");
  return u;
}

/** Private, loopback, link-local, CGNAT, metadata and unique-local ranges (SSRF protection). */
export function isPrivateIp(ip: string): boolean {
  const v = ip.replace(/^::ffff:/i, "");
  if (isIP(v) === 4) return /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|22[4-9]\.|23\d\.|24\d\.|25[0-5]\.)/.test(v);
  return v === "::1" || v === "::" || /^f[cd]/i.test(v) || /^fe[89ab]/i.test(v);
}

export type Resolver = (host: string) => Promise<string[]>;
/**
 * Public DNS-over-HTTPS A/AAAA lookup. Used when the host can only reach the internet through an HTTPS egress proxy
 * that resolves names itself (e.g. a Claude Code cloud environment): the system resolver then cannot answer, but the
 * SSRF check must still see the destination's public addresses.
 */
export function dohResolver(endpoint = process.env.DOH_RESOLVER_URL || "https://cloudflare-dns.com/dns-query", fetchImpl: typeof fetch = fetch): Resolver {
  return async (host) => {
    const out: string[] = [];
    for (const [type, code] of [["A", 1], ["AAAA", 28]] as const) {
      const r = await fetchImpl(`${endpoint}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const j = (await r.json()) as { Answer?: { type: number; data: string }[] };
      out.push(...(j.Answer ?? []).filter((a) => a.type === code).map((a) => a.data));
    }
    if (!out.length) throw new Error("ENOTFOUND");
    return out;
  };
}
const systemResolver: Resolver = async (host) => {
  try {
    return (await dnsp.lookup(host, { all: true })).map((a) => a.address);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if ((code === "ENOTFOUND" || code === "EAI_AGAIN") && (process.env.HTTPS_PROXY || process.env.https_proxy)) return dohResolver()(host);
    throw e;
  }
};

/** Resolve the hostname and refuse if ANY address is private (blocks DNS-based SSRF). */
export async function assertPublicHost(u: URL, resolve: Resolver): Promise<void> {
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new FetchBlockedError("Privé-adres — geweigerd");
    return;
  }
  let addrs: string[];
  try {
    addrs = await resolve(host);
  } catch {
    throw new FetchBlockedError(`Host niet resolvebaar: ${host}`);
  }
  if (!addrs.length || addrs.some(isPrivateIp)) throw new FetchBlockedError("Host resolveert naar privé-adres — geweigerd");
}

/** Minimal robots.txt evaluation for our user-agent and "*". */
export function robotsAllows(robotsTxt: string, path: string, ua = "cloudlifesalesarmyresearchbot"): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const line of robotsTxt.split(/\r?\n/)) {
    const l = line.replace(/#.*/, "").trim();
    if (!l) continue;
    const [k, ...rest] = l.split(":");
    const key = k.trim().toLowerCase();
    const val = rest.join(":").trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      lastWasAgent = false;
      if (val) current.rules.push({ allow: key === "allow", path: val });
      else if (key === "disallow") current.rules.push({ allow: true, path: "/" });
    } else lastWasAgent = false;
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  const applicable = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  let best: { allow: boolean; len: number } | null = null;
  for (const g of applicable)
    for (const r of g.rules) {
      const pattern = "^" + r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$");
      if (new RegExp(pattern).test(path) && (!best || r.path.length > best.len || (r.path.length === best.len && r.allow))) best = { allow: r.allow, len: r.path.length };
    }
  return best ? best.allow : true;
}

/** Extract absolute http(s) links with anchor text (max 400). */
export function extractLinks(html: string, base: string): PageLink[] {
  const out: PageLink[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 400) {
    try {
      const u = new URL(m[1].trim(), base);
      if (!/^https?:$/.test(u.protocol)) continue;
      u.hash = "";
      const href = u.href;
      if (seen.has(href)) continue;
      seen.add(href);
      const text = m[2].replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
      out.push({ href, text });
    } catch {
      /* ignore malformed */
    }
  }
  return out;
}

export function htmlToText(html: string): { title: string | null; text: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null;
  const text = html
    .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 [$1]")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
  return { title: title ? htmlToText(title).text : null, text };
}

export class HttpFetchProvider implements FetchProvider {
  readonly name = "http";
  readonly paid = false;
  private robotsCache = new Map<string, string | null>();
  constructor(private userAgent: string, private fetchImpl: typeof fetch = fetch, private maxBytes = 2_000_000, private resolve: Resolver = systemResolver) {}

  /** GET with manual redirect handling so every hop is re-validated (no redirect-based SSRF). */
  private async safeGet(start: URL, accept: string, timeoutMs: number): Promise<Response & { finalUrl: string }> {
    let url = start;
    for (let hop = 0; hop < 6; hop++) {
      const res = await this.getOnce(url, accept, timeoutMs);
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        url = new URL(res.headers.get("location")!, url);
        continue;
      }
      return Object.assign(res, { finalUrl: url.href });
    }
    throw new FetchBlockedError("Te veel redirects");
  }

  /**
   * One validated GET. Normal-browser fallbacks, no circumvention:
   *  - http:// is tried as https:// first (many sites redirect to plain http while serving https; HTTPS-only egress
   *    proxies cannot carry plain http);
   *  - a bare domain whose certificate only covers www. (or vice versa) is retried on the other host name.
   */
  private async getOnce(url: URL, accept: string, timeoutMs: number): Promise<Response> {
    const variants: URL[] = [];
    if (url.protocol === "http:") variants.push(Object.assign(new URL(url.href), { protocol: "https:" }));
    variants.push(url);
    let lastErr: unknown;
    for (const v of variants) {
      try {
        return await this.request(v, accept, timeoutMs);
      } catch (e) {
        if (e instanceof FetchBlockedError) throw e;
        lastErr = e;
        const code = (e as { cause?: { code?: string } }).cause?.code ?? "";
        if (/CERT|ALTNAME|ERR_TLS/.test(code) && v.protocol === "https:") {
          const alt = new URL(v.href);
          alt.hostname = alt.hostname.startsWith("www.") ? alt.hostname.slice(4) : `www.${alt.hostname}`;
          try {
            return await this.request(alt, accept, timeoutMs);
          } catch (e2) {
            if (e2 instanceof FetchBlockedError) throw e2;
            lastErr = e2;
          }
        }
      }
    }
    const code = (lastErr as { cause?: { code?: string } }).cause?.code;
    throw code ? new Error(`Verbinding mislukt (${code})`, { cause: lastErr }) : lastErr;
  }

  private async request(url: URL, accept: string, timeoutMs: number): Promise<Response> {
    assertPublicHttpUrl(url.href);
    await assertPublicHost(url, this.resolve);
    return this.fetchImpl(url.href, { headers: { "user-agent": this.userAgent, accept, "accept-language": "nl-NL,nl;q=0.9,en;q=0.8" }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  }

  private async robots(origin: string): Promise<string | null> {
    if (this.robotsCache.has(origin)) return this.robotsCache.get(origin)!;
    let txt: string | null = null;
    try {
      const r = await this.safeGet(new URL(`${origin}/robots.txt`), "text/plain", 10000);
      txt = r.ok ? await r.text() : null;
    } catch (e) {
      if (e instanceof FetchBlockedError) throw e;
      txt = null;
    }
    this.robotsCache.set(origin, txt);
    return txt;
  }

  async fetch(url: string): Promise<{ page: FetchedPage; units: number }> {
    const u = assertPublicHttpUrl(url);
    const robots = await this.robots(u.origin);
    if (robots && !robotsAllows(robots, u.pathname + u.search)) throw new FetchBlockedError(`robots.txt staat ${u.pathname} niet toe`);
    const res = await this.safeGet(u, "text/html,application/xhtml+xml,text/plain;q=0.9", 20000);
    if ([401, 403, 407, 429].includes(res.status)) throw new FetchBlockedError(`Toegang geweigerd (${res.status}) — niet omzeild`);
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain|application\/xhtml/.test(type)) throw new FetchBlockedError(`Niet-ondersteund contenttype: ${type}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > this.maxBytes) throw new FetchBlockedError("Pagina te groot");
    // NUL and other C0 control characters (except tab/newline) are rejected by PostgreSQL text/jsonb and carry no content.
    const html = new TextDecoder("utf-8", { fatal: false }).decode(buf).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
    if (/captcha|cf-challenge|challenge-platform|are you a robot/i.test(html.slice(0, 20000)) && html.length < 60000) {
      throw new FetchBlockedError("Bot-bescherming/CAPTCHA gedetecteerd — niet omzeild");
    }
    const isHtml = type.includes("html");
    const { title, text } = isHtml ? htmlToText(html) : { title: null, text: html };
    if (isHtml && text.length < 300 && /<script/i.test(html)) throw new ThinContentError("Pagina bevat vrijwel alleen JavaScript (rendering vereist)");
    return { page: { url, finalUrl: res.finalUrl, status: res.status, title, text, links: isHtml ? extractLinks(html, res.finalUrl) : [] }, units: 1 };
  }
}
