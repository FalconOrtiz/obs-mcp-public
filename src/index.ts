#!/usr/bin/env -S node --experimental-strip-types
import { pathToFileURL } from "node:url";
import { ObsClient } from "./client.ts";
import { runStdio } from "./mcp.ts";
import { normalizeObsUrl, normalizePassword } from "./protocol.ts";

export function clientFromEnv(env: NodeJS.ProcessEnv = process.env): ObsClient {
  return new ObsClient({
    url: normalizeObsUrl(env.OBS_WS_URL),
    password: normalizePassword(env.OBS_WS_PASSWORD),
    maxAttempts: positiveInt(env.OBS_WS_RETRY_ATTEMPTS, 4),
    retryBaseMs: positiveInt(env.OBS_WS_RETRY_BASE_MS, 200),
    retryMaxMs: positiveInt(env.OBS_WS_RETRY_MAX_MS, 2000),
  });
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected a positive integer environment value, received ${raw}`);
  }
  return value;
}

const SHUTDOWN_TIMEOUT_MS = positiveInt(process.env.OBS_MCP_SHUTDOWN_TIMEOUT_MS, 10_000);

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const client = clientFromEnv();
  let exiting = false;
  const shutdown = (code: number): void => {
    if (exiting) return;
    exiting = true;
    client.close();
    process.exit(code);
  };
  // runStdio awaits each handler in order, so it resolves only after every
  // pending tools/call response is written. Then drain stdout and exit.
  const finish = (code: number): void => {
    process.stdout.write("", () => shutdown(code));
  };
  const startSafetyTimer = (): void => {
    setTimeout(() => {
      console.error(`obs-mcp: pending requests did not finish within ${SHUTDOWN_TIMEOUT_MS} ms after stdin closed`);
      shutdown(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
  };
  process.stdin.once("end", startSafetyTimer);
  process.stdin.once("close", startSafetyTimer);
  runStdio({ client })
    .then(() => finish(0))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`obs-mcp: ${message}`);
      finish(1);
    });
}
