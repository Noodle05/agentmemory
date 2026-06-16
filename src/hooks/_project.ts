import { execSync } from "node:child_process";
import { basename } from "node:path";

export function collectGitRemotes(cwd?: string): string[] {
  const dir = cwd && cwd.trim() ? cwd : process.cwd();
  try {
    const out = execSync("git remote -v", {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    })
      .toString()
      .trim();
    if (!out) return [];
    const remotes: string[] = [];
    for (const line of out.split("\n")) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2) remotes.push(parts[1]);
    }
    // Deduplicate
    return [...new Set(remotes)];
  } catch {
    return [];
  }
}

// Resolution order: AGENTMEMORY_PROJECT_NAME env → git toplevel basename → cwd basename.
export function resolveProject(cwd?: string): string {
  const explicit = process.env["AGENTMEMORY_PROJECT_NAME"];
  if (explicit && explicit.trim()) return explicit.trim();
  const dir = cwd && cwd.trim() ? cwd : process.cwd();
  try {
    const top = execSync("git rev-parse --show-toplevel", {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    })
      .toString()
      .trim();
    if (top) return basename(top);
  } catch {}
  return basename(dir);
}
