#!/usr/bin/env node
// @ts-ignore Node built-in declarations are supplied by the runtime.
import path from 'node:path';
// @ts-ignore Node built-in declarations are supplied by the runtime.
import { mkdir } from 'node:fs/promises';
import { loadDefinition } from '../src/definition/load.js';
import { initializeState, loadState, saveState } from '../src/engine/state.js';
import { schedule } from '../src/engine/scheduler.js';
import { dependentSteps } from '../src/engine/graph.js';
import { acquireLease } from '../src/engine/lease.js';
import { fixtureGateway } from '../src/llm/gateways/fixture.js';
import { humanGateway } from '../src/llm/gateways/human.js';
import { readText, exists } from '../src/io/files.js';
import { log } from '../src/io/log.js';

const process = /** @type {any} */ (globalThis).process;

const args = process.argv.slice(2);
function option(name, fallback = undefined) { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; }
function usage() { console.log('aip run <workflow.json> --run-id <id> [--runs-dir <dir>] [--parallel <n>] [--llm <fixture-dir>|run:<run-id>]\naip continue --run-id <id>\naip rerun --run-id <id> --from <step>\naip status --run-id <id>\naip render --run-id <id>'); }
async function main() {
  const command = args[0]; if (!command) return usage();
  const runId = option('--run-id'); if (!runId) throw new Error('--run-id is required');
  const runsDir = path.resolve(option('--runs-dir', 'runs')); const runDir = path.join(runsDir, runId);
  const parallel = Number(option('--parallel', '4'));
  if (!['status', 'render'].includes(command) && (!Number.isInteger(parallel) || parallel < 1)) throw new Error('--parallel must be a positive integer');
  if (command === 'status' || command === 'render') {
    const state = await loadState(runDir);
    if (command === 'status') console.log(JSON.stringify(state, null, 2));
    else console.log(renderState(state));
    return;
  }
  if (command === 'run') {
    const loaded = await loadDefinition(args[1]);
    const inputs = Object.fromEntries(await Promise.all(Object.entries(loaded.definition.inputs).map(async ([id, file]) => [id, path.resolve(loaded.directory, file)])));
    await mkdir(runDir, { recursive: true });
    if (await exists(path.join(runDir, 'state.json'))) throw new Error(`run already exists: ${runId}`);
    return withLease(runDir, async () => { const state = await initializeState(runDir, loaded.definition, loaded.file, inputs); await runLoaded(loaded, runDir, state, parallel); });
  }
  const initialState = await loadState(runDir); const loaded = await loadDefinition(initialState.definitionFile);
  if (command === 'rerun') {
    const start = option('--from'); const startIndex = loaded.definition.steps.findIndex(step => step.id === start);
    if (!start || startIndex < 0) throw new Error(`unknown step: ${start}`);
    const affected = dependentSteps(loaded.definition, start);
    return withLease(runDir, async () => {
      const state = await loadState(runDir);
      for (const decide of loaded.definition.steps.filter(step => step.kind === 'decide')) if (affected.has(decide.id)) state.rounds[decide.id] = 0;
      for (const id of affected) state.steps[id] = { status: 'pending', attempts: state.steps[id].attempts };
      state.status = 'running'; delete state.error; await saveState(runDir, state);
      await runLoaded(loaded, runDir, state, parallel);
    });
  }
  if (command !== 'continue') return usage();
  return withLease(runDir, async () => { const state = await loadState(runDir); await runLoaded(loaded, runDir, state, parallel); });
}
async function runLoaded(loaded, runDir, state, parallel) {
  const resumeHuman = state.status === 'waiting-human';
  let gateway = context => humanGateway({ ...context, resumeHuman });
  const llmMode = option('--llm', state.llmMode ?? 'human'); state.llmMode = llmMode; await saveState(runDir, state);
  if (llmMode.startsWith('run:')) {
    const source = path.join(path.resolve(option('--runs-dir', 'runs')), llmMode.slice(4), 'steps');
    gateway = async ({ step, version }) => { const file = path.join(source, step.id, `v${version}`, 'a1', 'output.md'); if (!await exists(file)) throw new Error(`stopped: fixture-missing ${file}`); return readText(file); };
  }
  if (llmMode !== 'human' && !llmMode.startsWith('run:')) gateway = fixtureGateway(path.resolve(llmMode));
  const started = Date.now(); log('INFO', 'run_start', { run_id: state.runId, workflow: loaded.definition.id, steps: loaded.definition.steps.length });
  const result = await schedule({ definition: loaded.definition, definitionDir: loaded.directory, runDir, state, gateway, parallel });
  log(result.status === 'failed' ? 'ERROR' : 'INFO', 'run_done', { run_id: state.runId, status: result.status, elapsed_ms: Date.now() - started });
  if (result.error) log('ERROR', 'run_error', { run_id: state.runId, detail: result.error });
  console.log(`${result.status} run_id=${state.runId}`);
  if (result.status === 'failed' || result.status === 'stopped: max-rounds' || result.status.startsWith('stopped: fixture-missing')) process.exitCode = 1;
}
function renderState(state) { return [`Run ${state.runId}: ${state.status}`, ...Object.entries(state.steps).map(([id, value]) => `- ${id}: ${value.status}${value.selected ? ` -> ${value.selected}` : ''}`), ...Object.entries(state.rounds).map(([id, count]) => `- ${id} round=${count}`)].join('\n'); }
async function withLease(runDir, action) { const release = await acquireLease(path.join(runDir, 'run.lease')); try { await action(); } finally { await release(); } }
main().catch(error => { console.error(error.message); process.exitCode = 1; });
