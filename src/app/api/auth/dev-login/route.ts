import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { upsertUser } from "@/lib/auth/users";
import { signSession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";

/** Local development login. Hard-disabled in production. */
export async function POST(req: NextRequest) {
  if (env().NODE_ENV === "production" || env().AUTH_DEV_LOGIN !== "true") return NextResponse.json({ error: "Niet beschikbaar" }, { status: 404 });
  const form = await req.formData();
  const parsed = z.object({ email: z.email(), role: z.enum(["admin", "analyst", "viewer"]) }).safeParse({ email: form.get("email"), role: form.get("role") });
  if (!parsed.success) return NextResponse.redirect(new URL("/login?error=invalid", req.url), 303);
  const user = await upsertUser({ email: parsed.data.email, name: parsed.data.email.split("@")[0], role: parsed.data.role });
  await audit({ actorType: "user", actorId: user.id, action: "auth.login", details: { method: "dev" } });
  const res = NextResponse.redirect(new URL("/", req.url), 303);
  res.cookies.set(SESSION_COOKIE, await signSession({ sub: user.id, email: user.email, name: user.name, role: user.role }), sessionCookieOptions);
  return res;
}
