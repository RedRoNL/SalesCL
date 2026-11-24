# BUILD STATUS

_Last updated: 2026-11-24. Persistent checklist — update when work is completed or discovered._

## Overall
**The application is built and its core functionality is implemented and tested end to end. It is NOT yet verified on
live research**: no Anthropic/Firecrawl/KvK credentials were available, and the build environment's network blocks
arbitrary websites. The live pilot (`npm run pilot`) is ready to run once those dependencies are in place.
Until that pilot has passed, do not consider the definition of done met.

## Remaining dependencies (exact)
| # | Dependency | Needed for | How |
|---|---|---|---|
| 1 | `ANTHROPIC_API_KEY` | All 11 agents | Anthropic Console → API key → secret manager |
| 2 | Outbound HTTPS from the worker to public websites + `api.anthropic.com` (+ DoH resolver) | Real research | Hosting network policy |
| 3 | Search provider approval: `FIRECRAWL_API_KEY` + add `"firecrawl"` to approvedPaidProviders, **or** add `"anthropic_web_search"` | Discovery | Settings → Budget / Onderzoeksproviders |
| 4 | Entra ID app registration (tenant, client ID/secret, roles) | Production sign-in | DEPLOYMENT.md §2 |
| 5 | Optional: KvK API subscription (`KVK_API_KEY`) | Authoritative legal form → more prospects become contact-eligible | developers.kvk.nl |
| 6 | Legal review of the contact-eligibility configuration | Compliance sign-off | SECURITY.md → Telemarketing |
| 7 | Import of existing customers / opportunities / historical lists, and competitor domains | Correct exclusions | Settings → Bestaande relaties importeren / Uitsluitingen |
| 8 | Live pilot run + review of `pilot-report.md` | Definition of done | `npm run pilot -- --industry food_production --target 5 --budget 10` |

## Implementation checklist
### Phase 1 — Discovery
- [x] Inspected coreyhaines31/marketingskills, ComposioHQ/awesome-claude-skills, firecrawl/skills, firecrawl/firecrawl; searched skills.sh for alternatives
- [x] Adoption evaluated per skill vs parent repo; security inspection (no scripts, no hidden instructions); licences recorded → SKILLS.md
- [x] Dutch telemarketing law researched (soft opt-in abolished 1-7-2026; legal persons callable B2B) → eligibility engine
- [x] Versions verified on npm (Next 16.4.6, React 19.3.1, @anthropic-ai/sdk 1.13.0, pg-boss 12.39, Drizzle 0.45.4, Zod 4.6.7, Tailwind 4.3.5, Vitest 5.1.1)
- [x] Architecture & decisions → ARCHITECTURE.md

### Phase 2 — Foundation
- [x] Next.js app, Tailwind tokens, Dutch dark UI shell
- [x] PostgreSQL schema (38 tables) + migration + idempotent seed (industries, seed exclusions, sector exclusions, scoring v1)
- [x] Entra ID OIDC (PKCE, nonce, tenant check), signed sessions, RBAC (admin/analyst/viewer), dev login disabled in prod
- [x] Security headers, CSRF/origin checks, rate limiting, secure errors, audit log
- [x] Agent runtime (tool loop, allow-lists, Zod-validated output, cost accounting, budget checks)
- [x] Community skills installed (pinned, with licences) + 4 Cloud Life project skills; Claude Code subagents generated
- [x] Shared company intelligence (Cloud Life profile, ICP, security rules) injected into every agent

### Phase 3 — Research & agents
- [x] 11 agents with instructions, skills, tools, I/O schemas, quality standards, escalation rules, KPIs, task history
- [x] Genuine orchestration: CSO strategy, parallel discovery, per-candidate checkpointed stages, CSO approval, delegation in chat
- [x] Providers behind interfaces: Firecrawl, Claude web search, HTTP fetch (robots/SSRF-safe), DoH/system DNS, KvK
- [x] Dedup (KvK, domain, parent group, alias, fuzzy), exclusions (company/domain/parent/legal entity/sector/name), suppressions
- [x] Deterministic Microsoft evidence classification + validation of agent claims
- [x] Transparent scoring (fit vs confidence), service recommendation
- [x] Independent QA (deterministic checks + strong-model QA with filtered dossier; veto; documented admin override)
- [x] Contact eligibility engine

### Phase 4 — Application
- [x] Dashboard (real metrics; estimated vs contracted revenue separated; costs; agent activity; run status)
- [x] Sales Army HQ (roster, skills, tools, model, live status, performance, task log, communication, recommendations, chat with each agent or the whole army)
- [x] Prospect database with all 14 requested filters; detailed intelligence profile
- [x] Research control centre (start/pause/resume/cancel/retry; industries, size range, target, depth, budget; providers shown)
- [x] Market intelligence (coverage with explicit uncertainty, performance by segment with CIs, signals, geography, discovery history, recommendations)
- [x] Weekly lists (review, approve/reject items, QA report, exports, history) and feedback import wizard
- [x] Settings (ICP, industry priorities, size bands, exclusions, suppressions, scoring versions, schedule, models, credentials status, providers, budgets, users, retention, skills, eligibility, learning, relationship import, audit log)

