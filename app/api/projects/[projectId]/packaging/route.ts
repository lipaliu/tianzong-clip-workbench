import { and, eq } from "drizzle-orm";
import { normalizePackagingSettings } from "../../../../packaging";
import { getDb } from "../../../../../db";
import { clipPackagingSettings, projects } from "../../../../../db/schema";

function candidateIdFromUrl(request: Request) {
  return new URL(request.url).searchParams.get("candidateId")?.trim().slice(0, 160) ?? "";
}

async function projectMode(projectId: string) {
  const db = getDb();
  const [project] = await db
    .select({ mode: projects.mode })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return project?.mode ?? null;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params;
  const candidateId = candidateIdFromUrl(request);
  if (!candidateId) {
    return Response.json({ error: "candidateId is required" }, { status: 400 });
  }
  const mode = await projectMode(projectId);
  if (!mode) return Response.json({ error: "project not found" }, { status: 404 });

  const db = getDb();
  const [row] = await db
    .select()
    .from(clipPackagingSettings)
    .where(and(
      eq(clipPackagingSettings.projectId, projectId),
      eq(clipPackagingSettings.candidateId, candidateId),
    ))
    .limit(1);

  if (!row) return Response.json({ settings: null });
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(row.settings);
  } catch {
    parsed = null;
  }
  return Response.json({
    settings: normalizePackagingSettings(parsed, mode),
    updatedAt: row.updatedAt,
  });
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params;
  const mode = await projectMode(projectId);
  if (!mode) return Response.json({ error: "project not found" }, { status: 404 });

  let payload: Record<string, unknown>;
  try {
    payload = await request.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const candidateId = typeof payload.candidateId === "string"
    ? payload.candidateId.trim().slice(0, 160)
    : "";
  if (!candidateId) {
    return Response.json({ error: "candidateId is required" }, { status: 400 });
  }

  const settings = normalizePackagingSettings(payload.settings, mode);
  const updatedAt = new Date();
  const db = getDb();
  await db
    .insert(clipPackagingSettings)
    .values({
      projectId,
      candidateId,
      settings: JSON.stringify(settings),
      updatedAt,
    })
    .onConflictDoUpdate({
      target: [clipPackagingSettings.projectId, clipPackagingSettings.candidateId],
      set: {
        settings: JSON.stringify(settings),
        updatedAt,
      },
    });

  return Response.json({ settings, updatedAt });
}
