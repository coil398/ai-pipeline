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
test("fallback expansion inherits effort, removes duplicates, and stops after one level", async () => {
  const { expandRouteEntries } = await import("../src/llm/router.js");
  assert.deepEqual(expandRouteEntries([
    { gateway: "a", model: "m", effort: "high" },
    { gateway: "b", model: "n" },
  ], {
    "a:m": [
      { gateway: "b", model: "n" },
      { gateway: "c", model: "o", effort: "low" },
    ],
    "b:n": [{ gateway: "c", model: "o", effort: "low" }],
    "c:o": [{ gateway: "d", model: "p" }],
  }), [
    { gateway: "a", model: "m", effort: "high" },
    { gateway: "b", model: "n", effort: "high" },
    { gateway: "c", model: "o", effort: "low" },
    { gateway: "b", model: "n" },
  ]);
});
test("peak hours use UTC weekdays and include overnight windows on their start weekday", async () => {
  const { isPeak } = await import("../src/llm/router.js");
  const hours = [{ days: [1], start: "22:00", end: "02:00" }];
  assert.equal(isPeak(hours, Date.UTC(2026, 10, 2, 22)), true); // Monday
  assert.equal(isPeak(hours, Date.UTC(2026, 10, 3, 1, 59)), true);
  assert.equal(isPeak(hours, Date.UTC(2026, 10, 3, 2)), false);
  assert.equal(isPeak(hours, Date.UTC(2026, 10, 3, 0, 30)), true);
  assert.equal(isPeak([{ days: [2], start: "01:00", end: "04:00" }], Date.UTC(2026, 10, 3, 1)), true);
  assert.equal(isPeak([{ days: [2], start: "01:00", end: "04:00" }], Date.UTC(2026, 10, 3, 4)), false);
});
test("peak-hour gateway entries move behind off-peak entries with stable ordering", async (t) => {
  const { routeLlm } = await import("../src/llm/router.js");
  const temp = await tempRoot();
  const prior = process.env.AIP_COOLDOWN_PATH;
  process.env.AIP_COOLDOWN_PATH = path.join(temp, "cooldown.json");
  t.after(async () => { if (prior === undefined) delete process.env.AIP_COOLDOWN_PATH; else process.env.AIP_COOLDOWN_PATH = prior; await rm(temp, { recursive: true, force: true }); });
  const gateways = Object.fromEntries(["peak1", "off", "peak2"].map((gateway) => [gateway, {
    kind: "exec", peakHours: gateway.startsWith("peak") ? [{ days: [1], start: "00:00", end: "23:59" }] : undefined,
    argv: ["node", "-e", `process.stdin.resume();console.log('${gateway}')`],
  }]));
  const priorWrite = process.stderr.write; let stderr = ""; process.stderr.write = (chunk) => { stderr += chunk; return true; };
  let result;
  try {
    result = await routeLlm({ route: "r", prompt: "p", routes: { r: ["peak1", "off", "peak2"].map((gateway) => ({ gateway, model: "m" })) }, gateways, now: () => Date.UTC(2026, 10, 2, 12) });
  } finally { process.stderr.write = priorWrite; }
  assert.equal(result.gateway, "off");
  assert.match(stderr, /INFO route_offpeak_order route=r gateways=off,peak1,peak2/);
  assert.equal((await routeLlm({ route: "r", prompt: "p", routes: { r: [{ gateway: "peak1", model: "m" }, { gateway: "peak2", model: "m" }] }, gateways, now: () => Date.UTC(2026, 10, 2, 12) })).gateway, "peak1");
  assert.equal((await routeLlm({ route: "r", prompt: "p", routes: { r: [{ gateway: "off", model: "m" }, { gateway: "peak1", model: "m" }] }, gateways, now: () => Date.UTC(2026, 10, 2, 23, 59) })).gateway, "off");
});
test("peakHours validation rejects malformed windows", async () => {
  const { validatePeakHours } = await import("../src/llm/router.js");
  assert.throws(() => validatePeakHours({ a: { peakHours: [{ days: [7], start: "08:00", end: "09:00" }] } }), /invalid peakHours for gateway a/);
});
test("startup rejects malformed gateway peakHours", async (t) => {
  const temp = await tempRoot();
  t.after(() => rm(temp, { recursive: true, force: true }));
  const dir = path.join(temp, "wf");
  await workflow(dir);
  await writeFile(path.join(dir, "gateways.json"), JSON.stringify({ first: { kind: "exec", argv: ["true"], peakHours: [{ days: [1], start: "25:00", end: "04:00" }] } }));
  await assert.rejects(run([
    "run", path.join(dir, "workflow.json"), "--run-id", "invalid-peak",
    "--runs-dir", path.join(temp, "runs"),
  ]), /invalid peakHours for gateway first/);
});
test("openai chat assembles split SSE content and usage, stopping at DONE", async () => {
  const { openaiChat } = await import("../src/llm/gateways/openai-chat.js");
  const priorFetch = globalThis.fetch;
  let requestBody;
  let consumedAfterDone = false;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => "text/event-stream" },
      body: (async function* () {
        yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hel');
        yield new TextEncoder().encode('lo"}}]}\n\ndata: {"choices":[{"delta":{"reasoning_content":"hidden"}}]}\n');
        yield new TextEncoder().encode('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}\n');
        yield new TextEncoder().encode('data: [DONE]\n');
        consumedAfterDone = true;
        yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"!"}}]}\n');
      })(),
    };
  };
  try {
    const result = await openaiChat(
      { baseUrl: "http://example.invalid" },
      { model: "m", prompt: "p" },
    );
    assert.equal(requestBody.stream, true);
    assert.deepEqual(requestBody.stream_options, { include_usage: true });
    assert.deepEqual(result, {
      text: "Hello",
      usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 },
    });
    assert.equal(consumedAfterDone, false);
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("empty OpenAI response errors retain streamed usage", async () => {
  const { openaiChat } = await import("../src/llm/gateways/openai-chat.js");
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200,
    headers: { get: () => "text/event-stream" },
    body: (async function* () {
      yield new TextEncoder().encode('data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":0,"total_tokens":8}}\n');
      yield new TextEncoder().encode("data: [DONE]\n");
    })() });
  try {
    await assert.rejects(openaiChat({ baseUrl: "http://example.invalid" }, { model: "m", prompt: "p" }), error => {
      assert.deepEqual(error.usage, { inputTokens: 8, outputTokens: 0, totalTokens: 8 });
      return true;
    });
  } finally { globalThis.fetch = priorFetch; }
});

