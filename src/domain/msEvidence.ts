/**
 * Microsoft technology evidence classification.
 *
 * Deterministic rules — the LLM never decides the final classification on its
 * own. Agents propose claims with sources; this module validates/downgrades.
 *
 * Principle: an Exchange Online MX record is evidence of Microsoft-hosted mail,
 * NOT proof of Intune, Defender, Purview or any specific licence.
 */
export type EvidenceClass = "confirmed" | "strongly_indicated" | "weakly_indicated" | "unknown" | "contradicted";
export type MsTech =
  | "microsoft_365"
  | "exchange_online"
  | "entra_id"
  | "azure"
  | "intune"
  | "defender"
  | "purview"
  | "copilot"
  | "sharepoint_online"
  | "teams";

export const MS_TECHNOLOGIES: MsTech[] = [
  "microsoft_365", "exchange_online", "entra_id", "azure", "intune", "defender", "purview", "copilot", "sharepoint_online", "teams",
];

export const CLASS_RANK: Record<EvidenceClass, number> = {
  contradicted: -1,
  unknown: 0,
  weakly_indicated: 1,
  strongly_indicated: 2,
  confirmed: 3,
};

export interface DnsSnapshot {
  domain: string;
  mx: string[];
  txt: string[];
  /** CNAME targets keyed by queried host label, e.g. { autodiscover: "autodiscover.outlook.com" } */
  cname: Record<string, string | null>;
  /** SRV targets keyed by label, e.g. { "_sipfederationtls._tcp": "sipfed.online.lync.com" } */
  srv?: Record<string, string | null>;
  /** Optional: result of Microsoft's public OpenID metadata lookup for the domain. */
  tenant?: { exists: boolean; tenantId?: string | null } | null;
}

/** Known third-party mail security gateways that commonly sit in front of Exchange Online. */
const MAIL_GATEWAYS: [RegExp, string][] = [
  [/mimecast\.com$/, "Mimecast"], [/pphosted\.com$|ppe-hosted\.com$/, "Proofpoint"], [/barracudanetworks\.com$/, "Barracuda"],
  [/sophos\.com$/, "Sophos"], [/trendmicro\.(com|eu)$/, "Trend Micro"], [/spamexperts\.(com|eu)$|antispamcloud\.com$/, "SpamExperts"],
  [/messagelabs\.com$/, "Broadcom/Symantec"], [/iphmx\.com$/, "Cisco Secure Email"], [/hornetsecurity\.com$/, "Hornetsecurity"], [/forcepoint\.com$/, "Forcepoint"],
];
export function mailGateway(mx: string[]): string | null {
  for (const m of mx) for (const [re, n] of MAIL_GATEWAYS) if (re.test(m.toLowerCase().replace(/\.$/, ""))) return n;
  return null;
}

export interface EvidenceItem {
  technology: MsTech;
  classification: EvidenceClass;
  evidenceType: string;
  detail: string;
  sourceId?: string | null;
}

const lower = (a: string[]) => a.map((x) => x.toLowerCase().replace(/\.$/, ""));

