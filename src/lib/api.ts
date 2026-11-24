import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError } from "zod";
import { getCurrentUser, clientIp } from "@/lib/auth/current";
import { hasRole, type Role, type SessionUser } from "@/lib/auth/session";
import { rateLimit } from "@/lib/rateLimit";

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

type Ctx<P> = { req: NextRequest; user: SessionUser; params: P; ip: string | null };

/**
 * Wrap an API route: authentication, role-based authorisation, rate limiting,
 * same-origin check for mutations, and secure error handling (no stack traces
 * or internals leak to clients).
 */
export function apiRoute<P = Record<string, string>>(
  opts: { role: Role; limit?: number },
  handler: (ctx: Ctx<P>) => Promise<Response | unknown>,
) {
  return async (req: NextRequest, routeCtx: { params: Promise<P> }) => {
    try {
      const ip = await clientIp();
      if (!rateLimit(`${ip ?? "anon"}:${req.nextUrl.pathname}`, opts.limit ?? 60, (opts.limit ?? 60) / 60)) {
        throw new HttpError(429, "Te veel verzoeken");
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        const origin = req.headers.get("origin");
        if (origin && new URL(origin).host !== req.headers.get("host")) throw new HttpError(403, "Cross-origin verzoek geweigerd");
      }
      const user = await getCurrentUser();
      if (!user) throw new HttpError(401, "Niet ingelogd");
      if (!hasRole(user, opts.role)) throw new HttpError(403, "Onvoldoende rechten");
      const params = (await routeCtx?.params) ?? ({} as P);
      const result = await handler({ req, user, params, ip });
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true });
    } catch (err) {
      if (err instanceof HttpError) return NextResponse.json({ error: err.message, details: err.details }, { status: err.status });
      if (err instanceof ZodError) return NextResponse.json({ error: "Ongeldige invoer", details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, { status: 400 });
      const ref = crypto.randomUUID().slice(0, 8);
      console.error(`[api:${ref}]`, req.method, req.nextUrl.pathname, err);
      return NextResponse.json({ error: "Interne fout", ref }, { status: 500 });
    }
  };
}

export async function parseJson<T extends z.ZodType>(req: NextRequest, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "Ongeldige JSON");
  }
  return schema.parse(body);
}
