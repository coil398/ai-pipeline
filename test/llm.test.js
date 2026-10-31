import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(".");
const cli = path.join(root, "bin/aip.js");
const tempRoot = () => mkdtemp(path.join(os.tmpdir(), "aip-llm-"));
function run(args, env, expected = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        assert.equal(code, expected, stdout + stderr);
        resolve(stdout);
      } catch (error) {
        reject(error);
      }
    });
  });
}
async function workflow(dir, route = "test-route") {
  await mkdir(path.join(dir, "roles"), { recursive: true });
  await writeFile(path.join(dir, "role.md"), "Respond.");
  await writeFile(
    path.join(dir, "workflow.json"),
    JSON.stringify({
      id: "llm-test",
      inputs: {},
      steps: [{
        id: "respond",
        kind: "llm",
        role: "role.md",
        route,
        inputs: [],
        output: "answer",
      }],
    }),
  );
  await writeFile(
    path.join(dir, "routes.json"),
    JSON.stringify({
      "test-route": [{ gateway: "first", model: "m1", effort: "low" }, {
        gateway: "second",
        model: "m2",
        effort: "high",
      }],
    }),
  );
}
test("429 advances route, records cooldown and tried route usage", async (t) => {
  const temp = await tempRoot();
  t.after(() => rm(temp, { recursive: true, force: true }));
  let calls = 0;
  const server = http.createServer((request, response) => {
    calls += 1;
    if (calls === 1) {
      response.writeHead(429, { "Retry-After": "120" });
      response.end("{}");
    } else {
      response.end(
        JSON.stringify({
          choices: [{ message: { content: "answer" } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const dir = path.join(temp, "wf");
  await workflow(dir);
  await writeFile(
    path.join(dir, "gateways.json"),
    JSON.stringify({
      first: {
        kind: "openai-chat",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        apiKeyEnv: "TEST_KEY",
      },
      second: {
        kind: "openai-chat",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        apiKeyEnv: "TEST_KEY",
      },
    }),
  );
  const cooldown = path.join(temp, "cooldown.json");
  const runs = path.join(temp, "runs");
  await run([
    "run",
    path.join(dir, "workflow.json"),
    "--run-id",
    "switch",
    "--runs-dir",
    runs,
  ], { AIP_COOLDOWN_PATH: cooldown });
  const usage = JSON.parse(
    await readFile(
      path.join(runs, "switch/steps/respond/v1/a1/usage.json"),
      "utf8",
    ),
  );
  assert.deepEqual(usage.tried.map((item) => item.result), [
    "limit",
    "success",
  ]);
  assert.equal(usage.gateway, "second");
  assert.equal(usage.totalTokens, 5);
  const values = JSON.parse(await readFile(cooldown, "utf8"));
  assert.ok(
    values.first >= Date.now() + 119000 && values.first <= Date.now() + 121000,
  );
});
test("cooldown route is skipped and expired route is selected after earliest cooldown wait", async () => {
  const { routeLlm } = await import("../src/llm/router.js");
  const temp = await tempRoot();
  const cooldown = path.join(temp, "cooldown.json");
  const prior = process.env.AIP_COOLDOWN_PATH;
  process.env.AIP_COOLDOWN_PATH = cooldown;
  try {
    await writeFile(
      cooldown,
      JSON.stringify({ first: Date.now() + 100, second: Date.now() + 15 }),
    );
    const seen = [];
    const result = await routeLlm({
      route: "r",
      prompt: "p",
      routes: {
        r: [{ gateway: "first", model: "a" }, {
          gateway: "second",
          model: "b",
        }],
      },
      gateways: {
        first: { kind: "exec", argv: ["node", "-e", "process.stdin.resume()"] },
        second: {
          kind: "exec",
          argv: ["node", "-e", "process.stdin.resume()"],
        },
      },
    });
    seen.push(result.gateway);
    assert.deepEqual(seen, ["second"]);
  } finally {
    if (prior === undefined) delete process.env.AIP_COOLDOWN_PATH;
    else process.env.AIP_COOLDOWN_PATH = prior;
    await rm(temp, { recursive: true, force: true });
  }
});
test("exec gateway returns stdout and limit patterns advance to next route", async () => {
  const { routeLlm } = await import("../src/llm/router.js");
  const temp = await tempRoot();
  const prior = process.env.AIP_COOLDOWN_PATH;
  process.env.AIP_COOLDOWN_PATH = path.join(temp, "cooldown.json");
  try {
    const result = await routeLlm({
      route: "r",
      prompt: "prompt",
      routes: {
        r: [{ gateway: "limited", model: "a", effort: "x" }, {
          gateway: "ok",
          model: "b",
          effort: "y",
        }],
      },
      gateways: {
        limited: {
          kind: "exec",
          argv: [
            "node",
            "-e",
            "process.stdin.resume();console.log('quota limit')",
          ],
          limitPatterns: ["quota limit"],
          cooldownMs: 10,
        },
        ok: {
          kind: "exec",
          argv: [
            "node",
            "-e",
            "process.stdin.resume();console.log(process.argv[1]+' '+process.argv[2])",
            "{model}",
            "{effort}",
          ],
        },
      },
    });
    assert.match(result.text, /b y/);
    assert.deepEqual(result.tried.map((item) => item.result), [
      "limit",
      "success",
    ]);
  } finally {
    if (prior === undefined) delete process.env.AIP_COOLDOWN_PATH;
    else process.env.AIP_COOLDOWN_PATH = prior;
    await rm(temp, { recursive: true, force: true });
  }
});
test("5xx fails run and continue retries the same step", async (t) => {
  const temp = await tempRoot();
  t.after(() => rm(temp, { recursive: true, force: true }));
  let calls = 0;
  const server = http.createServer((_request, response) => {
    calls += 1;
    response.writeHead(calls === 1 ? 503 : 200, {
      "content-type": "application/json",
    });
    response.end(
      JSON.stringify(
        calls === 1
          ? {}
          : { choices: [{ message: { content: "done" } }], usage: {} },
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const dir = path.join(temp, "wf");
  await workflow(dir);
  await writeFile(
    path.join(dir, "routes.json"),
    JSON.stringify({ "test-route": [{ gateway: "first", model: "m" }] }),
  );
  await writeFile(
    path.join(dir, "gateways.json"),
    JSON.stringify({
      first: {
        kind: "openai-chat",
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        apiKeyEnv: "TEST_KEY",
      },
    }),
  );
  const runs = path.join(temp, "runs");
  await run(
    [
      "run",
      path.join(dir, "workflow.json"),
      "--run-id",
      "retry",
      "--runs-dir",
      runs,
    ],
    {},
    1,
  );
  let state = JSON.parse(
    await readFile(path.join(runs, "retry/state.json"), "utf8"),
  );
  assert.equal(state.status, "failed");
  await run(["continue", "--run-id", "retry", "--runs-dir", runs]);
  state = JSON.parse(
    await readFile(path.join(runs, "retry/state.json"), "utf8"),
  );
  assert.equal(state.status, "completed");
  assert.equal(calls, 2);
});
