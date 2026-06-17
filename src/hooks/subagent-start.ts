#!/usr/bin/env node
import { resolveProject, collectGitRemotes } from "./_project.js";

// Inlined from ./sdk-guard so each hook bundles to a single self-contained
// .mjs (matches the pattern used by every other hook entry in tsdown.config).
function isSdkChildContext(payload: unknown): boolean {
  if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
  if (!payload || typeof payload !== "object") return false;
  return (payload as { entrypoint?: unknown }).entrypoint === "sdk-ts";
}

// Subagent-start hook.
//
// Always records a subagent-start observation (fire-and-forget). When
// AGENTMEMORY_INJECT_CONTEXT=true, fetches project context from agentmemory
// and outputs it as JSON hookSpecificOutput.additionalContext so Claude Code
// injects it into the subagent's system prompt. Default off — same reasoning
// as session-start (#143); see pre-tool-use.ts for the full explanation.
const INJECT_CONTEXT = process.env["AGENTMEMORY_INJECT_CONTEXT"] === "true";

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
const TIMEZONE = process.env["CLAUDE_PLUGIN_OPTION_TIMEZONE"] || "";

const INJECT_TIMEOUT_MS = 1500;
const OBSERVE_TIMEOUT_MS = 800;

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
  return h;
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    return;
  }

  if (isSdkChildContext(data)) return;

  const sessionId = ((data.session_id || data.sessionId) as string) || "unknown";
  const cwd = (data.cwd as string) || process.cwd();
  const project = resolveProject(data.cwd as string | undefined);
  const gitRemotes = collectGitRemotes(data.cwd as string | undefined);
  const agentId = data.agent_id || data.agentName;
  const agentType = data.agent_type || data.agentDisplayName || data.agentName;

  // 1. Record observation (fire-and-forget — caller never reads the response)
  fetch(`${REST_URL}/agentmemory/observe` + (TIMEZONE ? `?timezone=${encodeURIComponent(TIMEZONE)}` : ""), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      hookType: "subagent_start",
      sessionId,
      project,
      cwd,
      gitRemotes,
      timestamp: new Date().toISOString(),
      data: {
        agent_id: agentId,
        agent_type: agentType,
      },
    }),
    signal: AbortSignal.timeout(OBSERVE_TIMEOUT_MS),
  }).catch(() => {});

  // 2. Inject project context if enabled (JSON output format)
  if (INJECT_CONTEXT) {
    try {
      const res = await fetch(`${REST_URL}/agentmemory/context` + (TIMEZONE ? `?timezone=${encodeURIComponent(TIMEZONE)}` : ""), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ sessionId, project, budget: 1500 }),
        signal: AbortSignal.timeout(INJECT_TIMEOUT_MS),
      });
      if (res.ok) {
        const result = (await res.json()) as { context?: string };
        if (result.context) {
          process.stdout.write(
            JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "SubagentStart",
                additionalContext: result.context,
              },
            }),
          );
        }
      }
    } catch {
      // silently fail — don't block subagent startup
    }
  }
}

main();
