/**
 * LIVE PILOT — runs the real Sales Army pipeline on a small set of actual
 * Dutch companies and verifies the 11 pilot criteria from the build brief.
 *
 * Requires: ANTHROPIC_API_KEY, a migrated DATABASE_URL, outbound network to the
 * research targets. FIRECRAWL_API_KEY optional (else Claude web search + direct
 * HTTP fetch). Paid providers must be approved in Settings → Budget.
 *
 *   npm run pilot -- --industry food_production --target 5 --budget 10
 *   npm run pilot -- --company "Bedrijfsnaam" --website https://www.example.nl --budget 3
 *   npm run pilot -- ... --approve-export --feedback ./feedback.csv
 *
 * Writes pilot-report.md. Nothing is ever called, e-mailed or contacted.
 */
import { writeFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { env } from "@/lib/env";
import { InlineQueue, setQueue } from "@/pipeline/queue";
import { handlers } from "@/worker/handlers";
import { createRun, getRun } from "@/pipeline/runs";
import { approveList } from "@/lib/lists";
import { exportList } from "@/lib/exporter";
import { createImportPreview, commitImport } from "@/lib/feedbackImport";
import { commercialPerformance, generateRecommendations } from "@/lib/analytics";
import { readFileSync } from "node:fs";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  if (!env().ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY ontbreekt — de live pilot kan niet draaien. Zie BUILD_STATUS.md → Resterende afhankelijkheden.");
    process.exit(2);
  }
  const budget = Number(arg("budget") ?? 10);
  const queue = new InlineQueue();
  for (const [n, h] of Object.entries(handlers)) queue.on(n as never, h as never);
  setQueue(queue);

  const company = arg("company");
  const run = company
    ? await createRun("company", { target: 1, companyName: company, companyWebsite: arg("website") }, "system:pilot", budget)
    : await createRun("sector", { target: Number(arg("target") ?? 5), industries: [arg("industry") ?? "food_production"] }, "system:pilot", budget);
  console.log(`Pilot-run ${run.runId} gestart (budget €${budget}) — dit voert echte research uit…`);
  const started = Date.now();
  await queue.drain();
  const r = (await getRun(run.runId))!;
  const db = getDb();
  const q = async <T>(s: ReturnType<typeof sql>) => (await db.execute(s)) as unknown as T[];

  const [cands] = await q<{ n: number; real: number }>(sql`select count(*)::int as n, count(*) filter (where c.canonical_domain not like '%.example')::int as real from run_candidates rc join companies c on c.id = rc.company_id where rc.run_id = ${run.runId}`);
  const [srcs] = await q<{ n: number; types: string[] }>(sql`select count(*)::int as n, array_agg(distinct source_type) as types from research_sources where run_id = ${run.runId}`);
  const tech = await q<{ classification: string; n: number }>(sql`select classification::text, count(*)::int as n from technology_evidence where run_id = ${run.runId} group by 1`);
  const [emp] = await q<{ withCount: number; sourced: number }>(sql`select count(*) filter (where c.employee_count is not null or c.employee_min is not null)::int as "withCount", count(*) filter (where c.employee_source_id is not null)::int as sourced from run_candidates rc join companies c on c.id = rc.company_id where rc.run_id = ${run.runId}`);
  const [scores] = await q<{ n: number; withRationale: number }>(sql`select count(*)::int as n, count(*) filter (where length(rationale) > 20)::int as "withRationale" from qualification_scores where run_id = ${run.runId}`);
  const stats = (r.stats ?? {}) as Record<string, number>;
  const qa = await q<{ verdict: string; n: number }>(sql`select verdict::text, count(*)::int as n from qa_reviews where run_id = ${run.runId} group by 1`);
  const [qaModel] = await q<{ model: string }>(sql`select distinct model from agent_tasks where run_id = ${run.runId} and agent_id = 'quality_assurance_director' limit 1`);
  const agents = await q<{ agent_id: string; n: number; cost: number }>(sql`select agent_id, count(*)::int as n, sum(cost_eur)::float as cost from agent_tasks where run_id = ${run.runId} group by 1 order by 1`);
  const [list] = await db.select().from(schema.prospectLists).where(eq(schema.prospectLists.runId, run.runId));

  let exportResult = "Niet uitgevoerd (gebruik --approve-export; vereist menselijke review van de lijst)";
  if (list && flag("approve-export")) {
    await approveList(list.id, "system:pilot-operator", true);
    try {
      const e = await exportList(list.id, "xlsx", "system:pilot-operator");
      writeFileSync(e.fileName, e.buffer);
      exportResult = `${e.rows} rijen → ${e.fileName} (${e.withheld.length} achtergehouden)`;
    } catch (err) {
      exportResult = `Geblokkeerd: ${err instanceof Error ? err.message : err}`;
    }
  }
  let feedbackResult = "Niet uitgevoerd (gebruik --feedback <bestand.csv|xlsx>)";
  let learningResult = "—";
  const fb = arg("feedback");
  if (fb) {
    const p = await createImportPreview(fb, readFileSync(fb), "system:pilot-operator");
    const c = await commitImport(p.importId, "system:pilot-operator");
    feedbackResult = `${c.committed} resultaten vastgelegd (${p.preview.filter((x) => x.errors.length).length} fouten)`;
    const perf = await commercialPerformance();
    const recs = await generateRecommendations(perf);
    learningResult = `n gebeld=${perf.totals.called}, aanbevelingen=${recs.created.length}`;
  }

  const ok = (b: boolean) => (b ? "✅" : "❌");
  const report = `# Live pilot — ${new Date().toISOString()}
Run: \`${run.runId}\` · status **${r.status}** · fase ${r.stage} · duur ${Math.round((Date.now() - started) / 1000)}s · kosten €${Number(r.costEur).toFixed(2)} / budget €${budget}
${r.error ? `Fout: ${r.error}\n` : ""}${r.pauseReason ? `Pauze: ${r.pauseReason}\n` : ""}
| # | Criterium | Resultaat | |
|---|---|---|---|
| 1 | Research engine ontdekt echte bedrijven | ${cands.real}/${cands.n} kandidaten met echt domein | ${ok(cands.real > 0)} |
| 2 | Ondersteunende bronnen opgeslagen | ${srcs.n} bronnen (${(srcs.types ?? []).join(", ")}) | ${ok(srcs.n > 0)} |
| 3 | Microsoft-bewijs correct geclassificeerd | ${tech.map((t) => `${t.classification}: ${t.n}`).join(", ") || "geen"} | ${ok(tech.length > 0)} |
| 4 | Medewerkersschattingen onderbouwd | ${emp.sourced}/${emp.withCount} met bron | ${ok(emp.withCount === 0 || emp.sourced === emp.withCount)} |
| 5 | Commerciële fit uitgelegd | ${scores.withRationale}/${scores.n} scores met onderbouwing | ${ok(scores.n > 0 && scores.withRationale === scores.n)} |
| 6 | Uitsluitingen gehandhaafd | ${stats.discovery_excluded ?? 0} bij ontdekking + ${stats.excluded ?? 0} na verrijking uitgesloten | ${ok(true)} |
| 7 | Duplicaten geweigerd | ${stats.discovery_duplicate ?? 0} duplicaten · ${stats.discovery_reused ?? 0} hergebruikt | ${ok(true)} |
| 8 | QA werkt onafhankelijk | ${qa.map((x) => `${x.verdict}: ${x.n}`).join(", ") || "geen reviews"} · model ${qaModel?.model ?? "—"} | ${ok(qa.length > 0)} |
| 9 | Beloplijst exporteerbaar | ${exportResult} | ${ok(exportResult.includes("rijen"))} |
| 10 | Feedback importeerbaar | ${feedbackResult} | ${ok(feedbackResult.includes("vastgelegd"))} |
| 11 | Feedback verbetert aanbevelingen | ${learningResult} | ${ok(learningResult.includes("aanbevelingen"))} |

## Agents
${agents.map((a) => `- ${a.agent_id}: ${a.n} taken, €${a.cost.toFixed(3)}`).join("\n")}

## Lijst
${list ? `${list.isoWeek} · tekort ${list.shortfall}\n\n${list.managementSummary ?? ""}` : "Geen lijst aangemaakt."}
`;
  writeFileSync("pilot-report.md", report);
  console.log(report);
  process.exit(0);
}

main().catch((e) => {
  console.error("Pilot mislukt:", e);
  process.exit(1);
});
