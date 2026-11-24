import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createDb, setDb } from "@/db/client";
import { seedReferenceData } from "@/db/seed";

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://salesarmy:salesarmy@localhost:5432/salesarmy_test";

/** Fresh schema for every test file. Never points at the production database. */
export async function setupTestDb() {
  if (!/_test\b/.test(TEST_DB_URL)) throw new Error("Refusing to run tests against a non-test database");
  const admin = postgres(TEST_DB_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe("drop schema if exists public cascade; create schema public; drop schema if exists drizzle cascade; drop schema if exists pgboss cascade;");
  await admin.end();
  const conn = createDb(TEST_DB_URL, 5);
  await migrate(conn.db, { migrationsFolder: "drizzle" });
  await seedReferenceData(conn.db);
  setDb(conn);
  return conn;
}
