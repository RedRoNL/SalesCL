import type { RegistryProvider, RegistryRecord } from "./types";
import { ProviderUnavailableError } from "./types";

/**
 * KvK (Dutch Chamber of Commerce) API — authorised, licensed register access.
 * Optional: requires a KvK API subscription (paid) approved in Settings → Budget.
 * Endpoints per developers.kvk.nl: Zoeken v2 and Basisprofiel v1.
 * NOTE: implemented against the published API contract; not exercised live in
 * this build because no API key was available (see BUILD_STATUS.md).
 */
export class KvkProvider implements RegistryProvider {
  readonly name = "kvk";
  readonly paid = true;
  constructor(private apiKey: string | undefined, private fetchImpl: typeof fetch = fetch, private base = "https://api.kvk.nl/api") {
    if (!apiKey) throw new ProviderUnavailableError("kvk", "KVK_API_KEY ontbreekt");
  }
  private async get(path: string) {
    const r = await this.fetchImpl(`${this.base}${path}`, { headers: { apikey: this.apiKey!, accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`KvK API ${r.status}`);
    return r.json() as Promise<Record<string, unknown>>;
  }
  async search(q: { name?: string; kvkNumber?: string }): Promise<{ records: RegistryRecord[]; units: number }> {
    let units = 0;
    const records: RegistryRecord[] = [];
    let numbers: string[] = [];
    if (q.kvkNumber) numbers = [q.kvkNumber.replace(/\D/g, "")];
    else if (q.name) {
      const z = await this.get(`/v2/zoeken?naam=${encodeURIComponent(q.name)}&resultatenPerPagina=5`);
      units++;
      const items = ((z?.resultaten as Record<string, unknown>[]) ?? []).filter((i) => i.type === "hoofdvestiging" || i.type === "rechtspersoon");
      numbers = [...new Set(items.map((i) => String(i.kvkNummer)))].slice(0, 3);
    }
    for (const n of numbers) {
      const b = await this.get(`/v1/basisprofielen/${n}`);
      units++;
      if (!b) continue;
      const emb = (b._embedded ?? {}) as Record<string, Record<string, unknown>>;
      const hoofd = emb.hoofdvestiging ?? {};
      const eigenaar = emb.eigenaar ?? {};
      const adressen = (hoofd.adressen as Record<string, unknown>[]) ?? [];
      records.push({
        kvkNumber: n,
        name: String(b.naam ?? b.statutaireNaam ?? ""),
        legalForm: (eigenaar.rechtsvorm as string) ?? (eigenaar.uitgebreideRechtsvorm as string) ?? null,
        city: (adressen[0]?.plaats as string) ?? null,
        isMainBranch: true,
        employees: typeof b.totaalWerkzamePersonen === "number" ? (b.totaalWerkzamePersonen as number) : null,
        sbi: ((b.sbiActiviteiten as Record<string, unknown>[]) ?? []).map((s) => String(s.sbiCode)),
      });
    }
    return { records, units };
  }
}
