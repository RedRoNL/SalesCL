import { isDutchMobile, normalizeLegalForm, normalizePhoneNL } from "./normalize";

/**
 * Contact eligibility engine (Dutch B2B telemarketing).
 *
 * Legal basis (see SECURITY.md → "Telemarketing"): since 1 July 2026 the soft
 * opt-in for telemarketing is abolished. Calling natural persons — including
 * sole traders (eenmanszaak) and partnerships (VOF, CV, maatschap) — requires
 * prior consent. Calling organisations with legal personality (BV, NV,
 * stichting, vereniging, coöperatie, public bodies) for B2B purposes remains
 * permitted, subject to honouring objections (opt-outs).
 *
 * This engine is configurable but conservative: anything not positively
 * verified is "unknown" and is excluded from automatic calling lists.
 * It is not legal advice; rules must be validated by Cloud Life's counsel.
 */
export type Eligibility = "eligible" | "restricted" | "unknown" | "suppressed";

export interface EligibilityInput {
  legalForm?: string | null;
  phone?: string | null;
  suppressed?: boolean;
  checkedAt?: Date | null;
}

export interface EligibilityConfig {
  eligibleLegalForms: string[];
  restrictedLegalForms: string[];
  blockMobileNumbers: boolean;
  reverifyAfterDays: number;
}

export interface EligibilityResult {
  status: Eligibility;
  reasons: string[];
  /** Phone number fit for the calling export (null when withheld). */
  exportablePhone: string | null;
  normalizedLegalForm: string | null;
}

export function evaluateEligibility(input: EligibilityInput, cfg: EligibilityConfig, now = new Date()): EligibilityResult {
  const reasons: string[] = [];
  const lf = normalizeLegalForm(input.legalForm) ?? (input.legalForm ? input.legalForm.toLowerCase() : null);
  const phone = normalizePhoneNL(input.phone ?? null);

  if (input.suppressed) {
    return { status: "suppressed", reasons: ["Opt-out / niet-bellen registratie — permanent onderdrukt"], exportablePhone: null, normalizedLegalForm: lf };
  }

  let status: Eligibility;
  if (!lf) {
    status = "unknown";
    reasons.push("Rechtsvorm onbekend — verificatie (KvK) vereist vóór opname in belijst");
  } else if (cfg.restrictedLegalForms.includes(lf)) {
    status = "restricted";
    reasons.push(`Rechtsvorm '${lf}' is een natuurlijke persoon/personenvennootschap — toestemming vereist (Tw, per 1-7-2026)`);
  } else if (cfg.eligibleLegalForms.includes(lf)) {
    status = "eligible";
    reasons.push(`Rechtspersoon (${lf}) — B2B-telemarketing toegestaan, mits bezwaar wordt gerespecteerd`);
  } else {
    status = "unknown";
    reasons.push(`Rechtsvorm '${lf}' niet geconfigureerd — handmatige beoordeling vereist`);
  }

  let exportablePhone: string | null = phone;
  if (!phone) {
    exportablePhone = null;
    reasons.push("Geen geldig openbaar bedrijfstelefoonnummer");
  } else if (cfg.blockMobileNumbers && isDutchMobile(phone)) {
    exportablePhone = null;
    reasons.push("Nummer is mobiel (06) — mogelijk persoonlijk; niet geëxporteerd");
  }

  if (status === "eligible" && input.checkedAt) {
    const ageDays = (now.getTime() - input.checkedAt.getTime()) / 86400000;
    if (ageDays > cfg.reverifyAfterDays) {
      status = "unknown";
      reasons.push(`Verificatie ouder dan ${cfg.reverifyAfterDays} dagen — opnieuw verifiëren`);
    }
  }

  return { status, reasons, exportablePhone, normalizedLegalForm: lf };
}
