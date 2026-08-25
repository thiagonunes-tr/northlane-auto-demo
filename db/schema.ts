import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const mfaChallenges = sqliteTable(
  "mfa_challenges",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    role: text("role", { enum: ["customer", "agent"] }).notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    consumedAt: integer("consumed_at"),
    /** Only challenges delivered by email count against the hourly limit. */
    delivery: text("delivery", { enum: ["fixed", "email"] })
      .notNull()
      .default("fixed"),
  },
  table => [
    index("mfa_challenges_email_created_idx").on(table.email, table.createdAt),
  ],
);

export const users = sqliteTable("users", {
  email: text("email").primaryKey(),
  name: text("name").notNull(),
  role: text("role", { enum: ["customer", "agent"] }).notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const pendingUsers = sqliteTable(
  "pending_users",
  {
    challengeId: text("challenge_id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    role: text("role", { enum: ["customer", "agent"] }).notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  table => [index("pending_users_email_idx").on(table.email)],
);

/** The single shared workflow row. One environment, one story, one state. */
export const demoState = sqliteTable("demo_state", {
  id: text("id").primaryKey(),
  stateJson: text("state_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const environmentMeta = sqliteTable("environment_meta", {
  id: text("id").primaryKey(),
  lastResetAt: integer("last_reset_at").notNull(),
});
