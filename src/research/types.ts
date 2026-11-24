import type { DnsSnapshot } from "@/domain/msEvidence";

/** Common interfaces so research providers are interchangeable. */
export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}
export interface SearchProvider {
  readonly name: string;
  readonly paid: boolean;
  search(query: string, opts?: { limit?: number; country?: string; includeDomains?: string[] }): Promise<{ results: SearchResult[]; units: number }>;
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  title: string | null;
  text: string;
}
export interface FetchProvider {
  readonly name: string;
  readonly paid: boolean;
  fetch(url: string): Promise<{ page: FetchedPage; units: number }>;
}

export interface DnsProvider {
  readonly name: string;
  snapshot(domain: string): Promise<DnsSnapshot>;
}

export interface RegistryRecord {
  kvkNumber: string;
  name: string;
  legalForm: string | null;
  city: string | null;
  isMainBranch: boolean | null;
  employees: number | null;
  sbi: string[];
}
export interface RegistryProvider {
  readonly name: string;
  readonly paid: boolean;
  search(query: { name?: string; kvkNumber?: string }): Promise<{ records: RegistryRecord[]; units: number }>;
}

export class ProviderUnavailableError extends Error {
  constructor(public provider: string, reason: string) {
    super(`${provider} niet beschikbaar: ${reason}`);
  }
}
export class FetchBlockedError extends Error {}
