import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";

export const posts = pgTable("posts", {
  id: serial().primaryKey(),
  displayName: text("display_name").notNull(),
  avatarSeed: text("avatar_seed").notNull(),
  caption: text("caption").notNull().default(""),
  audioKey: text("audio_key").notNull(),
  mimeType: text("mime_type").notNull(),
  durationSec: integer("duration_sec").notNull().default(0),
  likes: integer("likes").notNull().default(0),
  comments: integer("comments").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * One row per anonymous visitor.
 *
 * The row is keyed by a random id the browser keeps in localStorage, so a
 * returning visitor updates their existing row instead of creating a new one.
 * Total visits is the SUM of `visits`; unique visitors is the row count. No IP,
 * user agent or any other identifying data is stored.
 */
export const visitors = pgTable("visitors", {
  id: serial().primaryKey(),
  visitorId: text("visitor_id").notNull().unique(),
  visits: integer().notNull().default(1),
  firstSeenAt: timestamp("first_seen_at").defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
});
