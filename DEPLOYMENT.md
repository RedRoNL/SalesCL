# DEPLOYMENT

Two processes share one PostgreSQL database:

| Process | Command | Scale |
|---|---|---|
| **web** (Next.js) | `npm run build && npm run start` | 1+ instances behind HTTPS |
| **worker** (jobs + scheduler) | `npm run worker` | 1 instance (more is safe: pg-boss locks jobs; raise `WORKER_CONCURRENCY` first) |

The weekly run is fired by the worker's pg-boss cron — **no browser tab or interactive Claude Code session is involved.**

## 1. Prerequisites
- Node.js ≥ 22, PostgreSQL 16 (Supabase, Azure Database for PostgreSQL Flexible Server, or self-hosted).
- Outbound HTTPS from the worker to: `api.anthropic.com`, `api.firecrawl.dev` (if used), `api.kvk.nl` (if used),
  the DoH resolver (`cloudflare-dns.com` by default), and the public websites being researched.
- A secret manager (Azure Key Vault, Supabase/Vercel/Fly secrets…). Never commit `.env`.

## 2. Microsoft Entra ID
1. Entra admin center → App registrations → New: *Cloud Life Sales Army*, single tenant.
2. Redirect URI (Web): `https://<your-host>/api/auth/callback`.
3. Certificates & secrets → new client secret → `ENTRA_CLIENT_SECRET`. Note tenant ID and client ID.
4. App roles: `SalesArmy.Admin`, `SalesArmy.Analyst` (members: users/groups) — or set `ENTRA_ADMIN_GROUP_ID` / `ENTRA_ANALYST_GROUP_ID`
   and add the *groups* claim to the ID token. Users without a role become read-only viewers.
5. Set `INITIAL_ADMIN_EMAILS` for the first administrator(s).
6. Recommended: Conditional Access (MFA, compliant device) on the enterprise application.

## 3. Configure environment
Copy `.env.example`; at minimum set `DATABASE_URL`, `APP_URL`, `SESSION_SECRET` (`openssl rand -hex 32`), Entra values,
`ANTHROPIC_API_KEY`. Optional: `FIRECRAWL_API_KEY`, `KVK_API_KEY`.

## 4. Database
```bash
npm ci
```
```bash
npm run db:migrate
```
Applies SQL migrations and idempotently seeds industries, the permanent seed exclusions (Visma/ProActive, RedFoxBlue,
ZIGT Mediabureau, The Sales Unit), excluded sectors, scoring model v1 and the baseline strategy. pg-boss creates its own
`pgboss` schema on first worker start. Enable automated backups/PITR on the database.

## 5. Run
### Docker Compose (self-hosted)
```bash
docker compose up -d --build
```
### Separate services (e.g. Azure Container Apps / App Service, Fly, Render)
Build the image from `Dockerfile` once; run it twice — default command for **web**, `npm run worker` for **worker**;
run `npm run db:migrate` as a release/one-off job before each deploy.

## 6. First-time setup in the UI (administrator)
1. **Instellingen → Integraties**: confirm keys are detected.
2. **Instellingen → Budget**: set weekly/monthly limits; add `"firecrawl"` / `"kvk"` / `"anthropic_web_search"` to
   `approvedPaidProviders` only after approving those subscriptions.
3. **Instellingen → Onderzoeksproviders**: choose search (`firecrawl` or `anthropic_web_search`) and fetch provider.
4. **Instellingen → Bestaande relaties importeren**: upload current customers, active opportunities and historical
   prospect lists so they are never delivered as new prospects.
5. **Instellingen → Uitsluitingen**: add competitor domains (seed exclusions are name-based).
6. **Instellingen → Contactgeschiktheid**: have legal counsel confirm the eligible legal forms.
7. Run `npm run pilot -- --industry food_production --target 5 --budget 10` and review `pilot-report.md`.

## 7. Production hardening checklist
- HTTPS only; set `APP_URL` to the public HTTPS origin (cookies become `Secure`).
- Put a WAF / edge rate limiter in front when running more than one web instance.
- Restrict database network access to web + worker; least-privilege DB user (DDL only for the migrate job).
- Ship worker and web logs to your log platform; alert on `run.failed`, `weekly.skipped`, worker restarts.
- Supabase: the app connects server-side with a service DB user; do not expose tables through PostgREST, or enable RLS
  denying the `anon`/`authenticated` roles (the app does not use Supabase Auth).
