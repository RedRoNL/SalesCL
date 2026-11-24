import type { PgBoss } from "pg-boss";
import { JOBS } from "@/pipeline/queue";
import { getSettings } from "@/lib/settings";

/** (Re)apply schedules from settings. Called at worker start and every 5 minutes. */
export async function syncSchedules(boss: PgBoss) {
  const s = await getSettings();
  if (s.schedule.enabled) await boss.schedule(JOBS.weekly, s.schedule.cron, {}, { tz: s.schedule.timezone, key: "weekly", retryLimit: 2 });
  else await boss.unschedule(JOBS.weekly, "weekly").catch(() => {});
  await boss.schedule(JOBS.watchdog, "*/10 * * * *", {}, { key: "watchdog" });
  await boss.schedule(JOBS.retention, "30 2 * * *", {}, { tz: "Europe/Amsterdam", key: "retention" });
  await boss.schedule(JOBS.learning, "0 6 * * 1", {}, { tz: "Europe/Amsterdam", key: "learning" });
  return `${s.schedule.enabled ? s.schedule.cron : "uit"} (${s.schedule.timezone})`;
}
