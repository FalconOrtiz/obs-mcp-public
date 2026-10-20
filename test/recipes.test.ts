import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ObsClient } from "../src/client.ts";
import { payloadContains } from "../src/protocol.ts";
import { MIC_CHAIN, SCENE_PACK } from "../src/recipes.ts";
import { callTool } from "../src/tools.ts";
import { FakeObs } from "./fake-obs.ts";

function offlineClient(): ObsClient {
  return new ObsClient({ url: "ws://127.0.0.1:1", maxAttempts: 1, retryBaseMs: 1, handshakeTimeoutMs: 50, requestTimeoutMs: 50 });
}

async function withObs(fn: (obs: FakeObs, client: ObsClient) => Promise<void>) {
  const obs = new FakeObs();
  await obs.start();
  const client = new ObsClient({ url: obs.url, maxAttempts: 2, retryBaseMs: 10, handshakeTimeoutMs: 1000, requestTimeoutMs: 1000 });
  try {
    await fn(obs, client);
  } finally {
    client.close();
    await obs.stop();
  }
}

test("scene pack dry-run lists four scenes and does not connect", async () => {
  const client = offlineClient();
  const result = await callTool("obs_recipe_scene_pack", {}, client) as {
    dry_run: boolean;
    requests: Array<{ requestType: string; requestData: { sceneName: string } }>;
    backup: unknown[];
  };
  assert.equal(result.dry_run, true);
  assert.deepEqual(result.requests.map((item) => item.requestData.sceneName), [...SCENE_PACK]);
  assert.equal(result.requests.every((item) => item.requestType === "CreateScene"), true);
  assert.ok(result.backup.length >= 5);
  assert.equal(client.connectAttempts, 0);
});

