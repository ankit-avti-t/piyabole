import { pgTable, text, boolean, jsonb, timestamp, serial, index } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text().primaryKey(),
  username: text().notNull().unique(),
  name: text().notNull(),
  password: text().notNull(),
  dateOfBirth: text("date_of_birth"),
  publicKey: jsonb("public_key"),
  accountState: jsonb("account_state").notNull().default({}),
  onboardingComplete: boolean("onboarding_complete").notNull().default(false),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  readReceipts: boolean("read_receipts").notNull().default(true),
  gender: text().notNull().default(""),
  bio: text().notNull().default(""),
  bodyCount: text("body_count").notNull().default(""),
  avatar: text().notNull().default(""),
  profilePic: text("profile_pic").notNull().default(""),
  profilePublic: boolean("profile_public").notNull().default(true),
  media: jsonb().notNull().default([]),
  visibility: jsonb().notNull().default({ gender: true, bio: true, bodyCount: false }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const sessions = pgTable("sessions", {
  token: text().primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const groups = pgTable("groups", {
  id: text().primaryKey(),
  name: text().notNull(),
  type: text().notNull(),
  ownerId: text("owner_id").notNull(),
  memberIds: jsonb("member_ids").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable("messages", {
  id: text().primaryKey(),
  senderId: text("sender_id").notNull(),
  receiverId: text("receiver_id"),
  groupId: text("group_id"),
  text: text().notNull().default(""),
  encrypted: jsonb(),
  attachment: jsonb(),
  reactions: jsonb().notNull().default({}),
  reactors: jsonb().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  seenAt: timestamp("seen_at", { withTimezone: true }),
  editedAt: timestamp("edited_at", { withTimezone: true }),
}, table => [
  index("messages_sender_idx").on(table.senderId),
  index("messages_receiver_idx").on(table.receiverId),
  index("messages_group_idx").on(table.groupId),
]);

// Real-time notifications (new messages, edits, read receipts...) delivered to clients by polling.
export const events = pgTable("events", {
  id: serial().primaryKey(),
  userId: text("user_id").notNull(),
  payload: jsonb().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("events_user_idx").on(table.userId, table.id)]);
