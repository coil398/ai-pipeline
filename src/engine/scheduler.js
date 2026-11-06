import path from "node:path";
import { readdir } from "node:fs/promises";
import { copyFile, rename, rm, writeFile } from "node:fs/promises";
import { atomicJson, ensureDir, exists, readText } from "../io/files.js";
import { renderPrompt, runLlm } from "../steps/llm.js";
import { runExec } from "../steps/exec.js";
import { chooseCase } from "../steps/decide.js";
import { saveState } from "./state.js";
import { log } from "../io/log.js";

const process = /** @type {any} */ (globalThis).process;
const attemptDir = (runDir, step, version) =>
  path.join(runDir, "steps", step.id, `v${version}`, "a1");

/** @param {{definition: any, definitionDir: string, runDir: string, state: any, gateway: Function, parallel?: number}} options */
export async function schedule(
  { definition, definitionDir, runDir, state, gateway, parallel = 4 },
) {
  try {
    state.status = "running";
    delete state.error;
    await saveState(runDir, state);
    for (;;) {
      if (!state.frontier.length) {
        state.status = "completed";
        break;
      }
      const batch = [];
      const claimedOutputs = new Set();
      for (const id of state.frontier) {
        const step = definition.steps.find((item) => item.id === id);
        const record = state.steps[id];
        if (!(await allInputsExist(step, state))) continue;
        const waitSequence = record.status === "completed"
          ? (record.startedSequence ?? record.completedSequence ?? 0)
          : (record.completedSequence ?? 0);
        if (!(step.waitFor ?? []).every((source) =>
          (state.steps[source].completedSequence ?? 0) > waitSequence
        )) continue;
        if (step.kind === "decide") {
          if (!batch.length) batch.push(step);
          break;
        }
        const outputs = step.kind === "map" ? [step.output] : step.outputs ?? [step.output];
        if (outputs.some((output) => claimedOutputs.has(output))) continue;
        batch.push(step);
        for (const output of outputs) claimedOutputs.add(output);
        if (batch.length >= parallel) break;
      }
      if (!batch.length) {
        state.frontier = state.frontier.filter((id) => {
          const step = definition.steps.find((item) => item.id === id);
          return !(step?.waitFor?.length && step.waitFor.every((source) =>
            !state.frontier.includes(source)
          ));
        });
        if (!state.frontier.length) continue;
        state.status = "waiting-input";
        break;
      }
      const decision = batch.find((step) => step.kind === "decide");
      const selectedCase = decision
        ? chooseCase(decision, await readText(state.artifacts[decision.source].path)) : null;
      if (selectedCase?.max !== undefined) {
        const index = decision.cases.indexOf(selectedCase);
        const counts = state.rounds[decision.id] ??= {};
        if (!state.steps[decision.id].pendingSelection && (counts[index] ?? 0) >= selectedCase.max) {
          log("INFO", "case_limit", { run_id: state.runId, step_id: decision.id, case_index: index, count: counts[index], max: selectedCase.max });
          state.status = "stopped: max-rounds";
          break;
        }
      }
      if (decision && !state.steps[decision.id].pendingSelection) {
        const index = selectedCase ? decision.cases.indexOf(selectedCase) : undefined;
        state.steps[decision.id].pendingSelection = {
          selected: selectedCase?.goto ?? decision.default,
          ...(selectedCase?.max !== undefined ? { index } : {}),
        };
        await saveState(runDir, state);
      }
      const active = new Set(batch.map((step) => step.id));
      const outcomes = await Promise.allSettled(batch.map(async (step) => {
        const record = state.steps[step.id];
        record.startedSequence = ++state.sequence;
        const started = Date.now();
        log("INFO", "step_start", { run_id: state.runId, step_id: step.id, version: record.attempts + 1 });
        try {
          await execute({ step, definition, definitionDir, runDir, state, gateway, selectedCase, parallel });
          record.status = "completed";
          record.completedAt = new Date().toISOString();
          record.completedSequence = ++state.sequence;
          active.delete(step.id);
          const reactivated = Boolean(record.reactivated);
          delete record.reactivated;
          if (!reactivated) {
            state.frontier = state.frontier.filter((id) => id !== step.id);
          } else if (!state.frontier.includes(step.id)) {
            state.frontier.push(step.id);
          }
          const index = definition.steps.indexOf(step);
          const next = step.kind === "decide" ? [record.selected]
            : step.next ?? (definition.steps[index + 1] ? [definition.steps[index + 1].id] : []);
          for (const id of next) {
            if (active.has(id)) state.steps[id].reactivated = true;
            if (!state.frontier.includes(id)) state.frontier.push(id);
          }
          if (step.kind === "decide" && record.pendingSelection?.index !== undefined) {
            const counts = state.rounds[step.id] ??= {};
            counts[record.pendingSelection.index] = (counts[record.pendingSelection.index] ?? 0) + 1;
          }
          if (step.kind === "decide") delete record.pendingSelection;
          log("INFO", "step_done", { run_id: state.runId, step_id: step.id, next: next.join(","), elapsed_ms: Date.now() - started });
          await saveState(runDir, state);
        } catch (error) {
          log("ERROR", "step_failed", { run_id: state.runId, step_id: step.id, elapsed_ms: Date.now() - started, reason: error.message });
          record.status = error.message === "waiting-human" ? "waiting-human" : "failed";
          await saveState(runDir, state);
          throw error;
        }
      }));
      const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
      const failed = rejected.find((outcome) => outcome.reason.message !== "waiting-human") ?? rejected[0];
      if (failed) throw failed.reason;
    }
    await saveState(runDir, state);
    return state;
  } catch (error) {
    state.status = error.message === "waiting-human"
      ? "waiting-human"
      : error.message.startsWith("stopped:") ? error.message : "failed";
    state.error = error.stack ?? error.message;
    await saveState(runDir, state);
    return state;
  }
}

