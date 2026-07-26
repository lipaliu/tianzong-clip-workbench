import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { projectModes, projects } from "../../../db/schema";

type ProjectMode = (typeof projectModes)[number];

function toRouteErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  const detail =
    error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const combined = `${message}\n${detail}`;

  if (combined.includes("no such table") || combined.includes('from "projects"')) {
    return "The projects table is unavailable. Apply the generated D1 migration before using the projects API.";
  }

  return message;
}

function isProjectMode(value: unknown): value is ProjectMode {
  return typeof value === "string" && projectModes.includes(value as ProjectMode);
}

function isProjectDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  );
}

async function readPayload(request: Request) {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const db = getDb();
    const rows = await db
      .select()
      .from(projects)
      .orderBy(desc(projects.createdAt), desc(projects.id))
      .limit(20);

    return Response.json({ projects: rows });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const payload = await readPayload(request);
    if (!payload) {
      return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
    }

    const title = typeof payload.title === "string" ? payload.title.trim() : "";
    const sourceName =
      typeof payload.sourceName === "string" ? payload.sourceName.trim() : "";

    if (!title) {
      return Response.json({ error: "title is required" }, { status: 400 });
    }
    if (!isProjectDate(payload.projectDate)) {
      return Response.json(
        { error: "projectDate must use YYYY-MM-DD" },
        { status: 400 },
      );
    }
    if (!sourceName) {
      return Response.json({ error: "sourceName is required" }, { status: 400 });
    }
    if (!isProjectMode(payload.mode)) {
      return Response.json(
        { error: `mode must be one of: ${projectModes.join(", ")}` },
        { status: 400 },
      );
    }

    const db = getDb();
    const [project] = await db
      .insert(projects)
      .values({
        id: crypto.randomUUID(),
        title,
        projectDate: payload.projectDate,
        sourceName,
        mode: payload.mode,
        status: "analyzing",
        clipCount: 0,
        createdAt: new Date(),
      })
      .returning();

    return Response.json({ project }, { status: 201 });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const payload = await readPayload(request);
    if (!payload) {
      return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
    }

    const id = typeof payload.id === "string" ? payload.id.trim() : "";
    if (!id) {
      return Response.json({ error: "id is required" }, { status: 400 });
    }
    if (
      payload.status !== undefined &&
      !["analyzing", "ready", "failed"].includes(String(payload.status))
    ) {
      return Response.json(
        { error: 'status must be "analyzing", "ready", or "failed"' },
        { status: 400 },
      );
    }
    if (payload.clipCount !== undefined && (
      typeof payload.clipCount !== "number" ||
      !Number.isInteger(payload.clipCount) ||
      payload.clipCount < 0
    )) {
      return Response.json(
        { error: "clipCount must be a non-negative integer" },
        { status: 400 },
      );
    }
    if (payload.progress !== undefined && (
      typeof payload.progress !== "number" ||
      !Number.isInteger(payload.progress) ||
      payload.progress < 0 ||
      payload.progress > 100
    )) {
      return Response.json(
        { error: "progress must be an integer from 0 to 100" },
        { status: 400 },
      );
    }

    const optionalText = (value: unknown, maxLength: number) =>
      typeof value === "string" ? value.trim().slice(0, maxLength) : null;
    const status = payload.status === "ready" || payload.status === "failed"
      ? payload.status
      : "analyzing";

    const db = getDb();
    const [project] = await db
      .update(projects)
      .set({
        status,
        ...(payload.clipCount === undefined ? {} : { clipCount: payload.clipCount }),
        ...(payload.progress === undefined ? {} : { progress: payload.progress }),
        ...(payload.processorJobId === undefined
          ? {}
          : { processorJobId: optionalText(payload.processorJobId, 128) }),
        ...(payload.stage === undefined ? {} : { stage: optionalText(payload.stage, 120) ?? "处理中" }),
        ...(payload.error === undefined ? {} : { error: optionalText(payload.error, 1_000) }),
      })
      .where(eq(projects.id, id))
      .returning();

    if (!project) {
      return Response.json({ error: "project not found" }, { status: 404 });
    }

    return Response.json({ project });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}
