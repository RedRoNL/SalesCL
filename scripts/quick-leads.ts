/**
 * Quick weekly lead check — light-weight alternative to the full pipeline.
 * Input: a TSV of candidate companies (name, domain, sector, city, estimated NL FTE — estimates are UNVERIFIED).
 * For every candidate, deterministic checks only (no AI): website reachable (robots.txt respected), Microsoft 365
 * via public DNS (MX/TXT/autodiscover over DoH), switchboard phone / KvK / employee statements quoted from the
 * company's own home and contact pages, hard exclusions and opt-outs from the database, and earlier deliveries.
 * Output: an Excel workbook next to the input. Never committed (the output folder is git-ignored).
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/quick-leads.ts output/kandidaten-week48.tsv
 */
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { sql } from "drizzle-orm";
import { HttpFetchProvider } from "@/research/http";
import { DohDnsProvider } from "@/research/dns";
import { classifyDns, technologyConfidence } from "@/domain/msEvidence";
import { extractDeterministic, type ExtractPage } from "@/research/extract";
import { checkExclusions } from "@/pipeline/candidates";
import { getDb } from "@/db/client";
import { canonicalDomain } from "@/domain/normalize";

try { process.loadEnvFile(".env.local"); } catch { /* optional */ }

const file = process.argv[2];
if (!file) throw new Error("Gebruik: quick-leads.ts <kandidaten.tsv>");
const rows = readFileSync(file, "utf8").trim().split("\n").slice(1).map((l) => {
  const [name, domain, sector, city, fte] = l.split("\t");
  return { name, domain, sector, city, fte: Number(fte) || null };
});

const http = new HttpFetchProvider("CloudLifeSalesArmyResearchBot/1.0 (+https://www.cloudlife.nl)");
const dns = new DohDnsProvider(process.env.DOH_RESOLVER_URL || "https://cloudflare-dns.com/dns-query");
const CLASS: Record<string, string> = { confirmed: "bevestigd", strongly_indicated: "sterk aanwijzing", weakly_indicated: "zwakke aanwijzing", not_detected: "niet gevonden", contradicted: "nee (andere mailprovider)", unknown: "onbekend" };

async function check(r: (typeof rows)[number]) {
  const out: Record<string, unknown> = { ...r, website: null, status: "", m365: "onbekend", m365Detail: "", phone: null, phoneSource: null, kvk: null, employeesQuote: null, employeesSource: null, excluded: null, delivered: false, notes: [] as string[] };
  const notes = out.notes as string[];
  const ex = await checkExclusions({ name: r.name, domain: r.domain });
  if (ex.excluded || ex.suppressed) out.excluded = ex.reasons.map((x) => x.reason).join("; ");
  const [d] = (await getDb().execute(sql`select 1 from deliveries dl join companies c on c.id = dl.company_id where c.canonical_domain = ${canonicalDomain(r.domain)} limit 1`)) as unknown as unknown[];
  out.delivered = Boolean(d);
  const pages: ExtractPage[] = [];
  // Many sites only answer on www.; try that first, then the bare domain.
  let host = `www.${r.domain.replace(/^www\./, "")}`;
  try {
    await http.fetch(`https://${host}`);
  } catch {
    host = r.domain;
  }
  for (const path of ["", "/contact", "/over-ons"]) {
    try {
      const { page } = await http.fetch(`https://${host}${path}`);
      if (!path) out.website = page.finalUrl;
      pages.push({ sourceId: page.finalUrl, url: page.finalUrl, kind: path ? (path === "/contact" ? "contact" : "about") : "home", text: page.text });
    } catch (e) {
      if (!path) notes.push(`website: ${(e instanceof Error ? e.message : String(e)).slice(0, 90)}`);
    }
  }
  if (pages.length) {
    const det = extractDeterministic(pages);
    if (det.bestPhone) { out.phone = det.bestPhone.value; out.phoneSource = det.bestPhone.sourceId; }
    if (det.bestKvk) out.kvk = det.bestKvk.value;
    if (det.bestEmployees) { out.employeesQuote = `"${det.bestEmployees.quote.slice(0, 160)}"`; out.employeesSource = det.bestEmployees.sourceId; }
  }
  try {
    const snap = await dns.snapshot(canonicalDomain(r.domain) ?? r.domain);
    const ev = classifyDns(snap);
    const conf = technologyConfidence(ev);
    const best = [conf.exchange_online, conf.microsoft_365].sort((a, b) => ["confirmed", "strongly_indicated", "weakly_indicated", "not_detected", "unknown"].indexOf(a.classification) - ["confirmed", "strongly_indicated", "weakly_indicated", "not_detected", "unknown"].indexOf(b.classification))[0];
    out.m365 = CLASS[best.classification] ?? best.classification;
    out.m365Detail = ev.filter((e) => ["exchange_online", "microsoft_365", "entra_id"].includes(e.technology)).map((e) => e.detail).slice(0, 3).join(" | ").slice(0, 300);
  } catch (e) {
    notes.push(`DNS: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`);
  }
  const m365ok = out.m365 === "bevestigd" || out.m365 === "sterk aanwijzing";
  // A bot-blocked site on a domain with a live Microsoft 365 mail setup is still a real company: keep it as a lead.
  out.status = out.excluded ? "uitgesloten" : out.delivered ? "al geleverd" : out.m365 === "nee (andere mailprovider)" ? "geen M365 (andere mailprovider)" : !out.website ? (m365ok ? "lead (M365, website niet uitgelezen)" : "website niet bereikbaar") : m365ok ? "lead (M365 bevestigd)" : "lead (M365 niet aangetoond)";
  return out;
}

