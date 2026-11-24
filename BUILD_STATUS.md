# BUILD STATUS

_Last updated: 2026-11-24 (v3: Claude Subscription Mode + live zero-cost pilot). Persistent checklist — update when work is completed or discovered._

## Overall (v3, Claude Subscription Mode)
- **Default execution.** AI work runs in native Claude Code sessions (scheduled tasks) on the existing subscription,
  through the research bridge.
- **Verified live.** The full pipeline ran on the real web with €0 API cost: discovery, screening, extraction, deep
  research, Microsoft evidence, scoring and gates.
- **Not production-proven for volume.** The first zero-cost pilot produced **0 of 10** qualified companies before the
  subscription's 5-hour usage limit stopped the session. See the pilot results below.

## Zero-cost pilot (2026-11-24, preset "manufacturing", 300–5,000 FTE, run 4a9fd818…)

Executed in this Claude Code session as the subscription executor: `npm run army`, the 11 subagent roles on Sonnet,
the CSO strategy written by the session itself, native WebSearch, and fetching through the bridge.

| Measurement | Result |
|---|---|
| Candidates discovered | 117 (from 13 real sources: FME, NRK, VNCI, AWVN, Chemelot, Rijk Limburg top 10, regiobedrijf, GMV, …) |
| Qualified (QA- and eligibility-approved) | **0**: shortfall of 10, reported, bar not lowered |
| Rejected | 36. Of these, 26 were outside 300–5,000 (mostly SMEs from association lists, sizes sourced from annual-account FTE), 2 had no Microsoft environment (Google Workspace), 7 scored below threshold, 1 was a duplicate |
| Needs more research | 36. Best: fit 61–70 with confidence 45–81 (Attero 757 FTE, Accsys, Allinplast, Azelis, Beekenkamp). Typical gaps: Dutch-only headcount (only group or global counts were sourced), Microsoft 365 only weakly indicated, IT purchasing authority unknown |
| Failed / not a company | 17. Association acronyms and navigation links from member pages (filters fixed, see REVIEW v3) |
| Still open when stopped | 28 candidates, 36 parked AI tasks: resumable by the next scheduled start |
| Verified Microsoft evidence (≥ strongly indicated) | 65 companies (DNS/website, deterministic) |
| Verified phone numbers | 58 |
| Sourced employee counts | 45 |
| Duplicates | `duplicatesDetected` shows 765, which is **wrong**: re-seeing companies when deferred work resumed was counted as a duplicate. Fixed for future runs (`already_in_run`); the real duplicate rejections were 1 |
| QA rejection rate | n/a: no candidate reached QA |
| AI tasks | 273 parked: 173 succeeded, 64 failed (mostly non-companies and deliberate retirements), 36 open |
| Duration | ≈ 4.7 h wall-clock, including fixing the bugs found along the way |
| Subscription usage | Hit the **5-hour usage limit** once. No switch to paid API happened. The run resumed after the reset, and the user stopped further work to preserve daily limits |
| Additional API cost | **€0** (no API key configured). Provider cost €0 (no KvK, Brave or Firecrawl) |

**Conclusions:**
1. The architecture works and is compliant: €0 extra, resumable, checkpointed, and the quality gates held.
2. Throughput on one seat is the binding constraint. About 270 agent tasks for 117 candidates used up a 5-hour window
   without reaching 10 qualified. 100 per week is **not** demonstrated on a single seat with free sources only.
3. The yield problem is size evidence and source mix, not the model.
   - Association member lists are SME-heavy.
   - Websites rarely state Dutch headcount.
   - Highest-impact next steps, in this order:
     1. KvK API (€6.20/month; gives werkzame personen and legal form in one deterministic call, instead of agent deep
        research).
     2. Prioritise ranking and employer sources (AWVN, top-employer lists) over member lists.
     3. Pre-filter on the free directory FTE (liza.nl-style annual-account counts) before any AI task.
4. Re-run the pilot after (1)–(3) before deciding on more seats or Paid API Mode.

## Exact remaining steps (in order)
| # | Step | Where | Outside the app? |
|---|---|---|---|
| 1 | Host the dashboard with HTTPS + PostgreSQL 16 (`pg_trgm`). No worker needed | DEPLOYMENT.md §0 | Yes |
| 2 | `npm run db:migrate`; set `SESSION_SECRET`, `SECRETS_ENCRYPTION_KEY`, `SETUP_TOKEN`, `APP_URL` | DEPLOYMENT.md | Yes |
| 3 | Register the Entra ID app | Entra admin center | Yes |
| 4 | Wizard step 2: Subscription Mode, public URL, generate the bridge token | /setup | No |
| 5 | claude.ai/code: environment (Limited + dashboard host, network secret, `SALES_ARMY_URL`) and scheduled task (wizard prompt + cron) | SUBSCRIPTION_MODE.md §3 | Yes |
| 6 | Strongly recommended: KvK API key (approve in Budget) | developers.kvk.nl | Yes |
| 7 | Imports, exclusions, legal review of contact eligibility | /setup, counsel | Partly |
| 8 | Re-run the zero-cost pilots and compare yield per subscription window | /pilots | No |
| 9 | Consider a Team/Enterprise seat for commercial use; add seats only if measured throughput requires it | claude.ai | Yes |

