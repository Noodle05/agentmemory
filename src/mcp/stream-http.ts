import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { randomUUID } from "node:crypto";
import { timingSafeCompare } from "../auth.js";
import { handleToolsList, handleToolCall } from "./handler.js";
import { VERSION } from "../version.js";
import type { ISdk } from "iii-sdk";
import type { InMemoryKV } from "./in-memory-kv.js";

interface JsonRpcMessage {
  jsonrpc: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface SessionEntry {
  sessionId: string;
  createdAt: Date;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk.toString()));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
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
    id: id as string | number | null,
    error: { code, message },
  };
}

export async function startMcpStreamServer(
  port: number,
  sdk: ISdk | null,
  kv: InMemoryKV,
  secret?: string,
): Promise<{ server: Server; transports: Map<string, SessionEntry> }> {
  const sessions = new Map<string, SessionEntry>();

  const server = createServer(async (req, res) => {
    try {
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

      const bodyStr = await readBody(req);
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

      const sessionIdHeader =
        (req.headers["mcp-session-id"] as string) ||
        (req.headers["Mcp-Session-Id"] as string);

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
          errorResponse(msg.id ?? null, -32001, "Session not found"),
        );
        return;
      }

      switch (msg.method) {
        case "initialize": {
          const sessionId = randomUUID();
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
          sessions.set(sessionId, { sessionId, createdAt: new Date() });
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

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  return { server, transports: sessions };
}
