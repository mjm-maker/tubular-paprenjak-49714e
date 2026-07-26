CREATE TABLE "posts" (
	"id" serial PRIMARY KEY,
	"display_name" text NOT NULL,
	"avatar_seed" text NOT NULL,
	"caption" text DEFAULT '' NOT NULL,
	"audio_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"duration_sec" integer DEFAULT 0 NOT NULL,
	"likes" integer DEFAULT 0 NOT NULL,
	"comments" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
