import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ObsClient } from "../src/client.ts";
import { FakeObs } from "./fake-obs.ts";
import { handleMessage } from "../src/mcp.ts";
import { tools } from "../src/tools.ts";

const indexPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));

function client(): ObsClient {
  return new ObsClient({ url: "ws://127.0.0.1:1", maxAttempts: 1, handshakeTimeoutMs: 50 });
}

test("initialize negotiates a supported protocol version and lists tools", async () => {
  const ctx = { client: client() };
  const initialized = await handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  }, ctx) as { result: { protocolVersion: string; serverInfo: { name: string }; capabilities: { tools: unknown } } };
  assert.equal(initialized.result.protocolVersion, "2025-03-26");
  assert.equal(initialized.result.serverInfo.name, "obs-mcp");
  assert.ok(initialized.result.capabilities.tools);

  const fallback = await handleMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { protocolVersion: "1999-01-01" },
  }, ctx) as { result: { protocolVersion: string } };
  assert.equal(fallback.result.protocolVersion, "2025-06-18");

  assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx), undefined);

  const listed = await handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" }, ctx) as {
    result: { tools: Array<{ name: string; inputSchema: { properties?: { dry_run?: { default?: boolean } } } }> };
  };
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), tools.map((tool) => tool.name));
  const write = listed.result.tools.find((tool) => tool.name === "obs_set_current_scene");
  assert.equal(write?.inputSchema.properties?.dry_run?.default, true);
});

test("tools/call dry-run and protocol errors stay on the JSON-RPC channel", async () => {
  const ctx = { client: client() };
  const called = await handleMessage({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "obs_record", arguments: { action: "start" } },
  }, ctx) as { result: { isError: boolean; content: Array<{ text: string }> } };
  assert.equal(called.result.isError, false);
  const body = JSON.parse(called.result.content[0].text) as { dry_run: boolean; requests: Array<{ requestType: string }> };
  assert.equal(body.dry_run, true);
  assert.equal(body.requests[0].requestType, "StartRecord");
  assert.equal(ctx.client.connectAttempts, 0);

  const missing = await handleMessage({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "obs_not_a_tool", arguments: {} },
  }, ctx) as { result: { isError: boolean; content: Array<{ text: string }> } };
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /Unknown tool/);

  const unknown = await handleMessage({ jsonrpc: "2.0", id: 6, method: "prompts/list" }, ctx) as { error: { code: number } };
  assert.equal(unknown.error.code, -32601);
  const bad = await handleMessage("{", ctx) as { error: { code: number } };
  assert.equal(bad.error.code, -32600);
});

test("stdio server speaks newline-delimited JSON and keeps secrets off stdout", async () => {
  const child = spawn(process.execPath, ["--experimental-strip-types", indexPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      OBS_WS_URL: "ws://127.0.0.1:1",
      OBS_WS_PASSWORD: "stdio-should-not-print-this",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const send = (message: unknown) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "obs_virtualcam", arguments: { action: "start" } } });
  child.stdin.write("{not-json\n");

  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && stdout.split("\n").filter((line) => line.trim()).length < 4) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.stdin.end();
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1000))]);
  if (child.exitCode === null) child.kill();

  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  assert.equal(lines.length, 4);
  const initialize = JSON.parse(lines[0]) as { id: number; result: { serverInfo: { name: string } } };
  const toolsList = JSON.parse(lines[1]) as { id: number; result: { tools: unknown[] } };
  const call = JSON.parse(lines[2]) as { id: number; result: { content: Array<{ text: string }> } };
  const parseError = JSON.parse(lines[3]) as { id: null; error: { code: number } };
  assert.equal(initialize.id, 1);
  assert.equal(initialize.result.serverInfo.name, "obs-mcp");
  assert.equal(toolsList.id, 2);
  assert.equal(toolsList.result.tools.length, tools.length);
  assert.equal(call.id, 3);
  assert.match(call.result.content[0].text, /StartVirtualCam/);
  assert.equal(parseError.id, null);
  assert.equal(parseError.error.code, -32700);
  assert.equal(stdout.includes("stdio-should-not-print-this"), false);
  assert.equal(stderr.includes("stdio-should-not-print-this"), false);
});

test("stdio server closes the OBS socket and exits when stdin ends", async () => {
  const obs = new FakeObs();
  obs.setHandler("GetSceneList", () => ({ responseData: { currentProgramSceneName: "Main", currentPreviewSceneName: null, scenes: [{ sceneName: "Main", sceneIndex: 0 }] } }));
  await obs.start();
  try {
    const child = spawn(process.execPath, ["--experimental-strip-types", indexPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, OBS_WS_URL: obs.url, OBS_WS_PASSWORD: "" },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "obs_list_scenes", arguments: {} } })}\n`);
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !stdout.includes("\n")) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(obs.connections.some((c) => c.identified), "server should hold an identified OBS connection");
    const exited = once(child, "exit");
    child.stdin.end();
    const result = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 3000))]);
    if (result === "timeout") child.kill();
    assert.notEqual(result, "timeout", "process must exit after stdin closes");
    assert.equal(child.exitCode, 0);
  } finally {
    await obs.stop();
  }
});

test("stdio server writes every pending tools/call response before it exits", async () => {
  const obs = new FakeObs();
  obs.responseDelayMs = 300;
  obs.setHandler("GetSceneList", () => ({ responseData: { currentProgramSceneName: "Main", currentPreviewSceneName: null, scenes: [{ sceneName: "Main", sceneIndex: 0 }] } }));
  await obs.start();
  try {
    const child = spawn(process.execPath, ["--experimental-strip-types", indexPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, OBS_WS_URL: obs.url, OBS_WS_PASSWORD: "" },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    const exited = once(child, "exit");
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "obs_list_scenes", arguments: {} } });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "obs_status", arguments: {} } });
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "obs_list_scenes", arguments: {} } });
    child.stdin.end();
    const result = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 8000))]);
    if (result === "timeout") child.kill();
    assert.notEqual(result, "timeout", "process must exit after pending responses");
    assert.equal(child.exitCode, 0);
    const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    const ids = lines.map((line) => (JSON.parse(line) as { id: number }).id);
    assert.deepEqual(ids, [1, 2, 3, 4]);
    for (const line of lines.slice(1)) {
      const parsed = JSON.parse(line) as { result: { content: Array<{ text: string }> } };
      assert.ok(parsed.result.content[0].text.length > 0);
    }
  } finally {
    await obs.stop();
  }
});
