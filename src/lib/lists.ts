import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { audit } from "@/lib/audit";

/** Human decision on a single list item (approve / reject with reason). */
export async function decideItem(itemId: string, status: "approved" | "rejected", actor: string, reason?: string) {
  const db = getDb();
  const [item] = await db.select().from(schema.prospectListItems).where(eq(schema.prospectListItems.id, itemId));
  if (!item) throw new Error("Item niet gevonden");
  const [list] = await db.select().from(schema.prospectLists).where(eq(schema.prospectLists.id, item.listId));
  if (list.status === "exported") throw new Error("Lijst is al geëxporteerd");
  if (status === "approved") {
    const [c] = await db.select().from(schema.companies).where(eq(schema.companies.id, item.companyId));
    if (c.contactEligibility !== "eligible") throw new Error(`Contactgeschiktheid is '${c.contactEligibility}' — kan niet worden goedgekeurd`);
  }
  await db.update(schema.prospectListItems).set({ status, decidedBy: actor, decisionReason: reason ?? null }).where(eq(schema.prospectListItems.id, itemId));
  if (status === "rejected") await db.update(schema.companies).set({ status: "rejected", updatedAt: new Date() }).where(eq(schema.companies.id, item.companyId));
  await audit({ actorType: "user", actorId: actor, action: `list_item.${status}`, entityType: "prospect_list_item", entityId: itemId, details: { reason } });
}

/** Approve the list for export. Pending items are approved in bulk only if `approvePending`. */
export async function approveList(listId: string, actor: string, approvePending = false) {
  const db = getDb();
  const [list] = await db.select().from(schema.prospectLists).where(eq(schema.prospectLists.id, listId));
  if (!list) throw new Error("Lijst niet gevonden");
  if (list.status === "exported") throw new Error("Lijst is al geëxporteerd");
  if (approvePending) {
    const pending = await db.select().from(schema.prospectListItems).where(and(eq(schema.prospectListItems.listId, listId), eq(schema.prospectListItems.status, "pending")));
    for (const p of pending) await decideItem(p.id, "approved", actor, "Bulkgoedkeuring");
  }
  await db.update(schema.prospectLists).set({ status: "approved", approvedBy: actor, approvedAt: new Date() }).where(eq(schema.prospectLists.id, listId));
  const approved = await db.select().from(schema.prospectListItems).where(and(eq(schema.prospectListItems.listId, listId), eq(schema.prospectListItems.status, "approved")));
  for (const a of approved) await db.update(schema.companies).set({ status: "approved", updatedAt: new Date() }).where(eq(schema.companies.id, a.companyId));
  await audit({ actorType: "user", actorId: actor, action: "list.approved", entityType: "prospect_list", entityId: listId });
}

/**
 * Administrator override of a QA rejection — requires a documented reason.
 * Never possible for suppressions/opt-outs or restricted contact eligibility.
 */
export async function overrideQa(reviewId: string, actor: string, reason: string) {
  const db = getDb();
  if (!reason || reason.trim().length < 15) throw new Error("Een gedocumenteerde reden (min. 15 tekens) is verplicht");
  const [rev] = await db.select().from(schema.qaReviews).where(eq(schema.qaReviews.id, reviewId));
  if (!rev) throw new Error("QA-review niet gevonden");
  const [c] = await db.select().from(schema.companies).where(eq(schema.companies.id, rev.companyId));
  if (c.contactEligibility === "suppressed" || c.relationship === "opted_out") throw new Error("Opt-out/suppressie kan niet worden overschreven");
  await db.update(schema.qaReviews).set({ overriddenBy: actor, overrideReason: reason.trim(), overriddenAt: new Date() }).where(eq(schema.qaReviews.id, reviewId));
  await audit({ actorType: "user", actorId: actor, action: "qa.override", entityType: "qa_review", entityId: reviewId, details: { reason } });
}
