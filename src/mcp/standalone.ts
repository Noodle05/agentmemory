#!/usr/bin/env node

import { InMemoryKV } from "./in-memory-kv.js";
import { createStdioTransport } from "./transport.js";
import { getStandalonePersistPath } from "../config.js";
import { VERSION } from "../version.js";
import { handleToolCall as handleToolCallImpl, handleToolsList as handleToolsListImpl } from "./handler.js";

const SERVER_INFO = {
  name: "agentmemory",
  version: VERSION,
  protocolVersion: "2024-11-05",
};

const kv = new InMemoryKV(getStandalonePersistPath());

export async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>,
  kvInstance: InMemoryKV = kv,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  return handleToolCallImpl(toolName, args, null, kvInstance);
}

export async function handleToolsList(): Promise<{ tools: unknown[] }> {
  return handleToolsListImpl(null, kv);
}

const transport = createStdioTransport(async (method, params) => {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: SERVER_INFO.protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: SERVER_INFO.name,
          version: SERVER_INFO.version,
        },
      };

    case "notifications/initialized":
      return {};

    case "tools/list":
      return handleToolsList();

    case "tools/call": {
      const toolName = params.name as string;
      const toolArgs = (params.arguments as Record<string, unknown>) || {};
      try {
        return await handleToolCall(toolName, toolArgs);
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown method: ${method}`);
  }
});

process.stderr.write(
  `[@agentmemory/mcp] Standalone MCP server v${SERVER_INFO.version} starting...\n`,
);
transport.start();

process.on("SIGINT", () => {
  kv.persist();
  process.exit(0);
});
process.on("SIGTERM", () => {
  kv.persist();
  process.exit(0);
});
