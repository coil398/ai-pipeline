import path from "node:path";
import { readdir } from "node:fs/promises";
import { copyFile, writeFile } from "node:fs/promises";
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
        if (!(step.waitFor ?? []).every((source) =>
          (state.steps[source].completedSequence ?? 0) >
            (record.startedSequence ?? record.completedSequence ?? 0)
        )) continue;
        if (step.kind === "decide") {
          if (!batch.length) batch.push(step);
          break;
        }
        const outputs = step.outputs ?? [step.output];
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
      if (decision && state.rounds[decision.id] >= decision.max) {
        state.status = "stopped: max-rounds";
        break;
      }
      const active = new Set(batch.map((step) => step.id));
      const reactivated = new Set();
      const outcomes = await Promise.allSettled(batch.map(async (step) => {
        if (step.kind === "decide") state.rounds[step.id]++;
        const record = state.steps[step.id];
        record.startedSequence = ++state.sequence;
        const started = Date.now();
        log("INFO", "step_start", { run_id: state.runId, step_id: step.id, version: record.attempts + 1 });
        try {
          await execute({ step, definition, definitionDir, runDir, state, gateway });
          record.status = "completed";
          record.completedAt = new Date().toISOString();
          record.completedSequence = ++state.sequence;
          active.delete(step.id);
          if (!reactivated.has(step.id)) {
            state.frontier = state.frontier.filter((id) => id !== step.id);
          }
          const index = definition.steps.indexOf(step);
          const next = step.kind === "decide" ? [record.selected]
            : step.next ?? (definition.steps[index + 1] ? [definition.steps[index + 1].id] : []);
          for (const id of next) {
            if (active.has(id)) reactivated.add(id);
            if (!state.frontier.includes(id)) state.frontier.push(id);
          }
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
    ]
  ) {
    if (
      !state.artifacts[input] || !await exists(state.artifacts[input].path)
    ) return false;
  }
  return true;
}
async function execute(
  { step, definition, definitionDir, runDir, state, gateway },
) {
  const record = state.steps[step.id];
  const version = ++record.attempts;
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
      await atomicJson(path.join(dir, "usage.json"), {
        gateway: null,
        model: null,
        effort: null,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        tried: error.tried ?? [],
      });
      throw error;
    }
    const output = typeof result === "string" ? result : result.text;
    await writeFile(path.join(dir, "output.md"), output);
    await atomicJson(path.join(dir, "usage.json"), {
      gateway: result.gateway ?? "human",
      model: result.model ?? null,
      effort: result.effort ?? null,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      totalTokens: result.usage?.totalTokens ?? 0,
      tried: result.tried ?? [{ gateway: "human", result: "success" }],
    });
    const current = path.join(runDir, "artifacts", step.output);
    await ensureDir(path.dirname(current));
    await copyFile(path.join(dir, "output.md"), current);
    state.artifacts[step.output] = {
      path: current,
      producer: step.id,
      version,
    };
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
        path: state.artifacts[id].path,
        previous: await previousArtifactPaths(runDir, id, definition),
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
    for (const id of step.outputs) {
      if (!await exists(manifest.outputs[id])) {
        throw new Error(`exec output missing: ${id}`);
      }
      const current = path.join(runDir, "artifacts", id);
      await ensureDir(path.dirname(current));
      await copyFile(manifest.outputs[id], current);
      state.artifacts[id] = { path: current, producer: step.id, version };
    }
  } else {
    const source = await readText(state.artifacts[step.source].path);
    const selected = chooseCase(step, source)?.goto ?? step.default;
    if (!selected) throw new Error(`no matching case in ${step.id} and no default`);
    record.selected = selected;
  }
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
