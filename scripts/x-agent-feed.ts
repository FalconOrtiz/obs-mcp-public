// X_READ_MODE=agent feed. Reads JSON lines of posts (as returned by the Grok Bot X tools: mentions,
// search, posts) from stdin or the file in X_AGENT_INPUT and prints the same JSON feed lines as x-live.ts.
// Makes no X HTTP reads; only the optional follow check (X_AUDIENCE_FILTER) calls X and is paid.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { XAuthError, XChatPoller, missingXEnv } from "../packages/obs-bot/src/adapters/x.ts";
import { feedLine } from "./x-live.ts";

export async function runAgentFeed(options: { poller: Pick<XChatPoller, "ingestPosts" | "stopped">; lines: AsyncIterable<string>; write?: (line: string) => void }): Promise<number> {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  let count = 0;
  for await (const line of options.lines) {
    if (options.poller.stopped) break;
    for (const event of await options.poller.ingestPosts(line)) write(feedLine(event));
    count += 1;
  }
  return count;
}

export async function main(options: { env?: NodeJS.ProcessEnv; lines?: AsyncIterable<string>; write?: (line: string) => void; writeError?: (line: string) => void } = {}): Promise<number> {
  const env = options.env ?? process.env;
  const writeError = options.writeError ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (env.X_READ_MODE !== "agent") {
    writeError("x-agent-feed: set X_READ_MODE=agent (use scripts/x-live.ts for api mode).");
    return 1;
  }
  const missing = missingXEnv(env);
  if (missing.length > 0) {
    writeError(`x-agent-feed: missing required variable(s): ${missing.join(", ")}.`);
    return 1;
  }
  try {
    const poller = new XChatPoller({ env, stateFile: env.X_STATE_FILE || undefined });
    // UTF-8 both ways, so emoji survive Windows pipes.
    const input = env.X_AGENT_INPUT && env.X_AGENT_INPUT !== "-" ? createReadStream(env.X_AGENT_INPUT, { encoding: "utf8" }) : process.stdin.setEncoding("utf8");
    if (typeof process.stdout.setDefaultEncoding === "function") process.stdout.setDefaultEncoding("utf8");
    const lines = options.lines ?? createInterface({ input, crlfDelay: Infinity });
    await runAgentFeed({ poller, lines, write: options.write });
    return 0;
  } catch (error) {
    writeError(`x-agent-feed: ${error instanceof XAuthError || error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
