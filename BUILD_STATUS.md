# BUILD STATUS

_Last updated: 2026-11-24 (v2 review). Persistent checklist — update when work is completed or discovered._

## Overall
The platform is built, reviewed (REVIEW.md) and tested end to end with synthetic data. **It has not yet performed live
research**: the build environment had no Anthropic/KvK credentials and its network blocks ordinary websites. The three live pilots
are prepared (Setup → step 10, or `npm run pilot`). Do not treat the system as production-proven until they pass.

## Exact remaining steps (in order)
| # | Step | Where | Outside the app? |
|---|---|---|---|
| 1 | Provision hosting (web + worker containers, PostgreSQL 16 with `pg_trgm`), set `DATABASE_URL`, `APP_URL`, `SESSION_SECRET`, `SECRETS_ENCRYPTION_KEY`, `SETUP_TOKEN`; allow outbound HTTPS to the public web | DEPLOYMENT.md §0–5 | Yes |
| 2 | `npm run db:migrate`; start web and worker | DEPLOYMENT.md | Yes |
| 3 | Create an Anthropic API key with a monthly spend limit | console.anthropic.com | Yes |
| 4 | Register the Entra ID app (redirect URI, client secret, app roles) | Entra admin center | Yes (needs Entra admin) |
| 5 | Optional: KvK API key (recommended) | developers.kvk.nl | Yes |
| 6 | Sign in with `SETUP_TOKEN` → complete Setup steps 1–9 (keys, providers + approval, Entra, imports, exclusions, budget, schedule) | /setup | No |
| 7 | Legal review of the contact-eligibility configuration | Settings → Contactgeschiktheid | Counsel |
| 8 | Run the three pilots (≈€15 budget each), review /pilots metrics and the lists | Setup → 10, /pilots | No |
| 9 | Calibrate: funnel thresholds, QA model tier, budgets from measured cost per qualified prospect | Settings | No |
| 10 | Remove `SETUP_TOKEN`; enable the weekly schedule; click *Start eerste onderzoeksrun* or wait for Monday 08:00 | Setup | Yes / No |

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