test("scene pack apply backs up, then creates only missing scenes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "obs-mcp-recipe-"));
  const backupPath = path.join(directory, "scenes.json");
  try {
    await withObs(async (obs, client) => {
      obs.setHandler("GetVersion", () => ({ responseData: { obsVersion: "30.2.2", rpcVersion: 1 } }));
      obs.setHandler("GetSceneList", () => ({
        responseData: { scenes: [{ sceneName: "Starting" }, { sceneName: "Live" }] },
      }));
      obs.setHandler("GetGroupList", () => ({ responseData: { groups: [] } }));
      obs.setHandler("GetSceneTransitionList", () => ({ responseData: { transitions: [] } }));
      obs.setHandler("GetCurrentSceneTransition", () => ({ responseData: { transitionName: "Cut" } }));
      obs.setHandler("GetSceneItemList", () => ({ responseData: { sceneItems: [] } }));
      const result = await callTool("obs_recipe_scene_pack", { dry_run: false, backup_path: backupPath }, client) as {
        result: { created: string[]; skipped: string[] };
      };
      assert.deepEqual(result.result.skipped, ["Starting", "Live"]);
      assert.deepEqual(result.result.created, ["BRB", "Ending"]);
      const created = obs.received.filter((message) => message.d.requestType === "CreateScene");
      assert.deepEqual(created.map((message) => (message.d.requestData as { sceneName: string }).sceneName), ["BRB", "Ending"]);
      const backup = JSON.parse(await readFile(backupPath, "utf8")) as { backupVersion: number };
      assert.equal(backup.backupVersion, 1);
      const firstCreate = obs.received.findIndex((message) => message.d.requestType === "CreateScene");
      const backupList = obs.received.findIndex((message) => message.op === 8);
      assert.ok(backupList >= 0 && backupList < firstCreate);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("transition and mic recipes describe the best-practice requests", async () => {
  const client = offlineClient();
  const transitions = await callTool("obs_recipe_transitions", { stinger_path: "/media/hit.webm", stinger_point_ms: 400 }, client) as {
    requests: Array<{ requestType: string; requestData?: Record<string, unknown> }>;
    stinger: { configured: boolean };
  };
  assert.deepEqual(transitions.requests.map((item) => item.requestType), [
    "SetCurrentSceneTransition",
    "SetCurrentSceneTransitionSettings",
    "SetCurrentSceneTransition",
    "SetCurrentSceneTransitionDuration",
  ]);
  assert.equal((transitions.requests[1].requestData?.transitionSettings as { path: string }).path, "/media/hit.webm");
  assert.equal((transitions.requests[1].requestData?.transitionSettings as { transition_point: number }).transition_point, 400);
  assert.equal((transitions.requests[3].requestData?.transitionDuration), 300);
  assert.equal(transitions.stinger.configured, true);
  assert.equal(client.connectAttempts, 0);

  const bare = await callTool("obs_recipe_transitions", {}, client) as { requests: Array<{ requestType: string }>; stinger: { configured: boolean } };
  assert.deepEqual(bare.requests.map((item) => item.requestType), ["SetCurrentSceneTransition", "SetCurrentSceneTransitionDuration"]);
  assert.equal(bare.stinger.configured, false);

  const mic = await callTool("obs_recipe_mic_chain", { input_name: "Mic" }, client) as {
    requests: Array<{ requestData: { filterKind: string; filterName: string } }>;
  };
  assert.deepEqual(mic.requests.map((item) => item.requestData.filterKind), MIC_CHAIN.map((filter) => filter.filterKind));
  assert.deepEqual(mic.requests.map((item) => item.requestData.filterName), ["Noise Suppression", "Noise Gate", "Compressor", "Limiter"]);
  assert.equal(client.connectAttempts, 0);
});

test("mic chain apply updates an existing gate and creates the rest", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "obs-mcp-mic-"));
  const backupPath = path.join(directory, "mic.json");
  try {
    await withObs(async (obs, client) => {
      obs.setHandler("GetVersion", () => ({ responseData: { obsVersion: "30.2.2" } }));
      obs.setHandler("GetSceneList", () => ({ responseData: { scenes: [] } }));
      obs.setHandler("GetGroupList", () => ({ responseData: { groups: [] } }));
      obs.setHandler("GetSceneTransitionList", () => ({ responseData: { transitions: [] } }));
      obs.setHandler("GetCurrentSceneTransition", () => ({ responseData: {} }));
      obs.setHandler("GetSourceFilterList", () => ({ responseData: { filters: [{ filterName: "Noise Gate" }] } }));
      const result = await callTool("obs_recipe_mic_chain", { input_name: "Mic", dry_run: false, backup_path: backupPath }, client) as {
        result: { created: string[]; updated: string[] };
      };
      assert.deepEqual(result.result.updated, ["Noise Gate"]);
      assert.deepEqual(result.result.created, ["Noise Suppression", "Compressor", "Limiter"]);
      const updates = obs.received.filter((message) => message.d.requestType === "SetSourceFilterSettings");
      assert.equal(updates.length, 1);
      assert.equal((updates[0].d.requestData as { filterName: string }).filterName, "Noise Gate");
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("celebration dry-run keeps the return scene symbolic and apply batches the hold", async () => {
  const client = offlineClient();
  const preview = await callTool("obs_recipe_celebration", {}, client) as {
    requests: Array<{ requestType: string; requestData?: { sceneName?: string; sleepMillis?: number } }>;
  };
  assert.equal(preview.requests[2].requestType, "Sleep");
  assert.equal(preview.requests[2].requestData?.sleepMillis, 2000);
  assert.equal(preview.requests[3].requestData?.sceneName, "<current program scene>");
  assert.equal(client.connectAttempts, 0);

  const directory = await mkdtemp(path.join(tmpdir(), "obs-mcp-cele-"));
  try {
    await withObs(async (obs, live) => {
      obs.setHandler("GetVersion", () => ({ responseData: { obsVersion: "30.2.2" } }));
      obs.setHandler("GetSceneList", () => ({ responseData: { scenes: [] } }));
      obs.setHandler("GetGroupList", () => ({ responseData: { groups: [] } }));
      obs.setHandler("GetSceneTransitionList", () => ({ responseData: { transitions: [] } }));
      obs.setHandler("GetCurrentSceneTransition", () => ({ responseData: {} }));
      obs.setHandler("GetCurrentProgramScene", () => ({ responseData: { sceneName: "Live", sceneUuid: "s" } }));
      const result = await callTool("obs_recipe_celebration", {
        dry_run: false,
        backup_path: path.join(directory, "cele.json"),
        hold_ms: 800,
      }, live) as { result: { held: boolean; returnScene: string; created: boolean } };
      assert.equal(result.result.created, true);
      assert.equal(result.result.held, true);
      assert.equal(result.result.returnScene, "Live");
      const batch = obs.received.find((message) => message.op === 8 && Array.isArray(message.d.requests) && (message.d.requests as Array<{ requestType: string }>).some((item) => item.requestType === "Sleep"));
      assert.ok(batch);
      const items = batch.d.requests as Array<{ requestType: string; requestData?: { sceneName?: string; sleepMillis?: number } }>;
      assert.deepEqual(items.map((item) => item.requestType), ["SetCurrentProgramScene", "Sleep", "SetCurrentProgramScene"]);
      assert.equal(items[0].requestData?.sceneName, "Celebration");
      assert.equal(items[1].requestData?.sleepMillis, 800);
      assert.equal(items[2].requestData?.sceneName, "Live");
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stream service reads the key from the environment and never echoes it", async () => {
  const secret = "stream-key-should-not-echo";
  const previousKey = process.env.OBS_STREAM_KEY;
  const previousServer = process.env.OBS_STREAM_SERVER;
  process.env.OBS_STREAM_KEY = secret;
  process.env.OBS_STREAM_SERVER = "rtmp://example.test/live";
  try {
    const offline = offlineClient();
    const preview = await callTool("obs_set_stream_service", {}, offline);
    assert.equal(payloadContains(preview, secret), false);
    assert.equal(payloadContains(preview, "[REDACTED]"), true);
    assert.equal(offline.connectAttempts, 0);
    await assert.rejects(() => callTool("obs_set_stream_service", { key: secret }, offline), /Unknown argument: key/);

    await withObs(async (obs, client) => {
      obs.setHandler("SetStreamServiceSettings", (requestData) => ({
        responseData: {
          streamServiceType: requestData?.streamServiceType,
          streamServiceSettings: requestData?.streamServiceSettings as Record<string, unknown>,
        },
      }));
      const live = await callTool("obs_set_stream_service", { dry_run: false }, client);
      assert.equal(payloadContains(live, secret), false);
      assert.equal(payloadContains(live, "rtmp://example.test/live"), true);
      const sent = obs.received.find((message) => message.d.requestType === "SetStreamServiceSettings");
      const settings = (sent?.d.requestData as { streamServiceSettings: { key: string; server: string } }).streamServiceSettings;
      assert.equal(settings.key, secret);
      assert.equal(settings.server, "rtmp://example.test/live");
    });
  } finally {
    if (previousKey === undefined) delete process.env.OBS_STREAM_KEY;
    else process.env.OBS_STREAM_KEY = previousKey;
    if (previousServer === undefined) delete process.env.OBS_STREAM_SERVER;
    else process.env.OBS_STREAM_SERVER = previousServer;
  }
});

test("stream service errors never carry the key, even if OBS echoes it", async () => {
  const secret = "stream-key-in-error";
  const previousKey = process.env.OBS_STREAM_KEY;
  process.env.OBS_STREAM_KEY = secret;
  try {
    await withObs(async (obs, client) => {
      obs.setHandler("SetStreamServiceSettings", () => ({ code: 600, comment: `bad settings: key=${secret}` }));
      await assert.rejects(
        () => callTool("obs_set_stream_service", { dry_run: false, server: "rtmp://example.test/live" }, client),
        (error: Error) => {
          assert.equal(error.message.includes(secret), false);
          assert.equal(error.message.includes("[REDACTED]"), true);
          assert.equal(JSON.stringify(error).includes(secret), false);
          return true;
        },
      );
    });
    const offline = offlineClient();
    delete process.env.OBS_STREAM_KEY;
    await assert.rejects(() => callTool("obs_set_stream_service", { dry_run: false, server: "rtmp://example.test/live" }, offline), /OBS_STREAM_KEY is not set/);
  } finally {
    if (previousKey === undefined) delete process.env.OBS_STREAM_KEY;
    else process.env.OBS_STREAM_KEY = previousKey;
  }
});