/** Passive, public DNS records only. No scanning or probing of services. */
export function classifyDns(d: DnsSnapshot): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  const mx = lower(d.mx);
  const txt = d.txt.map((t) => t.toLowerCase());
  const norm = (v: string | null | undefined) => v?.toLowerCase().replace(/\.$/, "") ?? null;
  const cname = Object.fromEntries(Object.entries(d.cname).map(([k, v]) => [k, norm(v)]));
  const srv = Object.fromEntries(Object.entries(d.srv ?? {}).map(([k, v]) => [k, norm(v)]));

  const mxEop = mx.some((m) => m.endsWith(".mail.protection.outlook.com") || m.endsWith(".mx.microsoft"));
  const mxGoogle = mx.some((m) => m.endsWith("google.com") || m.endsWith("googlemail.com"));
  const gateway = mailGateway(mx);
  const spfMs = txt.some((t) => t.startsWith("v=spf1") && t.includes("include:spf.protection.outlook.com"));
  const spfGoogle = txt.some((t) => t.startsWith("v=spf1") && t.includes("_spf.google.com"));
  const msVerify = txt.some((t) => /^ms=ms\d+/.test(t));
  const autodiscoverMs = cname["autodiscover"]?.endsWith("outlook.com") ?? false;
  const enrollment = cname["enterpriseenrollment"]?.endsWith("manage.microsoft.com") ?? false;
  const registration = cname["enterpriseregistration"]?.endsWith("windows.net") ?? false;
  const lync = Boolean(cname["lyncdiscover"]?.endsWith("lync.com"));
  const sipFed = Boolean(srv["_sipfederationtls._tcp"]?.endsWith("lync.com"));
  const dkimMs = ["selector1._domainkey", "selector2._domainkey"].some((k) => (cname[k] ?? "").includes("onmicrosoft.com"));
  const msoid = Boolean(cname["msoid"]?.includes("microsoftonline"));

  // Exchange Online — Microsoft-hosted mail (says nothing about the security stack).
  if (mxEop && (autodiscoverMs || dkimMs)) {
    out.push({ technology: "exchange_online", classification: "confirmed", evidenceType: "dns_mx", detail: `MX naar Exchange Online Protection${autodiscoverMs ? " + autodiscover → outlook.com" : ""}${dkimMs ? " + DKIM via onmicrosoft.com" : ""}` });
  } else if (mxEop) {
    out.push({ technology: "exchange_online", classification: "strongly_indicated", evidenceType: "dns_mx", detail: "MX → *.mail.protection.outlook.com (Microsoft-gehoste mail-infrastructuur)" });
  } else if (gateway && (spfMs || dkimMs || autodiscoverMs)) {
    out.push({ technology: "exchange_online", classification: dkimMs || autodiscoverMs ? "strongly_indicated" : "weakly_indicated", evidenceType: "dns_mx", detail: `Mailgateway ${gateway} vóór Microsoft-mail (SPF/DKIM/autodiscover wijzen naar Microsoft)` });
  } else if (spfMs && autodiscoverMs) {
    out.push({ technology: "exchange_online", classification: "strongly_indicated", evidenceType: "spf", detail: "SPF include:spf.protection.outlook.com + autodiscover → outlook.com" });
  } else if (spfMs || dkimMs) {
    out.push({ technology: "exchange_online", classification: "weakly_indicated", evidenceType: "spf", detail: "SPF/DKIM verwijst naar Microsoft — mogelijk (deels) Microsoft-gehoste mail" });
  } else if (mxGoogle || (spfGoogle && !spfMs)) {
    out.push({ technology: "exchange_online", classification: "contradicted", evidenceType: "dns_mx", detail: "Mail via Google Workspace" });
  }

  // Microsoft 365 tenant / usage
  const tenant = d.tenant?.exists ?? false;
  if ((msVerify || tenant) && (mxEop || autodiscoverMs || dkimMs)) {
    out.push({ technology: "microsoft_365", classification: "strongly_indicated", evidenceType: "dns_txt", detail: `${tenant ? "Domein in Entra-tenant" : "MS=ms… domeinverificatie"} + Exchange Online-indicatoren` });
  } else if (msVerify || tenant || mxEop || msoid) {
    out.push({ technology: "microsoft_365", classification: "weakly_indicated", evidenceType: msVerify ? "dns_txt" : tenant ? "tenant_metadata" : "dns_mx", detail: msVerify ? "MS=ms… TXT-domeinverificatie (Microsoft 365/Entra-tenant aanwezig)" : tenant ? "Domein hoort bij een Entra ID-tenant (publieke Microsoft-metadata)" : msoid ? "msoid CNAME → microsoftonline (legacy M365-configuratie)" : "Exchange Online MX (M365-gebruik waarschijnlijk, licentie onbekend)" });
  } else if ((mxGoogle || spfGoogle) && !spfMs) {
    out.push({ technology: "microsoft_365", classification: "contradicted", evidenceType: "dns_mx", detail: "Mail via Google Workspace, geen Microsoft-indicatoren" });
  }

  // Entra ID
  if (registration) out.push({ technology: "entra_id", classification: "strongly_indicated", evidenceType: "dns_cname", detail: "enterpriseregistration → enterpriseregistration.windows.net (Entra device registration)" });
  else if (tenant) out.push({ technology: "entra_id", classification: "strongly_indicated", evidenceType: "tenant_metadata", detail: `Domein is geregistreerd in Entra ID-tenant${d.tenant?.tenantId ? ` ${d.tenant.tenantId.slice(0, 8)}…` : ""}` });
  else if (msVerify) out.push({ technology: "entra_id", classification: "weakly_indicated", evidenceType: "dns_txt", detail: "Geverifieerd domein in Microsoft-tenant impliceert Entra ID-directory" });

  // Intune — only via MDM auto-enrollment CNAME; never inferred from mail.
  if (enrollment) out.push({ technology: "intune", classification: "strongly_indicated", evidenceType: "dns_cname", detail: "enterpriseenrollment → enterpriseenrollment.manage.microsoft.com (Intune MDM auto-enrollment)" });

  if (sipFed || lync) out.push({ technology: "teams", classification: sipFed ? "strongly_indicated" : "weakly_indicated", evidenceType: sipFed ? "dns_srv" : "dns_cname", detail: sipFed ? "SRV _sipfederationtls → sipfed.online.lync.com (Teams/Skype-federatie)" : "lyncdiscover → Microsoft" });
  return out;
}