test("route records usage for failed gateway attempts", async (t) => {
  const { routeLlm } = await import("../src/llm/router.js");
  const temp = await tempRoot();
  const prior = process.env.AIP_COOLDOWN_PATH;
  process.env.AIP_COOLDOWN_PATH = path.join(temp, "cooldown.json");
  t.after(async () => { if (prior === undefined) delete process.env.AIP_COOLDOWN_PATH; else process.env.AIP_COOLDOWN_PATH = prior; await rm(temp, { recursive: true, force: true }); });
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => (++calls === 1
    ? ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 0, total_tokens: 4 } }) })
    : ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }) }));
  try {
    const result = await routeLlm({ route: "r", prompt: "p", routes: { r: [{ gateway: "a", model: "m" }, { gateway: "b", model: "m" }] }, gateways: { a: { kind: "openai-chat", baseUrl: "http://a" }, b: { kind: "openai-chat", baseUrl: "http://b" } } });
    assert.deepEqual(result.tried[0].usage, { inputTokens: 4, outputTokens: 0, totalTokens: 4 });
  } finally { globalThis.fetch = original; }
});

test("concurrent cooldown updates merge under a lease and remove it afterward", async (t) => {
  const { routeLlm } = await import("../src/llm/router.js");
  const temp = await tempRoot(); const cooldown = path.join(temp, "cooldown.json");
  const priorPath = process.env.AIP_COOLDOWN_PATH; process.env.AIP_COOLDOWN_PATH = cooldown;
  const priorFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = priorFetch; if (priorPath === undefined) delete process.env.AIP_COOLDOWN_PATH; else process.env.AIP_COOLDOWN_PATH = priorPath; await rm(temp, { recursive: true, force: true }); });
  globalThis.fetch = async url => {
    const name = new URL(url).hostname;
    return name === "limited-a" || name === "limited-b"
      ? { ok: false, status: 429, headers: { get: () => "1" }, text: async () => "" }
      : { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ choices: [{ message: { content: "ok" } }], usage: {} }) };
  };
  const entry = (gateway) => ({ gateway, model: "m" });
  const gateways = Object.fromEntries(["limited-a", "limited-b", "ok-a", "ok-b"].map(name => [name, { kind: "openai-chat", baseUrl: `http://${name}` }]));
  await Promise.all([
    routeLlm({ route: "a", prompt: "p", routes: { a: [entry("limited-a"), entry("ok-a")] }, gateways }),
    routeLlm({ route: "b", prompt: "p", routes: { b: [entry("limited-b"), entry("ok-b")] }, gateways }),
  ]);
  const saved = JSON.parse(await readFile(cooldown, "utf8"));
  assert.ok(saved["limited-a"] > Date.now());
  assert.ok(saved["limited-b"] > Date.now());
  await assert.rejects(readFile(`${cooldown}.lease`), { code: "ENOENT" });
});

