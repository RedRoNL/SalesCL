import { z } from "zod";
import { apiRoute, HttpError } from "@/lib/api";
import { createHistoricalPreview, HISTORICAL_KINDS } from "@/lib/historicalImport";

/** Upload historical commercial data (.xlsx/.csv) → matched preview (nothing committed yet). */
export const POST = apiRoute({ role: "admin", limit: 20 }, async ({ req, user }) => {
  const form = await req.formData();
  const file = form.get("file");
  const kind = z.enum(HISTORICAL_KINDS).parse(form.get("kind"));
  if (!(file instanceof File)) throw new HttpError(400, "Geen bestand ontvangen");
  if (file.size > 10 * 1024 * 1024) throw new HttpError(413, "Bestand te groot (max 10 MB)");
  if (!/\.(xlsx|csv)$/i.test(file.name)) throw new HttpError(415, "Alleen .xlsx of .csv");
  return createHistoricalPreview(kind, file.name, Buffer.from(await file.arrayBuffer()), `user:${user.sub}`);
});
