import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ObsClient } from "../src/client.ts";
import { payloadContains } from "../src/protocol.ts";
import { callTool, tools } from "../src/tools.ts";
import { FakeObs } from "./fake-obs.ts";

function offlineClient(): ObsClient {
  return new ObsClient({
    url: "ws://127.0.0.1:1",
    maxAttempts: 1,
    retryBaseMs: 1,
    handshakeTimeoutMs: 50,
    requestTimeoutMs: 50,
  });
}

async function withObs(fn: (obs: FakeObs, client: ObsClient) => Promise<void>) {
  const obs = new FakeObs();
  await obs.start();
  const client = new ObsClient({
    url: obs.url,
    maxAttempts: 2,
    retryBaseMs: 10,
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

test("read tools are listed before write tools and every write defaults dry_run", () => {
  const readNames = ["obs_status", "obs_list_scenes", "obs_list_inputs", "obs_get_scene_items", "obs_list_transitions"];
  assert.deepEqual(tools.slice(0, readNames.length).map((tool) => tool.name), readNames);
  assert.equal(tools.length, 25);
  for (const tool of tools) {
    const schema = tool.inputSchema;
    const properties = schema.properties as Record<string, { default?: boolean }> | undefined;
    if (tool.annotations.readOnlyHint) {
      assert.equal(properties?.dry_run, undefined, tool.name);
    } else {
      assert.equal(properties?.dry_run?.default, true, tool.name);
    }
  }
});

test("dry_run returns the exact request and does not connect", async () => {
  const client = offlineClient();
  const result = await callTool("obs_set_current_scene", { scene_name: "Main" }, client);
  assert.deepEqual(result, {
    dry_run: true,
    requests: [{ requestType: "SetCurrentProgramScene", requestData: { sceneName: "Main" } }],
  });
  assert.equal(client.connectAttempts, 0);
  const omitted = await callTool("obs_stream", { action: "toggle" }, client);
  assert.equal((omitted as { dry_run: boolean }).dry_run, true);
  assert.deepEqual((omitted as { requests: unknown }).requests, [{ requestType: "ToggleStream" }]);
  assert.equal(client.connectAttempts, 0);
});

test("write tools name the obs-websocket requests they would send", async () => {
  const client = offlineClient();
  const cases: Array<{ name: string; args: Record<string, unknown>; requests: unknown }> = [
    {
      name: "obs_set_preview_scene",
      args: { scene_name: "Next" },
      requests: [{ requestType: "SetCurrentPreviewScene", requestData: { sceneName: "Next" } }],
    },
    {
      name: "obs_set_studio_mode",
      args: { enabled: true },
      requests: [{ requestType: "SetStudioModeEnabled", requestData: { studioModeEnabled: true } }],
    },
    {
      name: "obs_set_transition",
      args: { transition_name: "Fade", duration: 300 },
      requests: [
        { requestType: "SetCurrentSceneTransition", requestData: { transitionName: "Fade" } },
        { requestType: "SetCurrentSceneTransitionDuration", requestData: { transitionDuration: 300 } },
      ],
    },
    {
      name: "obs_trigger_studio_transition",
      args: {},
      requests: [{ requestType: "TriggerStudioModeTransition" }],
    },
    {
      name: "obs_set_input_mute",
      args: { input_name: "Mic", muted: true },
      requests: [{ requestType: "SetInputMute", requestData: { inputName: "Mic", inputMuted: true } }],
    },
    {
      name: "obs_set_input_volume",
      args: { input_uuid: "abc", volume_db: -6 },
      requests: [{ requestType: "SetInputVolume", requestData: { inputUuid: "abc", inputVolumeDb: -6 } }],
    },
    {
      name: "obs_set_scene_item_enabled",
      args: { scene_name: "Main", scene_item_id: 3, enabled: false },
      requests: [{ requestType: "SetSceneItemEnabled", requestData: { sceneName: "Main", sceneItemId: 3, sceneItemEnabled: false } }],
    },
    {
      name: "obs_set_source_filter_enabled",
      args: { source_name: "Camera", filter_name: "Color", enabled: true },
      requests: [{ requestType: "SetSourceFilterEnabled", requestData: { sourceName: "Camera", filterName: "Color", filterEnabled: true } }],
    },
    { name: "obs_stream", args: { action: "start" }, requests: [{ requestType: "StartStream" }] },
    { name: "obs_stream", args: { action: "stop" }, requests: [{ requestType: "StopStream" }] },
    { name: "obs_record", args: { action: "pause" }, requests: [{ requestType: "PauseRecord" }] },
    { name: "obs_record", args: { action: "resume" }, requests: [{ requestType: "ResumeRecord" }] },
    { name: "obs_replay_buffer", args: { action: "save" }, requests: [{ requestType: "SaveReplayBuffer" }] },
    { name: "obs_virtualcam", args: { action: "toggle" }, requests: [{ requestType: "ToggleVirtualCam" }] },
  ];
  for (const entry of cases) {
    const result = await callTool(entry.name, entry.args, client) as { dry_run: boolean; requests: unknown };
    assert.equal(result.dry_run, true, entry.name);
    assert.deepEqual(result.requests, entry.requests, entry.name);
  }
  assert.equal(client.connectAttempts, 0);
});

test("dry_run false sends the program-scene request", async () => {
  await withObs(async (obs, client) => {
    const result = await callTool("obs_set_current_scene", { scene_name: "Main", dry_run: false }, client) as {
      dry_run: boolean;
      requests: Array<{ requestType: string }>;
    };
    assert.equal(result.dry_run, false);
    assert.equal(result.requests[0].requestType, "SetCurrentProgramScene");
    const sent = obs.received.find((message) => message.op === 6);
    assert.equal(sent?.d.requestType, "SetCurrentProgramScene");
    assert.deepEqual(sent?.d.requestData, { sceneName: "Main" });
  });
});

test("batch dry_run redacts stream keys and a live batch sends the original key", async () => {
  const secret = "super-secret-stream-key";
  const offline = offlineClient();
  const preview = await callTool("obs_batch", {
    requests: [{
      requestType: "SetStreamServiceSettings",
      requestData: {
        streamServiceType: "rtmp_custom",
        streamServiceSettings: { server: "rtmp://example.test/live", key: secret },
      },
    }],
  }, offline) as { dry_run: boolean; requests: unknown[] };
  assert.equal(preview.dry_run, true);
  assert.equal(payloadContains(preview, secret), false);
  assert.equal(payloadContains(preview, "rtmp://example.test/live"), true);
  assert.equal(payloadContains(preview, "[REDACTED]"), true);
  const wire = preview.requests[0] as { op: number; d: { executionType: number; haltOnFailure: boolean } };
  assert.equal(wire.op, 8);
  assert.equal(wire.d.executionType, 0);
  assert.equal(wire.d.haltOnFailure, false);
  assert.equal(offline.connectAttempts, 0);

  await withObs(async (obs, client) => {
    obs.setHandler("GetStreamServiceSettings", () => ({
      responseData: {
        streamServiceType: "rtmp_custom",
        streamServiceSettings: { server: "rtmp://example.test/live", key: secret, password: "ingest-password" },
      },
    }));
    const live = await callTool("obs_batch", {
      dry_run: false,
      requests: [
        {
          requestType: "SetStreamServiceSettings",
          requestData: {
            streamServiceType: "rtmp_custom",
            streamServiceSettings: { server: "rtmp://example.test/live", key: secret },
          },
        },
        { requestType: "GetStreamServiceSettings" },
      ],
    }, client);
    assert.equal(payloadContains(live, secret), false);
    assert.equal(payloadContains(live, "ingest-password"), false);
    const sent = obs.received.find((message) => message.op === 8);
    assert.equal(payloadContains(sent, secret), true);
  });
});

test("status, lists, and mapped errors use the fake server", async () => {
  await withObs(async (obs, client) => {
    obs.setHandler("GetVersion", () => ({
      responseData: { obsVersion: "30.2.2", obsWebSocketVersion: "5.5.2", rpcVersion: 1, platform: "ubuntu", availableRequests: ["GetVersion"] },
    }));
    obs.setHandler("GetStreamStatus", () => ({ responseData: { outputActive: false, outputReconnecting: false } }));
    obs.setHandler("GetRecordStatus", () => ({ responseData: { outputActive: true, outputPaused: true } }));
    obs.setHandler("GetStudioModeEnabled", () => ({ responseData: { studioModeEnabled: false } }));
    obs.setHandler("GetCurrentProgramScene", () => ({ responseData: { sceneName: "Main", sceneUuid: "scene-1" } }));
    obs.setHandler("GetCurrentPreviewScene", () => ({ code: 506, comment: "studio mode" }));
    obs.setHandler("GetStats", () => ({ responseData: { cpuUsage: 3.5, activeFps: 60 } }));
    obs.setHandler("GetSceneList", () => ({
      responseData: { currentProgramSceneName: "Main", scenes: [{ sceneName: "Main", sceneUuid: "scene-1" }] },
    }));
    obs.setHandler("GetInputList", () => ({ responseData: { inputs: [{ inputName: "Mic", inputKind: "wasapi_input_capture" }] } }));
    obs.setHandler("GetSceneItemList", () => ({ responseData: { sceneItems: [{ sceneItemId: 1, sourceName: "Camera" }] } }));
    obs.setHandler("GetSceneTransitionList", () => ({
      responseData: { currentSceneTransitionName: "Fade", transitions: [{ transitionName: "Fade" }] },
    }));
    obs.setHandler("GetCurrentSceneTransition", () => ({
      responseData: { transitionName: "Fade", transitionDuration: 300 },
    }));
    obs.setHandler("SetInputMute", () => ({ code: 600, comment: "inputName" }));

    const status = await callTool("obs_status", {}, client) as {
      version: { obsVersion: string; availableRequests?: unknown };
      programScene: { sceneName: string };
      previewScene: unknown;
      studioModeEnabled: boolean;
      record: { outputPaused: boolean };
    };
    assert.equal(status.version.obsVersion, "30.2.2");
    assert.equal(status.version.availableRequests, undefined);
    assert.equal(status.programScene.sceneName, "Main");
    assert.equal(status.previewScene, null);
    assert.equal(status.studioModeEnabled, false);
    assert.equal(status.record.outputPaused, true);

    const scenes = await callTool("obs_list_scenes", {}, client) as { scenes: unknown[] };
    assert.equal(scenes.scenes.length, 1);
    const inputs = await callTool("obs_list_inputs", { input_kind: "wasapi_input_capture" }, client);
    assert.equal((inputs as { inputs: unknown[] }).inputs.length, 1);
    const sentInputs = obs.received.filter((message) => message.d.requestType === "GetInputList");
    assert.deepEqual(sentInputs.at(-1)?.d.requestData, { inputKind: "wasapi_input_capture" });
    const items = await callTool("obs_get_scene_items", { scene_name: "Main" }, client) as { sceneItems: unknown[] };
    assert.equal(items.sceneItems.length, 1);
    const transitions = await callTool("obs_list_transitions", {}, client) as { currentTransition: { transitionDuration: number } };
    assert.equal(transitions.currentTransition.transitionDuration, 300);

    await assert.rejects(
      () => callTool("obs_set_input_mute", { input_name: "Missing", muted: false, dry_run: false }, client),
      /600 The resource was not found/,
    );
  });
});

test("scene collection backup dry-run skips OBS and a live backup writes redacted JSON", async () => {
  const offline = offlineClient();
  const preview = await callTool("obs_backup_scene_collection", {}, offline) as { dry_run: boolean; requests: Array<{ requestType: string }> };
  assert.equal(preview.dry_run, true);
  assert.deepEqual(preview.requests.map((item) => item.requestType), [
    "GetVersion",
    "GetSceneList",
    "GetGroupList",
    "GetSceneTransitionList",
    "GetCurrentSceneTransition",
    "GetSceneItemList",
    "GetGroupSceneItemList",
  ]);
  assert.equal(offline.connectAttempts, 0);

  const directory = await mkdtemp(path.join(tmpdir(), "obs-mcp-"));
  const destination = path.join(directory, "backup.json");
  try {
    await withObs(async (obs, client) => {
      obs.setHandler("GetVersion", () => ({ responseData: { obsVersion: "30.2.2", rpcVersion: 1 } }));
      obs.setHandler("GetSceneList", () => ({
        responseData: { scenes: [{ sceneName: "Main", sceneUuid: "scene-1" }, { sceneName: "Break", sceneUuid: "scene-2" }] },
      }));
      obs.setHandler("GetGroupList", () => ({ responseData: { groups: ["Lower Third"] } }));
      obs.setHandler("GetSceneTransitionList", () => ({ responseData: { transitions: [{ transitionName: "Cut" }] } }));
      obs.setHandler("GetCurrentSceneTransition", () => ({ responseData: { transitionName: "Cut", transitionDuration: null } }));
      obs.setHandler("GetSceneItemList", (requestData) => ({
        responseData: {
          sceneItems: [{
            sceneItemId: 1,
            sourceName: requestData?.sceneName,
            streamServiceSettings: { server: "rtmp://example.test/live", key: "backup-secret" },
          }],
        },
      }));
      obs.setHandler("GetGroupSceneItemList", () => ({ responseData: { sceneItems: [{ sceneItemId: 9, sourceName: "Logo" }] } }));
      const written = await callTool("obs_backup_scene_collection", { path: destination, dry_run: false }, client) as {
        result: { scenes: number; groups: number };
      };
      assert.equal(written.result.scenes, 2);
      assert.equal(written.result.groups, 1);
      const file = JSON.parse(await readFile(destination, "utf8")) as {
        backupVersion: number;
        sceneItems: Record<string, Array<{ streamServiceSettings: { key: string; server: string } }>>;
        groupItems: Record<string, unknown[]>;
        transitions: { transitions: unknown[] };
      };
      assert.equal(file.backupVersion, 1);
      assert.equal(file.sceneItems.Main[0].streamServiceSettings.server, "rtmp://example.test/live");
      assert.equal(file.sceneItems.Main[0].streamServiceSettings.key, "[REDACTED]");
      assert.equal(file.groupItems["Lower Third"].length, 1);
      assert.equal(file.transitions.transitions.length, 1);
      assert.equal((await readFile(destination, "utf8")).includes("backup-secret"), false);
      await assert.rejects(
        () => callTool("obs_backup_scene_collection", { path: destination, dry_run: false }, client),
        /already exists/,
      );
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