async function main() {
  const results: Record<string, unknown>[] = [];
  const queue = [...rows];
  await Promise.all(Array.from({ length: 6 }, async () => { for (let r = queue.shift(); r; r = queue.shift()) { results.push(await check(r)); process.stderr.write("."); } }));
  const order = ["lead (M365 bevestigd)", "lead (M365, website niet uitgelezen)", "lead (M365 niet aangetoond)", "geen M365 (andere mailprovider)", "website niet bereikbaar", "al geleverd", "uitgesloten"];
  results.sort((a, b) => order.indexOf(a.status as string) - order.indexOf(b.status as string) || String(a.sector).localeCompare(String(b.sector)) || String(a.name).localeCompare(String(b.name)));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Leads week 48");
  ws.columns = [
    { header: "Status", key: "status", width: 26 }, { header: "Bedrijf", key: "name", width: 32 }, { header: "Sector", key: "sector", width: 14 },
    { header: "Plaats", key: "city", width: 20 }, { header: "Website", key: "website", width: 36 },
    { header: "Microsoft 365 (DNS)", key: "m365", width: 18 }, { header: "DNS-bewijs", key: "m365Detail", width: 50 },
    { header: "Telefoon (eigen site)", key: "phone", width: 18 }, { header: "Bron telefoon", key: "phoneSource", width: 36 },
    { header: "KvK (eigen site)", key: "kvk", width: 12 }, { header: "Omvang: citaat eigen site", key: "employeesQuote", width: 50 },
    { header: "Omvang: schatting NL (NIET geverifieerd)", key: "fte", width: 18 }, { header: "Opmerkingen", key: "notesText", width: 40 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  for (const r of results) ws.addRow({ ...r, notesText: (r.notes as string[]).join("; ") });
  ws.autoFilter = { from: "A1", to: "M1" };
  const target = file.replace(/\.tsv$/, ".xlsx").replace("kandidaten", "leads");
  await wb.xlsx.writeFile(target);
  const count = (s: string) => results.filter((r) => r.status === s).length;
  console.log(`\n${target}\n` + order.map((s) => `${s}: ${count(s)}`).join("\n") + `\nmet telefoon: ${results.filter((r) => r.phone).length}, met omvangcitaat: ${results.filter((r) => r.employeesQuote).length}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
