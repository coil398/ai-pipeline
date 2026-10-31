// @ts-ignore Node built-in declarations are supplied by the runtime.
import path from 'node:path';
// @ts-ignore Node built-in declarations are supplied by the runtime.
import { readdir } from 'node:fs/promises';
// @ts-ignore Node built-in declarations are supplied by the runtime.
import { copyFile, writeFile } from 'node:fs/promises';
import { ensureDir, exists, readText, atomicJson } from '../io/files.js';
import { renderPrompt, runLlm } from '../steps/llm.js';
import { runExec } from '../steps/exec.js';
import { chooseCase } from '../steps/decide.js';
import { saveState } from './state.js';
import { dependentSteps } from './graph.js';

const process = /** @type {any} */ (globalThis).process;
const attemptDir = (runDir, step, version) => path.join(runDir, 'steps', step.id, `v${version}`, 'a1');

/** @param {{definition: any, definitionDir: string, runDir: string, state: any, gateway: Function, parallel?: number}} options */
export async function schedule({ definition, definitionDir, runDir, state, gateway, parallel = 4 }) {
  const controlled = new Map();
  for (const step of definition.steps) if (step.kind === 'decide') for (const item of step.cases) controlled.set(item.goto, false);
  let priorityStep = null;
  try {
    state.status = 'running'; await saveState(runDir, state);
    for (;;) {
      const ordered = priorityStep ? [definition.steps.find(item => item.id === priorityStep), ...definition.steps.filter(item => item.id !== priorityStep)] : definition.steps;
      priorityStep = null;
      const candidates = [];
      for (const step of ordered) {
        if (state.steps[step.id].status === 'completed') continue;
        if (controlled.has(step.id) && !controlled.get(step.id)) continue;
        if (!(await allInputsExist(step, state))) continue;
        if (step.kind === 'decide') {
          if (!candidates.length) candidates.push(step);
          break;
        }
        candidates.push(step);
      }
      if (!candidates.length) break;
      const batch = [];
      const claimedOutputs = new Set();
      for (const step of candidates) {
        if (step.kind === 'decide' && batch.length) break;
        const outputs = [...(step.output ? [step.output] : []), ...(step.outputs ?? [])];
        if (outputs.some(output => claimedOutputs.has(output))) continue;
        const inputs = [...(step.inputs ?? []), ...(step.kind === 'decide' ? [step.source] : [])];
        const stepPosition = candidates.indexOf(step);
        const blockedByBatch = inputs.some(input => candidates.some((producer, position) => position < stepPosition && producer.id !== step.id && state.steps[producer.id].status !== 'completed' && [...(producer.output ? [producer.output] : []), ...(producer.outputs ?? [])].includes(input)));
        if (blockedByBatch) continue;
        batch.push(step); for (const output of outputs) claimedOutputs.add(output);
        if (batch.length >= parallel || step.kind === 'decide') break;
      }
      if (!batch.length) break;
      const outcomes = await Promise.allSettled(batch.map(step => execute({ step, definition, definitionDir, runDir, state, gateway })));
      const failed = outcomes.find(outcome => outcome.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      const decision = batch.find(step => step.kind === 'decide');
      if (decision) {
        const selected = state.steps[decision.id].selected;
        for (const item of decision.cases) {
          controlled.set(item.goto, item.goto === selected);
          if (item.goto !== selected) state.steps[item.goto].status = 'skipped';
          if (item.goto === selected && state.steps[item.goto].status === 'skipped') state.steps[item.goto].status = 'pending';
        }
        const body = dependentSteps(definition, selected);
        const sourceProducer = definition.steps.find(item => item.output === decision.source || item.outputs?.includes(decision.source));
        const isBackward = sourceProducer && body.has(sourceProducer.id);
        if (isBackward) {
          priorityStep = selected;
          const count = state.rounds[decision.id];
          if (count >= decision.max) { state.status = 'stopped: max-rounds'; await saveState(runDir, state); return state; }
          state.rounds[decision.id] = count + 1;
          for (const id of body) if (state.steps[id]) state.steps[id].status = 'pending';
        }
      }
    }
    state.status = Object.values(state.steps).every(item => item.status === 'completed' || item.status === 'skipped') ? 'completed' : 'waiting-input';
    await saveState(runDir, state); return state;
  } catch (error) {
    state.status = error.message === 'waiting-human' ? 'waiting-human' : error.message.startsWith('stopped:') ? error.message : 'failed';
    state.error = error.stack ?? error.message; await saveState(runDir, state); return state;
  }
}

async function allInputsExist(step, state) { for (const input of [...(step.inputs ?? []), ...(step.kind === 'decide' ? [step.source] : [])]) if (!state.artifacts[input] || !await exists(state.artifacts[input].path)) return false; return true; }
async function execute({ step, definition, definitionDir, runDir, state, gateway }) {
  const record = state.steps[step.id]; const version = ++record.attempts;
  const dir = attemptDir(runDir, step, version); await ensureDir(dir);
  /** @type {Record<string, string>} */
  const inputs = {};
  for (const id of step.inputs ?? []) inputs[id] = await readText(state.artifacts[id].path);
  record.status = 'running'; await saveState(runDir, state);
  if (step.kind === 'llm') {
    const prompt = await renderPrompt(step, inputs, definitionDir);
    await writeFile(path.join(dir, 'prompt.md'), prompt);
    const output = await runLlm({ step, prompt, gateway, context: { version, runDir, dir } });
    await writeFile(path.join(dir, 'output.md'), output);
    const current = path.join(runDir, 'artifacts', step.output); await ensureDir(path.dirname(current)); await copyFile(path.join(dir, 'output.md'), current);
    state.artifacts[step.output] = { path: current, producer: step.id, version };
  } else if (step.kind === 'exec') {
    const manifest = { runId: state.runId, stepId: step.id, version, inputs: {}, outputs: {} };
    for (const id of step.inputs ?? []) manifest.inputs[id] = { path: state.artifacts[id].path, previous: await previousArtifactPaths(runDir, id, definition) };
    for (const id of step.outputs) manifest.outputs[id] = path.join(dir, 'outputs', id);
    const manifestFile = path.join(dir, 'manifest.json'); await atomicJson(manifestFile, manifest);
    for (const output of Object.values(manifest.outputs)) await ensureDir(path.dirname(output));
    await runExec({ argv: step.argv, cwd: definitionDir, stderrFile: path.join(dir, 'stderr.log'), env: { ...process.env, AIP_MANIFEST: manifestFile } });
    for (const id of step.outputs) {
      if (!await exists(manifest.outputs[id])) throw new Error(`exec output missing: ${id}`);
      const current = path.join(runDir, 'artifacts', id); await ensureDir(path.dirname(current)); await copyFile(manifest.outputs[id], current);
      state.artifacts[id] = { path: current, producer: step.id, version };
    }
  } else {
    const source = await readText(state.artifacts[step.source].path); const selected = chooseCase(step, source);
    if (!selected) throw new Error(`no matching case in ${step.id}`);
    record.selected = selected.goto;
  }
  record.status = 'completed'; record.completedAt = new Date().toISOString(); await saveState(runDir, state);
}
async function previousArtifactPaths(runDir, id, definition) {
  const producers = definition.steps.filter(step => step.output === id || step.outputs?.includes(id));
  const paths = [];
  for (const producer of producers) {
    const root = path.join(runDir, 'steps', producer.id);
    let versions = []; try { versions = await readdir(root); } catch {}
    for (const version of versions.filter(value => /^v\d+$/.test(value)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))) {
      const llmOutput = path.join(root, version, 'a1', 'output.md');
      const execOutput = path.join(root, version, 'a1', 'outputs', id);
      if (await exists(llmOutput) && producer.output === id) paths.push(llmOutput);
      if (await exists(execOutput)) paths.push(execOutput);
    }
  }
  return paths;
}