const CLASS_WEIGHT: Record<EvidenceClass, number> = { confirmed: 0.95, strongly_indicated: 0.75, weakly_indicated: 0.35, unknown: 0, contradicted: 0 };

export interface TechConfidence {
  technology: MsTech;
  classification: EvidenceClass;
  /** 0..1 — noisy-OR over independent evidence types (DNS, vacancy, website, reference…). */
  confidence: number;
  evidenceCount: number;
  independentTypes: number;
}

/**
 * Separate confidence per technology. Evidence of different *types* is treated as
 * independent; repeated evidence of the same type counts once (its strongest item).
 * Microsoft-hosted mail never raises confidence for Intune/Defender/Purview/Copilot.
 */
export function technologyConfidence(items: Pick<EvidenceItem, "technology" | "classification" | "evidenceType">[]): Record<MsTech, TechConfidence> {
  const summary = summarizeEvidence(items);
  const out = {} as Record<MsTech, TechConfidence>;
  for (const t of MS_TECHNOLOGIES) {
    const mine = items.filter((i) => i.technology === t);
    const bestByType = new Map<string, number>();
    for (const i of mine) bestByType.set(i.evidenceType, Math.max(bestByType.get(i.evidenceType) ?? 0, CLASS_WEIGHT[i.classification]));
    const conf = 1 - [...bestByType.values()].reduce((p, w) => p * (1 - w), 1);
    out[t] = { technology: t, classification: summary[t], confidence: summary[t] === "contradicted" ? 0 : Math.round(conf * 100) / 100, evidenceCount: mine.length, independentTypes: bestByType.size };
  }
  return out;
}

/** Source types that can support a "confirmed" classification on their own. */
const AUTHORITATIVE_SOURCE_TYPES = new Set(["official_site", "vacancy", "ms_customer_story", "ms_customer_reference", "annual_report", "procurement"]);

export interface AgentEvidenceClaim {
  technology: MsTech;
  classification: EvidenceClass;
  evidenceType: string;
  detail: string;
  sourceId?: string | null;
  quote?: string | null;
}

/**
 * Validate an agent-proposed claim against its stored source. Downgrades
 * unsupported claims; never upgrades. Returns null when the claim is unusable.
 */
export function validateAgentClaim(
  claim: AgentEvidenceClaim,
  source: { sourceType: string; excerpt?: string | null } | null,
): EvidenceItem | null {
  if (!source) {
    // A claim with no stored source can be at most "weakly_indicated" — and only if it isn't asserting confirmation.
    if (claim.classification === "contradicted" || claim.classification === "unknown") return null;
    return { ...claim, classification: "unknown", detail: `[onbevestigd, geen bron] ${claim.detail}` };
  }
  let cls = claim.classification;
  if (cls === "confirmed" && !AUTHORITATIVE_SOURCE_TYPES.has(source.sourceType)) cls = "strongly_indicated";
  if (cls === "confirmed" && claim.quote && source.excerpt && !normalizedIncludes(source.excerpt, claim.quote)) {
    // Quote not found in what we actually retrieved → cannot be confirmed.
    cls = "weakly_indicated";
  }
  if (cls === "strongly_indicated" && source.sourceType === "other") cls = "weakly_indicated";
  return { technology: claim.technology, classification: cls, evidenceType: claim.evidenceType, detail: claim.detail, sourceId: claim.sourceId ?? null };
}

function normalizedIncludes(hay: string, needle: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return n(hay).includes(n(needle).slice(0, 120));
}

/** Combine evidence items into one classification per technology (strongest wins; contradiction only if nothing positive). */
export function summarizeEvidence(items: Pick<EvidenceItem, "technology" | "classification">[]): Record<MsTech, EvidenceClass> {
  const out = Object.fromEntries(MS_TECHNOLOGIES.map((t) => [t, "unknown"])) as Record<MsTech, EvidenceClass>;
  for (const t of MS_TECHNOLOGIES) {
    const cls = items.filter((i) => i.technology === t).map((i) => i.classification);
    if (!cls.length) continue;
    const positive = cls.filter((c) => CLASS_RANK[c] > 0);
    if (positive.length) out[t] = positive.sort((a, b) => CLASS_RANK[b] - CLASS_RANK[a])[0];
    else if (cls.includes("contradicted")) out[t] = "contradicted";
  }
  // Exchange Online implies at least weak M365 usage.
  if (CLASS_RANK[out.exchange_online] >= 2 && CLASS_RANK[out.microsoft_365] < 1) out.microsoft_365 = "weakly_indicated";
  return out;
}
