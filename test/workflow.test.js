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
  assert.equal(s.rounds.gate, 1);
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
  await writeFile(path.join(fixture, "critic.md"), "VERDICT: PASS\nReady.\n");
  run(["rerun", "--run-id", "loop", "--from", "revise", ...opts(runs)]);
  s = JSON.parse(await readFile(path.join(runs, "loop/state.json"), "utf8"));
  assert.equal(s.status, "completed", s.error);
  assert.equal(s.rounds.gate, 0);
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
    steps: [{
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
  d.steps[0].argv = [
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
        {
          id: "left",
          kind: "exec",
          argv: ["node", "left.js"],
          inputs: [],
          outputs: ["left-result"],
        },
        {
          id: "right",
          kind: "exec",
          argv: ["node", "right.js"],
          inputs: [],
          outputs: ["right-result"],
        },
      ],
    }),
  );
  run(["run", wf, "--run-id", "parallel", ...opts(runs), "--parallel", "2"]);
  const s = JSON.parse(
    await readFile(path.join(runs, "parallel/state.json"), "utf8"),
  );
  assert.equal(s.status, "completed");
});
