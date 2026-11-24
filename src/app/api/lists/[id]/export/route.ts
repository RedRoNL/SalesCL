import { z } from "zod";
import { apiRoute, HttpError } from "@/lib/api";
import { exportList, ExportBlockedError } from "@/lib/exporter";

export const GET = apiRoute<{ id: string }>({ role: "analyst", limit: 20 }, async ({ req, params, user }) => {
  const id = z.string().uuid().parse(params.id);
  const format = z.enum(["xlsx", "csv"]).parse(req.nextUrl.searchParams.get("format") ?? "xlsx");
  try {
    const r = await exportList(id, format, `user:${user.sub}`);
    return new Response(new Uint8Array(r.buffer), {
      headers: { "content-type": r.contentType, "content-disposition": `attachment; filename="${r.fileName}"`, "cache-control": "no-store", "x-withheld-count": String(r.withheld.length) },
    });
  } catch (e) {
    if (e instanceof ExportBlockedError) throw new HttpError(409, e.message);
    throw e;
  }
});
