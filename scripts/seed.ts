import { createDb } from "@/db/client";
import { seedReferenceData } from "@/db/seed";
const { sql, db } = createDb(process.env.DATABASE_URL ?? "postgres://salesarmy:salesarmy@localhost:5432/salesarmy", 1);
await seedReferenceData(db);
console.log("Reference data seeded.");
await sql.end();
