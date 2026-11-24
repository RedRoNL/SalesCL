import { NextResponse } from "next/server";
import { SignJWT } from "jose";
import { buildAuthorizationUrl, entraConfigured } from "@/lib/auth/oidc";

export async function GET() {
  if (!entraConfigured()) return NextResponse.redirect(new URL("/login?error=entra_not_configured", process.env.APP_URL ?? "http://localhost:3000"));
  const { url, codeVerifier, state, nonce } = await buildAuthorizationUrl();
  const secret = new TextEncoder().encode(process.env.SESSION_SECRET ?? "dev-only-insecure-session-secret-change-me-0000");
  const tx = await new SignJWT({ codeVerifier, state, nonce }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("10m").sign(secret);
  const res = NextResponse.redirect(url.href);
  res.cookies.set("cl_oidc_tx", tx, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/auth", maxAge: 600 });
  return res;
}
