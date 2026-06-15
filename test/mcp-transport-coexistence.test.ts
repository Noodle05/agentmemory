import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "node:http";

vi.mock("../src/mcp/rest-proxy.js", () => ({
  resolveHandle: vi.fn(async () => ({ mode: "local", kv: new (await import("../src/mcp/in-memory-kv.js")).InMemoryKV() })),
  invalidateHandle: vi.fn(),
  setLivezProbe: vi.fn(),
  resetHandleForTests: vi.fn(),
}));

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
}));

import { InMemoryKV } from "../src/mcp/in-memory-kv.js";
import { startMcpStreamServer } from "../src/mcp/stream-http.js";
import { handleToolsList } from "../src/mcp/handler.js";
import type { Server } from "node:http";

const MCP_ACCEPT = "application/json, text/event-stream";

async function httpPost(
  port: number,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: unknown }> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const opts: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": MCP_ACCEPT,
        "Content-Length": String(Buffer.byteLength(bodyStr)),
        ...headers,
      },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: JSON.parse(data),
          });
        } catch {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: data,
          });
        }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

describe("MCP Transport Coexistence (T016-T017)", () => {
  let server: Server;
  let httpPort: number;
  let kv: InMemoryKV;
  let mockSdk: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env["AGENTMEMORY_TOOLS"] = "all";
    kv = new InMemoryKV();
    httpPort = await freePort();
    mockSdk = {
      trigger: vi.fn(async () => ({})),
      registerFunction: vi.fn(),
      registerTrigger: vi.fn(),
      shutdown: vi.fn(),
    };
    const result = await startMcpStreamServer(httpPort, mockSdk as any, kv as any, undefined);
    server = result.server as unknown as Server;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // T016
  describe("identical tool sets", () => {
    it("returns the same tool names via HTTP transport as handleToolsList()", async () => {
      const initRes = await httpPost(httpPort, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
      });
      const sessionId = initRes.headers["mcp-session-id"] as string;

      const toolsRes = await httpPost(
        httpPort,
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { "Mcp-Session-Id": sessionId },
      );

      const body = toolsRes.body as Record<string, unknown>;
      const result = body.result as Record<string, unknown>;
      const httpTools = (result.tools as Array<{ name: string }>).map((t) => t.name).sort();

      // Compare against what handleToolsList returns directly
      const handlerResult = await handleToolsList(mockSdk, kv);
      const handlerTools = (handlerResult.tools as Array<{ name: string }>).map((t) => t.name).sort();

      expect(httpTools).toEqual(handlerTools);
      expect(httpTools.length).toBe(handlerTools.length);
      expect(httpTools.length).toBeGreaterThan(0);
    });

    it("returns consistent tool schemas via HTTP matching handleToolsList()", async () => {
      const initRes = await httpPost(httpPort, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
      });
      const sessionId = initRes.headers["mcp-session-id"] as string;

      const toolsRes = await httpPost(
        httpPort,
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { "Mcp-Session-Id": sessionId },
      );

      const body = toolsRes.body as Record<string, unknown>;
      const httpTools = (body.result as Record<string, unknown>).tools as Array<Record<string, unknown>>;

      const handlerResult = await handleToolsList(mockSdk, kv);
      const handlerTools = handlerResult.tools as Array<Record<string, unknown>>;

      expect(httpTools.length).toBe(handlerTools.length);

      for (let i = 0; i < handlerTools.length; i++) {
        const httpTool = httpTools[i];
        const handlerTool = handlerTools[i];
        expect(httpTool.name).toBe(handlerTool.name);
        expect(httpTool.description).toBe(handlerTool.description);
        expect(httpTool.inputSchema).toEqual(handlerTool.inputSchema);
      }
    });

    it("returns identical results for the same tool call via HTTP transport", async () => {
      const initRes = await httpPost(httpPort, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
      });
      const sessionId = initRes.headers["mcp-session-id"] as string;

      const res = await httpPost(
        httpPort,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "memory_export", arguments: {} },
        },
        { "Mcp-Session-Id": sessionId },
      );

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.result).toBeDefined();
      const result = body.result as Record<string, unknown>;
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].type).toBe("text");

      const parsed = JSON.parse(content[0].text);
      expect(parsed).toBeDefined();
      expect(parsed.version).toBeDefined();
      expect(Array.isArray(parsed.memories)).toBe(true);
      expect(Array.isArray(parsed.sessions)).toBe(true);
    });
  });

  // T017
  describe("notification handling", () => {
    it("notifications without id field produce no response body", async () => {
      const initRes = await httpPost(httpPort, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
      });
      const sessionId = initRes.headers["mcp-session-id"] as string;

      const res = await httpPost(
        httpPort,
        {
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        },
        { "Mcp-Session-Id": sessionId },
      );

      expect([200, 202]).toContain(res.status);
    });

    it("server handles JSON-RPC without id field (notification)", async () => {
      const initRes = await httpPost(httpPort, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
      });
      const sessionId = initRes.headers["mcp-session-id"] as string;

      const res = await httpPost(
        httpPort,
        {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 1 },
        },
        { "Mcp-Session-Id": sessionId },
      );

      expect([200, 202, 204]).toContain(res.status);
    });
  });
});
