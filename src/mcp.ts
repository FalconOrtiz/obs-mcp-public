import { callTool, listToolDescriptors } from "./tools.ts";
import type { ObsClient } from "./client.ts";

export const SERVER_NAME = "obs-mcp";
export const SERVER_VERSION = "0.1.0";

const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];

type RpcMessage = {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
};

export type McpContext = {
  client: ObsClient;
};

export async function handleMessage(message: unknown, ctx: McpContext): Promise<unknown | undefined> {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return rpcError(null, -32600, "Invalid request");
  }
  const rpc = message as RpcMessage;
  if (rpc.jsonrpc !== undefined && rpc.jsonrpc !== "2.0") {
    return rpcError(rpc.id ?? null, -32600, "Invalid request");
  }
  if (typeof rpc.method !== "string") {
    return rpc.id === undefined ? undefined : rpcError(rpc.id, -32600, "Invalid request");
  }
  const isNotification = rpc.id === undefined;
  try {
    const result = await dispatch(rpc.method, rpc.params ?? {}, ctx);
    if (isNotification || result === undefined) return undefined;
    return { jsonrpc: "2.0", id: rpc.id, result };
  } catch (error) {
    if (isNotification) return undefined;
    const code = error instanceof ToolError ? error.code : -32603;
    const messageText = error instanceof Error ? error.message : "Internal error";
    return rpcError(rpc.id, code, messageText);
  }
}

async function dispatch(method: string, params: Record<string, unknown>, ctx: McpContext): Promise<unknown | undefined> {
  switch (method) {
    case "initialize":
      return initialize(params);
    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined;
    case "ping":
      return {};
    case "tools/list":
      return { tools: listToolDescriptors() };
    case "tools/call":
      return callMcpTool(params, ctx);
    default:
      if (method.startsWith("notifications/")) return undefined;
      throw new ToolError(-32601, `Method not found: ${method}`);
  }
}

function initialize(params: Record<string, unknown>): Record<string, unknown> {
  const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
  const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions:
      "Read OBS with obs_status, obs_list_scenes, obs_list_inputs, obs_get_scene_items, and obs_list_transitions. Write tools default dry_run to true and return the obs-websocket request instead of sending it. Set dry_run to false only after the user confirms. Back up the scene collection before scene or item edits. Stream keys are redacted.",
  };
}

async function callMcpTool(params: Record<string, unknown>, ctx: McpContext): Promise<Record<string, unknown>> {
  if (typeof params.name !== "string" || params.name.length === 0) {
    throw new ToolError(-32602, "tools/call requires a name");
  }
  if (params.arguments !== undefined && (!params.arguments || typeof params.arguments !== "object" || Array.isArray(params.arguments))) {
    throw new ToolError(-32602, "tools/call arguments must be an object");
  }
  try {
    const result = await callTool(params.name, params.arguments as Record<string, unknown> | undefined, ctx.client);
    return {
      content: [{ type: "text", text: `${JSON.stringify(result, null, 2)}\n` }],
      isError: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool failed";
    return {
      content: [{ type: "text", text: message }],
      isError: true,
    };
  }
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

class ToolError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

export async function runStdio(ctx: McpContext, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  let buffer = "";
  for await (const chunk of input) {
    buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      let response: unknown;
      try {
        const message = JSON.parse(line) as unknown;
        try {
          response = await handleMessage(message, ctx);
        } catch (error) {
          const id = message && typeof message === "object" && "id" in message ? (message as { id?: unknown }).id ?? null : null;
          response = rpcError(id, -32603, error instanceof Error ? error.message : "Internal error");
        }
      } catch {
        response = rpcError(null, -32700, "Parse error");
      }
      if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
    }
  }
}
