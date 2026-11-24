import * as client from "openid-client";
import { env } from "@/lib/env";
import { entraConfig } from "@/lib/secrets";

/**
 * Microsoft Entra ID sign-in via OpenID Connect (authorization code + PKCE).
 * Roles are derived from Entra group membership (configured group IDs) or
 * from app roles ("SalesArmy.Admin", "SalesArmy.Analyst").
 */
let configCache: { sig: string; p: Promise<client.Configuration> } | null = null;

export async function entraConfigured(): Promise<boolean> {
  return (await entraConfig()).configured;
}

export async function getOidcConfig(): Promise<client.Configuration> {
  const e = await entraConfig();
  if (!e.configured) throw new Error("Microsoft Entra ID is not configured");
  const sig = `${e.tenantId}|${e.clientId}|${e.clientSecret!.slice(-6)}`;
  if (!configCache || configCache.sig !== sig) {
    configCache = { sig, p: client.discovery(new URL(`https://login.microsoftonline.com/${e.tenantId}/v2.0`), e.clientId!, e.clientSecret!) };
  }
  return configCache.p;
}

export function redirectUri(): string {
  return `${env().APP_URL.replace(/\/$/, "")}/api/auth/callback`;
}

export async function buildAuthorizationUrl() {
  const config = await getOidcConfig();
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  const nonce = client.randomNonce();
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri(),
    scope: "openid profile email",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });
  return { url, codeVerifier, state, nonce };
}

export interface EntraIdentity {
  oid: string;
  email: string;
  name: string | null;
  groups: string[];
  roles: string[];
}

export async function completeAuthorization(currentUrl: URL, codeVerifier: string, state: string, nonce: string): Promise<EntraIdentity> {
  const config = await getOidcConfig();
  const tokens = await client.authorizationCodeGrant(config, currentUrl, {
    pkceCodeVerifier: codeVerifier,
    expectedState: state,
    expectedNonce: nonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims) throw new Error("No ID token claims");
  const email = String(claims.email ?? claims.preferred_username ?? "").toLowerCase();
  if (!email) throw new Error("Entra ID token has no email/UPN");
  if (String(claims.tid) !== (await entraConfig()).tenantId) throw new Error("Token tenant mismatch");
  return {
    oid: String(claims.oid ?? claims.sub),
    email,
    name: (claims.name as string) ?? null,
    groups: Array.isArray(claims.groups) ? (claims.groups as string[]) : [],
    roles: Array.isArray(claims.roles) ? (claims.roles as string[]) : [],
  };
}

export async function roleFromEntra(id: Pick<EntraIdentity, "groups" | "roles">): Promise<"admin" | "analyst" | "viewer"> {
  const e = await entraConfig();
  if (id.roles.includes("SalesArmy.Admin") || (e.adminGroupId && id.groups.includes(e.adminGroupId))) return "admin";
  if (id.roles.includes("SalesArmy.Analyst") || (e.analystGroupId && id.groups.includes(e.analystGroupId))) return "analyst";
  return "viewer";
}
