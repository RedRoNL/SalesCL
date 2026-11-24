# RESEARCH METHODOLOGY

## Principles
1. **Retrieved evidence, not model knowledge.** Every fact, signal and technology claim must reference a `research_sources`
   row created by an actual retrieval. Unsourced facts are stored with confidence 0 and do not count.
2. **Unknown stays unknown.** Nulls are first-class; scoring penalises missing data via confidence, never fills it in.
3. **Quality over quota.** Research 2–3× the target (`candidateMultiplier`, max 300); deliver only QA-approved,
   contact-eligible prospects; report shortfalls with their cause.
4. **Respect the web.** robots.txt, site terms, rate limits, provider licences; no CAPTCHA/login/bot-protection bypass;
   no LinkedIn or Google Maps scraping; passive public DNS only.
5. **Reuse before paying.** Provider responses are cached (`research_cache`, 30 days); company facts younger than
   `factReuseDays` (90) skip re-enrichment; existing eligible records are reused instead of re-created.

## Discovery engine (v2)
The goal is companies that ordinary searches do not surface. Discovery runs on a **persistent source database**:
- **Source types**: industry associations & member directories, trade-fair exhibitor lists, rankings, sector directories,
  business parks / park management, regional development agencies & networks, trade publications, corporate group structures
  ("onze werkmaatschappijen"), annual reports, Microsoft customer references, Microsoft partner case studies (the customer is the
  prospect), vacancies naming Microsoft technology, procurement (contracting authorities).
- **Seeds**: ~20 Dutch association/trade-fair homepages (status *unverified* until the first harvest proves a list exists) and
  ~35 search templates incl. 12 regional business-park and 6 regional-network templates.
- **Harvesting**: fetch → follow same-site links to member/exhibitor/ranking pages and pagination (bounded) → outbound company links
  (deterministic) → cheap-model extraction only when links are insufficient, names verified against page text.
- **Yield tracking**: per source: companies found, *unique* (new to us), qualified, delivered, appointments → priority
  `(qualified+1)/(unique+4)` × novelty. Exhausted sources (no new companies) rest until their re-harvest interval.
- **Exploration**: a configurable share (default 25%) of harvest capacity goes to unproven sources; the Market Intelligence
  Director scouts new sources when a sector has fewer than two productive sources; hunters' useful pools are saved as sources.
- **Reuse**: candidates parked as reserve (target reached) are fed into the next run before new discovery.

## Sources by stage
| Need | Preferred sources | Notes |
|---|---|---|
| Prospect pools | Branch associations & member lists, trade publications, sector rankings ("top 100"), public procurement (TenderNed), annual-report registries, regional business directories, job boards for IT roles | Market Intelligence keeps a per-segment record of queries & sources and their usefulness, so later runs avoid exhausted pools. |
| Company identity | Official website (about, contact, legal/colophon, terms — KvK number & legal form often appear there), KvK register (licensed API, optional), annual reports | Legal form drives contact eligibility. |
| Employees | Annual report, official site, KvK "werkzame personen", reputable press | Ranges allowed; source required. |
| Group / authority | Annual report, group website, press releases | `abroad_central` stops research early. |
| Microsoft technology | Public DNS (MX, TXT `MS=`, SPF, autodiscover/enterpriseenrollment/enterpriseregistration/lyncdiscover CNAME, DKIM selector1), company vacancies, Microsoft customer stories, company site, procurement documents | See `.claude/skills/sales-army-microsoft-evidence`. |
| Buying signals | News, press releases, vacancies (security/IT leadership), M&A announcements, regulator publications, annual reports | Each signal: source, date, explanation, commercial relevance. Incidents stated factually only. |

## Providers (interchangeable, `src/research/`)
| Interface | Implementations | Paid? |
|---|---|---|
| Search | Claude web search (default); Brave Search; Firecrawl search | Yes (metered; approval required) |
| Fetch | Direct HTTP (robots-aware, SSRF-safe, links extracted); Firecrawl only as JS-render fallback | HTTP free; Firecrawl metered |
| DNS | DNS-over-HTTPS (Cloudflare/Google JSON API); system resolver | Free |
| Registry | KvK API (Zoeken v2 + Basisprofiel v1) | Licensed, paid |

Paid providers must be listed in **Settings → Budget → approvedPaidProviders**; every call is metered in
`provider_usage` and checked against run/week/month budgets first.

### Optional providers for better Dutch coverage (assessed, not mandatory)
- **KvK API** — authoritative legal form, KvK number, employees, SBI codes; strongly recommended for contact-eligibility
  verification. Implemented; needs a subscription and `KVK_API_KEY`.
- **Company.info / Graydon (Creditsafe) / Dun & Bradstreet** — Dutch firmographics incl. group structures and size
  classes; materially improve pool discovery for 300–5,000 FTE. Not implemented (no licence); fit the `RegistryProvider` /
  `SearchProvider` interfaces.
- **Person-level enrichment (Apollo, ZoomInfo, Clay)** — not needed: we deliver roles, not personal contact data.

## Microsoft evidence classes (v2: separate confidence per technology)
Evidence collected, strongest first: Microsoft customer stories and partner case studies naming the company; company vacancies
naming Microsoft 365/Intune/Entra/Defender/Purview (deterministic scan of careers pages); adoption statements on the company's own
site; DNS (Exchange Online MX, autodiscover, DKIM selector1/2 via onmicrosoft.com, MS= verification, Intune enrollment CNAME,
Entra registration CNAME, Teams SRV, msoid); mail gateways in front of Microsoft (Mimecast, Proofpoint…) via SPF/DKIM;
optional public Entra tenant metadata. Per technology a confidence 0–1 is computed (noisy-OR over independent evidence types).

confirmed · strongly_indicated · weakly_indicated · unknown · contradicted. Code (`src/domain/msEvidence.ts`) classifies
DNS deterministically and **validates** agent claims: no source → dropped; non-authoritative source → max "strong";
quote not found in the retrieved text → "weak". An Exchange Online MX record never implies Intune, Defender, Purview
or a licence tier.

## Adaptive discovery
The CSO receives performance (with confidence intervals) and the market map. Discovery agents receive the queries already
used for their segment and are instructed to vary sources and phrasing; a second pass is triggered automatically when the
candidate pool is short. The learning engine shifts industry priority by at most one tier within approved boundaries.

## Pilot
`npm run pilot` executes a live run on actual Dutch companies and reports the 11 verification criteria
(see BUILD_STATUS.md for status).
