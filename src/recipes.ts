import type { ObsClient } from "./client.ts";
import { redactObsPayload, type ObsRequest } from "./protocol.ts";

type Args = Record<string, unknown>;

const dryRunProperty = {
  type: "boolean",
  default: true,
  description: "When true (the default), return the requests and do not change OBS. Set false to back up the scene collection and then apply.",
};

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function assertKeys(args: Args, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new Error(`Unknown argument: ${key}`);
  }
}

function readDryRun(args: Args): boolean {
  if (args.dry_run === undefined) return true;
  if (typeof args.dry_run !== "boolean") throw new Error("dry_run must be a boolean");
  return args.dry_run;
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

function optionalBoolean(args: Args, key: string, fallback: boolean): boolean {
  if (args[key] === undefined) return fallback;
  if (typeof args[key] !== "boolean") throw new Error(`${key} must be a boolean`);
  return args[key] as boolean;
}

function optionalNumber(args: Args, key: string, min: number, max: number, fallback: number): number {
  if (args[key] === undefined) return fallback;
  const value = args[key];
  if (typeof value !== "number" || Number.isNaN(value) || value < min || value > max) {
    throw new Error(`${key} must be a number from ${min} to ${max}`);
  }
  return value;
}

function request(requestType: string, requestData?: Record<string, unknown>): ObsRequest {
  if (requestData && Object.keys(requestData).length > 0) return { requestType, requestData };
  return { requestType };
}

export const SCENE_PACK = ["Starting", "Live", "BRB", "Ending"] as const;
export const CELEBRATION_SCENE = "Celebration";

/** OBS filter ids from obs-filters. Settings use the plugin's property names. */
export const MIC_CHAIN = [
  {
    filterName: "Noise Suppression",
    filterKind: "noise_suppress_filter",
    filterSettings: { method: "rnnoise" },
  },
  {
    filterName: "Noise Gate",
    filterKind: "noise_gate_filter",
    filterSettings: {
      open_threshold: -26,
      close_threshold: -32,
      attack_time: 25,
      hold_time: 200,
      release_time: 150,
    },
  },
  {
    filterName: "Compressor",
    filterKind: "compressor_filter",
    filterSettings: {
      ratio: 3,
      threshold: -18,
      attack_time: 6,
      release_time: 60,
      output_gain: 0,
    },
  },
  {
    filterName: "Limiter",
    filterKind: "limiter_filter",
    filterSettings: { threshold: -6, release_time: 60 },
  },
] as const;

const UNEXPANDED = new Set(["${OBS_STREAM_KEY}", "${env:OBS_STREAM_KEY}", "${OBS_STREAM_SERVER}", "${env:OBS_STREAM_SERVER}"]);

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw == null || raw.length === 0 || UNEXPANDED.has(raw)) return undefined;
  return raw;
}

async function backupFirst(args: Args, client: ObsClient): Promise<unknown> {
  const path = requireString(args, "backup_path");
  const overwrite = optionalBoolean(args, "overwrite", false);
  const tools = await import("./tools.ts");
  return tools.backupSceneCollection({ path, overwrite, dry_run: false }, client);
}

async function withBackup(
  args: Args,
  client: ObsClient,
  requests: ObsRequest[],
  apply: () => Promise<unknown>,
  extra: Record<string, unknown> = {},
): Promise<unknown> {
  const dry = readDryRun(args);
  const tools = await import("./tools.ts");
  if (dry) {
    return {
      dry_run: true,
      backup: tools.backupPlan,
      requests,
      note: "Apply writes the scene-collection backup first. CreateScene and CreateSourceFilter are skipped when that name already exists.",
      ...extra,
    };
  }
  const backup = await backupFirst(args, client);
  const result = await apply();
  return { dry_run: false, backup, requests, result, ...extra };
}

function sceneNames(list: Record<string, unknown>): Set<string> {
  const scenes = Array.isArray(list.scenes) ? list.scenes : [];
  const names = new Set<string>();
  for (const scene of scenes) {
    if (scene && typeof scene === "object" && typeof (scene as { sceneName?: unknown }).sceneName === "string") {
      names.add((scene as { sceneName: string }).sceneName);
    }
  }
  return names;
}

