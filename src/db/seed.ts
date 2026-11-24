import { sql } from "drizzle-orm";
import type { DB } from "./client";
import * as s from "./schema";
import { INDUSTRY_SEED, EXCLUSION_SEED, SECTOR_EXCLUSIONS } from "./seed-data";
import { normalizeExclusionValue } from "@/domain/exclusion";
import { DEFAULT_SCORING } from "@/domain/scoring";

/** Idempotent reference-data seed. Safe to run on every deploy. */
export async function seedReferenceData(db: DB) {
  for (const ind of INDUSTRY_SEED) {
    await db
      .insert(s.industries)
      .values({ ...ind, doraApplicable: ind.doraApplicable ?? false })
      .onConflictDoNothing({ target: s.industries.code });
  }
  const existing = await db.select({ v: s.exclusions.normalizedValue, scope: s.exclusions.scope }).from(s.exclusions);
  const has = (scope: string, v: string) => existing.some((e) => e.scope === scope && e.v === v);
  for (const ex of EXCLUSION_SEED) {
    const nv = normalizeExclusionValue(ex.scope, ex.value);
    if (!has(ex.scope, nv))
      await db.insert(s.exclusions).values({ scope: ex.scope, value: ex.value, normalizedValue: nv, category: "seed", reason: ex.reason, permanent: true, createdBy: "system:seed" });
  }
  for (const code of SECTOR_EXCLUSIONS) {
    if (!has("sector", code))
      await db.insert(s.exclusions).values({ scope: "sector", value: code, normalizedValue: code, category: "competitor", reason: `Uitgesloten sector: ${code}`, permanent: true, createdBy: "system:seed" });
  }
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(s.scoringConfigs);
  if (count === 0) {
    await db.insert(s.scoringConfigs).values({
      version: 1, weights: DEFAULT_SCORING.weights, thresholds: DEFAULT_SCORING.thresholds, rules: DEFAULT_SCORING.rules,
      active: true, notes: "Initieel scoremodel (hypothese, te valideren met commerciële resultaten)", createdBy: "system:seed", approvedBy: "system:seed",
    });
  }
  const [{ sc }] = await db.select({ sc: sql<number>`count(*)::int` }).from(s.strategies);
  if (sc === 0) {
    await db.insert(s.strategies).values({ version: 1, content: { note: "Baseline: ICP-prioriteiten uit configuratie", industryTierOverrides: {} }, createdByAgent: "system", approved: true, approvedBy: "system:seed" });
  }
}
