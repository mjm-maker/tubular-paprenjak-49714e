CREATE TABLE "visitors" (
	"id" serial PRIMARY KEY,
	"visitor_id" text NOT NULL UNIQUE,
	"visits" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL
);
