import test from "node:test";
import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { validateDefinition } from "../src/definition/load.js";
import { schedule } from "../src/engine/scheduler.js";
import { initializeState, saveState, loadState } from "../src/engine/state.js";
const root = path.resolve(".");
const cli = path.join(root, "bin/aip.js");
async function setup() {
  return mkdtemp(path.join(os.tmpdir(), "aip-test-"));
}
function run(args, expected = 0) {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  assert.equal(r.status, expected, r.stdout + r.stderr);
  return r.stdout;
}
const opts = (runs) => ["--runs-dir", runs];
test("review loop passes FAIL to revise and completes on PASS", async (t) => {
  const temp = await setup();
  t.after(() => rm(temp, { recursive: true, force: true }));
  const runs = path.join(temp, "runs");
  run([
    "run",
    path.join(root, "examples/review-loop/workflow.json"),
    "--run-id",
    "loop",
    ...opts(runs),
    "--llm",
    path.join(root, "examples/review-loop/fixtures/loop"),
  ]);
  const s = JSON.parse(
    await readFile(path.join(runs, "loop/state.json"), "utf8"),
  );
  assert.equal(s.status, "completed", s.error);
  assert.deepEqual(s.frontier, []);
  assert.equal(s.steps.draft.attempts, 1);
  assert.equal(s.steps.critic.attempts, 2);
  assert.equal(s.steps.revise.attempts, 1);
  assert.deepEqual(s.rounds.gate, { 1: 1 });
  assert.match(
    await readFile(
      path.join(runs, "loop/steps/revise/v1/a1/prompt.md"),
      "utf8",
    ),
    /VERDICT: FAIL/,
  );
});
test("run replay reads saved outputs from the source run steps directory", async (t) => {
  const temp = await setup();
  t.after(() => rm(temp, { recursive: true, force: true }));
  const dir = path.join(temp, "wf");
  await mkdir(dir);
  await writeFile(path.join(dir, "role.md"), "Respond.");
  const workflow = path.join(dir, "workflow.json");
  await writeFile(workflow, JSON.stringify({ id: "replay", inputs: {}, steps: [
    textStep("write", [], "result", []),
  ] }));
  const runs = path.join(temp, "runs");
  const fixture = path.join(temp, "fixture");
  await mkdir(fixture);
  await writeFile(path.join(fixture, "write.md"), "saved output");
  run(["run", workflow, "--run-id", "source", ...opts(runs), "--llm", fixture]);
  run(["run", workflow, "--run-id", "replay", ...opts(runs), "--llm", "run:source"]);
  const state = JSON.parse(await readFile(path.join(runs, "replay/state.json"), "utf8"));
  assert.equal(state.status, "completed", state.error);
  assert.equal(await readFile(state.artifacts.result.path, "utf8"), "saved output");
});
test("run replay maps a running map-item path to its completed source path", async (t) => {
  const temp = await setup();
  t.after(() => rm(temp, { recursive: true, force: true }));
  const dir = path.join(temp, "wf"); await mkdir(dir);
  await writeFile(path.join(dir, "role.md"), "Respond.");
  const items = path.join(dir, "items.json"); await writeFile(items, '["one"]');
  const workflow = path.join(dir, "workflow.json");
  await writeFile(workflow, JSON.stringify({ id: "map-replay", inputs: { items: "items.json" }, steps: [
    { id: "map", kind: "map", items: "items", itemArtifact: "item", output: "results", steps: [
      { id: "render", kind: "llm", role: "role.md", route: "local", inputs: ["item"], output: "rendered" },
    ] },
  ] }));
  const runs = path.join(temp, "runs"); const fixture = path.join(temp, "fixture"); await mkdir(fixture);
  await writeFile(path.join(fixture, "render.md"), "saved map output");
  run(["run", workflow, "--run-id", "source", ...opts(runs), "--llm", fixture]);
  run(["run", workflow, "--run-id", "replay", ...opts(runs), "--llm", "run:source"]);
  const state = JSON.parse(await readFile(path.join(runs, "replay/state.json"), "utf8"));
  assert.equal(state.status, "completed", state.error);
  assert.deepEqual(JSON.parse(await readFile(state.artifacts.results.path, "utf8")), ["saved map output"]);
});
test("map validates nested ids, inputs, and control flow", () => {
  const base = { id: "map-flow", inputs: { parts: "parts.json", draft: "draft.md" }, steps: [
    { id: "map", kind: "map", items: "parts", itemArtifact: "part", output: "plans", steps: [
      { id: "prep", kind: "exec", argv: ["node", "prep.mjs"], inputs: ["draft", "part"], outputs: ["prompt"] },
      { id: "check", kind: "llm", role: "check.md", route: "r", inputs: ["prompt"], output: "plan" },
    ] },
    { id: "merge", kind: "exec", argv: ["node", "merge.mjs"], inputs: ["plans"], outputs: [] },
  ] };
  assert.doesNotThrow(() => validateDefinition(base));
  assert.throws(() => validateDefinition({ ...base, steps: [{ ...base.steps[0], steps: [base.steps[0].steps[0], { ...base.steps[0].steps[1], id: "prep" }] }, base.steps[1]] }), /duplicate step id/);
  assert.throws(() => validateDefinition({ ...base, steps: [{ ...base.steps[0], steps: [{ ...base.steps[0].steps[0], inputs: ["missing"] }] }, base.steps[1]] }), /unresolved input/);
  assert.throws(() => validateDefinition({ ...base, steps: [{ ...base.steps[0], steps: [{ ...base.steps[0].steps[0], next: [] }] }, base.steps[1]] }), /control flow/);
});
async function runMap(t, values, options = {}) {
  const temp = await setup();
  t.after(() => rm(temp, { recursive: true, force: true }));
  const itemFile = path.join(temp, "items.json");
  await writeFile(itemFile, JSON.stringify(values));
  const definition = {
    id: "map-test",
    inputs: { items: "items.json" },
    steps: [{
      id: "map",
      kind: "map",
      items: "items",
      itemArtifact: "item",
      output: "results",
      maxConcurrency: options.maxConcurrency,
      steps: [
        {
          id: "prepare",
          kind: "exec",
          argv: ["node", "-e", 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.env.AIP_MANIFEST));const x=JSON.parse(fs.readFileSync(m.inputs.item.path));fs.writeFileSync(m.outputs.prompt,String(x))'],
          inputs: ["item"],
          outputs: ["prompt"],
        },
        { id: "render", kind: "llm", role: "role.md", route: "local", inputs: ["prompt"], output: "rendered" },
      ],
    }],
  };
  await writeFile(path.join(temp, "role.md"), "Render {{prompt}}");
  const state = await initializeState(temp, definition, "", { items: itemFile });
  const calls = [];
  let active = 0;
  let peak = 0;
  const gateway = async ({ prompt }) => {
    active += 1;
    peak = Math.max(peak, active);
    calls.push(prompt);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    if (options.failOnce && prompt.includes(String(options.failOnce)) && !options.failed) {
      options.failed = true;
      throw new Error("fixture failure");
    }
    return `result:${prompt.match(/## prompt\n([^\n]+)/)[1]}`;
  };
  await schedule({ definition, definitionDir: temp, runDir: temp, state, gateway, parallel: 4 });
  return { temp, state, definition, gateway, calls, peak, itemFile };
}
test("map runs exec then llm for each item and preserves input order", async (t) => {
  const { state, calls } = await runMap(t, ["a", "b", "c"]);
  assert.equal(state.status, "completed", state.error);
  assert.deepEqual(JSON.parse(await readFile(state.artifacts.results.path, "utf8")), [
    "result:a", "result:b", "result:c",
  ]);
  assert.equal(calls.length, 3);
});
test("map returns an empty array for empty items", async (t) => {
  const { state, calls } = await runMap(t, []);
  assert.equal(state.status, "completed", state.error);
  assert.deepEqual(JSON.parse(await readFile(state.artifacts.results.path, "utf8")), []);
  assert.equal(calls.length, 0);
});
test("map maxConcurrency limits active iterations", async (t) => {
  const { state, peak } = await runMap(t, [1, 2, 3], { maxConcurrency: 1 });
  assert.equal(state.status, "completed", state.error);
  assert.equal(peak, 1);
});
test("map continue retries only failed iterations", async (t) => {
  const result = await runMap(t, [1, 2, 3], { failOnce: 2 });
  assert.equal(result.state.status, "failed");
  assert.deepEqual(result.state.frontier, ["map"]);
  const before = result.calls.length;
  await schedule({ definition: result.definition, definitionDir: result.temp, runDir: result.temp, state: result.state, gateway: result.gateway });
  assert.equal(result.state.status, "completed", result.state.error);
  assert.equal(result.state.steps.map.attempts, 1);
  assert.equal(result.calls.length - before, 1);
  assert.deepEqual(JSON.parse(await readFile(result.state.artifacts.results.path, "utf8")), [
    "result:1", "result:2", "result:3",
  ]);
});
test("map does not reuse an item whose final exec wrote output then failed", async (t) => {
  const temp = await setup();
  t.after(() => rm(temp, { recursive: true, force: true }));
  const items = path.join(temp, "items.json");
  const failedFlag = path.join(temp, "failed-once");
  const countsFile = path.join(temp, "counts.json");
  await writeFile(items, '["retry","success"]');
  let retryCalls = 0;
  const definition = { id: "map-retry", inputs: { items: "items.json" }, steps: [{
    id: "map", kind: "map", items: "items", itemArtifact: "item", output: "results", steps: [{
      id: "render", kind: "exec", inputs: ["item"], outputs: ["rendered"], argv: [process.execPath, "-e",
        `const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.env.AIP_MANIFEST));const item=JSON.parse(fs.readFileSync(m.inputs.item.path));const counts=fs.existsSync(${JSON.stringify(countsFile)})?JSON.parse(fs.readFileSync(${JSON.stringify(countsFile)})):{};counts[item]=(counts[item]||0)+1;fs.writeFileSync(${JSON.stringify(countsFile)},JSON.stringify(counts));fs.writeFileSync(m.outputs.rendered,item==="retry"?"partial":"complete");if(item==="retry"&&!fs.existsSync(${JSON.stringify(failedFlag)})){fs.writeFileSync(${JSON.stringify(failedFlag)},"1");process.exit(1)}`,
      ],
    }],
  }] };
  const state = await initializeState(temp, definition, "", { items });
  const gateway = async () => { retryCalls++; return "unused"; };
  await schedule({ definition, definitionDir: temp, runDir: temp, state, gateway });
  assert.equal(state.status, "failed");
  assert.deepEqual(JSON.parse(await readFile(countsFile, "utf8")), { retry: 1, success: 1 });
  await schedule({ definition, definitionDir: temp, runDir: temp, state, gateway });
  assert.equal(state.status, "completed", state.error);
  assert.equal(retryCalls, 0);
  assert.deepEqual(JSON.parse(await readFile(state.artifacts.results.path, "utf8")), ["partial", "complete"]);
  assert.deepEqual(JSON.parse(await readFile(countsFile, "utf8")), { retry: 2, success: 1 });
  assert.deepEqual((await readdir(path.join(temp, "steps/map/v1/items"))).sort(), ["0", "1"]);
});
test("completed map reached again uses a new version and reruns all items", async (t) => {
  const result = await runMap(t, ["x", "y"]);
  assert.equal(result.state.status, "completed", result.state.error);
  result.state.frontier = ["map"];
  const before = result.calls.length;
  await schedule({ definition: result.definition, definitionDir: result.temp, runDir: result.temp, state: result.state, gateway: result.gateway });
  assert.equal(result.state.status, "completed", result.state.error);
  assert.equal(result.state.steps.map.attempts, 2);
  assert.equal(result.calls.length - before, 2);
  assert.ok(await readFile(path.join(result.temp, "steps/map/v2/items/0/render/a1/output.md"), "utf8"));
});
test("max rounds stops and rerun resets the loop", async (t) => {
  const temp = await setup();
  t.after(() => rm(temp, { recursive: true, force: true }));
  const runs = path.join(temp, "runs");
  const fixture = path.join(temp, "fixtures");
  await cp(path.join(root, "examples/review-loop/fixtures/failing"), fixture, {
    recursive: true,
  });
  const workflow = path.join(root, "examples/review-loop/workflow.json");
  run(
    ["run", workflow, "--run-id", "loop", ...opts(runs), "--llm", fixture],
    1,
  );
  let s = JSON.parse(
    await readFile(path.join(runs, "loop/state.json"), "utf8"),
  );
  assert.equal(s.status, "stopped: max-rounds");
  assert.deepEqual(s.rounds.gate, { 1: 3 });
  assert.deepEqual(s.frontier, ["gate"]);
  assert.equal(s.steps.gate.attempts, 3);
  await writeFile(path.join(fixture, "critic.md"), "VERDICT: PASS\nReady.\n");
  run(["rerun", "--run-id", "loop", "--from", "revise", ...opts(runs)]);
  s = JSON.parse(await readFile(path.join(runs, "loop/state.json"), "utf8"));
  assert.equal(s.status, "completed", s.error);
  assert.deepEqual(s.rounds.gate, {});
  assert.equal(s.steps.gate.attempts, 4);
  assert.equal(s.steps.revise.attempts, 4);
  assert.ok(
    await readFile(
      path.join(runs, "loop/steps/revise/v1/a1/output.md"),
      "utf8",
    ),
  );
});
test("failed command resumes after definition repair", async (t) => {
  const temp = await setup();
  t.after(() => rm(temp, { recursive: true, force: true }));
  const dir = path.join(temp, "wf");
  await mkdir(dir);
  await writeFile(path.join(dir, "input.md"), "x");
  const wf = path.join(dir, "workflow.json");
  const d = {
    id: "retry",
    inputs: { source: "input.md" },
    steps: [command("initial", ["command"]), {
      id: "command",
      kind: "exec",
      argv: ["node", "-e", "process.exit(1)"],
      inputs: ["source"],
      outputs: ["result"],
    }],
  };
  await writeFile(wf, JSON.stringify(d));
  const runs = path.join(temp, "runs");
  run(["run", wf, "--run-id", "retry", ...opts(runs)], 1);
  let s = JSON.parse(
    await readFile(path.join(runs, "retry/state.json"), "utf8"),
  );
  assert.equal(s.status, "failed");
  assert.deepEqual(s.frontier, ["command"]);
  assert.equal(s.steps.initial.attempts, 1);
  d.steps[1].argv = [
    "node",
    "-e",
    'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.env.AIP_MANIFEST));fs.writeFileSync(m.outputs.result,"ok")',
  ];
  d.steps[1].next = ["added"];
  d.steps.push({
    id: "added",
    kind: "exec",
    argv: ["node", "-e", 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.env.AIP_MANIFEST));fs.writeFileSync(m.outputs.added,"added")'],
    inputs: ["result"],
    outputs: ["added"],
  });
  await writeFile(wf, JSON.stringify(d));
  run(["continue", "--run-id", "retry", ...opts(runs)]);
  s = JSON.parse(await readFile(path.join(runs, "retry/state.json"), "utf8"));
  assert.equal(s.status, "completed");
  assert.equal(s.steps.added.attempts, 1);
  assert.deepEqual(s.rounds, {});
  run(["rerun", "--run-id", "retry", "--from", "added", ...opts(runs)]);
  s = JSON.parse(await readFile(path.join(runs, "retry/state.json"), "utf8"));
  assert.equal(s.status, "completed", s.error);
  assert.equal(s.steps.added.attempts, 2);
});
test("failed exec stores stderr tail and stderr.log path in run state", async (t) => {
  const temp = await setup();
  t.after(() => rm(temp, { recursive: true, force: true }));
  const dir = path.join(temp, "wf");
  await mkdir(dir);
  const wf = path.join(dir, "workflow.json");
  await writeFile(wf, JSON.stringify({ id: "stderr", inputs: {}, steps: [{
    id: "fail", kind: "exec", argv: [process.execPath, "-e", "console.error('useful failure detail');process.exit(1)"], outputs: [],
  }] }));
  const runs = path.join(temp, "runs");
  run(["run", wf, "--run-id", "stderr", ...opts(runs)], 1);
  const state = JSON.parse(await readFile(path.join(runs, "stderr/state.json"), "utf8"));
  assert.equal(state.status, "failed");
  assert.match(state.error, /useful failure detail/);
  assert.match(state.error, /stderr\/steps\/fail\/v1\/a1\/stderr\.log/);
  assert.equal(await readFile(path.join(runs, "stderr/steps/fail/v1/a1/stderr.log"), "utf8"), "useful failure detail\n");
});

