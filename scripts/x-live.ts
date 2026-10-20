// Read-only X live chat feed. Polls mentions plus live-post/hashtag search and
// prints one JSON line per event. Replies stay drafts; nothing is posted.
import { fileURLToPath } from "node:url";
import { X_ENV, X_POLL_INTERVAL_DEFAULT_MS, XAuthError, XChatPoller, missingXEnv } from "../packages/obs-bot/src/adapters/x.ts";
import type { ChatEvent } from "../packages/obs-bot/src/events.ts";

export type RunXLiveOptions = {
  poller: Pick<XChatPoller, "poll" | "stopped">;
  intervalMs: number;
  write?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Stop after this many polls. Unlimited when omitted. */
  maxTicks?: number;
};

export function feedLine(event: ChatEvent): string {
  return JSON.stringify({
    platform: event.platform,
    source: event.source ?? event.kind,
    user: event.user,
    text: event.text,
    time: event.time ?? event.ts,
    post_id: event.post_id ?? event.id ?? null,
    badges: event.badges ?? [],
    kind: event.kind,
  });
}

export function pollIntervalFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env[X_ENV.pollIntervalMs];
  if (raw === undefined || raw === "") return X_POLL_INTERVAL_DEFAULT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1000) throw new Error(`${X_ENV.pollIntervalMs} must be an integer of at least 1000`);
  return value;
}

export function maxTicksFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env[X_ENV.maxTicks];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${X_ENV.maxTicks} must be a positive integer`);
  return value;
}

export async function runXLive(options: RunXLiveOptions): Promise<number> {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let ticks = 0;
  while (!options.poller.stopped && (options.maxTicks === undefined || ticks < options.maxTicks)) {
    for (const event of await options.poller.poll()) write(feedLine(event));
    ticks += 1;
    if (!options.poller.stopped) await sleep(options.intervalMs);
  }
  return ticks;
}

/** Starts the feed. Returns the exit code: 0 when the poller stopped, 1 on missing config or a 401. No retry. */
export async function main(options: {
  env?: NodeJS.ProcessEnv;
  makePoller?: (env: NodeJS.ProcessEnv) => Pick<XChatPoller, "poll" | "stopped"> & { prepare?: () => Promise<string> };
  writeError?: (line: string) => void;
  run?: Omit<RunXLiveOptions, "poller" | "intervalMs">;
} = {}): Promise<number> {
  const env = options.env ?? process.env;
  const writeError = options.writeError ?? ((line: string) => process.stderr.write(`${line}\n`));
  const missing = missingXEnv(env);
  if (missing.length > 0) {
    writeError(`x-live: missing required variable(s): ${missing.join(", ")}. Set them in User scope and run again.`);
    return 1;
  }
  try {
    const poller = (options.makePoller ?? ((e) => new XChatPoller({ env: e, stateFile: e.X_STATE_FILE || undefined })))(env);
    if (poller.prepare) writeError(await poller.prepare());
    await runXLive({ poller, intervalMs: pollIntervalFromEnv(env), maxTicks: maxTicksFromEnv(env), ...options.run });
    return 0;
  } catch (error) {
    if (error instanceof XAuthError) {
      writeError(`x-live: ${error.message}`);
      return 1;
    }
    writeError(`x-live: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
