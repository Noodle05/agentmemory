#!/usr/bin/env node
import { execSync } from "node:child_process";
import { basename } from "node:path";
//#region src/hooks/_project.ts
function collectGitRemotes(cwd) {
	const dir = cwd && cwd.trim() ? cwd : process.cwd();
	try {
		const out = execSync("git remote -v", {
			cwd: dir,
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			],
			timeout: 500
		}).toString().trim();
		if (!out) return [];
		const remotes = [];
		for (const line of out.split("\n")) {
			const parts = line.split(/\s+/);
			if (parts.length >= 2) remotes.push(parts[1]);
		}
		return [...new Set(remotes)];
	} catch {
		return [];
	}
}
function resolveProject(cwd) {
	const explicit = process.env["AGENTMEMORY_PROJECT_NAME"];
	if (explicit && explicit.trim()) return explicit.trim();
	const dir = cwd && cwd.trim() ? cwd : process.cwd();
	try {
		const top = execSync("git rev-parse --show-toplevel", {
			cwd: dir,
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			],
			timeout: 500
		}).toString().trim();
		if (top) return basename(top);
	} catch {}
	return basename(dir);
}
//#endregion
//#region src/hooks/subagent-start.ts
function isSdkChildContext(payload) {
	if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
	if (!payload || typeof payload !== "object") return false;
	return payload.entrypoint === "sdk-ts";
}
const INJECT_CONTEXT = process.env["AGENTMEMORY_INJECT_CONTEXT"] === "true";
const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
const TIMEZONE = process.env["CLAUDE_PLUGIN_OPTION_TIMEZONE"] || "";
const INJECT_TIMEOUT_MS = 1500;
const OBSERVE_TIMEOUT_MS = 800;
function authHeaders() {
	const h = { "Content-Type": "application/json" };
	if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
	return h;
}
async function main() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	let data;
	try {
		data = JSON.parse(input);
	} catch {
		return;
	}
	if (isSdkChildContext(data)) return;
	const sessionId = data.session_id || data.sessionId || "unknown";
	const cwd = data.cwd || process.cwd();
	const project = resolveProject(data.cwd);
	const gitRemotes = collectGitRemotes(data.cwd);
	const agentId = data.agent_id || data.agentName;
	const agentType = data.agent_type || data.agentDisplayName || data.agentName;
	fetch(`${REST_URL}/agentmemory/observe` + (TIMEZONE ? `?timezone=${encodeURIComponent(TIMEZONE)}` : ""), {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			hookType: "subagent_start",
			sessionId,
			project,
			cwd,
			gitRemotes,
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			data: {
				agent_id: agentId,
				agent_type: agentType
			}
		}),
		signal: AbortSignal.timeout(OBSERVE_TIMEOUT_MS)
	}).catch(() => {});
	if (INJECT_CONTEXT) try {
		const res = await fetch(`${REST_URL}/agentmemory/context` + (TIMEZONE ? `?timezone=${encodeURIComponent(TIMEZONE)}` : ""), {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				sessionId,
				project,
				budget: 1500
			}),
			signal: AbortSignal.timeout(INJECT_TIMEOUT_MS)
		});
		if (res.ok) {
			const result = await res.json();
			if (result.context) process.stdout.write(JSON.stringify({ hookSpecificOutput: {
				hookEventName: "SubagentStart",
				additionalContext: result.context
			} }));
		}
	} catch {}
}
main();
//#endregion
export {};

//# sourceMappingURL=subagent-start.mjs.map