### Phase 5 — Automation
- [x] pg-boss worker; weekly cron (Mon 08:00 Europe/Amsterdam, configurable); watchdog; retention; learning job
- [x] Retries with backoff, checkpoints, interrupted-run recovery, duplicate-run prevention, budget pause, failure surfacing
- [x] Excel/CSV export (clean columns, formula-injection safe, feedback template tab), delivery history
- [x] Feedback-driven optimisation (stats with Wilson CIs/p-values, recommendations, bounded auto-adjust, approvals)
- [x] Cost tracking: per task/agent/provider/run; cost per company, per qualified prospect, per appointment; weekly/monthly budgets

### Phase 6 — Validation
- [x] 106 automated tests passing (see below)
- [x] Production build passes; all pages rendered in a headless browser against a populated DB with zero console errors
- [x] Real worker + UI path verified (UI → server action → pg-boss → worker → runtime → DB → UI)
- [x] Security self-review; fixed: DNS/redirect SSRF, CSV formula injection, `javascript:` URL rendering
- [ ] **Live research pilot on actual Dutch companies** — blocked by dependencies 1–3
- [x] Deployment instructions (DEPLOYMENT.md, Dockerfile, docker-compose, CI)

## Test results (2026-11-24)
`npm test` → **3 files, 106 tests, all passing** (~10 s), against PostgreSQL 16.

| Area (brief §16) | Covered by |
|---|---|
| Company discovery | pipeline E2E: discovery agents → candidates registered from fetched directory source |
| Deduplication / domain normalisation / parent matching | `domain.test.ts` (dedup, canonicalDomain, parent group), E2E duplicate of existing customer |
| Exclusion enforcement | seed exclusions incl. Visma ProActive, MSP category, sector, parent, delivered, customer; E2E |
| Scoring calculations | weights, thresholds, confidence downgrade, hard failures, stale/unsourced signals |
| Research source validation | facts citing non-existent sources → confidence 0; phone must appear on source; QA deterministic checks |
| Microsoft evidence classification | DNS rules, claim validation (quote present / absent / no source) |
| Contact eligibility | BV/stichting eligible; VOF/eenmanszaak restricted; unknown; suppressed; mobile withheld; re-verification |
| Structured AI responses | every output schema converts to JSON Schema; invalid input/tasks rejected; Zod validation in runtime |
| Excel export | header columns, CLSA IDs, no AI rationale, CSV delimiter/BOM, formula-injection neutralisation |
| Feedback import | mapping suggestion, validation errors, duplicate detection, append-only history, appointment/opportunity, do-not-contact suppression |
| Scheduled execution | pg-boss schedule `0 8 * * 1` tz Europe/Amsterdam registered; disabling removes it |
| Failed task recovery | transient failures retried; failed → *retry failed tasks* re-opens and completes the run |
| Agent orchestration | 8 distinct agents in one weekly run; CSO → specialist delegation in HQ; all 11 agents execute |
| Authorisation | session tampering rejected, role hierarchy, settings validation |
| Prompt-injection resistance | sanitiser/wrapper tests; injected page in E2E: warning surfaced, privileged tool call denied and audited, no run started |

The E2E tests use a **synthetic scripted model** and **synthetic providers** (fictitious `.example` companies). They prove
the orchestration, persistence and controls — not the quality of live research.

## Known limitations
- Live research quality (discovery yield, enrichment accuracy) is unverified until the pilot runs.
- Without a KvK subscription, legal form must come from company websites (footer/colophon/terms); companies where it
  can't be found stay `unknown` and are excluded from calling lists — this may cause shortfalls by design.
- Seed exclusions are name-based; competitor domains should be added by an administrator.
- In-process API rate limiter; use a WAF/edge limiter for multi-instance web deployments.
- Market pool sizes are unknown until an administrator records sourced estimates (coverage shows "onzeker").
- Model prices in `src/lib/costs.ts` must be maintained manually.
- The chat UI polls every 2.5 s (no streaming of intermediate agent steps).

## Legal sources consulted (telemarketing)
- https://www.ictrecht.nl/en/blog/end-of-the-soft-opt-in-telemarketing-from-1-july-2026-only-with-consent
- https://www.hoganlovells.com/en/publications/the-netherlands-tightens-telemarketing-rules-consent-becomes-the-new-standard
- https://www.houthoff.com/actueel/nieuws/telemarketing-voortaan-alleen-nog-met-toestemming/
- https://business.gov.nl/regulation/telesales/
- https://www.acm.nl/en/node/29377
