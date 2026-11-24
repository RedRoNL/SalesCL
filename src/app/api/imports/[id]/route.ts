import { z } from "zod";
import { apiRoute, parseJson } from "@/lib/api";
import { remapHistorical, commitHistorical, HistoricalMappingSchema } from "@/lib/historicalImport";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("remap"), mapping: HistoricalMappingSchema }),
  z.object({ action: z.literal("commit"), acceptProbable: z.boolean().default(true) }),
]);

export const POST = apiRoute<{ id: string }>({ role: "admin", limit: 30 }, async ({ req, params, user }) => {
  const id = z.string().uuid().parse(params.id);
  const body = await parseJson(req, Body);
  if (body.action === "remap") return { preview: await remapHistorical(id, body.mapping) };
  return commitHistorical(id, `user:${user.sub}`, { acceptProbable: body.acceptProbable });
});
