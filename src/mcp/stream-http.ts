/**
 * MCP Streamable HTTP transport — manual JSON-RPC implementation.
 *
 * We hand-roll JSON-RPC routing here instead of using the official
 * `@modelcontextprotocol/sdk`'s `NodeStreamableHTTPServerTransport` because
 * `handleRequest()` depends on `@hono/node-server`'s `getRequestListener()`,
 * which has a known body-parsing bug: it may return an empty or truncated body
 * for requests with `Transfer-Encoding: chunked` (common from MCP clients).
 *
 * Our manual approach gives us full control over body parsing, request
 * validation, and error formatting while still complying with the MCP
 * Streamable HTTP contract (protocolVersion "2025-03-26").
 *
 * Observed in @modelcontextprotocol/node v2.0.0-alpha.2 with chunked transfer encoding.
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { randomUUID } from "node:crypto";
import { timingSafeCompare } from "../auth.js";
import { handleToolsList, handleToolCall } from "./handler.js";
import { VERSION } from "../version.js";
import type { ISdk } from "iii-sdk";
import type { InMemoryKV } from "./in-memory-kv.js";

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

interface JsonRpcMessage {
  jsonrpc: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface SessionEntry {
  sessionId: string;
  createdAt: Date;
  lastUsedAt: Date;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

class BodyTooLargeError extends Error {
  constructor() {
    super("Payload Too Large");
    this.name = "BodyTooLargeError";
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const json = JSON.stringify(body);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(json)),
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(json);
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

/**
 * Start the MCP Streamable HTTP server.
 *
 * Returns the http.Server, the sessions map, and a `shutdown` function.
 * Call `shutdown()` to close the server and clear the eviction timer.
 */
export async function startMcpStreamServer(
  port: number,
  sdk: ISdk | null,
  kv: InMemoryKV,
  secret?: string,
): Promise<{
  server: Server;
  transports: Map<string, SessionEntry>;
  shutdown: () => Promise<void>;
}> {
  const sessions = new Map<string, SessionEntry>();

  // --- periodic eviction of idle sessions (every 10 minutes) ---
  const SESSION_IDLE_TTL_MS = 60 * 60 * 1000; // 1 hour
  const evictionTimer = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_TTL_MS;
    for (const [id, entry] of sessions) {
      if (entry.lastUsedAt.getTime() < cutoff) {
        sessions.delete(id);
      }
    }
  }, 10 * 60 * 1000).unref();

  const server = createServer(async (req, res) => {
    try {
      // --- HTTP method validation ---
      if (req.method !== "POST" && req.method !== "DELETE") {
        res.writeHead(405, { Allow: "POST, DELETE" });
        res.end(JSON.stringify(errorResponse(null, -32000, "Method Not Allowed")));
        return;
      }

      // --- Content-Type validation ---
      if (req.method === "POST") {
        const contentType = (req.headers["content-type"] || "").split(";")[0].trim();
        if (contentType !== "application/json") {
          sendJson(res, 415, errorResponse(null, -32000, "Unsupported Media Type: expected application/json"));
          return;
        }
      }

      if (secret) {
        const auth =
          req.headers["authorization"] || req.headers["Authorization"];
        if (
          typeof auth !== "string" ||
          !timingSafeCompare(auth, `Bearer ${secret}`)
        ) {
          sendJson(res, 401, errorResponse(null, -32001, "Unauthorized"));
          return;
        }
      }

      if (req.method === "DELETE") {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        if (sessionId) {
          sessions.delete(sessionId);
        }
        res.writeHead(200);
        res.end();
        return;
      }

      let bodyStr: string;
      try {
        bodyStr = await readBody(req);
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          // Safety guard: readBody() always rejects before any response is sent,
          // so headersSent is always false here under normal flow.
          if (!res.headersSent) {
            res.writeHead(413, { "Content-Type": "text/plain" });
            res.end("Payload Too Large");
          }
        } else {
          sendJson(res, 500, errorResponse(null, -32603, "Internal error"));
        }
        return;
      }

      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(bodyStr);
      } catch {
        sendJson(res, 400, errorResponse(null, -32700, "Parse error"));
        return;
      }

      if (!msg || typeof msg.jsonrpc !== "string") {
        sendJson(res, 400, errorResponse(null, -32600, "Invalid Request"));
        return;
      }

      const sessionIdHeader = req.headers["mcp-session-id"] as string | undefined;

      const isInitialize = msg.method === "initialize";
      const isNotification =
        msg.id === undefined || msg.id === null;

      if (isNotification) {
        res.writeHead(202);
        res.end();
        return;
      }

      if (!isInitialize && !sessionIdHeader) {
        sendJson(
          res,
          400,
          errorResponse(msg.id ?? null, -32000, "Bad Request: Mcp-Session-Id header is required"),
        );
        return;
      }

      if (!isInitialize && sessionIdHeader && !sessions.has(sessionIdHeader)) {
        sendJson(
          res,
          400,
          errorResponse(msg.id ?? null, -32000, "Session not found"),
        );
        return;
      }

      // Bump last-used timestamp for valid session
      if (sessionIdHeader && sessions.has(sessionIdHeader)) {
        sessions.get(sessionIdHeader)!.lastUsedAt = new Date();
      }

      switch (msg.method) {
        case "initialize": {
          const sessionId = randomUUID();
          const now = new Date();
          const response: JsonRpcMessage = {
            jsonrpc: "2.0",
            id: msg.id ?? null,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: {
                name: "agentmemory",
                version: VERSION,
              },
            },
          };
          sessions.set(sessionId, { sessionId, createdAt: now, lastUsedAt: now });
          sendJson(res, 200, response, { "Mcp-Session-Id": sessionId });
          break;
        }

        case "tools/list": {
          const result = await handleToolsList(sdk, kv);
          sendJson(res, 200, {
            jsonrpc: "2.0",
            id: msg.id ?? null,
            result,
          });
          break;
        }

        case "tools/call": {
          const params = msg.params;
          if (!params || typeof params.name !== "string") {
            sendJson(
              res,
              200,
              errorResponse(msg.id ?? null, -32602, "Invalid params: name is required"),
            );
            return;
          }
          const toolName = params.name as string;
          const args = (params.arguments as Record<string, unknown>) || {};
          try {
            const result = await handleToolCall(toolName, args, sdk, kv);
            sendJson(res, 200, {
              jsonrpc: "2.0",
              id: msg.id ?? null,
              result,
            });
          } catch (err) {
            sendJson(
              res,
              200,
              errorResponse(
                msg.id ?? null,
                -32603,
                err instanceof Error ? err.message : "Internal error",
              ),
            );
          }
          break;
        }

        default:
          sendJson(
            res,
            200,
            errorResponse(
              msg.id ?? null,
              -32601,
              `Method not found: ${msg.method || "unknown"}`,
            ),
          );
          break;
      }
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : "Internal error",
          },
        });
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));

  const shutdown = async (): Promise<void> => {
    clearInterval(evictionTimer);
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  };

  return { server, transports: sessions, shutdown };
}
