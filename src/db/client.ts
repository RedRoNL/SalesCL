import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";
import { env } from "@/lib/env";

export type DB = PostgresJsDatabase<typeof schema>;

declare global {
  // eslint-disable-next-line no-var
  var __salesArmyDb: { sql: postgres.Sql; db: DB } | undefined;
}

export function createDb(url: string, max = 10) {
  const sql = postgres(url, { max, prepare: false, onnotice: () => {} });
  return { sql, db: drizzle(sql, { schema }) };
}

/** Singleton DB connection (survives Next.js hot reload in dev). */
export function getDb(): DB {
  if (!globalThis.__salesArmyDb) globalThis.__salesArmyDb = createDb(env().DATABASE_URL);
  return globalThis.__salesArmyDb.db;
}

/** For tests: swap the singleton. */
export function setDb(conn: { sql: postgres.Sql; db: DB } | undefined) {
  globalThis.__salesArmyDb = conn;
}

export { schema };
