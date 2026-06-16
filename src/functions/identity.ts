import type { ISdk } from "iii-sdk";
import type { Project, Session, Memory } from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { logger } from "../logger.js";

export function normalizeGitUrl(raw: string): string | null {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();
  // Strip protocol + user prefix: git@github.com:user/repo.git → github.com:user/repo.git
  // https://github.com/user/repo.git → github.com/user/repo.git
  const atIndex = s.indexOf("@");
  if (atIndex >= 0) s = s.slice(atIndex + 1);
  const protocolIndex = s.indexOf("://");
  if (protocolIndex >= 0) s = s.slice(protocolIndex + 3);
  // Strip trailing .git (with optional trailing slash)
  s = s.replace(/\.git\/?$/, "");
  // Strip trailing slash
  if (s.endsWith("/")) s = s.slice(0, -1);
  // Replace : with / to normalize git@ format
  s = s.replace(":", "/");
  if (!s || s.length < 5) return null;
  return s.toLowerCase();
}

export async function resolveProject(
  kv: StateKV,
  signals: { name: string; gitRemotes?: string[] },
): Promise<{ projectId: string; project: Project; isNew: boolean }> {
  const remotes = signals.gitRemotes ?? [];
  const normalizedRemotes = remotes.map(normalizeGitUrl).filter(Boolean) as string[];

  // Match by normalized git remote URL first
  for (const norm of normalizedRemotes) {
    const existingId = await kv.get<string>(KV.projectSignals, norm);
    if (existingId) {
      const project = await kv.get<Project>(KV.projects, existingId);
      if (project) return { projectId: existingId, project, isNew: false };
    }
  }

  // Match by display name ONLY when no git remotes were provided.
  // When remotes are available, name is too weak a signal —
  // two repos with the same basename would collide.
  const name = signals.name.trim();
  if (name && normalizedRemotes.length === 0) {
    const existingId = await kv.get<string>(KV.projectSignals, name);
    if (existingId) {
      const project = await kv.get<Project>(KV.projects, existingId);
      if (project) return { projectId: existingId, project, isNew: false };
    }
  }

  // Create new project
  const projectId = `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const identitySignals: string[] = [];
  for (const norm of normalizedRemotes) identitySignals.push(norm);
  if (name) identitySignals.push(name);

  const project: Project = {
    id: projectId,
    displayName: name,
    identitySignals,
    createdAt: new Date().toISOString(),
  };

  await kv.set(KV.projects, projectId, project);
  // Index all signals
  for (const signal of identitySignals) {
    await kv.set(KV.projectSignals, signal, projectId);
  }

  logger.info("project created", { projectId, displayName: name, signals: identitySignals });
  return { projectId, project, isNew: true };
}

export async function runProjectMigration(kv: StateKV): Promise<number> {
  const sessions = await kv.list<Session>(KV.sessions);
  const uniqueProjects = new Set<string>();
  for (const s of sessions) {
    if (s.project && !s.projectId) uniqueProjects.add(s.project);
  }

  // Also check memories for project strings
  const memories = await kv.list<Memory>(KV.memories);
  for (const m of memories) {
    if (m.project && !m.projectId) uniqueProjects.add(m.project);
  }

  let created = 0;
  for (const projectName of uniqueProjects) {
    const { projectId } = await resolveProject(kv, { name: projectName });
    created++;
  }

  // Backfill sessions
  for (const session of sessions) {
    if (session.projectId) continue;
    if (!session.project) continue;
    const signalId = await kv.get<string>(KV.projectSignals, session.project);
    if (signalId) {
      await kv.set(KV.sessions, session.id, { ...session, projectId: signalId });
    }
  }

  if (created > 0) {
    logger.info("project migration complete", { projectsCreated: created, sessionsBackfilled: sessions.length });
  }
  return created;
}

export function registerIdentityFunctions(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::identity-resolve",
    async (data: { name: string; gitRemotes?: string[] }) => {
      if (!data?.name || typeof data.name !== "string" || !data.name.trim()) {
        return { success: false, error: "name required" };
      }
      const gitRemotes = Array.isArray(data.gitRemotes)
        ? data.gitRemotes.filter((r): r is string => typeof r === "string")
        : undefined;
      const result = await resolveProject(kv, { name: data.name, gitRemotes });
      return { success: true, ...result };
    },
  );

  sdk.registerFunction("mem::identity-migrate", async () => {
    const created = await runProjectMigration(kv);
    return { success: true, projectsCreated: created };
  });
}
