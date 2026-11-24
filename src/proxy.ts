import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";

/** Optimistic auth check (cookie only). Authoritative checks happen server-side per route. */
const PUBLIC = ["/login", "/api/auth/login", "/api/auth/callback", "/api/auth/dev-login", "/api/auth/bootstrap", "/api/health"];

export default async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (PUBLIC.some((p) => path === p || path.startsWith(p + "/")) || path.startsWith("/_next") || path === "/favicon.ico") {
    return NextResponse.next();
  }
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    if (path.startsWith("/api/")) return NextResponse.json({ error: "Niet ingelogd" }, { status: 401 });
    return NextResponse.redirect(new URL("/login", req.nextUrl));
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
