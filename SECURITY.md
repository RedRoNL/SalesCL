# SECURITY & COMPLIANCE

Cloud Life is a cybersecurity company; this platform is built to that standard. This file lists the controls, where
they live in code, and the legal assumptions that must be validated by Cloud Life's counsel.

## Authentication & authorisation
- **Microsoft Entra ID** sign-in (OIDC authorization code + PKCE, `state` + `nonce`, tenant-ID check) — `src/lib/auth/oidc.ts`.
- Sessions: HS256-signed JWT (`jose`), `httpOnly`, `secure` in production, `SameSite=Lax`, 8-hour lifetime; `SESSION_SECRET` (≥32 bytes) mandatory in production.
- **Roles**: `admin`, `analyst`, `viewer` (read-only). Derived from Entra app roles (`SalesArmy.Admin`, `SalesArmy.Analyst`) or configured group IDs on every login; bootstrap admins via `INITIAL_ADMIN_EMAILS`.
- **Server-side authorisation on every call**: `proxy.ts` does an optimistic cookie check; every page (`requirePageUser`), route handler (`apiRoute`) and server action (`requireActionUser`) re-verifies the session **and** that the user is active in the DB, then checks the role.
- Dev login exists only when `AUTH_DEV_LOGIN=true` **and** `NODE_ENV≠production` (hard-disabled in production builds).

## Application security
| Control | Implementation |
|---|---|
| Input validation | Zod on every action/route body, every setting, every agent input **and output** |
| SQL injection | Drizzle query builder / parameterised `sql` templates only |
| CSRF | Server Actions' built-in origin check; route handlers reject cross-origin mutations |
| XSS | React escaping; markdown rendered as React elements (no `dangerouslySetInnerHTML`); only `http(s)` URLs become links (`rel="noopener noreferrer nofollow"`) |
| Security headers | CSP, HSTS, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy (`next.config.ts`) |
| Rate limiting | Token bucket per IP+route in `apiRoute` (in-process; add a WAF/edge limiter for multi-instance) |
| Secure errors | Clients receive generic messages + reference ID; details only in server logs |
| Audit logging | Append-only `audit_logs` for logins, settings, exclusions, approvals, exports, overrides, imports, erasure, tool denials |
| Secrets | Read only server-side from env/secret manager; never sent to the browser (Settings shows presence only) |
| Dependency scanning | `npm audit --omit=dev` in CI (`.github/workflows/ci.yml`); `uuid` pinned via `overrides` to fix GHSA-w5hq-g745-h8pq in exceljs |
| Uploads | `.xlsx`/`.csv` only, 10 MB, 5,000 rows, parsed server-side, previewed before commit |
| Export | Spreadsheet formula-injection neutralised (`safeCell`); only QA-approved, human-approved, contact-eligible rows; suppressions re-checked at export time |

## AI & research-specific controls
- **Prompt-injection defence** (`src/domain/untrusted.ts`): all external content is sanitised (scripts, comments, zero-width/bidi characters removed), delimiter spoofing neutralised, size-bounded, injection patterns flagged, and wrapped in `<untrusted_content>` with an explicit "data, not instructions" header. Agents' system prompts state the same rule first.
- **Least-privilege tools**: a tool must be in both the agent's and the task's allow-list; anything else is refused and audited (`agent.tool_denied`). No tool can contact prospects, change settings, change exclusions, or approve/export lists. Only the CSO can delegate or start runs, and only for analyst+ users.
- **Output validation before persistence**: Zod schemas; sources must exist; "confirmed" Microsoft claims need a quote present in the retrieved text; phones must appear on the cited source; unsourced facts get confidence 0.
- **Independent QA** with veto on a separate (strong) model and a dossier without other agents' sales arguments.
- **SSRF protection** for fetching: http(s) only, no credentials/non-standard ports, private/loopback/link-local/metadata ranges blocked **after DNS resolution**, redirects followed manually with each hop re-validated.
- **Respectful research**: robots.txt honoured; descriptive User-Agent; per-host delay; 401/403/429/CAPTCHA/challenge pages are reported, never bypassed; no logins; no paywalls; passive public DNS only — no scanning or vulnerability testing.

## Privacy (GDPR / AVG)
- **Data minimisation**: company-level data; contacts limited to professional role, and a name only when lawfully public in a professional context on a cited source. No private e-mail addresses, no personal mobile numbers (06-numbers are withheld from exports).
- Lawful basis recorded per contact (`legitimate_interest_b2b_public_professional_role`) with source and retention date.
- **Retention** (configurable): contacts 2 years, source excerpts 2 years, rejected companies 3 years, audit log 7 years — enforced nightly by the `retention-cleanup` job.
- **Erasure**: admin "AVG: wis gegevens" removes contacts and excerpts and soft-deletes the company; opt-out suppressions are kept (minimal identifiers) so the organisation is never contacted again.
- Stored page content is limited to bounded excerpts needed to verify claims.

## Telemarketing law (NL) — contact eligibility engine
Research (2026-11): since **1 July 2026** the soft opt-in for telemarketing was abolished (Telecommunicatiewet).
Natural persons — including **eenmanszaak** and partnerships (**VOF, CV, maatschap**) — may only be called with prior
consent. Organisations with **legal personality** (BV, NV, stichting, vereniging, coöperatie, public bodies) may be called
for B2B purposes, provided objections are honoured. Sources: ACM, business.gov.nl, ICTRecht, Hogan Lovells, Houthoff
(see BUILD_STATUS.md for links). Sources diverge on edge cases, so the engine is conservative:

- `eligible` only for configured legal-person forms with a verified legal form and a public company number;
- `restricted` for natural-person forms; `unknown` when the legal form is unverified → **never** on calling lists;
- `suppressed` for opt-outs/do-not-contact — permanent, cannot be overridden by any approval or QA override;
- re-verification after 180 days.

**This is not legal advice.** Cloud Life's counsel must confirm the configured forms (Settings → Contactgeschiktheid)
and the calling agency's own obligations (identification, no number suppression, honouring objections).

## The system never contacts prospects
There is no e-mail, telephony, messaging or CRM-write integration. Output is a file a human approves and hands over.

## Reporting a vulnerability
Report privately to Cloud Life's security team. Do not open public issues for security findings.