test("exec stderr is appended while the child is still running", async (t) => {
  const temp = await setup(); t.after(() => rm(temp, { recursive: true, force: true }));
  const stderrFile = path.join(temp, "stderr.log");
  const { runExec } = await import("../src/steps/exec.js");
  const running = runExec({ argv: [process.execPath, "-e", "process.stderr.write('x'.repeat(20000));setTimeout(()=>process.exit(0),200)"], cwd: temp, env: process.env, stderrFile });
  let observed = false;
  for (let i = 0; i < 100; i++) {
    try { observed = (await readFile(stderrFile, "utf8")).length > 0; } catch {}
    if (observed) break;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(observed, true);
  await running;
  assert.equal((await readFile(stderrFile, "utf8")).length, 20000);
});

test("failed LLM usage includes tokens from unsuccessful route attempts", async (t) => {
  const temp = await setup(); t.after(() => rm(temp, { recursive: true, force: true }));
  await writeFile(path.join(temp, "role.md"), "role");
  const definition = { id: "usage-fail", inputs: {}, steps: [textStep("ask", [], "answer", [])] };
  const state = await initializeState(temp, definition, "workflow.json", {});
  const gateway = async () => { const error = new Error("all gateways failed"); error.tried = [{ gateway: "first", result: "transient", usage: { inputTokens: 9, outputTokens: 0, totalTokens: 9 } }]; throw error; };
  await schedule({ definition, definitionDir: temp, runDir: temp, state, gateway });
  const usage = JSON.parse(await readFile(path.join(temp, "steps/ask/v1/a1/usage.json"), "utf8"));
  assert.equal(usage.totalTokens, 9);
  assert.equal(usage.inputTokens, 9);
});
test("definition rejects unresolved inputs and unknown goto", () => {
  assert.throws(
    () =>
      validateDefinition({
        id: "x",
        inputs: {},
        steps: [{
          id: "a",
          kind: "exec",
          argv: ["true"],
          inputs: ["missing"],
          outputs: [],
        }],
      }),
    /unresolved input/,
  );
  assert.throws(
    () =>
      validateDefinition({
        id: "x",
        inputs: { provided: "source.md" },
        steps: [{
          id: "gate",
          kind: "decide",
          source: "provided",
          cases: [{ when: ["PASS"], goto: "missing" }],
        }],
      }),
    /unknown goto/,
  );
});
test("source vocabulary is generic except the permitted decision word", async () => {
  const files = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) await walk(f);
      else files.push(f);
    }
  }
  await walk(path.join(root, "src"));
  await walk(path.join(root, "bin"));
  const rx =
    /\b(article|weekly|stats|academy|quants|market|fin|glossary|draft|plan|critic|writer|review|judge|verdict|publish|editorial|alpha)\b/i;
  for (const f of files) {
    const text = await readFile(f, "utf8");
    assert.doesNotMatch(
      f.endsWith(path.join("steps", "decide.js"))
        ? text.replace(/verdict/gi, "")
        : text,
      rx,
      f,
    );
  }
});
test("design-change example completes with fixtures", async (t) => {
  const temp = await setup();
  t.after(() => rm(temp, { recursive: true, force: true }));
  const runs = path.join(temp, "runs");
  run([
    "run",
    path.join(root, "examples/design-change/workflow.json"),
    "--run-id",
    "design",
    ...opts(runs),
    "--llm",
    path.join(root, "examples/design-change/fixtures/local"),
  ]);
  const s = JSON.parse(
    await readFile(path.join(runs, "design/state.json"), "utf8"),
  );
  assert.equal(s.status, "completed");
});
test("human gateway waits for an output file and continues the same run", async (t) => {
  const temp = await setup();
  t.after(() => rm(temp, { recursive: true, force: true }));
  const dir = path.join(temp, "wf");
  await mkdir(path.join(dir, "roles"), { recursive: true });
  await writeFile(path.join(dir, "input.md"), "Request.");
  await writeFile(path.join(dir, "roles/role.md"), "Respond to the request.");
  const wf = path.join(dir, "workflow.json");
  await writeFile(
    wf,
    JSON.stringify({
      id: "human-flow",
      inputs: { request: "input.md" },
      steps: [{
        id: "respond",
        kind: "llm",
        role: "roles/role.md",
        route: "human",
        inputs: ["request"],
        output: "response",
      }],
    }),
  );
  const runs = path.join(temp, "runs");
  run(["run", wf, "--run-id", "human", ...opts(runs)]);
  let s = JSON.parse(
    await readFile(path.join(runs, "human/state.json"), "utf8"),
  );
  assert.equal(s.status, "waiting-human");
  const prompt = path.join(runs, "human/steps/respond/v1/a1/prompt.md");
  assert.match(await readFile(prompt, "utf8"), /Request/);
  await writeFile(
    path.join(runs, "human/steps/respond/v1/a1/output.md"),
    "Human response.",
  );
  run(["continue", "--run-id", "human", ...opts(runs)]);
  s = JSON.parse(await readFile(path.join(runs, "human/state.json"), "utf8"));
  assert.equal(s.status, "completed");
  assert.deepEqual(await readdir(path.join(runs, "human/steps/respond")), ["v1"]);
  assert.equal(
    await readFile(path.join(runs, "human/artifacts/response"), "utf8"),
    "Human response.",
  );
});

