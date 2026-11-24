import { apiRoute, HttpError } from "@/lib/api";
import { createImportPreview } from "@/lib/feedbackImport";

/** Upload an agency feedback file (.xlsx/.csv) → validated preview (nothing committed yet). */
export const POST = apiRoute({ role: "analyst", limit: 20 }, async ({ req, user }) => {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "Geen bestand ontvangen");
  if (file.size > 10 * 1024 * 1024) throw new HttpError(413, "Bestand te groot (max 10 MB)");
  if (!/\.(xlsx|csv)$/i.test(file.name)) throw new HttpError(415, "Alleen .xlsx of .csv");
  const r = await createImportPreview(file.name, Buffer.from(await file.arrayBuffer()), `user:${user.sub}`);
  return r;
});