export const recipeTools = [
  {
    name: "obs_recipe_scene_pack",
    description: "Create the Starting, Live, BRB, and Ending scenes (CreateScene). Existing names are left in place. dry_run defaults to true. Apply requires backup_path and writes a scene-collection backup first.",
    inputSchema: objectSchema({
      backup_path: { type: "string", description: "Backup JSON path. Required when dry_run is false." },
      overwrite: { type: "boolean", default: false },
      dry_run: dryRunProperty,
    }),
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (args: Args, client: ObsClient) => {
      assertKeys(args, ["backup_path", "overwrite", "dry_run"]);
      const requests = SCENE_PACK.map((sceneName) => request("CreateScene", { sceneName }));
      return withBackup(args, client, requests, async () => {
        const list = await client.request("GetSceneList");
        const existing = sceneNames(list);
        const created: string[] = [];
        const skipped: string[] = [];
        for (const sceneName of SCENE_PACK) {
          if (existing.has(sceneName)) {
            skipped.push(sceneName);
            continue;
          }
          await client.request("CreateScene", { sceneName });
          created.push(sceneName);
        }
        return { created, skipped };
      });
    },
  },
  {
    name: "obs_recipe_transitions",
    description: "Set Fade at 300ms as the everyday transition (SetCurrentSceneTransition, SetCurrentSceneTransitionDuration). When stinger_path is set, configure that stinger (path, transition_point, fade out/in) and then return the current transition to Fade. dry_run defaults to true. Apply backs up first.",
    inputSchema: objectSchema({
      duration: { type: "number", description: "Fade duration in milliseconds, 50 to 20000. Default 300." },
      stinger_name: { type: "string", description: "Existing transition to configure. Default Stinger." },
      stinger_path: { type: "string", description: "Media file for the stinger. Omitted requests do not invent a path." },
      stinger_point_ms: { type: "number", description: "Stinger transition point in milliseconds. Default 500." },
      backup_path: { type: "string" },
      overwrite: { type: "boolean", default: false },
      dry_run: dryRunProperty,
    }),
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (args: Args, client: ObsClient) => {
      assertKeys(args, ["duration", "stinger_name", "stinger_path", "stinger_point_ms", "backup_path", "overwrite", "dry_run"]);
      const duration = optionalNumber(args, "duration", 50, 20000, 300);
      const stingerName = optionalString(args, "stinger_name") ?? "Stinger";
      const stingerPath = optionalString(args, "stinger_path");
      const point = optionalNumber(args, "stinger_point_ms", 0, 60000, 500);
      const requests: ObsRequest[] = [
        request("SetCurrentSceneTransition", { transitionName: "Fade" }),
        request("SetCurrentSceneTransitionDuration", { transitionDuration: duration }),
      ];
      if (stingerPath) {
        requests.unshift(
          request("SetCurrentSceneTransition", { transitionName: stingerName }),
          request("SetCurrentSceneTransitionSettings", {
            transitionSettings: {
              path: stingerPath,
              tp_type: "time",
              transition_point: point,
              audio_fade_style: "fade_out_fade_in",
            },
            overlay: true,
          }),
        );
      }
      return withBackup(args, client, requests, async () => {
        const sent = [];
        for (const item of requests) {
          sent.push(await client.request(item.requestType, item.requestData));
        }
        return { applied: requests.map((item) => item.requestType), responses: sent.length };
      }, {
        stinger: stingerPath
          ? { name: stingerName, configured: true }
          : {
              configured: false,
              recommendation: "Add a transition named Stinger in OBS, then pass stinger_path. No media path is invented.",
            },
      });
    },
  },
  {
    name: "obs_recipe_mic_chain",
    description: "Add noise suppression (RNNoise), noise gate, compressor, and limiter to one input, in that order (CreateSourceFilter). An existing filter name is updated instead of created. dry_run defaults to true. Apply backs up first.",
    inputSchema: objectSchema({
      input_name: { type: "string" },
      input_uuid: { type: "string" },
      backup_path: { type: "string" },
      overwrite: { type: "boolean", default: false },
      dry_run: dryRunProperty,
    }, []),
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (args: Args, client: ObsClient) => {
      assertKeys(args, ["input_name", "input_uuid", "backup_path", "overwrite", "dry_run"]);
      const name = optionalString(args, "input_name");
      const uuid = optionalString(args, "input_uuid");
      if (!name && !uuid) throw new Error("Provide input_name or input_uuid");
      if (name && uuid) throw new Error("Provide only one of input_name or input_uuid");
      const identity = name ? { sourceName: name } : { sourceUuid: uuid as string };
      const requests = MIC_CHAIN.map((filter) => request("CreateSourceFilter", { ...identity, ...filter }));
      return withBackup(args, client, requests, async () => {
        const current = await client.request("GetSourceFilterList", identity);
        const filters = Array.isArray(current.filters) ? current.filters : [];
        const existing = new Set(
          filters
            .map((filter) => (filter && typeof filter === "object" ? (filter as { filterName?: unknown }).filterName : undefined))
            .filter((filterName): filterName is string => typeof filterName === "string"),
        );
        const created: string[] = [];
        const updated: string[] = [];
        for (const filter of MIC_CHAIN) {
          if (existing.has(filter.filterName)) {
            await client.request("SetSourceFilterSettings", {
              ...identity,
              filterName: filter.filterName,
              filterSettings: filter.filterSettings,
              overlay: false,
            });
            await client.request("SetSourceFilterEnabled", { ...identity, filterName: filter.filterName, filterEnabled: true });
            updated.push(filter.filterName);
          } else {
            await client.request("CreateSourceFilter", { ...identity, ...filter });
            created.push(filter.filterName);
          }
        }
        return { created, updated };
      });
    },
  },
  {
    name: "obs_recipe_celebration",
    description: "Ensure a Celebration scene exists, cut to it, hold, then return to the program scene (RequestBatch with Sleep). dry_run defaults to true and does not read the current scene. Apply backs up first.",
    inputSchema: objectSchema({
      hold_ms: { type: "number", description: "Hold time in milliseconds, 200 to 10000. Default 2000." },
      backup_path: { type: "string" },
      overwrite: { type: "boolean", default: false },
      dry_run: dryRunProperty,
    }),
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (args: Args, client: ObsClient) => {
      assertKeys(args, ["hold_ms", "backup_path", "overwrite", "dry_run"]);
      const hold = optionalNumber(args, "hold_ms", 200, 10000, 2000);
      const requests = [
        request("CreateScene", { sceneName: CELEBRATION_SCENE }),
        request("SetCurrentProgramScene", { sceneName: CELEBRATION_SCENE }),
        request("Sleep", { sleepMillis: hold }),
        request("SetCurrentProgramScene", { sceneName: "<current program scene>" }),
      ];
      return withBackup(args, client, requests, async () => {
        const list = await client.request("GetSceneList");
        const created = !sceneNames(list).has(CELEBRATION_SCENE);
        if (created) await client.request("CreateScene", { sceneName: CELEBRATION_SCENE });
        const program = await client.request("GetCurrentProgramScene");
        const returnScene = typeof program.sceneName === "string" ? program.sceneName : "";
        if (!returnScene) throw new Error("OBS did not return a program scene name");
        if (returnScene === CELEBRATION_SCENE) return { created, held: false, reason: "already on Celebration" };
        const batch = await client.batch([
          request("SetCurrentProgramScene", { sceneName: CELEBRATION_SCENE }),
          request("Sleep", { sleepMillis: hold }),
          request("SetCurrentProgramScene", { sceneName: returnScene }),
        ], { haltOnFailure: true, executionType: 0 });
        return { created, held: true, returnScene, results: batch.length };
      });
    },
  },
  {
    name: "obs_set_stream_service",
    description: "Set the RTMP stream service (SetStreamServiceSettings). The server URL comes from the server argument or OBS_STREAM_SERVER. The stream key is read only from OBS_STREAM_KEY and is never accepted as an argument and never returned. dry_run defaults to true.",
    inputSchema: objectSchema({
      server: { type: "string", description: "Ingest URL. Falls back to OBS_STREAM_SERVER." },
      service_type: { type: "string", description: "Default rtmp_custom." },
      dry_run: dryRunProperty,
    }),
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (args: Args, client: ObsClient) => {
      assertKeys(args, ["server", "service_type", "dry_run"]);
      const dry = readDryRun(args);
      const serviceType = optionalString(args, "service_type") ?? "rtmp_custom";
      const server = optionalString(args, "server") ?? envValue(process.env, "OBS_STREAM_SERVER");
      const key = envValue(process.env, "OBS_STREAM_KEY");
      const shownServer = server ?? "<OBS_STREAM_SERVER>";
      const preview = [request("SetStreamServiceSettings", {
        streamServiceType: serviceType,
        streamServiceSettings: { server: shownServer, key: "[REDACTED]" },
      })];
      if (dry) {
        return { dry_run: true, requests: preview, key_configured: key !== undefined, server_configured: server !== undefined };
      }
      if (!server) throw new Error("Stream server is not set. Pass server or set OBS_STREAM_SERVER.");
      if (!key) throw new Error("OBS_STREAM_KEY is not set. The stream key is not accepted as a tool argument.");
      let response: Awaited<ReturnType<ObsClient["request"]>>;
      try {
        response = await client.request("SetStreamServiceSettings", {
          streamServiceType: serviceType,
          streamServiceSettings: { server, key },
        });
      } catch (error) {
        // Never let the key ride out in an OBS comment or any other error text.
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`SetStreamServiceSettings failed: ${message.split(key).join("[REDACTED]")}`);
      }
      return {
        dry_run: false,
        requests: preview,
        key_configured: true,
        result: redactObsPayload(response),
      };
    },
  },
];
