CREATE TABLE "events" (
	"id" serial PRIMARY KEY,
	"user_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"owner_id" text NOT NULL,
	"member_ids" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY,
	"sender_id" text NOT NULL,
	"receiver_id" text,
	"group_id" text,
	"text" text DEFAULT '' NOT NULL,
	"encrypted" jsonb,
	"attachment" jsonb,
	"reactions" jsonb DEFAULT '{}' NOT NULL,
	"reactors" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone,
	"edited_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY,
	"username" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"password" text NOT NULL,
	"date_of_birth" text,
	"public_key" jsonb,
	"account_state" jsonb DEFAULT '{}' NOT NULL,
	"onboarding_complete" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone,
	"read_receipts" boolean DEFAULT true NOT NULL,
	"gender" text DEFAULT '' NOT NULL,
	"bio" text DEFAULT '' NOT NULL,
	"body_count" text DEFAULT '' NOT NULL,
	"avatar" text DEFAULT '' NOT NULL,
	"profile_pic" text DEFAULT '' NOT NULL,
	"profile_public" boolean DEFAULT true NOT NULL,
	"media" jsonb DEFAULT '[]' NOT NULL,
	"visibility" jsonb DEFAULT '{"gender":true,"bio":true,"bodyCount":false}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "events_user_idx" ON "events" ("user_id","id");--> statement-breakpoint
CREATE INDEX "messages_sender_idx" ON "messages" ("sender_id");--> statement-breakpoint
CREATE INDEX "messages_receiver_idx" ON "messages" ("receiver_id");--> statement-breakpoint
CREATE INDEX "messages_group_idx" ON "messages" ("group_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;