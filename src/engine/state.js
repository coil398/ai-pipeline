import path from "node:path";
import { atomicJson, readJson } from "../io/files.js";

export function statePath(runDir) {
  return path.join(runDir, "state.json");
}
const saves = new WeakMap();
export async function saveState(runDir, state) {
  state.updatedAt = new Date().toISOString();
  const snapshot = structuredClone(state);
  const pending = (saves.get(state) ?? Promise.resolve()).then(() => atomicJson(statePath(runDir), snapshot));
  saves.set(state, pending);
  await pending;
}
export async function loadState(runDir) {
  return readJson(statePath(runDir));
}
export async function initializeState(
  runDir,
  definition,
  definitionFile,
  inputFiles,
) {
  const artifacts = {};
  for (const [id, file] of Object.entries(inputFiles)) {
    artifacts[id] = { path: path.resolve(file), producer: null, version: 0 };
  }
  const state = {
    runId: path.basename(runDir),
    workflow: definition.id,
    definitionFile,
    status: "running",
    frontier: definition.steps.length ? [definition.steps[0].id] : [],
    sequence: 0,
    steps: Object.fromEntries(
      definition.steps.map(
        (step) => [step.id, { status: "pending", attempts: 0 }],
      ),
    ),
    rounds: Object.fromEntries(
      definition.steps.filter((step) => step.kind === "decide").map(
        (step) => [step.id, 0],
      ),
    ),
    artifacts,
    updatedAt: new Date().toISOString(),
  };
  await saveState(runDir, state);
  return state;
}
