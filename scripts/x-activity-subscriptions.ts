// Manage the X Activity API subscription for broadcast.chat. Dry run by default: prints the request
// with the token redacted and calls nothing. A live call needs --live, and create/delete also --confirm.
//
//   node --experimental-strip-types scripts/x-activity-subscriptions.ts list
//   node --experimental-strip-types scripts/x-activity-subscriptions.ts create --webhook-id <id> [--user-id <id>]
//   node --experimental-strip-types scripts/x-activity-subscriptions.ts delete --id <subscription_id>
//
// Auth (spec v2.172 + Activity docs): broadcast.chat is a private event, so create uses the user token
// (X_USER_ACCESS_TOKEN, OAuth 2.0 with broadcast.read). list and delete accept the same user token.
import { fileURLToPath } from "node:url";

const ORIGIN = "https://api.x.com";
const NUMERIC = /^[0-9]{1,19}$/;
export const X_ACTIVITY_EVENT = "broadcast.chat";

export type ActivityRequest = { method: "GET" | "POST" | "DELETE"; url: string; body?: Record<string, unknown> };

export function parseArgs(argv: string[]): { command: string; flags: Record<string, string | true> } {
  const [command = "", ...rest] = argv;
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[arg.slice(2)] = next;
      i += 1;
    } else flags[arg.slice(2)] = true;
  }
  return { command, flags };
}

export function buildActivityRequest(command: string, flags: Record<string, string | true>, env: NodeJS.ProcessEnv): ActivityRequest {
  const str = (name: string) => (typeof flags[name] === "string" ? (flags[name] as string) : undefined);
  if (command === "list") return { method: "GET", url: `${ORIGIN}/2/activity/subscriptions` };
  if (command === "create") {
    const webhookId = str("webhook-id");
    const userId = str("user-id") ?? env.X_USER_ID;
    if (!webhookId || !NUMERIC.test(webhookId)) throw new Error("create needs --webhook-id <numeric id> (from POST /2/webhooks)");
    if (!userId || !NUMERIC.test(userId)) throw new Error("create needs --user-id or X_USER_ID (the broadcast owner)");
    return { method: "POST", url: `${ORIGIN}/2/activity/subscriptions`, body: { event_type: X_ACTIVITY_EVENT, filter: { user_id: userId }, webhook_id: webhookId } };
  }
  if (command === "delete") {
    const id = str("id");
    if (!id || !NUMERIC.test(id)) throw new Error("delete needs --id <numeric subscription id>");
    return { method: "DELETE", url: `${ORIGIN}/2/activity/subscriptions/${id}` };
  }
  throw new Error("usage: x-activity-subscriptions.ts list | create --webhook-id <id> [--user-id <id>] | delete --id <id> [--live [--confirm]]");
}

export async function main(argv: string[], options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; write?: (line: string) => void } = {}): Promise<number> {
  const env = options.env ?? process.env;
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  let request: ActivityRequest;
  let flags: Record<string, string | true>;
  try {
    const parsed = parseArgs(argv);
    flags = parsed.flags;
    request = buildActivityRequest(parsed.command, flags, env);
  } catch (error) {
    write(`x-activity: ${(error as Error).message}`);
    return 1;
  }
  const preview = { dry_run: flags.live !== true, ...request, headers: { authorization: "Bearer [REDACTED]" } };
  if (flags.live !== true) {
    write(JSON.stringify(preview));
    write("x-activity: dry run, nothing sent. Add --live (and --confirm for create/delete) to call X.");
    return 0;
  }
  if (request.method !== "GET" && flags.confirm !== true) {
    write("x-activity: create/delete need --confirm together with --live.");
    return 1;
  }
  const token = env.X_USER_ACCESS_TOKEN;
  if (!token) {
    write("x-activity: X_USER_ACCESS_TOKEN is not set (OAuth 2.0 user token with broadcast.read).");
    return 1;
  }
  const response = await (options.fetchImpl ?? fetch)(request.url, {
    method: request.method,
    headers: { authorization: `Bearer ${token}`, ...(request.body ? { "content-type": "application/json" } : {}) },
    ...(request.body ? { body: JSON.stringify(request.body) } : {}),
  });
  const text = (await response.text()).split(token).join("[REDACTED]");
  write(`x-activity: ${request.method} ${new URL(request.url).pathname} -> ${response.status}`);
  write(text.slice(0, 2000));
  return response.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
