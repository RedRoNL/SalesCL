import { isIP } from "node:net";
import type { FetchProvider, FetchedPage } from "./types";
import { FetchBlockedError } from "./types";

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
  if (isIP(host)) {
    // Block private, loopback, link-local and metadata ranges (SSRF protection).
    if (/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host) || host === "::1" || /^f[cd]|^fe80/i.test(host)) {
      throw new FetchBlockedError("Privé IP-adres geweigerd");
    }
  }
  if (u.port && !["80", "443"].includes(u.port)) throw new FetchBlockedError("Niet-standaard poort geweigerd");
  return u;
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
  constructor(private userAgent: string, private fetchImpl: typeof fetch = fetch, private maxBytes = 2_000_000) {}

  private async robots(origin: string): Promise<string | null> {
    if (this.robotsCache.has(origin)) return this.robotsCache.get(origin)!;
    let txt: string | null = null;
    try {
      const r = await this.fetchImpl(`${origin}/robots.txt`, { headers: { "user-agent": this.userAgent }, signal: AbortSignal.timeout(10000), redirect: "follow" });
      txt = r.ok ? await r.text() : null;
    } catch {
      txt = null;
    }
    this.robotsCache.set(origin, txt);
    return txt;
  }

  async fetch(url: string): Promise<{ page: FetchedPage; units: number }> {
    const u = assertPublicHttpUrl(url);
    const robots = await this.robots(u.origin);
    if (robots && !robotsAllows(robots, u.pathname + u.search)) throw new FetchBlockedError(`robots.txt staat ${u.pathname} niet toe`);
    const res = await this.fetchImpl(u.href, {
      headers: { "user-agent": this.userAgent, accept: "text/html,application/xhtml+xml,text/plain;q=0.9", "accept-language": "nl-NL,nl;q=0.9,en;q=0.8" },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    assertPublicHttpUrl(res.url || u.href);
    if ([401, 403, 407, 429].includes(res.status)) throw new FetchBlockedError(`Toegang geweigerd (${res.status}) — niet omzeild`);
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain|application\/xhtml/.test(type)) throw new FetchBlockedError(`Niet-ondersteund contenttype: ${type}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > this.maxBytes) throw new FetchBlockedError("Pagina te groot");
    const html = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    if (/captcha|cf-challenge|challenge-platform|are you a robot/i.test(html.slice(0, 20000)) && html.length < 60000) {
      throw new FetchBlockedError("Bot-bescherming/CAPTCHA gedetecteerd — niet omzeild");
    }
    const { title, text } = type.includes("html") ? htmlToText(html) : { title: null, text: html };
    return { page: { url, finalUrl: res.url || url, status: res.status, title, text }, units: 1 };
  }
}
