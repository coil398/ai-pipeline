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
test("openai chat applies configured headers with a fresh requestId per request", async () => {
  const { openaiChat } = await import("../src/llm/gateways/openai-chat.js");
  const priorFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, options) => {
    seen.push(options.headers);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    const gateway = {
      baseUrl: "http://example.invalid",
      headers: { "x-opencode-session": "{requestId}", "x-request-copy": "id={requestId}" },
    };
    await openaiChat(gateway, { model: "m", prompt: "p" });
    await openaiChat(gateway, { model: "m", prompt: "p" });
    const firstId = seen[0]["x-opencode-session"];
    const secondId = seen[1]["x-opencode-session"];
    assert.match(firstId, /^[0-9a-f-]{36}$/i);
    assert.match(secondId, /^[0-9a-f-]{36}$/i);
    assert.notEqual(firstId, secondId);
    assert.equal(seen[0]["x-request-copy"], `id=${firstId}`);
    assert.equal(seen[1]["x-request-copy"], `id=${secondId}`);
  } finally {
    globalThis.fetch = priorFetch;
  }
});
test("openai chat includes an error response body without exposing the API key", async () => {
  const { openaiChat } = await import("../src/llm/gateways/openai-chat.js");
  const priorFetch = globalThis.fetch;
  const priorKey = process.env.TEST_ERROR_BODY_KEY;
  process.env.TEST_ERROR_BODY_KEY = "error-secret";
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    text: async () => "MissingSessionID; attempted key=error-secret",
  });
  try {
    await assert.rejects(
      openaiChat(
        { baseUrl: "http://example.invalid", apiKeyEnv: "TEST_ERROR_BODY_KEY" },
        { model: "m", prompt: "p" },
      ),
      (error) => {
        assert.equal(error.message, "HTTP 400: MissingSessionID; attempted key=[REDACTED]");
        assert.equal(error.message.includes("error-secret"), false);
        return true;
      },
    );
  } finally {
    if (priorKey === undefined) delete process.env.TEST_ERROR_BODY_KEY;
    else process.env.TEST_ERROR_BODY_KEY = priorKey;
    globalThis.fetch = priorFetch;
  }
});
test("openai chat rejects an empty API key before fetch", async () => {
  const { openaiChat } = await import("../src/llm/gateways/openai-chat.js");
  const priorKey = process.env.TEST_EMPTY_KEY;
  const priorFetch = globalThis.fetch;
  let calls = 0;
  process.env.TEST_EMPTY_KEY = "";
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("fetch should not be called");
  };
  try {
    await assert.rejects(
      openaiChat(
        { baseUrl: "http://example.invalid", apiKeyEnv: "TEST_EMPTY_KEY" },
        { model: "m", prompt: "p" },
      ),
      /missing API key environment variable: TEST_EMPTY_KEY/,
    );
    assert.equal(calls, 0);
  } finally {
    if (priorKey === undefined) delete process.env.TEST_EMPTY_KEY;
    else process.env.TEST_EMPTY_KEY = priorKey;
    globalThis.fetch = priorFetch;
  }
});
test("openai chat reads the named key from envFile without changing process.env", async (t) => {
  const { openaiChat } = await import("../src/llm/gateways/openai-chat.js");
  const dir = await tempRoot();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envFile = path.join(dir, "keys.env");
  await writeFile(envFile, '# ignored\nOTHER=value\nTEST_FILE_KEY="file-secret"\n');
  const priorKey = process.env.TEST_FILE_KEY;
  const priorFetch = globalThis.fetch;
  delete process.env.TEST_FILE_KEY;
  let authorization;
  globalThis.fetch = async (_url, options) => {
    authorization = options.headers.authorization;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
  };
  try {
    await openaiChat(
      { baseUrl: "http://example.invalid", apiKeyEnv: "TEST_FILE_KEY", envFile },
      { model: "m", prompt: "p" },
    );
    assert.equal(authorization, "Bearer file-secret");
    assert.equal(process.env.TEST_FILE_KEY, undefined);
  } finally {
    if (priorKey === undefined) delete process.env.TEST_FILE_KEY;
    else process.env.TEST_FILE_KEY = priorKey;
    globalThis.fetch = priorFetch;
  }
});
test("openai chat prefers process.env over envFile", async (t) => {
  const { openaiChat } = await import("../src/llm/gateways/openai-chat.js");
  const dir = await tempRoot();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envFile = path.join(dir, "keys.env");
  await writeFile(envFile, "TEST_PRIORITY_KEY=file-secret\n");
  const priorKey = process.env.TEST_PRIORITY_KEY;
  const priorFetch = globalThis.fetch;
  process.env.TEST_PRIORITY_KEY = "process-secret";
  let authorization;
  globalThis.fetch = async (_url, options) => {
    authorization = options.headers.authorization;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
  };
  try {
    await openaiChat(
      { baseUrl: "http://example.invalid", apiKeyEnv: "TEST_PRIORITY_KEY", envFile },
      { model: "m", prompt: "p" },
    );
    assert.equal(authorization, "Bearer process-secret");
  } finally {
    if (priorKey === undefined) delete process.env.TEST_PRIORITY_KEY;
    else process.env.TEST_PRIORITY_KEY = priorKey;
    globalThis.fetch = priorFetch;
  }
});
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
  ], { AIP_COOLDOWN_PATH: cooldown, TEST_KEY: "test-key" });
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
    { TEST_KEY: "test-key" },
    1,
  );
  let state = JSON.parse(
    await readFile(path.join(runs, "retry/state.json"), "utf8"),
  );
  assert.equal(state.status, "failed");
  await run(["continue", "--run-id", "retry", "--runs-dir", runs], {
    TEST_KEY: "test-key",
  });
  state = JSON.parse(
    await readFile(path.join(runs, "retry/state.json"), "utf8"),
  );
  assert.equal(state.status, "completed");
  assert.equal(calls, 2);
});
