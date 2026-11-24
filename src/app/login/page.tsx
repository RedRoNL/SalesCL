import { entraConfigured } from "@/lib/auth/oidc";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const devLogin = env().NODE_ENV !== "production" && env().AUTH_DEV_LOGIN === "true";
  return (
    <div className="min-h-screen grid place-items-center px-4">
      <div className="w-full max-w-sm border border-line bg-panel rounded-lg p-6">
        <div className="text-[11px] uppercase tracking-[.18em] text-faint">Cloud Life</div>
        <h1 className="text-lg font-semibold mb-1">Sales Army</h1>
        <p className="text-muted mb-5 text-[13px]">Commercieel intelligentieplatform. Toegang uitsluitend voor Cloud Life-medewerkers.</p>
        {error && <div className="mb-4 text-[12px] text-bad">{error === "entra_not_configured" ? "Microsoft Entra ID is niet geconfigureerd." : "Inloggen mislukt."}</div>}
        {entraConfigured() ? (
          <a href="/api/auth/login" className="block text-center rounded-md bg-accent text-accent-ink font-medium py-2">Inloggen met Microsoft</a>
        ) : (
          <p className="text-[12px] text-warn">Microsoft Entra ID is nog niet geconfigureerd (zie DEPLOYMENT.md).</p>
        )}
        {devLogin && (
          <form action="/api/auth/dev-login" method="post" className="mt-6 pt-5 border-t border-line flex flex-col gap-2">
            <div className="text-[11px] uppercase tracking-wider text-warn">Ontwikkelmodus</div>
            <input name="email" type="email" placeholder="naam@cloudlife.nl" required />
            <select name="role" defaultValue="admin">
              <option value="admin">Beheerder</option>
              <option value="analyst">Analist</option>
              <option value="viewer">Alleen-lezen</option>
            </select>
            <button className="rounded-md border border-line-strong py-1.5 hover:bg-panel-2">Lokaal inloggen</button>
          </form>
        )}
      </div>
    </div>
  );
}
