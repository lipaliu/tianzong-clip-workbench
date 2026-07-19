import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const projectModes = ["聊播", "带货"] as const;
export const projectStatuses = ["analyzing", "ready"] as const;

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
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("projects_created_at_idx").on(table.createdAt)],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
