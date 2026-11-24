import { z } from "zod";
import { apiRoute, parseJson } from "@/lib/api";
import { remapImport, commitImport, MappingSchema } from "@/lib/feedbackImport";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("remap"), mapping: MappingSchema }),
  z.object({ action: z.literal("commit") }),
]);

export const POST = apiRoute<{ id: string }>({ role: "analyst", limit: 30 }, async ({ req, params, user }) => {
  const id = z.string().uuid().parse(params.id);
  const body = await parseJson(req, Body);
  if (body.action === "remap") return { preview: await remapImport(id, body.mapping) };
  return commitImport(id, `user:${user.sub}`);
});
