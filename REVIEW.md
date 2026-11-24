# Engineering & commercial review (v2) — 2026-11-24

An independent-style audit of the v1 implementation, followed by fixes. Passing tests did **not** count as evidence of
production readiness; every finding below was either fixed in code or is listed as an open risk.

## 1. Findings and what was done

| # | Area | Finding in v1 | Severity | Fix in v2 |
|---|---|---|---|---|
| 1 | Cost | Every candidate ran **5 tool-using agent loops** (enrich ≤18 turns on Sonnet, Microsoft, signals, an Opus "qualify" call that only wrote prose, Opus QA). ≈€0.60–0.80 per candidate, also for companies that were rejected later. | High | **Progressive funnel**: free screening (crawl, DNS, regex) → one cheap extraction call without tools → specialists only when needed → deterministic score → QA only for strong candidates. Median model cost per candidate ≈ €0.003–0.03. |
| 2 | Cost | Qualification agent on the strong model per company, although the score is deterministic. | Medium | Removed. Deterministic template rationale + **one batched call per 20 final prospects**. |
| 3 | Cost | Up to three skill texts (~13k chars) injected into every call, incl. high-volume extraction. | Medium | Per-task `skills` mode: `all` (strategy/discovery/chat), `project` (short Cloud Life skills), `none` (extraction). Per-task `effort` and `maxTokens`. |
| 4 | Cost | No early stop: candidates kept being researched after the target was reached. | High | Before paid research each candidate checks the run's qualified count; surplus candidates are parked as **reserve** and fed back first in the next run. |
| 5 | Research quality | Discovery relied on generic "search for lists" agent prompts; no memory of which sources work; 300 known company names pasted into every discovery prompt. | High | **Discovery-source database** (`discovery_sources`, `source_companies`) with per-source yield (unique, qualified, delivered, appointments), seeded with Dutch associations/trade fairs and 30+ search templates; Bayesian prioritisation with an exploration share; agents scout *new sources*; hunters' pools become permanent sources. Known names removed from prompts (dedup is code's job). |
| 6 | Research quality | Candidate names from model memory could enter the pipeline. | High | Harvested names must literally occur on the retrieved page; scouted source URLs must have been retrieved; extraction fields must carry a quote that code finds in the stored page. |
| 7 | Scaling | `loadIdentityIndex()` loaded **every company** into memory, called per candidate in two stages (O(N) per candidate). | High | DB-side matching (`findExistingCompany`): indexed KvK/domain/phone/identifier lookups + `pg_trgm` similarity, then the deterministic matcher on ≤60 rows. |
| 8 | Scaling | Discovery waited for all industries before research started; orchestrate job could exceed its 1 h expiry. | Medium | Discovery split into parallel `run_work` units (harvest/scout/hunt); candidates stream into research immediately; a run finalises when both work and candidates are closed. |
| 9 | Duplicate work | Cache hits created new source rows; robots.txt re-fetched per research context; agents could re-fetch pages another agent had already fetched. | Medium | Source rows reused per company+URL+content hash; providers are process singletons; deep research receives the known sources list. |
| 10 | Dedup | Historical records with outdated websites, other name variants or only a phone number would not match. | High | `company_identifiers` (domains incl. historical, phones, KvK, name variants); phone/KvK found during screening triggers a second dedup; historical import with email-domain extraction and commit-time re-matching. |
| 11 | Microsoft evidence | Mail gateways (Mimecast/Proofpoint/…) in front of Exchange Online were missed; no Teams SRV, second DKIM selector or msoid; per-technology confidence was a class only. | Medium | Gateway detection, SRV/selector2/msoid, optional public Entra tenant metadata (off by default), deterministic website/vacancy scan per technology, `technologyConfidence()` (noisy-OR over independent evidence types). Mail never raises Intune/Defender/Purview. |
| 12 | Operations | Secrets only via environment variables; no way to see whether the worker runs; no first-admin path in production before Entra is configured. | High | Encrypted secrets store (AES-256-GCM, write-only UI), **setup wizard** with real validation, worker heartbeat, `SETUP_TOKEN` bootstrap that closes after the first Entra admin login. |
| 13 | Security | Origin check used `Host` only → broken behind reverse proxies. | Medium | Accepts configured `APP_URL` host / `X-Forwarded-Host`. |
| 14 | Security | — | — | New paths reviewed: SSRF guard applies to all harvest/scout URLs; Firecrawl is used only for JavaScript-only pages, never to get past 401/403/CAPTCHA; secret values never logged; bootstrap constant-time + rate-limited; all new endpoints role-checked. `npm audit`: 0 vulnerabilities. |
| 15 | Bugs found by new tests | Phone regex missed `+31 (0)10 - 123 45 67`; same page source harvested twice per run (and marked exhausted); in-file duplicates in historical imports; retry of failed work skipped pending work. | — | All fixed, with regression tests. |

