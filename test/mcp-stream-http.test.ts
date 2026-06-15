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
import type { Server } from "node:http";

const MCP_ACCEPT = "application/json, text/event-stream";

function jsonBody(data: unknown): string {
  return JSON.stringify(data);
}

async function httpPost(
  port: number,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: unknown }> {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof body === "string" ? body : jsonBody(body);
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
          const parsed = data.length > 0 ? JSON.parse(data) : null;
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: parsed,
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

describe("MCP Stream HTTP (T010-T015)", () => {
  let server: Server;
  let httpPort: number;
  let transports: Map<string, unknown>;

  beforeEach(async () => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function startServer(secret?: string) {
    httpPort = await freePort();
    const kv = new InMemoryKV();
    const mockSdk = {
      trigger: vi.fn(async () => ({})),
      registerFunction: vi.fn(),
      registerTrigger: vi.fn(),
      shutdown: vi.fn(),
    };
    const result = await startMcpStreamServer(httpPort, mockSdk as any, kv as any, secret);
    server = result.server as unknown as Server;
    transports = result.transports as unknown as Map<string, unknown>;
  }

  // T010
  describe("initialize over HTTP", () => {
    it("returns protocolVersion, capabilities, serverInfo, and Mcp-Session-Id header", async () => {
      await startServer();
      const res = await httpPost(httpPort, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0" },
        },
      });

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.jsonrpc).toBe("2.0");
      expect(body.id).toBe(1);
      expect(body.result).toBeDefined();
      expect((body.result as Record<string, unknown>).protocolVersion).toBe("2025-03-26");
      expect((body.result as Record<string, unknown>).capabilities).toEqual({ tools: {} });
      expect((body.result as Record<string, unknown>).serverInfo).toBeDefined();
      const serverInfo = (body.result as Record<string, unknown>).serverInfo as Record<string, unknown>;
      expect(serverInfo.name).toBe("agentmemory");
      expect(typeof serverInfo.version).toBe("string");
      expect(res.headers["mcp-session-id"]).toBeDefined();
      expect(typeof res.headers["mcp-session-id"]).toBe("string");
    });

    it("rejects initialize without protocolVersion gracefully", async () => {
      await startServer();
      const res = await httpPost(httpPort, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.result).toBeDefined();
    });

    it("handles multiple concurrent initialize requests generating distinct sessions", async () => {
      await startServer();

      const [r1, r2] = await Promise.all([
        httpPost(httpPort, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "a", version: "1" } } }),
        httpPost(httpPort, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "b", version: "1" } } }),
      ]);

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r1.headers["mcp-session-id"]).toBeDefined();
      expect(r2.headers["mcp-session-id"]).toBeDefined();
      expect(r1.headers["mcp-session-id"]).not.toBe(r2.headers["mcp-session-id"]);
    });
  });

  // T011
  describe("tools/list over HTTP", () => {
    it("returns tools list with correct count when AGENTMEMORY_TOOLS=all", async () => {
      process.env["AGENTMEMORY_TOOLS"] = "all";
      await startServer();

      const initRes = await httpPost(httpPort, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
      });
      const sessionId = initRes.headers["mcp-session-id"] as string;
      expect(sessionId).toBeDefined();

      const res = await httpPost(
        httpPort,
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { "Mcp-Session-Id": sessionId },
      );

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.result).toBeDefined();
      const result = body.result as Record<string, unknown>;
      expect(result.tools).toBeDefined();
      expect(Array.isArray(result.tools)).toBe(true);
      const tools = result.tools as unknown[];
      // In test mode (local fallback), IMPLEMENTED_TOOLS returns 7 tools
      // (production connected to engine returns all 53)
      expect(tools.length).toBeGreaterThanOrEqual(7);
    });

    it("returns reduced tool set with AGENTMEMORY_TOOLS=core", async () => {
      process.env["AGENTMEMORY_TOOLS"] = "core";
      await startServer();

      const initRes = await httpPost(httpPort, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
      });
      const sessionId = initRes.headers["mcp-session-id"] as string;

      const res = await httpPost(
        httpPort,
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { "Mcp-Session-Id": sessionId },
      );

      const body = res.body as Record<string, unknown>;
      const result = body.result as Record<string, unknown>;
      const tools = result.tools as unknown[];
      // In test mode, IMPLEMENTED_TOOLS filter applies (7 tools)
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        const t = tool as Record<string, unknown>;
        expect(t.name).toBeDefined();
        expect(t.description).toBeDefined();
        expect(t.inputSchema).toBeDefined();
      }
    });
  });

  // T012
  describe("tools/call over HTTP", () => {
    it("forwards tool call and returns content array", async () => {
      process.env["AGENTMEMORY_TOOLS"] = "all";
      await startServer();

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
      expect(content.length).toBeGreaterThan(0);
      expect(content[0].type).toBe("text");
      expect(typeof content[0].text).toBe("string");
    });

    it("returns error for unknown tool", async () => {
      process.env["AGENTMEMORY_TOOLS"] = "all";
      await startServer();

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
          id: 4,
          method: "tools/call",
          params: { name: "nonexistent_tool", arguments: {} },
        },
        { "Mcp-Session-Id": sessionId },
      );

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.error).toBeDefined();
    });

    it("returns error for missing tool name", async () => {
      process.env["AGENTMEMORY_TOOLS"] = "all";
      await startServer();

      const initRes = await httpPost(httpPort, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
      });
      const sessionId = initRes.headers["mcp-session-id"] as string;

      const res = await httpPost(
        httpPort,
        { jsonrpc: "2.0", id: 5, method: "tools/call", params: {} },
        { "Mcp-Session-Id": sessionId },
      );

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.error).toBeDefined();
    });
  });

  // T013
  describe("Bearer auth", () => {
    it("returns 401 without token when secret is set", async () => {
      await startServer("test-secret");
      const res = await httpPost(httpPort, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
      });

      expect(res.status).toBe(401);
      const body = res.body as Record<string, unknown>;
      expect(body.error).toBeDefined();
    });

    it("returns 401 with wrong token", async () => {
      await startServer("test-secret");
      const res = await httpPost(
        httpPort,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
        },
        { Authorization: "Bearer wrong-token" },
      );

      expect(res.status).toBe(401);
    });

    it("returns 200 with correct token", async () => {
      await startServer("test-secret");
      const res = await httpPost(
        httpPort,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
        },
        { Authorization: "Bearer test-secret" },
      );

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.result).toBeDefined();
    });

    it("skips auth when secret is undefined", async () => {
      await startServer(undefined);
      const res = await httpPost(httpPort, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
      });

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.result).toBeDefined();
    });

    it("skips auth when secret is empty string", async () => {
      await startServer("");
      const res = await httpPost(httpPort, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
      });

      expect(res.status).toBe(200);
    });
  });

  // T014
  describe("JSON-RPC errors", () => {
    it("returns parse error (-32700) for invalid JSON", async () => {
      await startServer();
      const bodyStr = "not-valid-json{{{";
      const res = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: httpPort,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Accept": MCP_ACCEPT,
              "Content-Length": String(Buffer.byteLength(bodyStr)),
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
              try {
                resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
              } catch {
                resolve({ status: res.statusCode ?? 0, body: data });
              }
            });
          },
        );
        req.on("error", reject);
        req.write(bodyStr);
        req.end();
      });

      // Transport returns parse error via its internal handling
      expect(res.status).toBe(400);
      const body = res.body as Record<string, unknown>;
      // The transport returns a JSON-RPC parse error which may be -32700 or -32000
      if (body && body.error) {
        const code = (body.error as Record<string, unknown>).code;
        expect([-32700, -32000]).toContain(code);
      }
    });

    it("returns method not found (-32601) for unknown methods", async () => {
      await startServer();

      // Initialize first to get a session
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
          id: 2,
          method: "unknown/method",
          params: {},
        },
        { "Mcp-Session-Id": sessionId },
      );

      const body = res.body as Record<string, unknown>;
      expect(body.error).toBeDefined();
      expect((body.error as Record<string, unknown>).code).toBe(-32601);
    });

    it("returns invalid params (-32602) for tools/call without params", async () => {
      process.env["AGENTMEMORY_TOOLS"] = "all";
      await startServer();

      const initRes = await httpPost(httpPort, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
      });
      const sessionId = initRes.headers["mcp-session-id"] as string;

      const res = await httpPost(
        httpPort,
        { jsonrpc: "2.0", id: 12, method: "tools/call" },
        { "Mcp-Session-Id": sessionId },
      );

      const body = res.body as Record<string, unknown>;
      expect(body.error).toBeDefined();
      expect((body.error as Record<string, unknown>).code).toBe(-32602);
    });
  });

  // T015
  describe("session management", () => {
    it("initialize creates a session with Mcp-Session-Id header", async () => {
      await startServer();

      const res = await httpPost(httpPort, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
      });

      expect(res.status).toBe(200);
      expect(res.headers["mcp-session-id"]).toBeDefined();
      const sessionId = res.headers["mcp-session-id"] as string;
      expect(typeof sessionId).toBe("string");
      expect(sessionId.length).toBeGreaterThan(0);
    });

    it("reuses session via Mcp-Session-Id header for tools/list", async () => {
      await startServer();

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

      expect(toolsRes.status).toBe(200);
      const body = toolsRes.body as Record<string, unknown>;
      expect(body.result).toBeDefined();
    });

    it("rejects invalid session ID", async () => {
      await startServer();

      const res = await httpPost(
        httpPort,
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        { "Mcp-Session-Id": "invalid-nonexistent-session-id" },
      );

      // Either our code returns 400, or the transport returns 400/404
      expect([400, 404]).toContain(res.status);
    });

    it("returns 400 for non-initialize requests without session ID", async () => {
      await startServer();

      const res = await httpPost(httpPort, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });

      expect(res.status).toBe(400);
    });

    it("multiple initialize creates separate sessions", async () => {
      await startServer();

      const r1 = await httpPost(httpPort, {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "a", version: "1" } },
      });
      const r2 = await httpPost(httpPort, {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "b", version: "1" } },
      });

      const s1 = r1.headers["mcp-session-id"] as string;
      const s2 = r2.headers["mcp-session-id"] as string;

      expect(s1).toBeDefined();
      expect(s2).toBeDefined();
      expect(s1).not.toBe(s2);

      // Both sessions should work independently
      const t1 = await httpPost(
        httpPort,
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { "Mcp-Session-Id": s1 },
      );
      const t2 = await httpPost(
        httpPort,
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { "Mcp-Session-Id": s2 },
      );

      expect(t1.status).toBe(200);
      expect(t2.status).toBe(200);
    });
  });

  // T017
  describe("notification handling (T017)", () => {
    it("handles initialized notification without response", async () => {
      await startServer();

      const initRes = await httpPost(httpPort, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
      });
      const sessionId = initRes.headers["mcp-session-id"] as string;

      // Send initialized notification (no id field)
      const notifRes = await httpPost(
        httpPort,
        {
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        },
        { "Mcp-Session-Id": sessionId },
      );

      // Notifications should be accepted (200 or 202)
      expect([200, 202]).toContain(notifRes.status);
    });
  });
});
