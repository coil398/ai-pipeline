// @ts-ignore Node built-in declarations are supplied by the runtime.
import path from 'node:path';
import { atomicJson, readJson } from '../io/files.js';

export function statePath(runDir) { return path.join(runDir, 'state.json'); }
export async function saveState(runDir, state) { state.updatedAt = new Date().toISOString(); await atomicJson(statePath(runDir), state); }
export async function loadState(runDir) { return readJson(statePath(runDir)); }
export async function initializeState(runDir, definition, definitionFile, inputFiles) {
  const artifacts = {};
  for (const [id, file] of Object.entries(inputFiles)) artifacts[id] = { path: path.resolve(file), producer: null, version: 0 };
  const state = { runId: path.basename(runDir), workflow: definition.id, definitionFile, status: 'running', steps: Object.fromEntries(definition.steps.map(step => [step.id, { status: 'pending', attempts: 0 }])), rounds: Object.fromEntries(definition.steps.filter(step => step.kind === 'decide').map(step => [step.id, 0])), artifacts, updatedAt: new Date().toISOString() };
  await saveState(runDir, state); return state;
}
