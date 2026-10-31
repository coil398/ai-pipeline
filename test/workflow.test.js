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
  assert.equal(s.rounds.gate, 2);
  assert.match(
    await readFile(
      path.join(runs, "loop/steps/revise/v1/a1/prompt.md"),
      "utf8",
    ),
    /VERDICT: FAIL/,
  );
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
  assert.equal(s.rounds.gate, 3);
  assert.deepEqual(s.frontier, ["gate"]);
  assert.equal(s.steps.gate.attempts, 3);
  await writeFile(path.join(fixture, "critic.md"), "VERDICT: PASS\nReady.\n");
  run(["rerun", "--run-id", "loop", "--from", "revise", ...opts(runs)]);
  s = JSON.parse(await readFile(path.join(runs, "loop/state.json"), "utf8"));
  assert.equal(s.status, "completed", s.error);
  assert.equal(s.rounds.gate, 1);
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
  await writeFile(wf, JSON.stringify(d));
  run(["continue", "--run-id", "retry", ...opts(runs)]);
  s = JSON.parse(await readFile(path.join(runs, "retry/state.json"), "utf8"));
  assert.equal(s.status, "completed");
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
          max: 1,
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
  assert.equal(
    await readFile(path.join(runs, "human/artifacts/response"), "utf8"),
    "Human response.",
  );
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
    { id: "g1", kind: "decide", source: "a-value", max: 2, cases: [{when: ["PASS"], goto: "b"}, {when: ["FAIL"], goto: "repair"}] },
    textStep("repair", ["b-value"], "repair-value", ["a"]),
    textStep("b", [], "b-value", ["g2"]),
    { id: "g2", kind: "decide", source: "b-value", max: 2, cases: [{when: ["FAIL"], goto: "repair"}, {when: ["PASS"], goto: "end"}] },
    command("end", []),
  ], undefined, { "repair-value": "seed.md" });
  assert.equal(state.status, "completed", state.error);
  assert.equal(state.steps.a.attempts, 1);
  assert.equal(state.steps.repair.attempts, 0);
  assert.equal(state.rounds.g1, 1);
});
test("unmatched decision fails with reason; first matching case wins over default", async (t) => {
  const steps = [textStep("source", [], "value", ["gate"]),
    { id: "gate", kind: "decide", source: "value", max: 1, cases: [{ when: ["OTHER"], goto: "end" }] }, command("end", [])];
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
  assert.equal(state.status, "waiting-input");
  assert.deepEqual(state.frontier, ["join"]);
  assert.equal(state.steps.join.attempts, 1);
  assert.equal(state.steps.a.attempts, 2);
  assert.equal(state.steps.b.attempts, 1);
  definition.steps.find(step => step.id === "join").next = [];
  state.frontier.push("b");
  await saveState(temp, state);
  const restored = await loadState(temp);
  await schedule({ definition, definitionDir: temp, runDir: temp, state: restored, gateway, parallel: 1 });
  assert.equal(restored.status, "completed");
  assert.equal(restored.steps.join.attempts, 2);
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

test("definition validates transition and join references", () => {
  for (const key of ["next", "waitFor"]) {
    for (const value of ["end", ["missing"], [42]]) {
      assert.throws(() => validateDefinition({ id: "x", inputs: {},
        steps: [{ ...command("start", []), [key]: value }] }), /invalid/);
    }
  }
  assert.throws(() => validateDefinition({ id: "x", inputs: { value: "value.md" },
    steps: [{ id: "gate", kind: "decide", source: "value", max: 1, cases: [], default: "missing" }] }), /unknown default/);
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
  assert.match(await readFile(path.join(runs, "override/steps/read/v3/a1/prompt.md"), "utf8"), /replacement content/);
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