## v2 checklist (this review)
- [x] Independent audit with fixes (REVIEW.md: 15 findings)
- [x] Discovery-source database, seeds (≈20 associations/fairs + ≈35 templates), yield tracking, prioritisation + exploration, scouting, hunters' pools persisted
- [x] Progressive funnel: free screening → one cheap extraction → dynamic specialists → deterministic score → QA → eligibility
- [x] Target-reached reserve and reuse in the next run; shortfall round with growth/midmarket hunters
- [x] DB-side identity matching (pg_trgm, identifiers incl. historical domains/phones/KvK/name variants)
- [x] Microsoft intelligence v2 (gateways, SRV, DKIM selector2, msoid, optional tenant metadata, vacancy/website scan, per-technology confidence)
- [x] Research cost comparison and three cost scenarios (COSTS.md, live estimate in Setup)
- [x] Brave Search provider; Firecrawl only as JS-render fallback; Claude web search as default (no extra subscription)
- [x] Agents reassessed: dynamic activation, per-task tier/effort/skills/max tokens, batch rationale, CSO strategic only
- [x] Encrypted secrets store, setup wizard with live validation, worker heartbeat, first-admin bootstrap
- [x] Historical imports (calling lists, customers, opportunities, rejected, opt-outs) with matching on messy data
- [x] Three pilot presets with explicit budget approval and the requested measurements (/pilots, CLI report)
- [x] Proxy-aware origin check; security review of new paths; `npm audit` 0 vulnerabilities
- [ ] **Live pilots** — blocked by steps 1–6 above

## Test results (2026-11-24)
`npm test` → **4 files, 130 tests, all passing** (~12 s) on PostgreSQL 16. Production build passes; all 14 pages render in a headless
browser against a populated test database with zero console errors.

| Area | Covered by |
|---|---|
| Discovery engine | harvest → list page → outbound links; LLM list extraction with fabricated name rejected; scouted source must be retrieved; per-source yield; page sources harvested once per run; selection exploit/explore/re-harvest interval |
| Funnel economics | Google-Workspace rejection with zero model calls; specialists activated only when needed (asserted per company); extraction on fast tier without tools; CSO never per company; batch rationale (1 call); target-reached reserve and reuse in next run |
| Deterministic extraction | NL phone formats incl. `+31 (0)10 - …`, mobile excluded, KvK, legal form, employees, Microsoft mentions per page type, security vacancies, certifications, subpage selection |
| Microsoft evidence | gateways, SRV, tenant metadata, per-technology confidence, mail never lifts the security stack, fabricated quotes dropped |
| Identity & imports | phone/KvK/domain/historical-domain matching, email-derived domains, in-file duplicates, opt-out lists → suppressions, later discovery recognised as already delivered |
| Secrets & bootstrap | AES-GCM round-trip + tamper detection, env precedence, write-only storage; setup-token rules; pilot budget approval |
| All v1 areas | as before: dedup, exclusions, scoring, eligibility, export (formula-injection safe), feedback import, scheduling, recovery, authorisation, prompt-injection containment, HQ delegation, all 11 agents executable |

E2E tests use a **synthetic scripted model** and **synthetic providers**; they prove orchestration, persistence and controls, not live research quality.

## Known limitations
- Funnel shares and costs in COSTS.md are assumptions until pilots measure them.
- Without KvK, legal form comes from websites; companies where it isn't published stay `unknown` (not callable) → possible shortfalls.
- Association member lists behind logins are not harvested (by design); JavaScript-only lists need the Firecrawl fallback.
- Seed association URLs are homepages; the first harvest verifies whether a reachable member list exists.
- In-process API rate limiter; use a WAF/edge limiter for multiple web instances.
- Model prices in `src/lib/costs.ts` are maintained manually.

## Legal sources consulted (telemarketing)
- https://www.ictrecht.nl/en/blog/end-of-the-soft-opt-in-telemarketing-from-1-july-2026-only-with-consent
- https://www.hoganlovells.com/en/publications/the-netherlands-tightens-telemarketing-rules-consent-becomes-the-new-standard
- https://www.houthoff.com/actueel/nieuws/telemarketing-voortaan-alleen-nog-met-toestemming/
- https://business.gov.nl/regulation/telesales/
- https://www.acm.nl/en/node/29377