async function allInputsExist(step, state) {
  for (
    const input of [
      ...(step.inputs ?? []),
      ...(step.kind === "decide" ? [step.source] : []),
      ...(step.kind === "map" ? [step.items] : []),
    ]
  ) {
    if (
      !state.artifacts[input] || !await exists(state.artifacts[input].path)
    ) return false;
  }
  return true;
}
async function execute(
  { step, definition, definitionDir, runDir, state, gateway, selectedCase, parallel = 4 },
) {
  const record = state.steps[step.id];
  const version = record.status === "waiting-human" ? record.attempts
    : step.kind === "map" && ["failed", "running"].includes(record.status) && record.attempts ? record.attempts : ++record.attempts;
  if (step.kind === "map") {
    record.status = "running";
    await saveState(runDir, state);
    return executeMap({ step, version, definition, definitionDir, runDir, state, gateway, parallel });
  }
  const dir = attemptDir(runDir, step, version);
  await ensureDir(dir);
  /** @type {Record<string, string>} */
  const inputs = {};
  for (const id of step.inputs ?? []) {
    inputs[id] = await readText(state.artifacts[id].path);
  }
  for (const id of step.optionalInputs ?? []) {
    if (!Object.hasOwn(inputs, id) && state.artifacts[id] &&
      await exists(state.artifacts[id].path)) {
      inputs[id] = await readText(state.artifacts[id].path);
    }
  }
  record.status = "running";
  await saveState(runDir, state);
  await executeWork({
    step,
    dir,
    version,
    runDir,
    definition,
    definitionDir,
    inputs,
    resolveInputPath: (id) => state.artifacts[id].path,
    outputPath: (id) => path.join(runDir, "artifacts", id),
    state,
    gateway,
  });
  if (step.kind === "decide") {
    const selected = record.pendingSelection?.selected ?? selectedCase?.goto ?? step.default;
    if (!selected) throw new Error(`no matching case in ${step.id} and no default`);
    record.selected = selected;
  }
}

