import { requirePageUser } from "@/lib/auth/current";
import { integrationStatus } from "@/lib/env";
import { Nav } from "@/components/Nav";

export const dynamic = "force-dynamic";

const ROLE_NL = { admin: "Beheerder", analyst: "Analist", viewer: "Alleen-lezen" } as const;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageUser("viewer");
  const integ = integrationStatus();
  const missing = [!integ.anthropic && "Claude API", !integ.firecrawl && "Firecrawl", !integ.entra && "Entra ID"].filter(Boolean);
  return (
    <div className="min-h-screen flex">
      <aside className="w-56 shrink-0 border-r border-line bg-panel flex flex-col px-3 py-4 sticky top-0 h-screen">
        <div className="px-2 mb-5">
          <div className="text-[11px] uppercase tracking-[.18em] text-faint">Cloud Life</div>
          <div className="text-[15px] font-semibold">Sales Army</div>
        </div>
        <Nav />
        <div className="mt-auto px-2 pt-4 border-t border-line text-[12px]">
          <div className="truncate">{user.name ?? user.email}</div>
          <div className="text-faint">{ROLE_NL[user.role]}</div>
          <form action="/api/auth/logout" method="post" className="mt-2">
            <button className="text-muted hover:text-text">Uitloggen</button>
          </form>
        </div>
      </aside>
      <main className="flex-1 min-w-0 px-8 py-6">
        {missing.length > 0 && (
          <div className="mb-5 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-[12px] text-warn">
            Niet geconfigureerd: {missing.join(", ")}. Functies die deze integraties vereisen zijn uitgeschakeld — zie Instellingen → Integraties.
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
