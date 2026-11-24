/** Small statistics helpers for the learning engine. */

/** Wilson score interval for a binomial proportion. */
export function wilson(successes: number, n: number, z = 1.96): { p: number; low: number; high: number } {
  if (n === 0) return { p: 0, low: 0, high: 0 };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { p, low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

/** Standard normal CDF (Abramowitz–Stegun approximation). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

/** Two-sided two-proportion z-test p-value: group vs rest. */
export function twoProportionPValue(s1: number, n1: number, s2: number, n2: number): number {
  if (n1 === 0 || n2 === 0) return 1;
  const p = (s1 + s2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return 1;
  const z = (s1 / n1 - s2 / n2) / se;
  return 2 * (1 - normalCdf(Math.abs(z)));
}

export type EvidenceStrength = "statistically_meaningful" | "indicative" | "speculative";

export function evidenceStrength(n: number, pValue: number, minIndicative = 10, minSignificant = 30): EvidenceStrength {
  if (n >= minSignificant && pValue < 0.05) return "statistically_meaningful";
  if (n >= minIndicative) return "indicative";
  return "speculative";
}
