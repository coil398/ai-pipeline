#!/usr/bin/env node
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { loadDefinition } from "../src/definition/load.js";
import { initializeState, loadState, saveState } from "../src/engine/state.js";
import { schedule } from "../src/engine/scheduler.js";
import { acquireLease } from "../src/engine/lease.js";
import { fixtureGateway } from "../src/llm/gateways/fixture.js";
import { humanGateway } from "../src/llm/gateways/human.js";
import { routeLlm } from "../src/llm/router.js";
import { exists, readText } from "../src/io/files.js";
import { log } from "../src/io/log.js";

const process = /** @type {any} */ (globalThis).process;

const args = process.argv.slice(2);
function option(name, fallback = undefined) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
function usage() {
  console.log(
    "aip run <workflow.json> --run-id <id> [--inputs <file.json>] [--runs-dir <dir>] [--parallel <n>] [--llm <fixture-dir>|run:<run-id>] [--routes <path>] [--gateways <path>]\naip continue --run-id <id>\naip rerun --run-id <id> --from <step>\naip status --run-id <id>\naip render --run-id <id>",
  );
}
async function main() {
  const command = args[0];
  if (!command) return usage();
  const runId = option("--run-id");
  if (!runId) throw new Error("--run-id is required");
  const runsDir = path.resolve(option("--runs-dir", "runs"));
  const runDir = path.join(runsDir, runId);
  const parallel = Number(option("--parallel", "4"));
  if (
    !["status", "render"].includes(command) &&
    (!Number.isInteger(parallel) || parallel < 1)
  ) throw new Error("--parallel must be a positive integer");
  if (command === "status" || command === "render") {
    const state = await loadState(runDir);
    if (command === "status") console.log(JSON.stringify(state, null, 2));
    else console.log(renderState(state));
    return;
  }
  if (command === "run") {
    const inputsFile = option("--inputs");
    if (args.includes("--inputs") && (!inputsFile || inputsFile.startsWith("--"))) {
      throw new Error("--inputs requires a JSON file");
    }
    let overrides = {};
    if (inputsFile) {
      const file = path.resolve(inputsFile);
      const value = JSON.parse(await readText(file));
      if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.values(value).some((input) => typeof input !== "string")) {
        throw new Error("--inputs must contain an object mapping input ids to paths");
      }
      overrides = Object.fromEntries(Object.entries(value).map(([id, input]) =>
        [id, path.resolve(path.dirname(file), input)]));
    }
    const loaded = await loadDefinition(args[1], overrides);
    if (inputsFile) log("INFO", "inputs_loaded", {
      run_id: runId, file: path.resolve(inputsFile), count: Object.keys(overrides).length,
    });
    const inputs = Object.fromEntries(
      await Promise.all(
        Object.entries(loaded.definition.inputs).map(async (
          [id, file],
        ) => [id, path.resolve(loaded.directory, file)]),
      ),
    );
    await mkdir(runDir, { recursive: true });
    if (await exists(path.join(runDir, "state.json"))) {
      throw new Error(`run already exists: ${runId}`);
    }
    return withLease(runDir, async () => {
      const state = await initializeState(
        runDir,
        loaded.definition,
        loaded.file,
        inputs,
      );
      await runLoaded(loaded, runDir, state, parallel);
    });
  }
  const initialState = await loadState(runDir);
  const loaded = await loadDefinition(initialState.definitionFile,
    Object.fromEntries(Object.entries(initialState.artifacts)
      .filter(([, artifact]) => artifact.producer === null)
      .map(([id, artifact]) => [id, artifact.path])));
  if (command === "rerun") {
    const start = option("--from");
    const startIndex = loaded.definition.steps.findIndex((step) =>
      step.id === start
    );
    if (!start || startIndex < 0) throw new Error(`unknown step: ${start}`);
    return withLease(runDir, async () => {
      const state = await loadState(runDir);
      state.frontier = [start];
      for (const id of Object.keys(state.rounds)) state.rounds[id] = 0;
      state.status = "running";
      delete state.error;
      await saveState(runDir, state);
      await runLoaded(loaded, runDir, state, parallel);
    });
  }
  if (command !== "continue") return usage();
  return withLease(runDir, async () => {
    const state = await loadState(runDir);
    await runLoaded(loaded, runDir, state, parallel);
  });
}
async function runLoaded(loaded, runDir, state, parallel) {
  const resumeHuman = state.status === "waiting-human";
  const llmMode = option("--llm", state.llmMode ?? "router");
  state.llmMode = llmMode;
  await saveState(runDir, state);
  const definitionDir = path.dirname(loaded.file);
  const routesFile = path.resolve(
    option("--routes", path.join(definitionDir, "routes.json")),
  );
  const gatewaysFile = path.resolve(
    option("--gateways", path.join(definitionDir, "gateways.json")),
  );
  const routes = await exists(routesFile)
    ? JSON.parse(await readText(routesFile))
    : {};
  const gateways = await exists(gatewaysFile)
    ? JSON.parse(await readText(gatewaysFile))
    : {};
  let gateway;
  if (llmMode === "router") {
    gateway = async (context) => {
      if (context.step.route === "human") {
        return namedResult(
          await humanGateway({ ...context, resumeHuman }),
          "human",
        );
      }
      return routeLlm({
        route: context.step.route,
        prompt: context.prompt,
        routes,
        gateways,
      });
    };
  } else if (llmMode.startsWith("run:")) {
    const source = path.join(
      path.resolve(option("--runs-dir", "runs")),
      llmMode.slice(4),
      "steps",
    );
    gateway = async ({ step, version }) => {
      const file = path.join(source, step.id, `v${version}`, "a1", "output.md");
      if (!await exists(file)) {
        throw new Error(`stopped: fixture-missing ${file}`);
      }
      return namedResult(await readText(file), "fixture");
    };
  } else if (llmMode === "human") {
    gateway = async (context) =>
      namedResult(await humanGateway({ ...context, resumeHuman }), "human");
  } else {
    const fixture = fixtureGateway(path.resolve(llmMode));
    gateway = async (context) => namedResult(await fixture(context), "fixture");
  }
  const started = Date.now();
  log("INFO", "run_start", {
    run_id: state.runId,
    workflow: loaded.definition.id,
    steps: loaded.definition.steps.length,
  });
  const result = await schedule({
    definition: loaded.definition,
    definitionDir: loaded.directory,
    runDir,
    state,
    gateway,
    parallel,
  });
  log(result.status === "failed" ? "ERROR" : "INFO", "run_done", {
    run_id: state.runId,
    status: result.status,
    elapsed_ms: Date.now() - started,
  });
  if (result.error) {
    log("ERROR", "run_error", { run_id: state.runId, detail: result.error });
  }
  console.log(`${result.status} run_id=${state.runId}`);
  if (
    result.status === "failed" || result.status === "stopped: max-rounds" ||
    result.status.startsWith("stopped: fixture-missing")
  ) process.exitCode = 1;
}
function namedResult(text, gateway) {
  return {
    text,
    gateway,
    model: null,
    effort: null,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    tried: [{ gateway, result: "success" }],
  };
}
function renderState(state) {
  return [
    `Run ${state.runId}: ${state.status}`,
    ...Object.entries(state.steps).map(([id, value]) =>
      `- ${id}: ${value.status}${value.selected ? ` -> ${value.selected}` : ""}`
    ),
    ...Object.entries(state.rounds).map(([id, count]) =>
      `- ${id} round=${count}`
    ),
  ].join("\n");
}
async function withLease(runDir, action) {
  const release = await acquireLease(path.join(runDir, "run.lease"));
  try {
    await action();
  } finally {
    await release();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
