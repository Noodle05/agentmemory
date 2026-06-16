import { describe, it, expect } from "vitest";
import { normalizeGitUrl, resolveProject } from "../src/functions/identity.js";
import { KV } from "../src/state/schema.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      if (!store.has(scope)) return [];
      return Array.from(store.get(scope)!.values()) as T[];
    },
  };
}

describe("normalizeGitUrl", () => {
  it("normalizes SSH git URL", () => {
    expect(normalizeGitUrl("git@github.com:Noodle05/agentmemory.git")).toBe("github.com/noodle05/agentmemory");
  });

  it("normalizes HTTPS git URL", () => {
    expect(normalizeGitUrl("https://github.com/Noodle05/agentmemory.git")).toBe("github.com/noodle05/agentmemory");
  });

  it("normalizes URL without .git suffix", () => {
    expect(normalizeGitUrl("git@gitlab.com:org/proj")).toBe("gitlab.com/org/proj");
  });

  it("strips trailing slash", () => {
    expect(normalizeGitUrl("https://github.com/user/repo.git/")).toBe("github.com/user/repo");
  });

  it("returns null for empty input", () => {
    expect(normalizeGitUrl("")).toBeNull();
    expect(normalizeGitUrl("  ")).toBeNull();
  });

  it("returns lowercase result", () => {
    expect(normalizeGitUrl("git@GitHub.Com:User/Repo.git")).toBe("github.com/user/repo");
  });
});

describe("resolveProject", () => {
  it("creates a new project on first encounter", async () => {
    const kv = mockKV();
    const { projectId, project, isNew } = await resolveProject(kv, {
      name: "test-project",
      gitRemotes: ["git@github.com:test/repo.git"],
    });
    expect(isNew).toBe(true);
    expect(projectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(project.displayName).toBe("test-project");
    expect(project.identitySignals).toContain("github.com/test/repo");
  });

  it("matches existing project by normalized git remote", async () => {
    const kv = mockKV();
    const first = await resolveProject(kv, {
      name: "my-app",
      gitRemotes: ["git@github.com:org/my-app.git"],
    });
    // Second call with HTTPS variant of same remote
    const second = await resolveProject(kv, {
      name: "my-app",
      gitRemotes: ["https://github.com/org/my-app.git"],
    });
    expect(second.isNew).toBe(false);
    expect(second.projectId).toBe(first.projectId);
  });

  it("returns different projects for same basename with different remotes", async () => {
    const kv = mockKV();
    const projA = await resolveProject(kv, {
      name: "server",
      gitRemotes: ["git@github.com:org-a/server.git"],
    });
    const projB = await resolveProject(kv, {
      name: "server",
      gitRemotes: ["git@github.com:org-b/server.git"],
    });
    expect(projA.projectId).not.toBe(projB.projectId);
    // Verify isolation: each project stored under different IDs
    const a = await kv.get(KV.projects, projA.projectId);
    const b = await kv.get(KV.projects, projB.projectId);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it("matches by name when no git remotes provided", async () => {
    const kv = mockKV();
    const first = await resolveProject(kv, { name: "standalone" });
    const second = await resolveProject(kv, { name: "standalone" });
    expect(second.isNew).toBe(false);
    expect(second.projectId).toBe(first.projectId);
  });
});
