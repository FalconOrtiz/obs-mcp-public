import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createAuthenticationString,
  formatCloseError,
  formatRequestError,
  normalizePassword,
  payloadContains,
  redactObsPayload,
} from "../src/protocol.ts";

const DOCUMENTED_SALT = "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=";
const DOCUMENTED_CHALLENGE = "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=";
const DOCUMENTED_PASSWORD = "supersecretpassword";
const FROZEN_AUTH = "1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=";

test("authentication string follows the protocol SHA256 steps", () => {
  const secret = createHash("sha256").update(DOCUMENTED_PASSWORD + DOCUMENTED_SALT).digest("base64");
  const expected = createHash("sha256").update(secret + DOCUMENTED_CHALLENGE).digest("base64");
  assert.equal(expected, FROZEN_AUTH);
  assert.equal(createAuthenticationString(DOCUMENTED_PASSWORD, DOCUMENTED_SALT, DOCUMENTED_CHALLENGE), expected);
  assert.notEqual(
    createAuthenticationString("other-password", DOCUMENTED_SALT, DOCUMENTED_CHALLENGE),
    expected,
  );
});

test("request and close codes become specific messages", () => {
  assert.match(
    formatRequestError("SetCurrentProgramScene", 600, "sceneName"),
    /SetCurrentProgramScene failed \(600 The resource was not found\): sceneName/,
  );
  assert.match(formatRequestError("StartStream", 500), /500 An output is running/);
  assert.match(formatRequestError("GetSceneList", 207), /not ready/i);
  assert.match(formatRequestError("Nope", 999), /999 Unrecognized OBS error/);
  assert.match(formatCloseError(4009), /4009 Authentication failed/);
  assert.match(formatCloseError(4011, "kicked"), /4011 OBS invalidated the session.*kicked/);
});

test("streamServiceSettings key fields are redacted and other fields stay", () => {
  const payload = {
    sceneName: "Live",
    key: "not-a-stream-key",
    streamServiceType: "rtmp_custom",
    streamServiceSettings: {
      server: "rtmp://example.test/live",
      key: "super-secret-stream-key",
      streamKey: "another-secret",
      stream_key: "third-secret",
      password: "ingest-password",
      token: "tok-1",
      nested: { secret: "hide-me", service: "twitch" },
    },
    results: [
      {
        responseData: {
          streamServiceSettings: { server: "rtmp://example.test/backup", key: "batch-secret" },
        },
      },
    ],
  };
  const redacted = redactObsPayload(payload);
  assert.equal(redacted.key, "not-a-stream-key");
  assert.equal(redacted.sceneName, "Live");
  const settings = redacted.streamServiceSettings as Record<string, unknown>;
  assert.equal(settings.server, "rtmp://example.test/live");
  assert.equal(settings.key, "[REDACTED]");
  assert.equal(settings.streamKey, "[REDACTED]");
  assert.equal(settings.stream_key, "[REDACTED]");
  assert.equal(settings.password, "[REDACTED]");
  assert.equal(settings.token, "[REDACTED]");
  assert.equal((settings.nested as Record<string, unknown>).secret, "[REDACTED]");
  assert.equal((settings.nested as Record<string, unknown>).service, "twitch");
  const nested = (redacted.results[0] as { responseData: { streamServiceSettings: { key: string; server: string } } })
    .responseData.streamServiceSettings;
  assert.equal(nested.key, "[REDACTED]");
  assert.equal(nested.server, "rtmp://example.test/backup");
  assert.equal(payloadContains(redacted, "super-secret-stream-key"), false);
  assert.equal(payloadContains(redacted, "batch-secret"), false);
  assert.equal(payloadContains(redacted, "ingest-password"), false);
});

test("unexpanded password placeholders are treated as unset", () => {
  assert.equal(normalizePassword(undefined), undefined);
  assert.equal(normalizePassword(""), undefined);
  assert.equal(normalizePassword("${OBS_WS_PASSWORD}"), undefined);
  assert.equal(normalizePassword("${env:OBS_WS_PASSWORD}"), undefined);
  assert.equal(normalizePassword("real-secret"), "real-secret");
});
