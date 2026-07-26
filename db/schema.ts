import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const projectModes = ["聊播", "带货"] as const;
export const projectStatuses = ["analyzing", "ready", "failed"] as const;

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    projectDate: text("project_date").notNull(),
    sourceName: text("source_name").notNull(),
    mode: text("mode", { enum: projectModes }).notNull(),
    status: text("status", { enum: projectStatuses })
      .notNull()
      .default("analyzing"),
    clipCount: integer("clip_count").notNull().default(0),
    processorJobId: text("processor_job_id"),
    stage: text("stage").notNull().default("等待上传"),
    progress: integer("progress").notNull().default(0),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("projects_created_at_idx").on(table.createdAt)],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

export const authLoginAttempts = sqliteTable(
  "auth_login_attempts",
  {
    key: text("key").primaryKey(),
    windowStartedAt: integer("window_started_at").notNull(),
    failureCount: integer("failure_count").notNull().default(0),
    blockedUntil: integer("blocked_until"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("auth_login_attempts_updated_at_idx").on(table.updatedAt)],
);
