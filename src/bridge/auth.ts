import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getSettings, updateSetting } from "@/lib/settings";

/**
 * Bridge token: a random bearer token that only grants access to the research bridge (no UI, users,
 * settings, secrets, exclusions or exports). Only its SHA-256 hash is stored. In the Claude Code
 * environment it is configured as a *network secret* for the dashboard host, so the proxy injects the
 * header and the value is never visible to the session or its logs.
 */
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export async function generateBridgeToken(actor: string): Promise<string> {
  const token = `sab_${randomBytes(32).toString("base64url")}`;
  const s = await getSettings();
  await updateSetting("execution", { ...s.execution, bridgeTokenHash: hashToken(token) }, actor);
  return token; // shown once
}

export async function verifyBridgeToken(header: string | null): Promise<boolean> {
  const m = header?.match(/^Bearer\s+(\S+)$/i);
  if (!m) return false;
  const s = await getSettings();
  const hashes = [s.execution.bridgeTokenHash, process.env.SALES_ARMY_BRIDGE_TOKEN_HASH].filter((h): h is string => Boolean(h && /^[0-9a-f]{64}$/.test(h)));
  if (!hashes.length) return false;
  const got = Buffer.from(hashToken(m[1]), "hex");
  return hashes.some((h) => timingSafeEqual(got, Buffer.from(h, "hex")));
}
