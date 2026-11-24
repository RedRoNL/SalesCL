import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { seedReferenceData } from "@/db/seed";

const url = process.env.DATABASE_URL ?? "postgres://salesarmy:salesarmy@localhost:5432/salesarmy";
const { sql, db } = createDb(url, 1);
await migrate(db, { migrationsFolder: "drizzle" });
await seedReferenceData(db);
console.log("Migrations applied and reference data seeded.");
await sql.end();
