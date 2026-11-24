# COSTS — research methods, pricing and operating-cost scenarios

_Prices researched 2026-11-24; vendor pages and third-party summaries disagree in places — verify before contracting.
The live estimate for your configuration is shown in **Setup → Budget**; the model is `src/lib/costModel.ts`._

## 0. Default: Claude Subscription Mode — €0 additional AI cost
- **AI.** All agent tasks run in Claude Code cloud sessions billed to the existing Claude subscription. There is no
  Anthropic API key and no per-token cost, so the dashboard records AI cost as €0 per task. Usage counts against the
  plan's limits. When they are reached, work waits for the next window: there is **no automatic fallback to paid API**.
- **Search.** Native Claude Code WebSearch, included in the subscription. Paid search APIs stay off by default.
- **Fetching, DNS, extraction, scoring, QA checks, eligibility.** Deterministic code on the dashboard host, €0.
- **Optional paid items**, each requiring explicit approval: KvK API (€6.20/month + €0.02 per query), Brave, Firecrawl,
  and Paid API Mode.
- **Hosting.** €0 on an existing server, ≈€5–10/month on one small VPS, or ≈€15–40/month on PaaS (DEPLOYMENT.md §0).
  An always-on worker is no longer needed.
- **Plan advice.** Use a Team or Enterprise seat for business use under the Commercial Terms. Whether one seat's weekly
  allowance covers 100 qualified prospects must be measured (pilot data in BUILD_STATUS.md). If it doesn't, the options
  in order are:
  1. Spread the work over more scheduled starts (Monday–Wednesday).
  2. Lower the per-company AI work further (more deterministic screening).
  3. A second seat.
  4. Only then Paid API Mode, using the scenarios below.

The scenarios below apply **only to the optional Paid API Mode**.

## 1. Research methods compared

| Method | Price (2026) | Coverage of Dutch 50–5,000 FTE organisations | Reliability / limits | Needed? |
|---|---|---|---|---|
| **Direct website retrieval** (own HTTP fetcher) | Free | Every company with a public website | robots.txt respected; no JS rendering; blocked sites are skipped, never bypassed | **Yes — core** |
| **Public DNS** (DoH / system) | Free | All domains | Passive; strong Microsoft-mail evidence; says nothing about the security stack | **Yes — core** |
| **Claude web search** (Anthropic server tool) | $10 / 1,000 searches + small model tokens (≈€0.01 per search) | Broad web index; good for Dutch lists, news, vacancies | No extra subscription (same Anthropic account) | **Default search** |
| **Brave Search API** | ≈$5 / 1,000 queries; free tier replaced by monthly credit | Independent index; Dutch coverage decent | Separate subscription; cheapest at volume | Optional (high volume) |
| **Firecrawl** | Hobby ≈$19/mo for ~5,000 credits; scrape 1 credit/page, search 2 credits/10 results | Same web, renders JavaScript | Good for JS-heavy sites; must not be used to get around bot protection | Optional (render fallback only) |
| **Tavily / Exa** | ≈$4–8 / 1,000 searches (credit-based) | Agent-oriented web search | Comparable to Brave; no advantage for NL | Not needed |
| **KvK API** | Zoeken: free (quota 300k/mo); Basisprofiel €0.02/query + €6.20–6.40 per month per key | Authoritative register: legal form, KvK no., "werkzame personen" | Official, licensed; no sector search | **Recommended** (contact eligibility) |
| **Company.info / Graydon (Creditsafe) / D&B** | Quote-based (typically hundreds–thousands € per year) | Firmographics incl. group structures and size classes | Licensed; good for pool discovery at 300–5,000 FTE | Not needed for basic operation; reassess after pilots if source discovery stalls |
| **Person-level enrichment** (Apollo, ZoomInfo, Clay…) | Subscription | Personal contact data | Conflicts with data minimisation; we deliver roles | Not used |

**Conclusion:** required = Anthropic API only. Recommended = KvK API (≈€6/month + cents per lookup) because legal form decides
whether a company may be called. Everything else is optional and off until an administrator approves it.

## 2. Progressive strategy (how costs are kept down)
1. **Discover cheaply**: harvest source pages with free fetches; link extraction is deterministic; the cheap model reads a list page only when links are insufficient.
2. **Eliminate before spending**: dedup (incl. historical identifiers), exclusions, Google-Workspace contradiction, size from the site — all free.
3. **Reuse**: page/search/DNS caches; facts younger than 90 days are not re-researched; reserve candidates from earlier runs go first.
4. **Deep research only for promising candidates** with real gaps; KvK lookup (€0.02) before any agent.
5. **Expensive models only where justified**: strong model for CSO (2 calls/run) and QA; extraction on the fast tier; rationale in batches.
6. **No duplicate retrieval**: all agents share one cached research gateway; deep research receives the list of sources already fetched.
7. **Stop at the target**: remaining candidates become reserve instead of being researched.

## 3. Weekly / monthly scenarios (100 qualified per week unless stated)

Assumptions (all editable in `src/lib/costModel.ts`): tokens per task include adaptive-thinking overhead; prompt caching ignored
(real costs lower); EUR = USD × 0.92; months = 4.33 weeks; KvK enabled; no Firecrawl subscription; hosting excluded.

| Scenario | Candidates/week | Variable €/week | €/month | € per qualified prospect | Key assumptions |
|---|---|---|---|---|---|
| **Conservative** | 450 | **€108** | **€466** | €1.08 | 4.5 candidates per qualified; 55% need gap-filling; QA 1.5× per delivered |
| **Realistic** | 300 | **€67** | **€291** | €0.67 | 3 candidates per qualified; 35% gap-filling; QA 1.25× |
| **High volume (200/week)** | 640 | **€135** | **€584** | €0.67 | as realistic, 3.2 candidates per qualified |

Realistic breakdown (per week): QA Director €39 (58%) · gap-filling €16 · signals €2 · Microsoft specialist €1.3 · KvK €2.5 ·
extraction €0.6 · discovery (searches + list extraction + scouting + hunting) ≈ €3.5 · CSO + batch rationale + feedback €1.2.
Option: QA on Sonnet → realistic ≈ **€48/week** (decide after comparing QA quality in the pilots).

For comparison, the v1 design (5 agent loops per candidate) is estimated at roughly €200–250/week for the same output.

**Budget advice:** weekly budget ≥ the conservative estimate (≈€110) and a monthly cap of ≈€470 so runs never pause mid-week;
lower both once the pilots have measured real cost per qualified prospect (shown on /pilots).

## 4. Fixed costs (outside the model)
| Item | Indicative |
|---|---|
| KvK API key | €6.20–6.40 / month |
| Hosting (web + worker containers + managed PostgreSQL, EU) | €40–120 / month depending on provider and size (see DEPLOYMENT.md) |
| Optional Firecrawl Hobby | ≈ €17.50 / month |
| Optional Brave Search | pay per use (≈ €0.005/query) |
