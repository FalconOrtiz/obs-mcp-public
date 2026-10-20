// X Activity API webhook receiver. Listens on 127.0.0.1 by default and prints the same JSON feed
// lines as x-live.ts. Exposing it publicly (tunnel, reverse proxy) is the owner's decision; this
// script never deploys or registers anything.
import { fileURLToPath } from "node:url";
import { XAuthError, XChatPoller, missingXEnv } from "../packages/obs-bot/src/adapters/x.ts";
import { createXWebhookServer, xWebhookConfigFromEnv, type XWebhookSink } from "../packages/obs-bot/src/adapters/x-webhook.ts";
import { feedLine } from "./x-live.ts";

export async function main(options: {
  env?: NodeJS.ProcessEnv;
  makeSink?: (env: NodeJS.ProcessEnv) => XWebhookSink & { prepare?: () => Promise<string> };
  write?: (line: string) => void;
  writeError?: (line: string) => void;
} = {}): Promise<{ code: number; close?: () => Promise<void> }> {
  const env = options.env ?? process.env;
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeError = options.writeError ?? ((line: string) => process.stderr.write(`${line}\n`));
  const missing = missingXEnv(env);
  if (missing.length > 0) {
    writeError(`x-webhook: missing required variable(s): ${missing.join(", ")}. Set them in User scope and run again.`);
    return { code: 1 };
  }
  try {
    const config = xWebhookConfigFromEnv(env);
    const sink = (options.makeSink ?? ((e) => new XChatPoller({ env: e, stateFile: e.X_STATE_FILE || undefined })))(env);
    if (sink.prepare) writeError(await sink.prepare());
    const receiver = createXWebhookServer({
      config,
      sink: {
        get stopped() { return sink.stopped; },
        ingest: async (delivery) => {
          try {
            return await sink.ingest(delivery);
          } catch (error) {
            if (error instanceof XAuthError) {
              writeError(`x-webhook: ${error.message}. Stopping.`);
              process.exitCode = 1;
              void receiver.close();
              return [];
            }
            throw error;
          }
        },
      },
      onEvent: (event) => write(feedLine(event)),
      log: writeError,
    });
    const { host, port } = await receiver.listen();
    writeError(`x-webhook: listening on http://${host}:${port}${config.path} (CRC + signature check on)`);
    return { code: 0, close: receiver.close };
  } catch (error) {
    writeError(`x-webhook: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await main();
  if (result.code !== 0) process.exitCode = result.code;
}
