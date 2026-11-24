import { z } from "zod";
import { ilike, eq, or, and, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { canonicalDomain, normalizeCompanyName, formatProspectId } from "@/domain/normalize";
import { classifyDns, summarizeEvidence } from "@/domain/msEvidence";
import { findDuplicate } from "@/domain/dedup";
import type { ResearchService } from "@/research/service";
import { sanitizeUntrusted, wrapUntrusted } from "@/domain/untrusted";
import type { AgentId, ToolName } from "./types";
import { AGENT_IDS } from "./types";

export interface ToolContext {
  research: ResearchService;
  agentId: AgentId;
  taskId: string;
  runId?: string | null;
  companyId?: string | null;
  threadId?: string | null;
  userId?: string | null;
  userRole?: string | null;
  depth: number;
  /** Injected by the runtime to avoid circular imports. */
  delegate?: (agentId: AgentId, instruction: string) => Promise<string>;
  startRun?: (params: StartRunParams) => Promise<{ runId: string; created: boolean }>;
  analytics?: () => Promise<unknown>;
  marketMap?: () => Promise<unknown>;
  dossier?: (companyId: string, forQa: boolean) => Promise<unknown>;
  runStatus?: (runId?: string) => Promise<unknown>;
}

export const StartRunParams = z.object({
  kind: z.enum(["manual", "sector", "company"]),
  target: z.number().int().min(1).max(300),
  industries: z.array(z.string()).max(12).optional(),
  minEmployees: z.number().int().min(1).optional(),
  maxEmployees: z.number().int().max(100000).optional(),
  companyName: z.string().max(200).optional(),
  companyWebsite: z.string().max(300).optional(),
  instructions: z.string().max(1500).optional(),
});
export type StartRunParams = z.infer<typeof StartRunParams>;

interface ToolDef<S extends z.ZodType> {
  name: ToolName;
  description: string;
  schema: S;
  run(input: z.infer<S>, ctx: ToolContext): Promise<string>;
}
const def = <S extends z.ZodType>(t: ToolDef<S>) => t;

const SOURCE_TYPES = ["official_site", "vacancy", "ms_customer_story", "news", "directory", "registry", "annual_report", "procurement", "association", "other"] as const;

export const TOOLS: Record<ToolName, ToolDef<z.ZodType>> = {
  web_search: def({
    name: "web_search",
    description: "Zoek op het openbare web (NL-gericht). Retourneert titels, URL's en korte snippets (onvertrouwde data). Gebruik fetch_page om een bron werkelijk op te halen en een source_id te krijgen.",
    schema: z.object({ query: z.string().min(2).max(300), limit: z.number().int().min(1).max(15).optional() }),
    async run(i, ctx) {
      const results = await ctx.research.search(i.query, i.limit ?? 8);
      const text = results.map((r, n) => `${n + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n");
      return wrapUntrusted({ kind: "search_results" }, sanitizeUntrusted(text || "(geen resultaten)", 6000));
    },
  }),
  fetch_page: def({
    name: "fetch_page",
    description: "Haal één openbare webpagina op (respecteert robots.txt, geen login/CAPTCHA-omzeiling). Slaat de bron op en retourneert source_id + inhoud (onvertrouwde data). Kies het juiste source_type.",
    schema: z.object({ url: z.string().url().max(2000), source_type: z.enum(SOURCE_TYPES) }),
    async run(i, ctx) {
      const r = await ctx.research.fetchPage(i.url, i.source_type);
      return `source_id: ${r.sourceId}\ntitel: ${r.title ?? "-"}\n${r.wrapped}`;
    },
  }),
  dns_lookup: def({
    name: "dns_lookup",
    description: "Passieve lookup van openbare DNS-records (MX, TXT, CNAME) voor Microsoft-infrastructuurindicatoren. Geen scanning. Retourneert deterministische classificatie.",
    schema: z.object({ domain: z.string().min(3).max(253) }),
    async run(i, ctx) {
      const { sourceId, snapshot } = await ctx.research.dns(i.domain);
      const ev = classifyDns(snapshot);
      return JSON.stringify({ source_id: sourceId, mx: snapshot.mx, evidence: ev, summary: summarizeEvidence(ev), note: "MX-bewijs ≠ Intune/Defender/Purview-gebruik" });
    },
  }),
  registry_lookup: def({
    name: "registry_lookup",
    description: "Zoek in het KvK-handelsregister (indien geconfigureerd en goedgekeurd) op naam of KvK-nummer: rechtsvorm, vestiging, werkzame personen.",
    schema: z.object({ name: z.string().max(200).optional(), kvk_number: z.string().max(12).optional() }),
    async run(i, ctx) {
      const recs = await ctx.research.registry({ name: i.name, kvkNumber: i.kvk_number });
      return JSON.stringify(recs);
    },
  }),
  lookup_company_db: def({
    name: "lookup_company_db",
    description: "Controleer of een bedrijf al in de Sales Army-database staat (duplicaat, eerder geleverd, klant, uitgesloten).",
    schema: z.object({ name: z.string().max(200).optional(), domain: z.string().max(300).optional() }),
    async run(i) {
      const db = getDb();
      const domain = canonicalDomain(i.domain ?? null);
      const norm = i.name ? normalizeCompanyName(i.name) : null;
      const conds = [];
      if (domain) conds.push(eq(schema.companies.canonicalDomain, domain));
      if (norm) conds.push(ilike(schema.companies.normalizedName, `%${norm.split(" ")[0]}%`));
      if (!conds.length) return "Geef naam of domein op.";
      const rows = await db
        .select({ id: schema.companies.id, n: schema.companies.prospectNumber, name: schema.companies.officialName, domain: schema.companies.canonicalDomain, status: schema.companies.status, relationship: schema.companies.relationship })
        .from(schema.companies)
        .where(and(or(...conds), isNull(schema.companies.deletedAt)))
        .limit(25);
      const match = i.name || domain ? findDuplicate({ name: i.name ?? "", domain }, rows.map((r) => ({ id: r.id, name: r.name, domain: r.domain }))) : null;
      const excl = await db.select({ scope: schema.exclusions.scope, value: schema.exclusions.value, reason: schema.exclusions.reason }).from(schema.exclusions).where(eq(schema.exclusions.active, true));
      const exclHits = excl.filter((e) => (domain && e.value.toLowerCase() === domain) || (norm && normalizeCompanyName(e.value) && norm.includes(normalizeCompanyName(e.value))));
      return JSON.stringify({
        duplicate: match ? { ...match, prospectId: formatProspectId(rows.find((r) => r.id === match.matchedId)?.n ?? 0), status: rows.find((r) => r.id === match.matchedId)?.status, relationship: rows.find((r) => r.id === match.matchedId)?.relationship } : null,
        similar: rows.slice(0, 5).map((r) => ({ prospectId: formatProspectId(r.n), name: r.name, domain: r.domain, status: r.status })),
        exclusionHits: exclHits,
      });
    },
  }),
  get_company_dossier: def({
    name: "get_company_dossier",
    description: "Haal het opgeslagen dossier van een bedrijf op (feiten, bronnen, bewijs, signalen, scores).",
    schema: z.object({ company_id: z.string().uuid() }),
    async run(i, ctx) {
      if (!ctx.dossier) return "Niet beschikbaar";
      return JSON.stringify(await ctx.dossier(i.company_id, ctx.agentId === "quality_assurance_director"));
    },
  }),
  get_commercial_performance: def({
    name: "get_commercial_performance",
    description: "Commerciële prestaties uit belbureau-feedback: conversie per sector, omvang, score, dienst, signaal en Microsoft-bewijs, met betrouwbaarheidsintervallen.",
    schema: z.object({}),
    async run(_i, ctx) {
      return JSON.stringify(ctx.analytics ? await ctx.analytics() : {});
    },
  }),
  get_market_map: def({
    name: "get_market_map",
    description: "Permanente marktkaart: onderzochte sectoren, gebruikte bronnen/queries, gevonden en gekwalificeerde aantallen, geschatte uitputting (onzeker).",
    schema: z.object({}),
    async run(_i, ctx) {
      return JSON.stringify(ctx.marketMap ? await ctx.marketMap() : {});
    },
  }),
  get_run_status: def({
    name: "get_run_status",
    description: "Status van onderzoeksruns (lopend of specifiek run-ID).",
    schema: z.object({ run_id: z.string().uuid().optional() }),
    async run(i, ctx) {
      return JSON.stringify(ctx.runStatus ? await ctx.runStatus(i.run_id) : {});
    },
  }),
  delegate_to_agent: def({
    name: "delegate_to_agent",
    description: "Delegeer een deelopdracht aan een specialist van het Sales Army en ontvang diens antwoord.",
    schema: z.object({ agent_id: z.enum(AGENT_IDS), instruction: z.string().min(5).max(3000) }),
    async run(i, ctx) {
      if (!ctx.delegate) return "Delegatie niet beschikbaar in deze context.";
      if (ctx.depth >= 1) return "Maximale delegatiediepte bereikt.";
      if (i.agent_id === ctx.agentId) return "Kan niet aan jezelf delegeren.";
      return ctx.delegate(i.agent_id, i.instruction);
    },
  }),
  start_research_run: def({
    name: "start_research_run",
    description: "Start een echte onderzoeksrun (handmatig, sector of specifiek bedrijf). Vereist analist- of beheerdersrechten van de gebruiker.",
    schema: StartRunParams,
    async run(i, ctx) {
      if (!ctx.startRun) return "Niet beschikbaar.";
      if (!ctx.userRole || ctx.userRole === "viewer") return "Geweigerd: de gebruiker heeft alleen leesrechten.";
      const r = await ctx.startRun(i as StartRunParams);
      return r.created ? `Run gestart: ${r.runId}` : `Er loopt al een identieke run: ${r.runId}`;
    },
  }),
  propose_recommendation: def({
    name: "propose_recommendation",
    description: "Leg een aanbeveling vast voor menselijke beoordeling (wijzigingen aan uitsluitingen, juridische regels of scoremodel worden nooit automatisch toegepast).",
    schema: z.object({
      type: z.enum(["prioritize_industry", "deprioritize_industry", "scoring_adjustment", "new_criterion", "research_source", "search_strategy", "new_opportunity"]),
      title: z.string().max(200),
      content: z.string().max(2000),
      evidence_strength: z.enum(["statistically_meaningful", "indicative", "speculative"]),
    }),
    async run(i, ctx) {
      const [r] = await getDb()
        .insert(schema.recommendations)
        .values({ type: i.type, title: i.title, content: i.content, evidenceStrength: i.evidence_strength, requiresApproval: true, createdBy: `agent:${ctx.agentId}` })
        .returning({ id: schema.recommendations.id });
      return `Aanbeveling vastgelegd (${r.id}) — wacht op menselijke beoordeling.`;
    },
  }),
};

/** JSON schema for a tool's input, for the Messages API. */
export function toolJsonSchema(s: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(s, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}
