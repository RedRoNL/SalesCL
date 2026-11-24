import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { completeAuthorization, roleFromEntra } from "@/lib/auth/oidc";
import { upsertUser } from "@/lib/auth/users";
import { signSession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";

export async function GET(req: NextRequest) {
  const base = env().APP_URL;
  try {
    const tx = req.cookies.get("cl_oidc_tx")?.value;
    if (!tx) throw new Error("missing transaction");
    const secret = new TextEncoder().encode(process.env.SESSION_SECRET ?? "dev-only-insecure-session-secret-change-me-0000");
    const { payload } = await jwtVerify(tx, secret);
    const callbackUrl = new URL(req.nextUrl.pathname + req.nextUrl.search, base);
    const id = await completeAuthorization(callbackUrl, String(payload.codeVerifier), String(payload.state), String(payload.nonce));
    const user = await upsertUser({ email: id.email, name: id.name, entraObjectId: id.oid, role: roleFromEntra(id) });
    if (!user.active) throw new Error("user disabled");
    await audit({ actorType: "user", actorId: user.id, action: "auth.login", details: { method: "entra" } });
    const res = NextResponse.redirect(new URL("/", base));
    res.cookies.set(SESSION_COOKIE, await signSession({ sub: user.id, email: user.email, name: user.name, role: user.role }), sessionCookieOptions);
    res.cookies.delete("cl_oidc_tx");
    return res;
  } catch (err) {
    console.error("[auth] callback failed", err);
    return NextResponse.redirect(new URL("/login?error=signin_failed", base));
  }
}