## 2. What was removed or simplified
- Per-company **qualify** agent call (now deterministic + batch).
- Per-company **enrich** tool loop for every candidate (now one extraction call; tool loop only for real gaps).
- Discovery via **"name the companies you know"** prompts and the `knownCompanyNames` input.
- `relationshipImport` (replaced by the historical importer with preview, mapping and matching).
- JSON editing for ordinary administration (wizard forms; JSON editors remain under Settings for advanced use).
- Three hunters doing the same thing: they now have distinct, dynamically activated roles (enterprise: groups/annual reports/rankings; midmarket: signal-driven gaps + shortfall round; growth: shortfall round only).

## 3. Are all eleven agents useful?
Yes, but not as eleven calls per company. Per company only **Company Research (extract)** always runs (cheap tier). Everything
else is conditional: Microsoft specialist (~25%), signals (~40%), gap-filling (~35%), QA (strong candidates only). Strategic
agents (CSO, Market Intelligence, hunters, Sales Ops) run a handful of times per week. See AGENTS.md → *Activated*.

## 4. Open risks (not solvable in code without live data)
- **Real yield is unmeasured.** Funnel shares and cost per qualified prospect are assumptions until the three pilots run.
- **Website-only legal-form detection** may leave many companies `unknown` (not callable) → shortfalls. KvK API (€6.20/mo + €0.02) is the cheap fix.
- **Association sites vary**: some member lists are behind logins or JavaScript (we do not bypass logins; JS needs the optional Firecrawl fallback).
- **Search-engine coverage of Dutch niche lists** differs per provider; compare Claude web search vs Brave during pilots.
- **QA on Opus is ~58% of variable cost**; running QA on Sonnet halves it but should only be decided after comparing QA rejection quality in pilots.
- Legal review of the telemarketing eligibility configuration is still required.

---

# v3 addendum: Claude Subscription Mode (2026-11-24)

**Decision.** The AI execution layer was refactored; the business functionality was left as it was.
- Agent tasks are parked and executed by native Claude Code cloud sessions (scheduled tasks) through a narrow research
  bridge.
- The Messages-API loop remains as the optional, explicitly approved Paid API Mode.
- Verified against Anthropic's documentation:
  - Scheduled tasks are billed as subscription usage.
  - The fire endpoint uses a per-task token.
  - OAuth credentials may not be used in our own code, and we don't.

**Issues found and fixed while doing this:**
1. **pg-boss sends failed in production.**
   - pg-boss asserts on option keys that are present but `undefined` (`priority`, `startAfter`).
   - Every `PgBossQueue.send` without a priority threw. Tests use the inline queue, so this was invisible.
   - Fixed: options are now built from defined values only.
2. **SSRF check skipped literal IP hosts.**
   - `assertPublicHost` returned early for IP literals.
   - `assertPublicHttpUrl` blocked the common cases, so this is defence in depth.
   - Fixed: literal private IPs are now refused.
3. **DNS resolution behind an egress proxy.**
   - Behind an egress proxy that resolves names itself, the system resolver fails and every fetch was refused.
   - Fixed: the check now falls back to a DoH A/AAAA lookup.
   - `fetch` must use `HTTPS_PROXY`, so `NODE_USE_ENV_PROXY=1` is required. Documented in DEPLOYMENT.md.
4. **A DNS failure marked discovery sources as permanently blocked.**
   - Now only robots.txt and private-address refusals block a source; DNS errors are retried.
5. **Navigation/footer anchors became candidates in the live harvest.**
   - Examples: "© 2026 Jaarbeurs", "Ga naar Members&rsquo; Benefits &raquo;".
   - Fixed: anchors are entity-decoded and navigation patterns are rejected. Regression test added.
6. **Sites that redirect to plain `http://`, or whose certificate covers only `www.`.**
   - These failed behind an HTTPS-only egress.
   - Fixed: https upgrade and `www.`/apex fallback, the same as a normal browser. Invalid certificates are still refused.

**Trade-offs:**
- Per-task token usage is not visible in Subscription Mode, so cost per task is recorded as €0.
- Throughput is bounded by the plan's usage limits. The pilot measures this (BUILD_STATUS.md).
- The live pilot confirmed what earlier reviews predicted:
  - Association member lists skew towards small companies.
  - Company websites often state no employee count.
  - Without KvK or another register, many candidates stay "size unknown" and are correctly not qualified.
  - The highest-yield way to improve volume is better size evidence: KvK, annual-report and ranking sources.
    Lowering the bar is not an option.
