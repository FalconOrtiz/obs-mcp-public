import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ObsClient } from "./client.ts";
import { recipeTools } from "./recipes.ts";
import {
  BatchExecution,
  ObsRequestError,
  redactObsPayload,
  type ObsRequest,
  type ObsResult,
} from "./protocol.ts";

type Args = Record<string, unknown>;
type Handler = (args: Args, client: ObsClient) => Promise<unknown>;

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  handler: Handler;
};

const dryRunProperty = {
  type: "boolean",
  default: true,
  description: "When true (the default), return the obs-websocket request and do not send it. Set false to apply the change.",
};

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function readDryRun(args: Args): boolean {
  if (args.dry_run === undefined) return true;
  if (typeof args.dry_run !== "boolean") throw new Error("dry_run must be a boolean");
  return args.dry_run;
}

function assertKeys(args: Args, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new Error(`Unknown argument: ${key}`);
  }
}

function optionalString(args: Args, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function requireString(args: Args, key: string): string {
  const value = optionalString(args, key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function requireBoolean(args: Args, key: string): boolean {
  if (typeof args[key] !== "boolean") throw new Error(`${key} must be a boolean`);
  return args[key] as boolean;
}

function requireInteger(args: Args, key: string, min: number, max: number): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function optionalNumber(args: Args, key: string, min: number, max: number): number | undefined {
  if (args[key] === undefined) return undefined;
  const value = args[key];
  if (typeof value !== "number" || Number.isNaN(value) || value < min || value > max) {
    throw new Error(`${key} must be a number from ${min} to ${max}`);
  }
  return value;
}

function oneIdentity(args: Args, nameKey: string, uuidKey: string, obsName: string, obsUuid: string): Record<string, string> {
  const name = optionalString(args, nameKey);
  const uuid = optionalString(args, uuidKey);
  if (!name && !uuid) throw new Error(`Provide ${nameKey} or ${uuidKey}`);
  if (name && uuid) throw new Error(`Provide only one of ${nameKey} or ${uuidKey}`);
  return name ? { [obsName]: name } : { [obsUuid]: uuid as string };
}

function request(requestType: string, requestData?: Record<string, unknown>): ObsRequest {
  if (requestData && Object.keys(requestData).length > 0) return { requestType, requestData };
  return { requestType };
}

async function runWrite(args: Args, client: ObsClient, requests: ObsRequest[], execute: () => Promise<unknown>): Promise<unknown> {
  const shown = redactObsPayload(requests);
  if (readDryRun(args)) return { dry_run: true, requests: shown };
  const result = redactObsPayload(await execute());
  return { dry_run: false, requests: shown, result };
}

function unwrap(result: ObsResult | undefined, requestType: string, optionalCodes: number[] = []): Record<string, unknown> | null {
  if (!result) throw new ObsRequestError(requestType, 0, "missing batch result");
  if (result.requestStatus?.result === true) return result.responseData ?? {};
  const code = result.requestStatus?.code ?? 0;
  if (optionalCodes.includes(code)) return null;
  throw new ObsRequestError(requestType, code, result.requestStatus?.comment);
}

const STREAM_ACTIONS: Record<string, string> = {
  start: "StartStream",
  stop: "StopStream",
  toggle: "ToggleStream",
};

const RECORD_ACTIONS: Record<string, string> = {
  start: "StartRecord",
  stop: "StopRecord",
  pause: "PauseRecord",
  resume: "ResumeRecord",
};

const REPLAY_ACTIONS: Record<string, string> = {
  start: "StartReplayBuffer",
  stop: "StopReplayBuffer",
  save: "SaveReplayBuffer",
};

const VIRTUALCAM_ACTIONS: Record<string, string> = {
  start: "StartVirtualCam",
  stop: "StopVirtualCam",
  toggle: "ToggleVirtualCam",
};

const BATCH_EXECUTION: Record<string, number> = {
  serial_realtime: BatchExecution.SerialRealtime,
  serial_frame: BatchExecution.SerialFrame,
  parallel: BatchExecution.Parallel,
};

function actionRequest(args: Args, actions: Record<string, string>, allowed: readonly string[]): ObsRequest[] {
  assertKeys(args, allowed);
  const action = requireString(args, "action");
  const requestType = actions[action];
  if (!requestType) throw new Error(`action must be one of: ${Object.keys(actions).join(", ")}`);
  readDryRun(args);
  return [request(requestType)];
}

const identityPair = (name: string, uuid: string) => ({
  [name]: { type: "string", description: `OBS ${name}. Provide this or ${uuid}.` },
  [uuid]: { type: "string", description: `OBS ${uuid}. Provide this or ${name}.` },
});

export const tools: ToolDefinition[] = [
  {
    name: "obs_status",
    description: "Read OBS version, stream status, record status, studio mode, program scene, preview scene, and stats. Does not return stream service settings.",
    inputSchema: objectSchema({}),
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: async (args, client) => {
      assertKeys(args, []);
      const requests: ObsRequest[] = [
        request("GetVersion"),
        request("GetStreamStatus"),
        request("GetRecordStatus"),
        request("GetStudioModeEnabled"),
        request("GetCurrentProgramScene"),
        request("GetCurrentPreviewScene"),
        request("GetStats"),
      ];
      const results = await client.batch(requests, { haltOnFailure: false });
      const version = unwrap(results[0], "GetVersion");
      const stream = unwrap(results[1], "GetStreamStatus");
      const record = unwrap(results[2], "GetRecordStatus");
      const studio = unwrap(results[3], "GetStudioModeEnabled");
      const program = unwrap(results[4], "GetCurrentProgramScene");
      const preview = unwrap(results[5], "GetCurrentPreviewScene", [505, 506]);
      const stats = unwrap(results[6], "GetStats");
      return {
        version: pick(version, ["obsVersion", "obsWebSocketVersion", "rpcVersion", "platform", "platformDescription"]),
        stream,
        record,
        studioModeEnabled: studio?.studioModeEnabled === true,
        programScene: pick(program, ["sceneName", "sceneUuid"]),
        previewScene: preview ? pick(preview, ["sceneName", "sceneUuid"]) : null,
        stats,
      };
    },
  },
  {
    name: "obs_list_scenes",
    description: "List scenes (GetSceneList), including the current program and preview scene names.",
    inputSchema: objectSchema({}),
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: async (args, client) => {
      assertKeys(args, []);
      return client.request("GetSceneList");
    },
  },
  {
    name: "obs_list_inputs",
    description: "List inputs (GetInputList). Optional input_kind limits the list to one kind.",
    inputSchema: objectSchema({
      input_kind: { type: "string", description: "Optional OBS input kind filter." },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: async (args, client) => {
      assertKeys(args, ["input_kind"]);
      const inputKind = optionalString(args, "input_kind");
      return client.request("GetInputList", inputKind ? { inputKind } : undefined);
    },
  },
  {
    name: "obs_get_scene_items",
    description: "List scene items in one scene (GetSceneItemList). Provide scene_name or scene_uuid.",
    inputSchema: objectSchema(identityPair("scene_name", "scene_uuid")),
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: async (args, client) => {
      assertKeys(args, ["scene_name", "scene_uuid"]);
      const identity = oneIdentity(args, "scene_name", "scene_uuid", "sceneName", "sceneUuid");
      return client.request("GetSceneItemList", identity);
    },
  },
  {
    name: "obs_list_transitions",
    description: "List scene transitions (GetSceneTransitionList) and the current transition, including duration (GetCurrentSceneTransition).",
    inputSchema: objectSchema({}),
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: async (args, client) => {
      assertKeys(args, []);
      const results = await client.batch([request("GetSceneTransitionList"), request("GetCurrentSceneTransition")], {
        haltOnFailure: false,
      });
      const list = unwrap(results[0], "GetSceneTransitionList");
      const current = unwrap(results[1], "GetCurrentSceneTransition");
      return { ...list, currentTransition: current };
    },
  },
  {
    name: "obs_set_current_scene",
    description: "Set the program scene (SetCurrentProgramScene). dry_run defaults to true.",
    inputSchema: objectSchema(
      { ...identityPair("scene_name", "scene_uuid"), dry_run: dryRunProperty },
    ),
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (args, client) => {
      assertKeys(args, ["scene_name", "scene_uuid", "dry_run"]);
      const identity = oneIdentity(args, "scene_name", "scene_uuid", "sceneName", "sceneUuid");
      const requests = [request("SetCurrentProgramScene", identity)];
      return runWrite(args, client, requests, () => client.request("SetCurrentProgramScene", identity));
    },
  },
  {
    name: "obs_set_preview_scene",
    description: "Set the preview scene (SetCurrentPreviewScene). Studio mode must already be on. dry_run defaults to true.",
    inputSchema: objectSchema({ ...identityPair("scene_name", "scene_uuid"), dry_run: dryRunProperty }),
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (args, client) => {
      assertKeys(args, ["scene_name", "scene_uuid", "dry_run"]);
      const identity = oneIdentity(args, "scene_name", "scene_uuid", "sceneName", "sceneUuid");
      const requests = [request("SetCurrentPreviewScene", identity)];
      return runWrite(args, client, requests, () => client.request("SetCurrentPreviewScene", identity));
    },
  },
  {
    name: "obs_set_studio_mode",
    description: "Enable or disable studio mode (SetStudioModeEnabled). dry_run defaults to true.",
    inputSchema: objectSchema(
      {
        enabled: { type: "boolean", description: "True enables studio mode." },
        dry_run: dryRunProperty,
      },
      ["enabled"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (args, client) => {
      assertKeys(args, ["enabled", "dry_run"]);
      const studioModeEnabled = requireBoolean(args, "enabled");
      const requests = [request("SetStudioModeEnabled", { studioModeEnabled })];
      return runWrite(args, client, requests, () => client.request("SetStudioModeEnabled", { studioModeEnabled }));
    },
  },
  {
    name: "obs_set_transition",
    description: "Set the current transition by name (SetCurrentSceneTransition) and optionally its duration in milliseconds (SetCurrentSceneTransitionDuration, 50-20000). Provide name, duration, or both. dry_run defaults to true.",
    inputSchema: objectSchema({
      transition_name: { type: "string" },
      duration: { type: "number", description: "Duration in milliseconds, from 50 to 20000." },
      dry_run: dryRunProperty,
    }),
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (args, client) => {
      assertKeys(args, ["transition_name", "duration", "dry_run"]);
      const transitionName = optionalString(args, "transition_name");
      const duration = optionalNumber(args, "duration", 50, 20000);
      if (!transitionName && duration === undefined) throw new Error("Provide transition_name, duration, or both");
      const requests: ObsRequest[] = [];
      if (transitionName) requests.push(request("SetCurrentSceneTransition", { transitionName }));
      if (duration !== undefined) requests.push(request("SetCurrentSceneTransitionDuration", { transitionDuration: duration }));
      return runWrite(args, client, requests, async () => {
        if (requests.length === 1) {
          const only = requests[0];
          return client.request(only.requestType, only.requestData);
        }
        return client.batch(requests, { haltOnFailure: true });
      });
    },
  },
  {
    name: "obs_trigger_studio_transition",
    description: "Trigger the studio mode transition (TriggerStudioModeTransition). dry_run defaults to true.",
    inputSchema: objectSchema({ dry_run: dryRunProperty }),
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (args, client) => {
      assertKeys(args, ["dry_run"]);
      const requests = [request("TriggerStudioModeTransition")];
      return runWrite(args, client, requests, () => client.request("TriggerStudioModeTransition"));
    },
  },
  {
    name: "obs_set_input_mute",
    description: "Mute or unmute an input (SetInputMute). Provide input_name or input_uuid. dry_run defaults to true.",
    inputSchema: objectSchema(
      {
        ...identityPair("input_name", "input_uuid"),
        muted: { type: "boolean" },
        dry_run: dryRunProperty,
      },
      ["muted"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (args, client) => {
      assertKeys(args, ["input_name", "input_uuid", "muted", "dry_run"]);
      const identity = oneIdentity(args, "input_name", "input_uuid", "inputName", "inputUuid");
      const inputMuted = requireBoolean(args, "muted");
      const data = { ...identity, inputMuted };
      const requests = [request("SetInputMute", data)];
      return runWrite(args, client, requests, () => client.request("SetInputMute", data));
    },
  },
  {
    name: "obs_set_input_volume",
    description: "Set input volume (SetInputVolume). Provide exactly one of volume_db (-100 to 26) or volume_mul (0 to 20), plus input_name or input_uuid. dry_run defaults to true.",
    inputSchema: objectSchema({
      ...identityPair("input_name", "input_uuid"),
      volume_db: { type: "number", description: "Decibels, from -100 to 26." },
      volume_mul: { type: "number", description: "Multiplier, from 0 to 20." },
      dry_run: dryRunProperty,
    }),
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (args, client) => {
      assertKeys(args, ["input_name", "input_uuid", "volume_db", "volume_mul", "dry_run"]);
      const identity = oneIdentity(args, "input_name", "input_uuid", "inputName", "inputUuid");
      const hasDb = args.volume_db !== undefined;
      const hasMul = args.volume_mul !== undefined;
      if (hasDb === hasMul) throw new Error("Provide exactly one of volume_db or volume_mul");
      const data = { ...identity };
      if (hasDb) data.inputVolumeDb = optionalNumber(args, "volume_db", -100, 26);
      if (hasMul) data.inputVolumeMul = optionalNumber(args, "volume_mul", 0, 20);
      const requests = [request("SetInputVolume", data)];
      return runWrite(args, client, requests, () => client.request("SetInputVolume", data));
    },
  },
  {
    name: "obs_set_scene_item_enabled",
    description: "Show or hide a scene item (SetSceneItemEnabled). dry_run defaults to true.",
    inputSchema: objectSchema(
      {
        ...identityPair("scene_name", "scene_uuid"),
        scene_item_id: { type: "integer", minimum: 0 },
        enabled: { type: "boolean" },
        dry_run: dryRunProperty,
      },
      ["scene_item_id", "enabled"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (args, client) => {
      assertKeys(args, ["scene_name", "scene_uuid", "scene_item_id", "enabled", "dry_run"]);
      const identity = oneIdentity(args, "scene_name", "scene_uuid", "sceneName", "sceneUuid");
      const sceneItemId = requireInteger(args, "scene_item_id", 0, 1_000_000_000);
      const sceneItemEnabled = requireBoolean(args, "enabled");
      const data = { ...identity, sceneItemId, sceneItemEnabled };
      const requests = [request("SetSceneItemEnabled", data)];
      return runWrite(args, client, requests, () => client.request("SetSceneItemEnabled", data));
    },
  },
  {
    name: "obs_set_source_filter_enabled",
    description: "Enable or disable a source filter (SetSourceFilterEnabled). dry_run defaults to true.",
    inputSchema: objectSchema(
      {
        ...identityPair("source_name", "source_uuid"),
        filter_name: { type: "string" },
        enabled: { type: "boolean" },
        dry_run: dryRunProperty,
      },
      ["filter_name", "enabled"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (args, client) => {
      assertKeys(args, ["source_name", "source_uuid", "filter_name", "enabled", "dry_run"]);
      const identity = oneIdentity(args, "source_name", "source_uuid", "sourceName", "sourceUuid");
      const filterName = requireString(args, "filter_name");
      const filterEnabled = requireBoolean(args, "enabled");
      const data = { ...identity, filterName, filterEnabled };
      const requests = [request("SetSourceFilterEnabled", data)];
      return runWrite(args, client, requests, () => client.request("SetSourceFilterEnabled", data));
    },
  },
  {
    name: "obs_stream",
    description: "Start, stop, or toggle the stream (StartStream, StopStream, ToggleStream). Does not read or set the stream key. dry_run defaults to true.",
    inputSchema: objectSchema(
      {
        action: { type: "string", enum: ["start", "stop", "toggle"] },
        dry_run: dryRunProperty,
      },
      ["action"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (args, client) => {
      const requests = actionRequest(args, STREAM_ACTIONS, ["action", "dry_run"]);
      return runWrite(args, client, requests, () => client.request(requests[0].requestType));
    },
  },
  {
    name: "obs_record",
    description: "Start, stop, pause, or resume recording (StartRecord, StopRecord, PauseRecord, ResumeRecord). dry_run defaults to true.",
    inputSchema: objectSchema(
      {
        action: { type: "string", enum: ["start", "stop", "pause", "resume"] },
        dry_run: dryRunProperty,
      },
      ["action"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (args, client) => {
      const requests = actionRequest(args, RECORD_ACTIONS, ["action", "dry_run"]);
      return runWrite(args, client, requests, () => client.request(requests[0].requestType));
    },
  },
  {
    name: "obs_replay_buffer",
    description: "Start, stop, or save the replay buffer (StartReplayBuffer, StopReplayBuffer, SaveReplayBuffer). dry_run defaults to true.",
    inputSchema: objectSchema(
      {
        action: { type: "string", enum: ["start", "stop", "save"] },
        dry_run: dryRunProperty,
      },
      ["action"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (args, client) => {
      const requests = actionRequest(args, REPLAY_ACTIONS, ["action", "dry_run"]);
      return runWrite(args, client, requests, () => client.request(requests[0].requestType));
    },
  },
  {
    name: "obs_virtualcam",
    description: "Start, stop, or toggle the virtual camera (StartVirtualCam, StopVirtualCam, ToggleVirtualCam). dry_run defaults to true.",
    inputSchema: objectSchema(
      {
        action: { type: "string", enum: ["start", "stop", "toggle"] },
        dry_run: dryRunProperty,
      },
      ["action"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (args, client) => {
      const requests = actionRequest(args, VIRTUALCAM_ACTIONS, ["action", "dry_run"]);
      return runWrite(args, client, requests, () => client.request(requests[0].requestType));
    },
  },
  {
    name: "obs_batch",
    description: "Send a raw obs-websocket RequestBatch (opcode 8). Each item needs requestType and may include requestData. execution_type is serial_realtime (default), serial_frame, or parallel. Responses redact streamServiceSettings key fields. dry_run defaults to true.",
    inputSchema: objectSchema(
      {
        requests: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: objectSchema({
            requestType: { type: "string" },
            requestId: { type: "string" },
            requestData: { type: "object" },
          }, ["requestType"]),
        },
        halt_on_failure: { type: "boolean", default: false },
        execution_type: { type: "string", enum: ["serial_realtime", "serial_frame", "parallel"], default: "serial_realtime" },
        dry_run: dryRunProperty,
      },
      ["requests"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (args, client) => {
      assertKeys(args, ["requests", "halt_on_failure", "execution_type", "dry_run"]);
      const requests = parseBatchRequests(args.requests);
      const haltOnFailure = args.halt_on_failure === undefined ? false : requireBoolean(args, "halt_on_failure");
      const executionName = args.execution_type === undefined ? "serial_realtime" : requireString(args, "execution_type");
      const executionType = BATCH_EXECUTION[executionName];
      if (executionType === undefined) {
        throw new Error("execution_type must be serial_realtime, serial_frame, or parallel");
      }
      const wire = {
        op: 8,
        d: {
          haltOnFailure,
          executionType,
          requests: requests.map((item) => {
            const entry: Record<string, unknown> = { requestType: item.requestType };
            if (item.requestId) entry.requestId = item.requestId;
            if (item.requestData) entry.requestData = item.requestData;
            return entry;
          }),
        },
      };
      const shown = redactObsPayload(wire);
      if (readDryRun(args)) return { dry_run: true, requests: [shown] };
      const results = await client.batch(requests, { haltOnFailure, executionType });
      return { dry_run: false, requests: [shown], result: results };
    },
  },
  {
    name: "obs_backup_scene_collection",
    description: "Read scenes, scene items, groups, and transitions, then write them to a JSON file. Use this before scene or item edits. dry_run defaults to true and does not connect or write a file. The second-wave item requests depend on the scene and group names OBS returns.",
    inputSchema: objectSchema({
      path: { type: "string", description: "Destination JSON file. Required when dry_run is false." },
      overwrite: { type: "boolean", default: false },
      dry_run: dryRunProperty,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: backupSceneCollection,
  },
  ...recipeTools,
];

export const backupPlan: ObsRequest[] = [
  request("GetVersion"),
  request("GetSceneList"),
  request("GetGroupList"),
  request("GetSceneTransitionList"),
  request("GetCurrentSceneTransition"),
  request("GetSceneItemList", { sceneName: "<scene name from GetSceneList>" }),
  request("GetGroupSceneItemList", { sceneName: "<group name from GetGroupList>" }),
];

export async function backupSceneCollection(args: Args, client: ObsClient): Promise<unknown> {
  assertKeys(args, ["path", "overwrite", "dry_run"]);
  const dry = readDryRun(args);
  const overwrite = args.overwrite === undefined ? false : requireBoolean(args, "overwrite");
  if (dry) {
    return {
      dry_run: true,
      requests: backupPlan,
      note: "GetSceneItemList is sent once per scene from GetSceneList. GetGroupSceneItemList is sent once per group from GetGroupList. No file is written and OBS is not contacted.",
    };
  }
  const filePath = requireString(args, "path");
  if (filePath.includes("\0")) throw new Error("path contains a NUL byte");
  const destination = path.resolve(filePath);
  const first = await client.batch(backupPlan.slice(0, 5), { haltOnFailure: false });
  const version = unwrap(first[0], "GetVersion");
  const sceneList = unwrap(first[1], "GetSceneList") ?? {};
  const groupList = unwrap(first[2], "GetGroupList") ?? {};
  const transitions = unwrap(first[3], "GetSceneTransitionList");
  const currentTransition = unwrap(first[4], "GetCurrentSceneTransition");
  const scenes = Array.isArray(sceneList.scenes) ? sceneList.scenes : [];
  const groups = Array.isArray(groupList.groups) ? groupList.groups : [];
  const itemRequests: ObsRequest[] = [];
  for (const scene of scenes) {
    if (!scene || typeof scene !== "object") continue;
    const identity = sceneIdentity(scene as Record<string, unknown>);
    if (identity) itemRequests.push(request("GetSceneItemList", identity));
  }
  for (const group of groups) {
    if (typeof group === "string" && group.length > 0) itemRequests.push(request("GetGroupSceneItemList", { sceneName: group }));
  }
  const itemResults = itemRequests.length > 0 ? await client.batch(itemRequests, { haltOnFailure: true }) : [];
  for (let index = 0; index < itemRequests.length; index++) {
    unwrap(itemResults[index], itemRequests[index].requestType);
  }
  const sceneItems: Record<string, unknown> = {};
  const groupItems: Record<string, unknown> = {};
  itemRequests.forEach((item, index) => {
    const data = itemResults[index]?.responseData ?? {};
    const key = String(item.requestData?.sceneName ?? item.requestData?.sceneUuid ?? index);
    if (item.requestType === "GetSceneItemList") sceneItems[key] = data.sceneItems ?? [];
    else groupItems[key] = data.sceneItems ?? [];
  });
  const body = redactObsPayload({
    backupVersion: 1,
    createdAt: new Date().toISOString(),
    obs: pick(version, ["obsVersion", "obsWebSocketVersion", "rpcVersion", "platform", "platformDescription"]),
    sceneList,
    groups: groupList.groups ?? [],
    sceneItems,
    groupItems,
    transitions,
    currentTransition,
  });
  const json = `${JSON.stringify(body, null, 2)}\n`;
  await mkdir(path.dirname(destination), { recursive: true });
  if (!overwrite) {
    try {
      await writeFile(destination, json, { flag: "wx" });
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        throw new Error(`Backup file already exists: ${destination}. Pass overwrite true to replace it.`);
      }
      throw error;
    }
  } else {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, json, { flag: "wx" });
    try {
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  return {
    dry_run: false,
    requests: [...backupPlan.slice(0, 5), ...itemRequests],
    result: { path: destination, scenes: scenes.length, groups: groups.length },
  };
}

function sceneIdentity(scene: Record<string, unknown>): Record<string, string> | null {
  if (typeof scene.sceneName === "string" && scene.sceneName.length > 0) return { sceneName: scene.sceneName };
  if (typeof scene.sceneUuid === "string" && scene.sceneUuid.length > 0) return { sceneUuid: scene.sceneUuid };
  return null;
}

function parseBatchRequests(value: unknown): ObsRequest[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("requests must be a non-empty array");
  if (value.length > 100) throw new Error("requests is limited to 100 items");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`requests[${index}] must be an object`);
    const record = item as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== "requestType" && key !== "requestId" && key !== "requestData") {
        throw new Error(`requests[${index}] has unknown field ${key}`);
      }
    }
    if (typeof record.requestType !== "string" || record.requestType.length === 0) {
      throw new Error(`requests[${index}].requestType must be a non-empty string`);
    }
    const parsed: ObsRequest = { requestType: record.requestType };
    if (record.requestId !== undefined) {
      if (typeof record.requestId !== "string" || record.requestId.length === 0) {
        throw new Error(`requests[${index}].requestId must be a non-empty string`);
      }
      parsed.requestId = record.requestId;
    }
    if (record.requestData !== undefined) {
      if (!record.requestData || typeof record.requestData !== "object" || Array.isArray(record.requestData)) {
        throw new Error(`requests[${index}].requestData must be an object`);
      }
      parsed.requestData = record.requestData as Record<string, unknown>;
    }
    return parsed;
  });
}

function pick(source: Record<string, unknown> | null, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!source) return out;
  for (const key of keys) {
    if (key in source) out[key] = source[key];
  }
  return out;
}

export function listToolDescriptors(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
}> {
  return tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
}

export async function callTool(name: string, args: Args | undefined, client: ObsClient): Promise<unknown> {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.handler(args ?? {}, client);
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) return String(error.code);
  return "";
}
