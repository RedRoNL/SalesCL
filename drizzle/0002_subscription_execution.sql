ALTER TYPE "public"."task_status" ADD VALUE 'awaiting';--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "executor" text DEFAULT 'api' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "resume_job" jsonb;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "research_runs" ADD COLUMN "executor" text DEFAULT 'api' NOT NULL;--> statement-breakpoint
ALTER TABLE "research_runs" ADD COLUMN "executor_sessions" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
CREATE INDEX "task_idem_idx" ON "agent_tasks" USING btree ("idempotency_key");