test("human resume reads the response from its current attempt version", async (t) => {
  const temp = await setup(); t.after(() => rm(temp, { recursive: true, force: true }));
  const runDir = path.join(temp, "run");
  const current = path.join(runDir, "steps/respond/v2/a1");
  await mkdir(path.join(runDir, "steps/respond/v1/a1"), { recursive: true });
  await mkdir(current, { recursive: true });
  await writeFile(path.join(runDir, "steps/respond/v1/a1/output.md"), "stale answer");
  await writeFile(path.join(current, "output.md"), "current answer");
  const { humanGateway } = await import("../src/llm/gateways/human.js");
  assert.equal(await humanGateway({ step: { id: "respond" }, version: 2, dir: current, runDir, prompt: "prompt", resumeHuman: true }), "current answer");
});
test("ready commands run concurrently within the configured limit", async (t) => {
  const temp = await setup();
  t.after(() => rm(temp, { recursive: true, force: true }));
  const dir = path.join(temp, "wf");
  await mkdir(dir, { recursive: true });
  const runs = path.join(temp, "runs");
  const left = path.join(temp, "left.started");
  const right = path.join(temp, "right.started");
  for (
    const [name, own, other, output] of [["left", left, right, "left-result"], [
      "right",
      right,
      left,
      "right-result",
    ]]
  ) {
    const script = path.join(dir, name + ".js");
    const code =
      `const fs=require('node:fs');const m=JSON.parse(fs.readFileSync(process.env.AIP_MANIFEST));fs.writeFileSync(${
        JSON.stringify(own)
      },'1');const until=Date.now()+1500;while(!fs.existsSync(${
        JSON.stringify(other)
      })&&Date.now()<until){}if(!fs.existsSync(${
        JSON.stringify(other)
      }))process.exit(3);fs.writeFileSync(m.outputs[${
        JSON.stringify(output)
      }],'ok');`;
    await writeFile(script, code);
  }
  const wf = path.join(dir, "workflow.json");
  await writeFile(
    wf,
    JSON.stringify({
      id: "parallel",
      inputs: {},
      steps: [
        { id: "start", kind: "exec", argv: ["node", "-e", ""], outputs: [], next: ["left", "right"] },
        {
          id: "left",
          kind: "exec",
          argv: ["node", "left.js"],
          inputs: [],
          outputs: ["left-result"],
          next: ["left2"],
        },
        {
          id: "right",
          kind: "exec",
          argv: ["node", "right.js"],
          inputs: [],
          outputs: ["right-result"],
          next: ["right2"],
        },
        { id: "left2", kind: "exec", argv: ["node", "-e", ""], outputs: [], next: ["join"] },
        { id: "right2", kind: "exec", argv: ["node", "-e", ""], outputs: [], next: ["join"] },
        { id: "join", kind: "exec", argv: ["node", "-e", ""], outputs: [], waitFor: ["left2", "right2"], next: [] },
      ],
    }),
  );
  run(["run", wf, "--run-id", "parallel", ...opts(runs), "--parallel", "2"]);
  const s = JSON.parse(
    await readFile(path.join(runs, "parallel/state.json"), "utf8"),
  );
  assert.equal(s.status, "completed");
});

