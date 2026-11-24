import * as client from "openid-client";
import { env } from "@/lib/env";

/**
 * Microsoft Entra ID sign-in via OpenID Connect (authorization code + PKCE).
 * Roles are derived from Entra group membership (configured group IDs) or
 * from app roles ("SalesArmy.Admin", "SalesArmy.Analyst").
 */
let configPromise: Promise<client.Configuration> | null = null;

export function entraConfigured(): boolean {
  const e = env();
  return Boolean(e.ENTRA_TENANT_ID && e.ENTRA_CLIENT_ID && e.ENTRA_CLIENT_SECRET);
}

export async function getOidcConfig(): Promise<client.Configuration> {
  const e = env();
  if (!entraConfigured()) throw new Error("Microsoft Entra ID is not configured");
  if (!configPromise) {
    configPromise = client.discovery(
      new URL(`https://login.microsoftonline.com/${e.ENTRA_TENANT_ID}/v2.0`),
      e.ENTRA_CLIENT_ID!,
      e.ENTRA_CLIENT_SECRET!,
    );
  }
  return configPromise;
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
  if (String(claims.tid) !== env().ENTRA_TENANT_ID) throw new Error("Token tenant mismatch");
  return {
    oid: String(claims.oid ?? claims.sub),
    email,
    name: (claims.name as string) ?? null,
    groups: Array.isArray(claims.groups) ? (claims.groups as string[]) : [],
    roles: Array.isArray(claims.roles) ? (claims.roles as string[]) : [],
  };
}

export function roleFromEntra(id: Pick<EntraIdentity, "groups" | "roles">): "admin" | "analyst" | "viewer" {
  const e = env();
  if (id.roles.includes("SalesArmy.Admin") || (e.ENTRA_ADMIN_GROUP_ID && id.groups.includes(e.ENTRA_ADMIN_GROUP_ID))) return "admin";
  if (id.roles.includes("SalesArmy.Analyst") || (e.ENTRA_ANALYST_GROUP_ID && id.groups.includes(e.ENTRA_ANALYST_GROUP_ID))) return "analyst";
  return "viewer";
}
