export const STATUS_LABELS: Record<string, [string, "ok" | "warn" | "bad" | "info" | "accent" | "muted"]> = {
  candidate: ["Kandidaat", "muted"], researching: ["In onderzoek", "info"], researched: ["Onderzocht", "info"], qualified: ["Gekwalificeerd", "ok"],
  needs_research: ["Aanvullend onderzoek", "warn"], rejected: ["Afgewezen", "bad"], approved: ["Goedgekeurd", "ok"], exported: ["Geleverd", "accent"], excluded: ["Uitgesloten", "bad"],
  queued: ["In wachtrij", "muted"], running: ["Actief", "info"], paused: ["Gepauzeerd", "warn"], cancelled: ["Geannuleerd", "muted"], completed: ["Voltooid", "ok"], failed: ["Mislukt", "bad"],
  succeeded: ["Geslaagd", "ok"], awaiting: ["Wacht op Claude Code", "warn"], skipped: ["Overgeslagen", "muted"], pending: ["Open", "muted"], in_progress: ["Bezig", "info"], done: ["Klaar", "ok"],
  draft: ["Concept", "muted"], in_review: ["Ter review", "warn"],
  eligible: ["Belbaar", "ok"], restricted: ["Beperkt", "bad"], unknown: ["Onbekend", "warn"], suppressed: ["Onderdrukt", "bad"],
  confirmed: ["Bevestigd", "ok"], strongly_indicated: ["Sterk aangewezen", "accent"], weakly_indicated: ["Zwak aangewezen", "warn"], contradicted: ["Tegengesproken", "bad"],
  exceptional: ["Uitzonderlijk", "ok"], strong: ["Sterk", "accent"], requires_research: ["Onderzoek nodig", "warn"], reject: ["Afwijzen", "bad"],
  customer: ["Klant", "info"], active_opportunity: ["Actieve opportunity", "info"], prior_prospect: ["Eerdere prospect", "muted"], opted_out: ["Opt-out", "bad"], none: ["—", "muted"],
  proposed: ["Voorgesteld", "warn"], applied: ["Toegepast", "ok"],
};
export const label = (s: string | null | undefined) => (s ? STATUS_LABELS[s]?.[0] ?? s : "—");
export const tone = (s: string | null | undefined) => (s ? STATUS_LABELS[s]?.[1] ?? "muted" : "muted");

export const TECH_LABELS: Record<string, string> = {
  microsoft_365: "Microsoft 365", exchange_online: "Exchange Online", entra_id: "Entra ID", azure: "Azure", intune: "Intune", defender: "Defender",
  purview: "Purview", copilot: "Copilot", sharepoint_online: "SharePoint Online", teams: "Teams",
};
export const SIGNAL_LABELS: Record<string, string> = {
  copilot_adoption: "Copilot-adoptie", m365_migration: "M365-migratie", digital_transformation: "Digitale transformatie", new_it_leadership: "Nieuwe IT-leiding",
  security_vacancy: "Securityvacature", acquisition_merger: "Overname/fusie", expansion: "Groei/uitbreiding", regulatory_pressure: "Regeldruk", nis2: "NIS2", dora: "DORA",
  data_governance: "Data governance", security_project: "Securityproject", it_modernization: "IT-modernisering", security_strategy_change: "Wijziging securitystrategie",
  public_incident: "Publiek incident", agentic_ai: "Agentic AI",
};