async function engineRun(t, steps, gateway = async () => "VERDICT: PASS", inputs = {}) {
  const temp = await setup();
  t.after(() => rm(temp, { recursive: true, force: true }));
  await writeFile(path.join(temp, "role.md"), "Respond.");
  const definition = { id: "flow", inputs, steps };
  const inputFiles = {};
  for (const [id, file] of Object.entries(inputs)) {
    inputFiles[id] = path.join(temp, file);
    await writeFile(inputFiles[id], "Initial value.");
  }
  validateDefinition(definition);
  const state = await initializeState(temp, definition, "", inputFiles);
  await schedule({ definition, definitionDir: temp, runDir: temp, state, gateway });
  return { temp, state, definition, gateway };
}
const command = (id, next, waitFor = []) => ({ id, kind: "exec", argv: ["node", "-e", ""], outputs: [], next, waitFor });
const textStep = (id, inputs, output, next) => ({ id, kind: "llm", role: "role.md", route: "local", inputs, output, next });
test("two decisions do not reactivate an unselected dependency path", async (t) => {
  const { state } = await engineRun(t, [
    textStep("a", ["repair-value"], "a-value", ["g1"]),
    { id: "g1", kind: "decide", source: "a-value", cases: [{when: ["PASS"], goto: "b"}, {when: ["FAIL"], goto: "repair"}] },
    textStep("repair", ["b-value"], "repair-value", ["a"]),
    textStep("b", [], "b-value", ["g2"]),
    { id: "g2", kind: "decide", source: "b-value", cases: [{when: ["FAIL"], goto: "repair"}, {when: ["PASS"], goto: "end"}] },
    command("end", []),
  ], undefined, { "repair-value": "seed.md" });
  assert.equal(state.status, "completed", state.error);
  assert.equal(state.steps.a.attempts, 1);
  assert.equal(state.steps.repair.attempts, 0);
  assert.deepEqual(state.rounds.g1, {});
});
test("unmatched decision fails with reason; first matching case wins over default", async (t) => {
  const steps = [textStep("source", [], "value", ["gate"]),
    { id: "gate", kind: "decide", source: "value", cases: [{ when: ["OTHER"], goto: "end" }] }, command("end", [])];
  const result = await engineRun(t, steps);
  assert.equal(result.state.status, "failed");
  assert.match(result.state.error, /no matching case/);
  assert.deepEqual(result.state.frontier, ["gate"]);
  steps[1].default = "end";
  const fallback = await engineRun(t, steps);
  assert.equal(fallback.state.status, "completed");
  steps[1].cases = [{when: ["PASS"], goto: "end"}, {when: ["PASS"], goto: "source"}];
  steps[1].default = "source";
  steps[1].next = ["source"];
  const matched = await engineRun(t, steps);
  assert.equal(matched.state.status, "completed");
  assert.equal(matched.state.steps.source.attempts, 1);
});
test("waitFor requires fresh completions on every activation and survives continue", async (t) => {
  const result = await engineRun(t, [command("start", ["a", "b"]),
    command("a", ["join"]), command("b", ["join"]),
    command("join", ["again"], ["a", "b"]), command("again", ["a"])]);
  const { state, definition, temp, gateway } = result;
  assert.equal(state.status, "completed");
  assert.deepEqual(state.frontier, []);
  assert.equal(state.steps.join.attempts, 1);
  assert.equal(state.steps.a.attempts, 2);
  assert.equal(state.steps.b.attempts, 1);
  definition.steps.find(step => step.id === "join").next = [];
  state.frontier.push("a", "b", "join");
  await saveState(temp, state);
  const restored = await loadState(temp);
  await schedule({ definition, definitionDir: temp, runDir: temp, state: restored, gateway, parallel: 1 });
  assert.equal(restored.status, "completed");
  assert.equal(restored.steps.join.attempts, 2);
});