async function executeWork({
  step,
  dir,
  version,
  runDir,
  definition,
  definitionDir,
  inputs,
  resolveInputPath,
  outputPath,
  recordArtifacts = true,
  isMapInner = false,
  state,
  gateway,
}) {
  if (step.kind === "llm") {
    const prompt = await renderPrompt(step, inputs, definitionDir);
    await writeFile(path.join(dir, "prompt.md"), prompt);
    let result;
    try {
      result = await runLlm({
        step,
        prompt,
        gateway,
        context: { version, runDir, dir },
      });
    } catch (error) {
      const tried = error.tried ?? [];
      const usage = tried.reduce((sum, item) => ({
        inputTokens: sum.inputTokens + (item.usage?.inputTokens ?? 0),
        outputTokens: sum.outputTokens + (item.usage?.outputTokens ?? 0),
        totalTokens: sum.totalTokens + (item.usage?.totalTokens ?? 0),
      }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
      await atomicJson(path.join(dir, "usage.json"), {
        gateway: null,
        model: null,
        effort: null,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        ...usage,
        tried,
      });
      throw error;
    }
    const output = typeof result === "string" ? result : result.text;
    await writeFile(path.join(dir, "output.md"), output);
    const tried = result.tried ?? [{ gateway: "human", result: "success" }];
    const usage = tried.reduce((sum, item) => ({
      inputTokens: sum.inputTokens + (item.usage?.inputTokens ?? 0),
      outputTokens: sum.outputTokens + (item.usage?.outputTokens ?? 0),
      totalTokens: sum.totalTokens + (item.usage?.totalTokens ?? 0),
    }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    await atomicJson(path.join(dir, "usage.json"), {
      gateway: result.gateway ?? "human",
      model: result.model ?? null,
      effort: result.effort ?? null,
      ...usage,
      tried,
    });
    const current = outputPath(step.output);
    await ensureDir(path.dirname(current));
    await copyFile(path.join(dir, "output.md"), current);
    if (recordArtifacts) {
      state.artifacts[step.output] = {
        path: current,
        producer: step.id,
        version,
      };
    }
  } else if (step.kind === "exec") {
    const manifest = {
      runId: state.runId,
      stepId: step.id,
      version,
      inputs: {},
      outputs: {},
    };
    for (const id of Object.keys(inputs)) {
      manifest.inputs[id] = {
        path: resolveInputPath(id),
        previous: isMapInner
          ? []
          : await previousArtifactPaths(runDir, id, definition),
      };
    }
    for (const id of step.outputs) {
      manifest.outputs[id] = path.join(dir, "outputs", id);
    }
    const manifestFile = path.join(dir, "manifest.json");
    await atomicJson(manifestFile, manifest);
    for (const output of Object.values(manifest.outputs)) {
      await ensureDir(path.dirname(output));
    }
    await runExec({
      argv: step.argv,
      cwd: definitionDir,
      stderrFile: path.join(dir, "stderr.log"),
      env: { ...process.env, AIP_MANIFEST: manifestFile },
    });
    for (const id of step.outputs) if (!await exists(manifest.outputs[id])) throw new Error(`exec output missing: ${id}`);
    for (const id of step.outputs) {
      const current = outputPath(id);
      await ensureDir(path.dirname(current));
      await copyFile(manifest.outputs[id], current);
      if (recordArtifacts) {
        state.artifacts[id] = { path: current, producer: step.id, version };
      }
    }
  }
}
async function executeMap({ step, version, definition, definitionDir, runDir, state, gateway, parallel }) {
  const values = JSON.parse(await readText(state.artifacts[step.items].path));
  if (!Array.isArray(values)) throw new Error(`map items is not an array: ${step.items}`);
  const root = path.join(runDir, "steps", step.id, `v${version}`, "items");
  const results = new Array(values.length);
  let cursor = 0;
  let firstError;
  const worker = async () => {
    while (!firstError) {
      const index = cursor++;
      if (index >= values.length) return;
      const completedItemRoot = path.join(root, String(index));
      const runningItemRoot = `${completedItemRoot}.running`;
      const last = step.steps.at(-1);
      const lastOutput = (itemRoot) => path.join(
        itemRoot,
        last.id,
        "a1",
        last.kind === "llm" ? "output.md" : "outputs",
        ...(last.kind === "llm" ? [] : [last.outputs.at(-1)]),
      );
      const started = Date.now();
      if (await exists(completedItemRoot)) {
        results[index] = await readText(lastOutput(completedItemRoot));
        continue;
      }
      log("INFO", "map_item_start", { run_id: state.runId, step_id: step.id, index });
      try {
        await rm(runningItemRoot, { recursive: true, force: true });
        const itemRoot = runningItemRoot;
        const artifacts = {
          [step.itemArtifact]: {
            path: path.join(itemRoot, "artifacts", step.itemArtifact),
          },
        };
        await ensureDir(path.dirname(artifacts[step.itemArtifact].path));
        await writeFile(artifacts[step.itemArtifact].path, JSON.stringify(values[index]));
        for (const inner of step.steps) {
          const innerDir = path.join(itemRoot, inner.id, "a1");
          await ensureDir(innerDir);
          const inputs = {};
          const resolveInputPath = (id) =>
            artifacts[id]?.path ?? state.artifacts[id].path;
          for (const id of inner.inputs ?? []) {
            inputs[id] = await readText(resolveInputPath(id));
          }
          for (const id of inner.optionalInputs ?? []) {
            const artifact = artifacts[id] ?? state.artifacts[id];
            if (!Object.hasOwn(inputs, id) && artifact && await exists(artifact.path)) {
              inputs[id] = await readText(artifact.path);
            }
          }
          await executeWork({
            step: inner,
            dir: innerDir,
            version: 1,
            runDir,
            definition,
            definitionDir,
            inputs,
            resolveInputPath,
            outputPath: (id) => path.join(itemRoot, "artifacts", id),
            recordArtifacts: false,
            isMapInner: true,
            state,
            gateway,
          });
          for (const id of inner.kind === "llm" ? [inner.output] : inner.outputs) {
            artifacts[id] = { path: path.join(itemRoot, "artifacts", id) };
          }
        }
        results[index] = await readText(lastOutput(itemRoot));
        await rename(runningItemRoot, completedItemRoot);
        log("INFO", "map_item_done", { run_id: state.runId, step_id: step.id, index, inner_step_id: last.id, elapsed_ms: Date.now() - started });
      } catch (error) {
        firstError ??= error;
        log("ERROR", "map_item_failed", {
          run_id: state.runId,
          step_id: step.id,
          index,
          elapsed_ms: Date.now() - started,
          reason: error.message,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(step.maxConcurrency ?? parallel, values.length) }, worker));
  if (firstError) throw firstError;
  const current = path.join(runDir, "artifacts", step.output);
  await ensureDir(path.dirname(current));
  await writeFile(current, JSON.stringify(results));
  state.artifacts[step.output] = { path: current, producer: step.id, version };
}
async function previousArtifactPaths(runDir, id, definition) {
  const producers = definition.steps.filter((step) =>
    step.output === id || step.outputs?.includes(id)
  );
  const paths = [];
  for (const producer of producers) {
    const root = path.join(runDir, "steps", producer.id);
    let versions = [];
    try {
      versions = await readdir(root);
    } catch {}
    for (
      const version of versions.filter((value) => /^v\d+$/.test(value)).sort((
        a,
        b,
      ) => Number(a.slice(1)) - Number(b.slice(1)))
    ) {
      const llmOutput = path.join(root, version, "a1", "output.md");
      const execOutput = path.join(root, version, "a1", "outputs", id);
      if (await exists(llmOutput) && producer.output === id) {
        paths.push(llmOutput);
      }
      if (await exists(execOutput)) paths.push(execOutput);
    }
  }
  return paths;
}
