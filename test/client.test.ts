import assert from "node:assert/strict";
import test from "node:test";
import { ObsClient } from "../src/client.ts";
import { ObsConnectionError, ObsRequestError } from "../src/protocol.ts";
import { FakeObs } from "./fake-obs.ts";

const FROZEN_AUTH = "1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=";

async function withObs(options: ConstructorParameters<typeof FakeObs>[0], fn: (obs: FakeObs, client: ObsClient) => Promise<void>) {
  const obs = new FakeObs(options);
  await obs.start();
  const client = new ObsClient({
    url: obs.url,
    password: options?.password,
    maxAttempts: 4,
    retryBaseMs: 40,
    retryMaxMs: 200,
    handshakeTimeoutMs: 1000,
    requestTimeoutMs: 1000,
  });
  try {
    await fn(obs, client);
  } finally {
    client.close();
    await obs.stop();
  }
}

test("identifies without a password and completes a request", async () => {
  await withObs({}, async (obs, client) => {
    obs.setHandler("GetVersion", () => ({
      responseData: { obsVersion: "30.2.2", obsWebSocketVersion: "5.5.2", rpcVersion: 1 },
    }));
    const version = await client.request("GetVersion");
    assert.equal(version.obsVersion, "30.2.2");
    const identify = obs.received.find((message) => message.op === 1);
    assert.ok(identify);
    assert.equal(identify.d.rpcVersion, 1);
    assert.equal(identify.d.eventSubscriptions, 0);
    assert.equal("authentication" in identify.d, false);
    assert.equal(obs.connections.length, 1);
  });
});

test("SHA256 identify matches the frozen protocol vector", async () => {
  await withObs({ password: "supersecretpassword" }, async (obs, client) => {
    const version = await client.request("GetVersion");
    assert.deepEqual(version, {});
    const identify = obs.received.find((message) => message.op === 1);
    assert.equal(identify?.d.authentication, FROZEN_AUTH);
    assert.equal(obs.connections.filter((connection) => connection.identified).length, 1);
  });
});

test("authentication failure is not retried", async () => {
  await withObs({ password: "expected" }, async (obs) => {
    const client = new ObsClient({
      url: obs.url,
      password: "wrong",
      maxAttempts: 4,
      retryBaseMs: 20,
      handshakeTimeoutMs: 500,
    });
    try {
      await assert.rejects(() => client.request("GetVersion"), (error: unknown) => {
        assert.ok(error instanceof ObsConnectionError);
        assert.match(error.message, /4009 Authentication failed/);
        assert.equal(error.fatal, true);
        return true;
      });
      assert.equal(client.connectAttempts, 1);
      assert.equal(obs.connections.length, 1);
    } finally {
      client.close();
    }
  });
});

test("dropped connections retry with backoff and then succeed", async () => {
  await withObs({}, async (obs, client) => {
    obs.failNextConnections = 2;
    const started = Date.now();
    const version = await client.request("GetVersion");
    assert.deepEqual(version, {});
    assert.equal(obs.connections.length, 3);
    const firstGap = obs.connections[1].at - obs.connections[0].at;
    const secondGap = obs.connections[2].at - obs.connections[1].at;
    assert.ok(firstGap >= 30, `first backoff gap was ${firstGap}ms`);
    assert.ok(secondGap >= 70, `second backoff gap was ${secondGap}ms`);
    assert.ok(secondGap > firstGap, `backoff did not grow (${firstGap} then ${secondGap})`);
    assert.ok(Date.now() - started >= 100);
  });
});

test("request batch uses opcode 8 and returns opcode 9 results", async () => {
  await withObs({}, async (obs, client) => {
    obs.setHandler("Sleep", () => ({ code: 205, comment: "bad sleep" }));
    obs.setHandler("GetVersion", () => ({ responseData: { obsVersion: "30.2.2" } }));
    const results = await client.batch(
      [{ requestType: "GetVersion" }, { requestType: "Sleep", requestData: { sleepMillis: 1 } }, { requestType: "GetVersion" }],
      { haltOnFailure: true, executionType: 0 },
    );
    const batch = obs.received.find((message) => message.op === 8);
    assert.ok(batch);
    assert.equal(batch.d.haltOnFailure, true);
    assert.equal(batch.d.executionType, 0);
    assert.equal((batch.d.requests as unknown[]).length, 3);
    assert.equal(results.length, 2);
    assert.equal(results[0].requestStatus.result, true);
    assert.equal(results[0].responseData?.obsVersion, "30.2.2");
    assert.equal(results[1].requestStatus.code, 205);
    assert.equal(results[1].requestStatus.comment, "bad sleep");
  });
});

test("OBS error codes surface as ObsRequestError", async () => {
  await withObs({}, async (obs, client) => {
    obs.setHandler("SetCurrentProgramScene", () => ({ code: 600, comment: "sceneName" }));
    await assert.rejects(() => client.request("SetCurrentProgramScene", { sceneName: "Missing" }), (error: unknown) => {
      assert.ok(error instanceof ObsRequestError);
      assert.equal(error.code, 600);
      assert.match(error.message, /The resource was not found/);
      assert.match(error.message, /sceneName/);
      return true;
    });
  });
});

test("session invalidation does not reconnect", async () => {
  await withObs({}, async (obs, client) => {
    obs.invalidateOnRequest = true;
    await assert.rejects(() => client.request("GetVersion"), /4011/);
    assert.equal(client.connectAttempts, 1);
    await assert.rejects(() => client.request("GetVersion"), /4011/);
    assert.equal(client.connectAttempts, 1);
    assert.equal(obs.connections.length, 1);
  });
});

test("events are ignored while a request is in flight", async () => {
  await withObs({}, async (obs, client) => {
    obs.eventBeforeResponse = true;
    obs.setHandler("GetVersion", () => ({ responseData: { obsVersion: "30.2.2" } }));
    const version = await client.request("GetVersion");
    assert.equal(version.obsVersion, "30.2.2");
  });
});