test("waitFor ignores completions from before a failed join rerun", async (t) => {
  const temp = await setup();
  t.after(() => rm(temp, { recursive: true, force: true }));
  const definition = { id: "flow", inputs: {}, steps: [
    command("a", ["join"]),
    { ...command("b", ["join"]), inputs: ["missing-input"] },
    { ...textStep("join", [], "gate-value", ["gate"]), waitFor: ["a", "b"] },
    { id: "gate", kind: "decide", source: "gate-value", cases: [] },
  ] };
  const state = await initializeState(temp, definition, "", {});
  state.frontier = ["a", "b", "join"];
  state.sequence = 3;
  state.steps.a.completedSequence = 1;
  state.steps.b.completedSequence = 2;
  state.steps.join.status = "completed";
  state.steps.join.completedSequence = 1;
  state.steps.join.startedSequence = 3;
  await schedule({ definition, definitionDir: temp, runDir: temp, state, gateway: async () => "ok" });
  assert.equal(state.steps.join.attempts, 0);
  assert.equal(state.status, "waiting-input");
  assert.deepEqual(state.frontier, ["b", "join"]);
});

test("failed join continues after upstream completion and rerun --from join runs it again", async (t) => {
  const temp = await setup();
  t.after(() => rm(temp, { recursive: true, force: true }));
  const dir = path.join(temp, "wf");
  await mkdir(dir);
  await writeFile(path.join(dir, "role.md"), "Respond.");
  const wf = path.join(dir, "workflow.json");
  const definition = { id: "join-retry", inputs: {}, steps: [
    command("start", ["a", "b"]), command("a", ["join"]), command("b", ["join"]),
    { ...textStep("join", [], "joined", ["after"]), waitFor: ["a", "b"] },
    command("after", []),
  ] };
  await writeFile(wf, JSON.stringify(definition));
  const runs = path.join(temp, "runs");
  const fixture = path.join(temp, "fixture");
  await mkdir(fixture);
  run(["run", wf, "--run-id", "join", ...opts(runs), "--llm", fixture], 1);
  let state = JSON.parse(await readFile(path.join(runs, "join/state.json"), "utf8"));
  assert.match(state.status, /^(failed|stopped: fixture-missing)/);
  assert.equal(state.steps.join.status, "failed");
  assert.equal(state.steps.a.status, "completed");
  assert.equal(state.steps.b.status, "completed");
  await writeFile(path.join(fixture, "join.md"), "joined");
  run(["continue", "--run-id", "join", ...opts(runs), "--llm", fixture]);
  state = JSON.parse(await readFile(path.join(runs, "join/state.json"), "utf8"));
  assert.equal(state.status, "completed", state.error);
  assert.equal(state.steps.join.attempts, 2);
  assert.equal(state.steps.after.attempts, 1);

  const rerunFixture = path.join(temp, "rerun-fixture");
  await mkdir(rerunFixture);
  run(["run", wf, "--run-id", "rerun", ...opts(runs), "--llm", rerunFixture], 1);
  state = JSON.parse(await readFile(path.join(runs, "rerun/state.json"), "utf8"));
  assert.equal(state.steps.join.status, "failed");
  await writeFile(path.join(rerunFixture, "join.md"), "joined");
  run(["rerun", "--run-id", "rerun", "--from", "join", ...opts(runs), "--llm", rerunFixture]);
  state = JSON.parse(await readFile(path.join(runs, "rerun/state.json"), "utf8"));
  assert.equal(state.status, "completed", state.error);
  assert.equal(state.steps.join.attempts, 2);
  assert.equal(state.steps.after.attempts, 1);
});

test("failed join retry keeps the wait baseline from its launch", async (t) => {
  const temp = await setup();
  t.after(() => rm(temp, { recursive: true, force: true }));
  const definition = { id: "join-baseline", inputs: {}, steps: [
    command("a", []), command("b", []), { ...textStep("join", [], "joined", []), waitFor: ["a", "b"] },
  ] };
  const state = await initializeState(temp, definition, "", {});
  await writeFile(path.join(temp, "role.md"), "Respond.");
  state.frontier = ["join"];
  state.sequence = 4;
  Object.assign(state.steps.a, { status: "completed", completedSequence: 4 });
  Object.assign(state.steps.b, { status: "completed", completedSequence: 4 });
  Object.assign(state.steps.join, { status: "completed", startedSequence: 3, completedSequence: 4 });
  let fail = true;
  await schedule({ definition, definitionDir: temp, runDir: temp, state, gateway: async () => {
    if (fail) { fail = false; throw new Error("first launch fails"); }
    return "joined";
  } });
  assert.equal(state.steps.join.status, "failed");
  const waitBaseline = state.steps.join.waitBaseline;
  state.frontier = ["join"];
  await schedule({ definition, definitionDir: temp, runDir: temp, state, gateway: async () => "joined" });
  assert.equal(waitBaseline, 3);
  assert.equal(state.status, "completed", state.error);
  assert.equal(state.steps.join.attempts, 2);
  assert.equal(Object.hasOwn(state.steps.join, "waitBaseline"), false);
});

