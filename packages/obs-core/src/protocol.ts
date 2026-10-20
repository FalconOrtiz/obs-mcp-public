import { createHash } from "node:crypto";

/** obs-websocket v5 opcodes. https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md */
export const OpCode = {
  Hello: 0,
  Identify: 1,
  Identified: 2,
  Reidentify: 3,
  Event: 5,
  Request: 6,
  RequestResponse: 7,
  RequestBatch: 8,
  RequestBatchResponse: 9,
} as const;

export const RPC_VERSION = 1;
export const EVENT_SUBSCRIPTION_NONE = 0;

export const BatchExecution = {
  SerialRealtime: 0,
  SerialFrame: 1,
  Parallel: 2,
} as const;

export const DEFAULT_OBS_URL = "ws://127.0.0.1:4455";

const UNEXPANDED_PASSWORDS = new Set(["${OBS_WS_PASSWORD}", "${env:OBS_WS_PASSWORD}"]);

/**
 * base64(sha256(base64(sha256(password + salt)) + challenge))
 *
 * Steps are the protocol section "Creating an authentication string".
 * The server check is Utils::Crypto::GenerateSecret plus CheckAuthenticationString
 * in obs-websocket src/utils/Crypto.cpp.
 */
export function createAuthenticationString(password: string, salt: string, challenge: string): string {
  const secret = createHash("sha256").update(password + salt).digest("base64");
  return createHash("sha256").update(secret + challenge).digest("base64");
}

export function normalizePassword(raw: string | undefined): string | undefined {
  if (raw == null) return undefined;
  if (raw.length === 0 || UNEXPANDED_PASSWORDS.has(raw)) return undefined;
  return raw;
}

export function normalizeObsUrl(raw: string | undefined): string {
  const url = raw == null || raw.trim() === "" ? DEFAULT_OBS_URL : raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`OBS_WS_URL is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`OBS_WS_URL must use ws: or wss:. Received ${parsed.protocol}`);
  }
  return url;
}

export const REQUEST_STATUS: Record<number, string> = {
  0: "Unknown status",
  10: "No error",
  100: "Success",
  203: "The requestType field is missing",
  204: "Unknown request type",
  205: "OBS reported a generic error",
  206: "Unsupported request batch execution type",
  207: "OBS is not ready. Retry after the scene collection change or shutdown finishes",
  300: "A required request field is missing",
  301: "The request does not have a valid requestData object",
  400: "A request field is invalid",
  401: "A request field has the wrong type",
  402: "A request field is outside the allowed range",
  403: "A request field is empty",
  404: "Too many request fields were provided",
  500: "An output is running",
  501: "An output is not running",
  502: "An output is paused",
  503: "An output is not paused",
  504: "An output is disabled",
  505: "Studio mode is active",
  506: "Studio mode is not active",
  600: "The resource was not found",
  601: "The resource already exists",
  602: "The resource type is invalid",
  603: "There are not enough resources to perform the request",
  604: "The resource is in an invalid state",
  605: "The input kind is invalid",
  606: "The resource cannot be configured",
  607: "The filter kind is invalid",
  700: "Creating the resource failed",
  701: "The action on the resource failed",
  702: "OBS failed while processing the request",
  703: "Those request fields cannot be used together",
};

export const CLOSE_CODES: Record<number, string> = {
  1000: "Normal closure",
  1006: "Connection closed abnormally",
  4000: "Unknown close reason",
  4002: "OBS could not decode a message",
  4003: "A required data field is missing",
  4004: "A data field has an invalid type",
  4005: "A data field has an invalid value",
  4006: "Unknown opcode",
  4007: "A message was sent before Identify",
  4008: "Identify was sent after the client was already identified",
  4009: "Authentication failed. Check OBS_WS_PASSWORD",
  4010: "Unsupported obs-websocket RPC version",
  4011: "OBS invalidated the session. Automatic reconnect is disabled",
  4012: "OBS does not support a requested feature",
};

export const FATAL_CLOSE_CODES = new Set([4009, 4010, 4011]);

export function formatRequestError(requestType: string, code: number, comment?: string): string {
  const name = REQUEST_STATUS[code] ?? "Unrecognized OBS error";
  const detail = comment ? `: ${comment}` : "";
  return `OBS request ${requestType} failed (${code} ${name})${detail}`;
}

export function formatCloseError(code: number, reason?: string): string {
  const name = CLOSE_CODES[code] ?? "Connection closed";
  const detail = reason ? `: ${reason}` : "";
  return `OBS WebSocket closed (${code} ${name})${detail}`;
}

export class ObsRequestError extends Error {
  readonly requestType: string;
  readonly code: number;
  readonly comment?: string;

  constructor(requestType: string, code: number, comment?: string) {
    super(formatRequestError(requestType, code, comment));
    this.name = "ObsRequestError";
    this.requestType = requestType;
    this.code = code;
    this.comment = comment;
  }
}

export class ObsConnectionError extends Error {
  readonly closeCode?: number;
  readonly fatal: boolean;

  constructor(message: string, options?: { closeCode?: number; fatal?: boolean }) {
    super(message);
    this.name = "ObsConnectionError";
    this.closeCode = options?.closeCode;
    this.fatal = options?.fatal ?? false;
  }
}

export type ObsRequest = {
  requestType: string;
  requestId?: string;
  requestData?: Record<string, unknown>;
};

export type ObsRequestStatus = {
  result: boolean;
  code: number;
  comment?: string;
};

export type ObsResult = {
  requestType: string;
  requestId?: string;
  requestStatus: ObsRequestStatus;
  responseData?: Record<string, unknown>;
};

const REDACTED = "[REDACTED]";

function isSecretField(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "key") return true;
  if (lower.includes("password") || lower.includes("secret") || lower.includes("token")) return true;
  if (lower.includes("stream") && lower.includes("key")) return true;
  return false;
}

function redactStreamSettings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactStreamSettings(entry));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSecretField(key) ? REDACTED : redactStreamSettings(child);
  }
  return out;
}

/** Replace streamServiceSettings key, password, secret, and token fields. Other fields stay intact. */
export function redactObsPayload<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => walk(entry));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = key === "streamServiceSettings" ? redactStreamSettings(child) : walk(child);
  }
  return out;
}

export function payloadContains(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) return value.some((entry) => payloadContains(entry, needle));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((entry) => payloadContains(entry, needle));
  }
  return false;
}