test("gateway cooldown is rechecked after waiting for a parallel slot", async (t) => {
  const { routeLlm } = await import("../src/llm/router.js");
  const temp = await tempRoot(); const cooldown = path.join(temp, "cooldown.json");
  const priorPath = process.env.AIP_COOLDOWN_PATH; process.env.AIP_COOLDOWN_PATH = cooldown;
  const priorFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = priorFetch; if (priorPath === undefined) delete process.env.AIP_COOLDOWN_PATH; else process.env.AIP_COOLDOWN_PATH = priorPath; await rm(temp, { recursive: true, force: true }); });
  let requests = 0; let releaseFirst; let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  globalThis.fetch = async () => {
    requests++;
    if (requests === 1) { markStarted(); await new Promise(resolve => { releaseFirst = resolve; }); }
    return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ choices: [{ message: { content: "ok" } }], usage: {} }) };
  };
  const gateways = { shared: { kind: "openai-chat", baseUrl: "http://shared", maxParallel: 1 } };
  const options = { route: "r", prompt: "p", routes: { r: [{ gateway: "shared", model: "m" }] }, gateways };
  const first = routeLlm(options);
  await started;
  const second = routeLlm(options);
  const cooldownUntil = Date.now() + 120;
  await writeFile(cooldown, JSON.stringify({ shared: cooldownUntil }));
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(requests, 2);
  assert.ok(Date.now() >= cooldownUntil);
});
test("openai chat aborts an SSE stream that stays idle after headers", async (t) => {
  const { openaiChat } = await import("../src/llm/gateways/openai-chat.js");
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  await assert.rejects(
    openaiChat(
      { baseUrl: `http://127.0.0.1:${server.address().port}`, idleTimeoutMs: 50 },
      { model: "m", prompt: "p" },
    ),
    (error) => error.message === "stream idle for 50ms" && error.kind === "transient",
  );
});
test("openai chat keeps an SSE stream alive while chunks continue arriving", async (t) => {
  const { openaiChat } = await import("../src/llm/gateways/openai-chat.js");
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"A"}}]}\n');
    const second = setTimeout(() => {
      response.write('data: {"choices":[{"delta":{"content":"B"}}]}\n');
      const done = setTimeout(() => response.end("data: [DONE]\n"), 30);
      done.unref();
    }, 30);
    second.unref();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const result = await openaiChat(
    { baseUrl: `http://127.0.0.1:${server.address().port}`, idleTimeoutMs: 50 },
    { model: "m", prompt: "p" },
  );
  assert.equal(result.text, "AB");
});
test("openai chat rejects an SSE response that ends at DONE without content", async () => {
  const { openaiChat } = await import("../src/llm/gateways/openai-chat.js");
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "text/event-stream" },
    body: (async function* () {
      yield new TextEncoder().encode('data: {"choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}\n');
      yield new TextEncoder().encode("data: [DONE]\n");
    })(),
  });
  try {
    await assert.rejects(
      openaiChat(
        { baseUrl: "http://example.invalid" },
        { model: "m", prompt: "p" },
      ),
      (error) => {
        assert.equal(error.message, "empty response");
        assert.equal(error.kind, "transient");
        return true;
      },
    );
  } finally {
    globalThis.fetch = priorFetch;
  }
});
test("openai chat classifies temporary HTTP and response failures", async () => {
  const { openaiChat } = await import("../src/llm/gateways/openai-chat.js");
  const priorFetch = globalThis.fetch;
  try {
    for (const status of [500, 503, 408]) {
      globalThis.fetch = async () => ({ ok: false, status, headers: { get: () => null }, text: async () => "" });
      await assert.rejects(openaiChat({ baseUrl: "http://example.invalid" }, { model: "m", prompt: "p" }), (error) => error.kind === "transient");
    }
    globalThis.fetch = async () => ({ ok: false, status: 400, headers: { get: () => null }, text: async () => "bad" });
    await assert.rejects(openaiChat({ baseUrl: "http://example.invalid" }, { model: "m", prompt: "p" }), (error) => error.kind === undefined);
    globalThis.fetch = async () => ({ ok: false, status: 429, headers: { get: () => null }, text: async () => "" });
    await assert.rejects(openaiChat({ baseUrl: "http://example.invalid" }, { model: "m", prompt: "p" }), (error) => error.kind === "limit");
    globalThis.fetch = async () => { throw new TypeError("terminated"); };
    await assert.rejects(openaiChat({ baseUrl: "http://example.invalid" }, { model: "m", prompt: "p" }), (error) => error.kind === "transient");
  } finally { globalThis.fetch = priorFetch; }
});
test("transient route failure advances to the next entry and records the outcome", async (t) => {
  const { routeLlm } = await import("../src/llm/router.js");
  const temp = await tempRoot();
  const prior = process.env.AIP_COOLDOWN_PATH;
  process.env.AIP_COOLDOWN_PATH = path.join(temp, "cooldown.json");
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("terminated"); };
  t.after(() => { globalThis.fetch = priorFetch; });
  t.after(async () => { if (prior === undefined) delete process.env.AIP_COOLDOWN_PATH; else process.env.AIP_COOLDOWN_PATH = prior; await rm(temp, { recursive: true, force: true }); });
  const result = await routeLlm({ route: "r", prompt: "p", routes: { r: [{ gateway: "broken", model: "m" }, { gateway: "ok", model: "m" }] }, gateways: {
    broken: { kind: "openai-chat", baseUrl: "http://unused", apiKeyEnv: "", },
    ok: { kind: "exec", argv: [process.execPath, "-e", "console.log('ok')"] },
  } });
  assert.equal(result.text.trim(), "ok");
  assert.deepEqual(result.tried.map(({ gateway, result: outcome }) => [gateway, outcome]), [["broken", "transient"], ["ok", "success"]]);
});
test("HTTP request timeout advances to the next route entry", async (t) => {
  const { routeLlm } = await import("../src/llm/router.js");
  const temp = await tempRoot();
  const prior = process.env.AIP_COOLDOWN_PATH;
  const priorFetch = globalThis.fetch;
  process.env.AIP_COOLDOWN_PATH = path.join(temp, "cooldown.json");
  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  t.after(() => { globalThis.fetch = priorFetch; });
  t.after(async () => { if (prior === undefined) delete process.env.AIP_COOLDOWN_PATH; else process.env.AIP_COOLDOWN_PATH = prior; await rm(temp, { recursive: true, force: true }); });
  const result = await routeLlm({ route: "r", prompt: "p", routes: { r: [{ gateway: "slow", model: "m" }, { gateway: "ok", model: "m" }] }, gateways: {
    slow: { kind: "openai-chat", baseUrl: "http://unused", apiKeyEnv: "", timeoutMs: 5, idleTimeoutMs: 0 },
    ok: { kind: "exec", argv: [process.execPath, "-e", "console.log('after timeout')"] },
  } });
  assert.equal(result.text.trim(), "after timeout");
  assert.deepEqual(result.tried.map(({ gateway, result: outcome }) => [gateway, outcome]), [["slow", "transient"], ["ok", "success"]]);
});
test("exec timeout advances to the next route entry", async (t) => {
  const { routeLlm } = await import("../src/llm/router.js");
  const temp = await tempRoot();
  const prior = process.env.AIP_COOLDOWN_PATH;
  process.env.AIP_COOLDOWN_PATH = path.join(temp, "cooldown.json");
  t.after(async () => { if (prior === undefined) delete process.env.AIP_COOLDOWN_PATH; else process.env.AIP_COOLDOWN_PATH = prior; await rm(temp, { recursive: true, force: true }); });
  const result = await routeLlm({ route: "r", prompt: "p", routes: { r: [{ gateway: "slow", model: "m" }, { gateway: "ok", model: "m" }] }, gateways: {
    slow: { kind: "exec", argv: [process.execPath, "-e", "setInterval(()=>{},1000)"], timeoutMs: 5 },
    ok: { kind: "exec", argv: [process.execPath, "-e", "console.log('after timeout')"] },
  } });
  assert.equal(result.text.trim(), "after timeout");
  assert.deepEqual(result.tried.map(({ gateway, result: outcome }) => [gateway, outcome]), [["slow", "transient"], ["ok", "success"]]);
});
test("all transient route failures throw with every entry recorded", async (t) => {
  const { routeLlm } = await import("../src/llm/router.js");
  const temp = await tempRoot();
  const prior = process.env.AIP_COOLDOWN_PATH;
  process.env.AIP_COOLDOWN_PATH = path.join(temp, "cooldown.json");
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("terminated"); };
  t.after(() => { globalThis.fetch = priorFetch; });
  t.after(async () => { if (prior === undefined) delete process.env.AIP_COOLDOWN_PATH; else process.env.AIP_COOLDOWN_PATH = prior; await rm(temp, { recursive: true, force: true }); });
  await assert.rejects(routeLlm({ route: "r", prompt: "p", routes: { r: [{ gateway: "one", model: "m" }, { gateway: "two", model: "m" }] }, gateways: Object.fromEntries(["one", "two"].map((gateway) => [gateway, { kind: "openai-chat", baseUrl: "http://unused", apiKeyEnv: "" }])) }), (error) => {
    assert.equal(error.kind, "transient");
    assert.deepEqual(error.tried.map(({ gateway, result }) => [gateway, result]), [["one", "transient"], ["two", "transient"]]);
    return true;
  });
});
test("route errors without a kind still fail immediately", async (t) => {
  const { routeLlm } = await import("../src/llm/router.js");
  const temp = await tempRoot();
  const prior = process.env.AIP_COOLDOWN_PATH;
  process.env.AIP_COOLDOWN_PATH = path.join(temp, "cooldown.json");
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => { throw new SyntaxError("invalid JSON"); } });
  t.after(() => { globalThis.fetch = priorFetch; });
  t.after(async () => { if (prior === undefined) delete process.env.AIP_COOLDOWN_PATH; else process.env.AIP_COOLDOWN_PATH = prior; await rm(temp, { recursive: true, force: true }); });
  await assert.rejects(routeLlm({ route: "r", prompt: "p", routes: { r: [{ gateway: "bad", model: "m" }, { gateway: "ok", model: "m" }] }, gateways: {
    bad: { kind: "openai-chat", baseUrl: "http://unused", apiKeyEnv: "" },
    ok: { kind: "exec", argv: [process.execPath, "-e", "console.log('unexpected')"] },
  } }), (error) => { assert.equal(error.kind, undefined); assert.deepEqual(error.tried.map((item) => item.result), ["failed"]); return true; });
});
test("openai chat continues to read JSON responses", async () => {
  const { openaiChat } = await import("../src/llm/gateways/openai-chat.js");
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => ({
      choices: [{ message: { content: "json result" } }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }),
  });
  try {
    assert.deepEqual(await openaiChat(
      { baseUrl: "http://example.invalid" },
      { model: "m", prompt: "p" },
    ), {
      text: "json result",
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    });
  } finally {
    globalThis.fetch = priorFetch;
  }
});
test("openai chat applies configured headers with a fresh requestId per request", async () => {
  const { openaiChat } = await import("../src/llm/gateways/openai-chat.js");
  const priorFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, options) => {
    seen.push(options.headers);
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    };
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
test("fallbacks reject references to gateways missing from gateways.json", async (t) => {
  const temp = await tempRoot();
  t.after(() => rm(temp, { recursive: true, force: true }));
  const dir = path.join(temp, "wf");
  await workflow(dir);
  await writeFile(path.join(dir, "gateways.json"), JSON.stringify({ first: { kind: "exec", argv: ["true"] } }));
  await writeFile(path.join(dir, "fallbacks.json"), JSON.stringify({
    "first:m1": [{ gateway: "missing", model: "m2" }],
  }));
  await run([
    "run", path.join(dir, "workflow.json"), "--run-id", "invalid",
    "--runs-dir", path.join(temp, "runs"),
  ], {}, 1);
});
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
test("limit advances from a route entry to its configured fallback", async (t) => {
  const { routeLlm } = await import("../src/llm/router.js");
  const temp = await tempRoot();
  const prior = process.env.AIP_COOLDOWN_PATH;
  process.env.AIP_COOLDOWN_PATH = path.join(temp, "cooldown.json");
  t.after(async () => {
    if (prior === undefined) delete process.env.AIP_COOLDOWN_PATH;
    else process.env.AIP_COOLDOWN_PATH = prior;
    await rm(temp, { recursive: true, force: true });
  });
  const result = await routeLlm({
    route: "r",
    prompt: "p",
    routes: { r: [{ gateway: "limited", model: "m", effort: "high" }] },
    fallbacks: { "limited:m": [{ gateway: "ok", model: "alternate" }] },
    gateways: {
      limited: {
        kind: "exec",
        argv: ["node", "-e", "process.stdin.resume();console.log('Quota Limit');process.exit(1)"],
        limitPatterns: ["quota limit"],
        cooldownMs: 1,
      },
      ok: { kind: "exec", argv: ["node", "-e", "process.stdin.resume();console.log('ok')"] },
    },
    attemptDir: path.join(temp, "attempt"),
  });
  assert.equal(result.gateway, "ok");
  assert.equal(result.effort, "high");
  assert.deepEqual(result.tried.map(({ gateway, result: outcome }) => [gateway, outcome]), [
    ["limited", "limit"], ["ok", "success"],
  ]);
});
test("exec fallback does not read output left by the preceding limited route", async (t) => {
  const { routeLlm } = await import("../src/llm/router.js");
  const temp = await tempRoot();
  const prior = process.env.AIP_COOLDOWN_PATH;
  process.env.AIP_COOLDOWN_PATH = path.join(temp, "cooldown.json");
  t.after(async () => { if (prior === undefined) delete process.env.AIP_COOLDOWN_PATH; else process.env.AIP_COOLDOWN_PATH = prior; await rm(temp, { recursive: true, force: true }); });
  const result = await routeLlm({ route: "r", prompt: "p", routes: { r: [{ gateway: "limited", model: "m" }, { gateway: "ok", model: "m" }] }, gateways: {
    limited: { kind: "exec", argv: [process.execPath, "-e", "require('node:fs').writeFileSync('response.md','A stale output');console.log('limit');process.exit(1)"], outputFile: "response.md", limitPatterns: ["limit"] },
    ok: { kind: "exec", argv: [process.execPath, "-e", "console.log('B fresh output')"], outputFile: "response.md" },
  }, attemptDir: path.join(temp, "attempt") });
  assert.equal(result.text.trim(), "B fresh output");
});
test("cooldown route is skipped and expired route is selected after earliest cooldown wait", async () => {
  const { routeLlm } = await import("../src/llm/router.js");
  const temp = await tempRoot();
  const cooldown = path.join(temp, "cooldown.json");
  const prior = process.env.AIP_COOLDOWN_PATH;
  const priorWrite = process.stderr.write;
  let stderr = "";
  process.stderr.write = (chunk) => {
    stderr += chunk;
    return true;
  };
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
    assert.match(stderr, /WARN route_wait route=r .*waitMs=\d+/);
    assert.match(stderr, /cooldowns=first=\d{4}-\d\d-\d\dT.*Z,second=\d{4}-\d\d-\d\dT.*Z/);
  } finally {
    process.stderr.write = priorWrite;
    if (prior === undefined) delete process.env.AIP_COOLDOWN_PATH;
    else process.env.AIP_COOLDOWN_PATH = prior;
    await rm(temp, { recursive: true, force: true });
  }
});
test("exec gateway returns stdout and limit patterns advance to next route", async () => {
  const { routeLlm } = await import("../src/llm/router.js");
  const temp = await tempRoot();
  const prior = process.env.AIP_COOLDOWN_PATH;
  const priorWrite = process.stderr.write;
  let stderr = "";
  process.stderr.write = (chunk) => {
    stderr += chunk;
    return true;
  };
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
      attemptDir: path.join(temp, "attempt"),
      gateways: {
        limited: {
          kind: "exec",
          argv: [
            "node",
            "-e",
            "process.stdin.resume();console.log('Quota Limit');process.exit(1)",
          ],
          limitPatterns: ["quota limit"],
          cooldownMs: 10,
        },
        ok: {
          kind: "exec",
          argv: [
            "node",
            "-e",
            "process.stdin.resume();console.log(process.argv[1]+' '+process.argv[2]+' '+process.cwd()+' '+process.argv[3])",
            "{model}",
            "{effort}",
            "{workdir}",
          ],
        },
      },
    });
    assert.match(result.text, /b y/);
    const workdir = path.join(temp, "attempt/work");
    assert.match(result.text, new RegExp(`${workdir} ${workdir.replaceAll("\\", "\\\\")}`));
    assert.deepEqual(result.tried.map((item) => item.result), [
      "limit",
      "success",
    ]);
    assert.match(stderr, /WARN gateway_limited gateway=limited model=a cooldownUntil=\d{4}-\d\d-\d\dT.*Z/);
  } finally {
    process.stderr.write = priorWrite;
    if (prior === undefined) delete process.env.AIP_COOLDOWN_PATH;
    else process.env.AIP_COOLDOWN_PATH = prior;
    await rm(temp, { recursive: true, force: true });
  }
});
test("exec gateway only matches case-insensitive limit patterns on failure", async () => {
  const { execGateway } = await import("../src/llm/gateways/exec.js");
  const temp = await tempRoot();
  try {
    const base = {
      argv: [process.execPath, "-e", "console.log('Usage Limit reached')"],
      limitPatterns: ["usage limit"],
    };
    const success = await execGateway(base, {
      model: "m",
      prompt: "p",
      attemptDir: path.join(temp, "success"),
    });
    assert.match(success.text, /Usage Limit/);

    await assert.rejects(
      execGateway({
        ...base,
        argv: [process.execPath, "-e", "console.log('USAGE LIMIT');process.exit(2)"],
      }, {
        model: "m",
        prompt: "p",
        attemptDir: path.join(temp, "limit"),
      }),
      (error) => error.kind === "limit",
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
test("exec gateway terminates timed out child processes", async () => {
  const { execGateway } = await import("../src/llm/gateways/exec.js");
  const temp = await tempRoot();
  const attemptDir = path.join(temp, "attempt");
  try {
    await assert.rejects(
      execGateway({
        argv: [
          process.execPath,
          "-e",
          "process.on('SIGTERM',()=>{require('node:fs').writeFileSync('terminated','yes');process.exit(0)});setInterval(()=>{},1000)",
        ],
        timeoutMs: 500,
      }, { model: "m", prompt: "p", attemptDir }),
      (error) => error.kind === "transient",
    );
    assert.equal(
      await readFile(path.join(attemptDir, "work", "terminated"), "utf8"),
      "yes",
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
test("exec gateway uses a non-empty outputFile and falls back to stdout otherwise", async () => {
  const { execGateway } = await import("../src/llm/gateways/exec.js");
  const temp = await tempRoot();
  try {
    for (const [mode, expected] of [
      ["content", "file output"],
      ["missing", "stdout output"],
      ["empty", "stdout output"],
    ]) {
      const attemptDir = path.join(temp, mode);
      const script = [
        "const fs = require('node:fs');",
        "console.log('stdout output');",
        "if (process.argv[1] === 'content') fs.writeFileSync('output.md', 'file output');",
        "if (process.argv[1] === 'empty') fs.writeFileSync('output.md', '');",
      ].join(" ");
      const result = await execGateway({
        argv: [process.execPath, "-e", script, mode],
        outputFile: "output.md",
      }, { model: "m", prompt: "p", attemptDir });
      assert.equal(result.text.trim(), expected);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
test("exec gateway runs in its work directory and expands {workdir}", async () => {
  const { execGateway } = await import("../src/llm/gateways/exec.js");
  const temp = await tempRoot();
  try {
    const attemptDir = path.join(temp, "attempt");
    const result = await execGateway({
      argv: [process.execPath, "-e", "console.log(process.cwd()+'|'+process.argv[1])", "{workdir}"],
    }, { model: "m", prompt: "p", attemptDir });
    const expected = path.join(attemptDir, "work");
    assert.equal(result.text.trim(), `${expected}|${expected}`);
  } finally {
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