test("rerun clears scheduling state from every step while continue retains it", async (t) => {
  const temp = await setup(); t.after(() => rm(temp, { recursive: true, force: true }));
  const dir = path.join(temp, "wf"); await mkdir(dir);
  await writeFile(path.join(dir, "role.md"), "Respond.");
  const workflow = path.join(dir, "workflow.json");
  const definition = { id: "reset-scheduling", inputs: {}, steps: [
    command("before", ["target"]), command("target", [], ["before"]), command("later", [], ["before"]),
  ] };
  await writeFile(workflow, JSON.stringify(definition));
  const runs = path.join(temp, "runs"); const fixture = path.join(temp, "fixture"); await mkdir(fixture);
  run(["run", workflow, "--run-id", "rerun-state", ...opts(runs), "--llm", fixture]);
  const statePath = path.join(runs, "rerun-state/state.json");
  let state = JSON.parse(await readFile(statePath, "utf8"));
  state.sequence = 5;
  state.steps.before.completedSequence = 5;
  for (const id of ["before", "target", "later"]) Object.assign(state.steps[id], {
    pendingSelection: { selected: "stale", index: 0 }, reactivated: true, waitBaseline: 17,
  });
  await writeFile(statePath, JSON.stringify(state));
  run(["rerun", "--run-id", "rerun-state", "--from", "target", ...opts(runs), "--llm", fixture]);
  state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.status, "completed", state.error);
  for (const id of ["before", "target", "later"]) for (const key of ["pendingSelection", "reactivated", "waitBaseline"]) {
    assert.equal(Object.hasOwn(state.steps[id], key), false, `${id}.${key}`);
  }

  state.frontier = ["later"];
  for (const id of ["later"]) Object.assign(state.steps[id], {
    pendingSelection: { selected: "preserve", index: 2 }, reactivated: true, waitBaseline: 23,
  });
  await writeFile(statePath, JSON.stringify(state));
  run(["continue", "--run-id", "rerun-state", ...opts(runs), "--llm", fixture]);
  state = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(state.steps.later.pendingSelection, { selected: "preserve", index: 2 });
  assert.equal(state.steps.later.reactivated, true);
  assert.equal(state.steps.later.waitBaseline, 23);
});

