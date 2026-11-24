import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { bootstrapOpen, tokenMatches } from "@/lib/auth/bootstrap";
import { upsertUser } from "@/lib/auth/users";
import { signSession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/rateLimit";

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
  if (!rateLimit(`bootstrap:${ip}`, 5, 5 / 600)) return NextResponse.redirect(new URL("/login?error=rate", req.url), 303);
  if (!(await bootstrapOpen())) return NextResponse.redirect(new URL("/login?error=bootstrap_closed", req.url), 303);
  const form = await req.formData();
  const p = z.object({ token: z.string().min(24).max(200), email: z.email() }).safeParse({ token: form.get("token"), email: form.get("email") });
  if (!p.success || !tokenMatches(p.data.token)) {
    await audit({ actorType: "system", action: "auth.bootstrap_failed", ip });
    return NextResponse.redirect(new URL("/login?error=invalid", req.url), 303);
  }
  const user = await upsertUser({ email: p.data.email, name: p.data.email.split("@")[0], role: "admin" });
  await audit({ actorType: "user", actorId: user.id, action: "auth.bootstrap_login", ip });
  const res = NextResponse.redirect(new URL("/setup", req.url), 303);
  res.cookies.set(SESSION_COOKIE, await signSession({ sub: user.id, email: user.email, name: user.name, role: "admin" }), sessionCookieOptions);
  return res;
}
