import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError } from "zod";
import { verifyBridgeToken } from "@/bridge/auth";
import { bridgeStart, bridgePump, bridgeTasks, bridgeSpec, bridgeTool, bridgeSubmit, bridgeFail, bridgeStatus, BridgeError } from "@/bridge/service";
import { rateLimit } from "@/lib/rateLimit";
import { clientIp } from "@/lib/auth/current";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const maxDuration = 120;

const uuid = z.string().uuid();
const bodies = {
  start: z.object({ runId: uuid.optional(), kind: z.enum(["weekly", "manual"]).optional(), target: z.number().int().min(1).max(500).optional(), sessionUrl: z.string().url().regex(/^https:\/\/claude\.ai\//).optional(), payload: z.string().max(65536).optional() }),
  pump: z.object({ maxMs: z.number().int().min(1000).max(110000).optional() }),
  tasks: z.object({ runId: uuid.optional(), limit: z.number().int().min(1).max(25).optional(), agentId: z.string().max(60).optional() }),
  spec: z.object({ taskId: uuid }),
  tool: z.object({ taskId: uuid, tool: z.string().max(60), args: z.unknown() }),
  submit: z.object({ taskId: uuid, output: z.unknown() }),
  fail: z.object({ taskId: uuid, reason: z.string().min(3).max(500) }),
  status: z.object({ runId: uuid.optional() }),
} as const;
type Action = keyof typeof bodies;

/**
 * Research bridge for the Claude Code session (Claude Subscription Mode). Authenticated with the
 * bridge bearer token only (no cookies, no user session); grants exactly the actions above.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  try {
    const ip = await clientIp();
    if (!rateLimit(`bridge:${ip ?? "anon"}`, 600, 10)) return NextResponse.json({ error: "Te veel verzoeken" }, { status: 429 });
    if (!(await verifyBridgeToken(req.headers.get("authorization")))) {
      await audit({ actorType: "system", actorId: "bridge", action: "bridge.auth_failed", details: { action }, ip });
      return NextResponse.json({ error: "Niet geautoriseerd" }, { status: 401 });
    }
    if (!(action in bodies)) return NextResponse.json({ error: "Onbekende actie" }, { status: 404 });
    const raw = await req.json().catch(() => ({}));
    const a = action as Action;
    const b = bodies[a].parse(raw) as never;
    const handlers: Record<Action, (x: never) => Promise<unknown>> = {
      start: (x: z.infer<typeof bodies.start>) => bridgeStart(x),
      pump: (x: z.infer<typeof bodies.pump>) => bridgePump(x),
      tasks: (x: z.infer<typeof bodies.tasks>) => bridgeTasks(x),
      spec: (x: z.infer<typeof bodies.spec>) => bridgeSpec(x.taskId),
      tool: async (x: z.infer<typeof bodies.tool>) => ({ result: await bridgeTool(x.taskId, x.tool, x.args) }),
      submit: (x: z.infer<typeof bodies.submit>) => bridgeSubmit(x.taskId, x.output),
      fail: (x: z.infer<typeof bodies.fail>) => bridgeFail(x.taskId, x.reason),
      status: (x: z.infer<typeof bodies.status>) => bridgeStatus(x.runId),
    };
    return NextResponse.json(await handlers[a](b));
  } catch (err) {
    if (err instanceof BridgeError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof ZodError) return NextResponse.json({ error: "Ongeldige invoer", details: err.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })) }, { status: 400 });
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`[bridge:${ref}]`, action, err);
    return NextResponse.json({ error: "Interne fout", ref }, { status: 500 });
  }
}
