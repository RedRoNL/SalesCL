# SCORING MODEL

Implementation: `src/domain/scoring.ts` (pure, unit-tested). Configuration is versioned in `scoring_configs`
(Settings → Scoremodel). **The initial model is a hypothesis**; the learning engine tests it against calling outcomes.

## Two separate numbers
- **Commercial fit (0–100)** — how attractive the organisation is *if the facts are true*.
- **Evidence confidence (0–100)** — how well the key facts are supported by retrieved sources.

A company can never become "exceptional"/"strong" on attractive industry/size alone: if confidence is below
`minConfidenceForQualified` (default 60) the classification drops to *requires additional research*.

## Components (initial weights)

| Component | Max | How points are earned |
|---|---|---|
| Microsoft technology fit | 30 | 55% from the best of Microsoft 365 / Exchange Online evidence; 45% from the security stack (Entra, Intune, Defender, Purview, Copilot, Azure, SharePoint, Teams; best three weighted 50/30/20). Class values: confirmed 1, strong ⅔, weak ⅓, unknown 0. Contradicted M365 (e.g. Google Workspace) → 0 and a hard failure. |
| Organisation size | 25 | 300–1,999 → 100%; 2,000–5,000 → 88%; 200–299 → 56%; 50–199 → 40%; 5,001–20,000 → 40%; unknown → 0. |
| Industry & operational fit | 15 | Effective priority tier (base tier ± learning adjustment): T1 100%, T2 75%, T3 45%, T4 20%, excluded 0; unknown 30%. |
| Security & compliance relevance | 15 | NIS2 essential 0.4 / important 0.3; DORA 0.3; sensitive data 0.2; OT dependency 0.2; regulator/certification 0.1 (capped at 1). |
| Dutch purchasing authority | 10 | NL independent / NL group HQ 100%; NL subsidiary with own IT 70%; unknown 30%; IT bought centrally abroad 0 (hard failure). |
| Current buying signals | 5 | Only **sourced** signals ≤ 365 days old: high 0.6, medium 0.4, low 0.2 (undated counts half), capped at 1. |

Fit = Σ points / Σ max × 100 (so custom weights need not sum to 100).

## Confidence
Weighted field confidences — employees 0.20, industry 0.10, HQ 0.10, Microsoft 0.25, purchasing authority 0.15,
phone 0.10, legal form 0.10 — × source diversity (≥3 distinct hosts 1.0, 2 → 0.9, 1 → 0.7, 0 → 0.4) × freshness
(oldest key fact >180 days 0.9, >365 days 0.75). Field confidences are zeroed when the field has no stored source.

## Classifications

| Fit | Class | Treatment |
|---|---|---|
| 85–100 | Exceptional opportunity | → QA → eligibility → list (priority A) |
| 70–84 | Strong opportunity | → QA → eligibility → list (priority B) |
| 55–69 | Requires additional research | not delivered; kept for later research |
| < 55 | Reject | not delivered |

**Hard failures** override any score: hard exclusion/contact restriction, <50 employees, far above ICP, IT purchasing
abroad, excluded sector, contradicted Microsoft environment.

## Recommended service
Rule-based baseline (`src/domain/services.ts`), which the Lead Qualification Specialist may override only with an
explicit evidence-based reason (stored in the rationale): agentic-AI signal → Agentic AI Security Assessment; Copilot
adoption/evidence → Copilot Security Assessment; weak Microsoft evidence → Microsoft Security Assessment; Purview or
data-governance signal → Purview Care (+Protect 365 if regulated data); regulated data & ≥300 FTE → Protect 365 +
Purview Care; regulated data <300 → Purview Assessment; otherwise → Protect 365.

## Validation loop
`src/lib/analytics.ts` reports appointment rates by score band with Wilson intervals. If 85–100 converts worse than
70–84 (with ≥10 calls each), a *scoring_adjustment* recommendation is raised. Weight/threshold changes always require
an administrator (new version; history preserved; old scores keep their `scoring_config_id`).

## Potential score (v2, used only for routing)
`potentialScore()` estimates what a company could score once unknowns are researched (bounded expected values for unknown size,
authority, Microsoft evidence and sector; known negatives are never forgiven). Below the research threshold (default 55) or
`minScreenScoreForExtraction` no paid research is spent. It is never used for delivery decisions. The final rationale is first
generated deterministically from the score components (`templateRationale`) and then enriched in batches by the Lead
Qualification Specialist for the final list.