test("rerun clears a stale pending selection on a step reached by a backward route", async (t) => {
  const temp = await setup(); t.after(() => rm(temp, { recursive: true, force: true }));
  const dir = path.join(temp, "wf"); await mkdir(dir);
  const choice = path.join(dir, "choice.md"); await writeFile(choice, "VERDICT: fresh\n");
  const workflow = path.join(dir, "workflow.json");
  const definition = { id: "rerun-backward-selection", inputs: { choice: "choice.md" }, steps: [
    { id: "decision", kind: "decide", source: "choice", cases: [
      { when: ["fresh"], goto: "fresh" }, { when: ["stale"], goto: "stale" },
    ] },
    command("target", ["decision"]), command("stale", []), command("fresh", []),
  ] };
  await writeFile(workflow, JSON.stringify(definition));
  const runs = path.join(temp, "runs"); const fixture = path.join(temp, "fixture"); await mkdir(fixture);
  run(["run", workflow, "--run-id", "backward-selection", ...opts(runs), "--llm", fixture]);
  const statePath = path.join(runs, "backward-selection/state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.steps.decision.pendingSelection = { selected: "stale", index: 1 };
  await writeFile(statePath, JSON.stringify(state));
  run(["rerun", "--run-id", "backward-selection", "--from", "target", ...opts(runs), "--llm", fixture]);
  const rerunState = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(rerunState.status, "completed", rerunState.error);
  assert.equal(rerunState.steps.decision.selected, "fresh");
});

test("waitFor activates a join once before advancing its decision", async (t) => {
  const { state } = await engineRun(t, [
    command("start", ["a", "b"]),
    command("a", ["join"]),
    command("b", ["join"]),
    { ...textStep("join", [], "gate-value", ["gate"]), waitFor: ["a", "b"] },
    { id: "gate", kind: "decide", source: "gate-value", cases: [{ when: ["PASS"], goto: "end" }] },
    command("end", []),
  ], async () => "VERDICT: PASS");
  assert.equal(state.status, "completed", state.error);
  assert.equal(state.steps.join.attempts, 1);
  assert.deepEqual(state.rounds.gate, {});
});

test("activation during execution schedules another version", async (t) => {
  const slow = textStep("slow", [], "result", []);
  const { state } = await engineRun(t, [command("start", ["fast", "slow"]),
    textStep("fast", [], "signal", ["slow"]), slow], async ({step}) => {
    if (step.id === "slow") await new Promise(resolve => setTimeout(resolve, 40));
    return "ok";
  });
  assert.equal(state.status, "completed", state.error);
  assert.equal(state.steps.slow.attempts, 2);
});

test("activation during execution is saved before the running step completes", async (t) => {
  const temp = await setup(); t.after(() => rm(temp, { recursive: true, force: true }));
  await writeFile(path.join(temp, "role.md"), "role");
  const definition = { id: "persist-reactivation", inputs: {}, steps: [
    command("start", ["fast", "slow"]),
    textStep("fast", [], "signal", ["slow"]),
    textStep("slow", [], "result", []),
  ] };
  const runDir = path.join(temp, "run"); await mkdir(runDir, { recursive: true });
  const state = await initializeState(runDir, definition, "workflow.json", {});
  let releaseSlow; let slowStarted;
  const started = new Promise(resolve => { slowStarted = resolve; });
  let firstSlow = true;
  const resultPromise = schedule({ definition, definitionDir: temp, runDir, state, gateway: async ({ step }) => {
    if (step.id === "slow" && firstSlow) { firstSlow = false; slowStarted(); await new Promise(resolve => { releaseSlow = resolve; }); }
    return "ok";
  } });
  await started;
  await new Promise(resolve => setTimeout(resolve, 20));
  const saved = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
  const observed = saved.steps.slow.reactivated === true;
  releaseSlow();
  const result = await resultPromise;
  assert.equal(result.status, "completed", result.error);
  assert.equal(observed, true);
  assert.equal(result.steps.slow.attempts, 2);
});

test("a saved pending decision resumes with one case count and commits its frontier", async (t) => {
  const temp = await setup(); t.after(() => rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, "source.md"); await writeFile(source, "VERDICT: PASS");
  const definition = { id: "resume-decision", inputs: { source }, steps: [
    { id: "gate", kind: "decide", source: "source", cases: [{ when: ["PASS"], goto: "finish", max: 3 }] },
    command("finish", []),
  ] };
  const state = await initializeState(temp, definition, "workflow.json", { source });
  state.steps.gate.pendingSelection = { selected: "finish", index: 0 };
  await saveState(temp, state);
  const result = await schedule({ definition, definitionDir: temp, runDir: temp, state, gateway: async () => "" });
  assert.equal(result.status, "completed", result.error);
  assert.equal(result.rounds.gate[0], 1);
  assert.equal(result.steps.gate.selected, "finish");
  assert.equal(Object.hasOwn(result.steps.gate, "pendingSelection"), false);
});

test("exec arguments that resemble paths are passed through without file checks", async (t) => {
  const temp = await setup();
  t.after(() => rm(temp, { recursive: true, force: true }));
  const wf = path.join(temp, "workflow.json");
  await writeFile(wf, JSON.stringify({ id: "args", inputs: {}, steps: [{ id: "run", kind: "exec", argv: [process.execPath, "-e", "process.exit(process.argv[1] === './not-a-file' ? 0 : 1)", "./not-a-file"], outputs: [] }] }));
  const { loadDefinition } = await import("../src/definition/load.js");
  const loaded = await loadDefinition(wf);
  assert.equal(loaded.definition.steps[0].argv.at(-1), "./not-a-file");
});

test("failed multi-output exec does not publish partial artifacts", async (t) => {
  const temp = await setup();
  t.after(() => rm(temp, { recursive: true, force: true }));
  const wfDir = path.join(temp, "wf"); await mkdir(wfDir);
  const wf = path.join(wfDir, "workflow.json");
  await writeFile(wf, JSON.stringify({ id: "partial", inputs: {}, steps: [{ id: "write", kind: "exec", argv: [process.execPath, "-e", "const fs=require('node:fs');const m=JSON.parse(fs.readFileSync(process.env.AIP_MANIFEST));fs.writeFileSync(m.outputs.a,'new');fs.writeFileSync(m.outputs.b,'new')"], outputs: ["a", "b"] }] }));
  const runs = path.join(temp, "runs"); await mkdir(path.join(runs, "run", "artifacts"), { recursive: true });
  await writeFile(path.join(runs, "run", "artifacts", "a"), "old-a");
  const { definition } = await import("../src/definition/load.js").then(async m => m.loadDefinition(wf));
  const state = await initializeState(path.join(runs, "run"), definition, wf, {});
  const broken = structuredClone(definition); broken.steps[0].argv[2] = "const fs=require('node:fs');const m=JSON.parse(fs.readFileSync(process.env.AIP_MANIFEST));fs.writeFileSync(m.outputs.a,'new')";
  const result = await schedule({ definition: broken, definitionDir: wfDir, runDir: path.join(runs, "run"), state, gateway: async () => "" });
  assert.equal(result.status, "failed");
  assert.equal(await readFile(path.join(runs, "run", "artifacts", "a"), "utf8"), "old-a");
});

test("definition validates transition and join references", () => {
  for (const key of ["next", "waitFor"]) {
    for (const value of ["end", ["missing"], [42]]) {
      assert.throws(() => validateDefinition({ id: "x", inputs: {},
        steps: [{ ...command("start", []), [key]: value }] }), /invalid/);
    }
  }
  assert.throws(() => validateDefinition({ id: "x", inputs: { value: "value.md" },
    steps: [{ id: "gate", kind: "decide", source: "value", cases: [], default: "missing" }] }), /unknown default/);
});

test("runtime inputs resolve from the JSON file and survive continue and rerun", async (t) => {
  const temp = await setup();
  t.after(() => rm(temp, { recursive: true, force: true }));
  const dir = path.join(temp, "workflow");
  const data = path.join(temp, "data");
  await mkdir(dir); await mkdir(data);
  await writeFile(path.join(dir, "kept.md"), "default kept");
  await writeFile(path.join(dir, "role.md"), "Read inputs");
  await writeFile(path.join(data, "replacement.md"), "replacement content");
  const overrides = path.join(data, "inputs.json");
  await writeFile(overrides, JSON.stringify({ source: "replacement.md" }));
  const wf = path.join(dir, "workflow.json");
  await writeFile(wf, JSON.stringify({ id: "override", inputs: { source: "missing-default.md", kept: "kept.md" }, steps: [
    { id: "read", kind: "llm", role: "role.md", route: "test", inputs: ["source", "kept"], output: "result" },
  ] }));
  const runs = path.join(temp, "runs");
  run(["run", wf, "--run-id", "override", ...opts(runs), "--inputs", overrides, "--llm", "human"]);
  let state = await loadState(path.join(runs, "override"));
  assert.equal(state.status, "waiting-human");
  assert.equal(state.artifacts.source.path, path.join(data, "replacement.md"));
  assert.equal(state.artifacts.kept.path, path.join(dir, "kept.md"));
  const prompt = await readFile(path.join(runs, "override/steps/read/v1/a1/prompt.md"), "utf8");
  assert.match(prompt, /replacement content/); assert.match(prompt, /default kept/);
  await rm(overrides);
  await writeFile(path.join(runs, "override/steps/read/v1/a1/output.md"), "response");
  run(["continue", "--run-id", "override", ...opts(runs)]);
  state = await loadState(path.join(runs, "override"));
  assert.equal(state.status, "completed");
  run(["rerun", "--run-id", "override", "--from", "read", ...opts(runs)]);
  state = await loadState(path.join(runs, "override"));
  assert.equal(state.status, "waiting-human");
  assert.match(await readFile(path.join(runs, "override/steps/read/v2/a1/prompt.md"), "utf8"), /replacement content/);
});

test("runtime inputs reject unknown IDs, invalid mappings, and missing paths before creating a run", async (t) => {
  const temp = await setup();
  t.after(() => rm(temp, { recursive: true, force: true }));
  const wf = path.join(temp, "workflow.json");
  await writeFile(path.join(temp, "source.md"), "source");
  await writeFile(wf, JSON.stringify({ id: "inputs", inputs: { source: "source.md" }, steps: [] }));
  const cases = [
    [{ typo: "source.md" }, /unknown input id: typo/],
    [null, /object mapping input ids to paths/],
    [[], /object mapping input ids to paths/],
    [{ source: 42 }, /object mapping input ids to paths/],
    [{ source: "absent.md" }, /missing input file for source/],
  ];
  for (const [value, message] of cases) {
    const file = path.join(temp, "inputs.json");
    await writeFile(file, JSON.stringify(value));
    const result = spawnSync(process.execPath, [cli, "run", wf, "--run-id", "invalid", ...opts(path.join(temp, "runs")), "--inputs", file], { encoding: "utf8" });
    assert.equal(result.status, 1); assert.match(result.stderr, message);
  }
  assert.deepEqual((await readdir(temp)).sort(), ["inputs.json", "source.md", "workflow.json"]);
  run(["run", wf, "--run-id", "empty", ...opts(path.join(temp, "runs")), "--inputs"], 1);
});

test('components use the exec manifest and CLI directory survives continue and rerun', async (t) => {
  const temp = await setup();
  t.after(() => rm(temp, { recursive: true, force: true }));
  const components = path.join(temp, 'components');
  const component = path.join(components, 'transform');
  await mkdir(component, { recursive: true });
  const entry = path.join(component, 'run.mjs');
  await writeFile(entry, `import {readFile, writeFile} from 'node:fs/promises';
const m = JSON.parse(await readFile(process.env.AIP_MANIFEST, 'utf8'));
const input = await readFile(m.inputs.source.path, 'utf8');
await writeFile(m.outputs.result, JSON.stringify({input, previous:m.inputs.source.previous, version:m.version, stepId:m.stepId}));`);
  await writeFile(path.join(temp, 'input.md'), 'source contents');
  const workflow = path.join(temp, 'workflow.json');
  const definition = { id: 'components', inputs: {source: 'input.md'}, steps: [
    {id: 'transform', kind: 'exec', component: 'transform', inputs: ['source'], outputs: ['result']},
  ] };
  await writeFile(workflow, JSON.stringify(definition));
  const runs = path.join(temp, 'runs');
  run(['run', workflow, '--run-id', 'override', ...opts(runs), '--components', components]);
  const resultFile = path.join(runs, 'override/artifacts/result');
  assert.deepEqual(JSON.parse(await readFile(resultFile, 'utf8')), {
    input: 'source contents', previous: [], version: 1, stepId: 'transform',
  });
  // A failed component remains pending and can be repaired in place.
  await writeFile(entry, 'throw new Error("broken component");');
  run(['rerun', '--run-id', 'override', '--from', 'transform', ...opts(runs)], 1);
  await writeFile(entry, `import {readFile, writeFile} from 'node:fs/promises';
const m = JSON.parse(await readFile(process.env.AIP_MANIFEST, 'utf8'));
await writeFile(m.outputs.result, 'repaired');`);
  run(['continue', '--run-id', 'override', ...opts(runs)]);
  assert.equal(await readFile(resultFile, 'utf8'), 'repaired');
  definition.components = 'components';
  await writeFile(workflow, JSON.stringify(definition));
  run(['run', workflow, '--run-id', 'relative', ...opts(runs)]);
  assert.equal(await readFile(path.join(runs, 'relative/artifacts/result'), 'utf8'), 'repaired');
  definition.components = 'absent-directory';
  await writeFile(workflow, JSON.stringify(definition));
  run(['run', workflow, '--run-id', 'precedence', ...opts(runs), '--components', components]);
});

test('component exec requires one command form and an existing run.mjs entry', async (t) => {
  const step = {id: 'transform', kind: 'exec', component: 'transform', outputs: []};
  const definition = {id: 'component', inputs: {}, steps: [step]};
  assert.doesNotThrow(() => validateDefinition(definition));
  assert.throws(() => validateDefinition({...definition, steps: [{...step, argv: ['node']}]}), /exactly one/);
  for (const component of ['', '../outside', '/absolute', 'nested/name']) {
    assert.throws(() => validateDefinition({...definition, steps: [{...step, component}]}), /exactly one/);
  }
  const temp = await setup();
  t.after(() => rm(temp, { recursive: true, force: true }));
  const workflow = path.join(temp, 'workflow.json');
  await writeFile(workflow, JSON.stringify(definition));
  assert.match(run(['run', workflow, '--run-id', 'no-dir', ...opts(temp)], 1), /^$/);
  const result = spawnSync(process.execPath, [cli, 'run', workflow, '--run-id', 'missing-entry', ...opts(temp), '--components', temp], {encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing component entry/);
});

test("passing an upstream decision repeatedly does not spend its repair limit", async (t) => {
  const { state } = await engineRun(t, [
    textStep("quality", [], "quality-result", ["quality-gate"]),
    { id: "quality-gate", kind: "decide", source: "quality-result", cases: [
      { when: ["PASS"], goto: "review" }, { when: ["FAIL"], goto: "quality", max: 1 },
    ] },
    textStep("review", [], "review-result", ["review-gate"]),
    { id: "review-gate", kind: "decide", source: "review-result", cases: [
      { when: ["FAIL"], goto: "quality", max: 4 }, { when: ["PASS"], goto: "end" },
    ] }, command("end", []),
  ], async ({step, version}) => `VERDICT: ${step.id === "review" && version <= 4 ? "FAIL" : "PASS"}`);
  assert.equal(state.status, "completed", state.error);
  assert.equal(state.steps["quality-gate"].attempts, 5);
  assert.deepEqual(state.rounds["quality-gate"], {});
  assert.deepEqual(state.rounds["review-gate"], { 0: 4 });
});

test("case counts persist independently even for cases sharing a destination", async (t) => {
  const result = await engineRun(t, [textStep("source", [], "value", ["gate"]),
    { id: "gate", kind: "decide", source: "value", cases: [
      { when: ["A"], goto: "source", max: 1 }, { when: ["B"], goto: "source", max: 2 },
    ] },
  ], async ({version}) => `VERDICT: ${version === 1 ? "A" : "B"}`);
  const { state, temp, definition, gateway } = result;
  assert.equal(state.status, "stopped: max-rounds");
  assert.deepEqual(state.rounds.gate, { 0: 1, 1: 2 });
  assert.equal(state.steps.source.attempts, 4);
  assert.equal(state.steps.gate.attempts, 3);
  const restored = await loadState(temp);
  await schedule({definition, definitionDir: temp, runDir: temp, state: restored, gateway});
  assert.equal(restored.status, "stopped: max-rounds");
  assert.deepEqual(restored.rounds.gate, { 0: 1, 1: 2 });
  assert.equal(restored.steps.gate.attempts, 3);
  // Numeric totals from old saved states cannot identify a selected case.
  restored.rounds.gate = 99;
  await saveState(temp, restored);
  const legacy = await loadState(temp);
  assert.deepEqual(legacy.rounds.gate, {});
  await schedule({definition, definitionDir: temp, runDir: temp, state: legacy, gateway});
  assert.equal(legacy.status, "stopped: max-rounds");
  assert.deepEqual(legacy.rounds.gate, { 1: 2 });
  assert.equal(legacy.steps.gate.attempts, 5);
});

test("definition rejects decide max and requires positive integer case limits", () => {
  const gate = { id: "gate", kind: "decide", source: "value", cases: [{when: ["FAIL"], goto: "gate"}] };
  const definition = {id: "limits", inputs: {value: "value.md"}, steps: [gate]};
  validateDefinition(definition);
  gate.max = 1;
  assert.throws(() => validateDefinition(definition), /invalid decide/);
  delete gate.max;
  for (const max of [0, -1, 1.5, null, "2"]) {
    gate.cases[0].max = max;
    assert.throws(() => validateDefinition(definition), /invalid case/);
  }
  gate.cases[0].max = 2;
  validateDefinition(definition);
});
