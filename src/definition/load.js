import path from "node:path";
import { exists, readJson } from "../io/files.js";

const process = /** @type {any} */ (globalThis).process;

/** @typedef {{ id: string, kind: 'llm'|'exec'|'decide', inputs?: string[], optionalInputs?: string[], role?: string, route?: string, output?: string, outputs?: string[], argv?: string[], component?: string, source?: string, field?: string, cases?: Array<{when: string[], goto: string, max?: number}>, next?: string[], waitFor?: string[], default?: string }} WorkflowStep */
/** @typedef {{ id: string, inputs: Record<string, string>, components?: string, steps: WorkflowStep[] }} Workflow */

/** @param {string} file @param {Record<string, string>} [inputOverrides] @param {{componentsDir?: string}} [options] @returns {Promise<{definition: Workflow, file: string, directory: string}>} */
export async function loadDefinition(file, inputOverrides = {}, options = {}) {
  const absolute = path.resolve(file);
  const value = await readJson(absolute);
  validateDefinition(value);
  for (const [id, input] of Object.entries(inputOverrides)) {
    if (!Object.hasOwn(value.inputs, id)) throw new Error(`unknown input id: ${id}`);
    value.inputs[id] = input;
  }
  for (const [id, input] of Object.entries(value.inputs)) {
    if (
      typeof input !== "string" ||
      !await exists(path.resolve(path.dirname(absolute), input))
    ) throw new Error(`missing input file for ${id}: ${input}`);
  }
  const componentsDir = options.componentsDir ?? (value.components === undefined
    ? undefined : path.resolve(path.dirname(absolute), value.components));
  for (const step of value.steps) {
    if (step.component !== undefined) {
      if (!componentsDir) throw new Error(`components directory required for ${step.id}`);
      const entry = path.resolve(componentsDir, step.component, "run.mjs");
      if (!await exists(entry)) throw new Error(`missing component entry for ${step.id}: ${entry}`);
      step.argv = [process.execPath, entry];
    }
    if (
      step.role &&
      !await exists(path.resolve(path.dirname(absolute), step.role))
    ) throw new Error(`missing role file for ${step.id}: ${step.role}`);
    for (const inner of step.steps ?? []) {
      if (inner.role && !await exists(path.resolve(path.dirname(absolute), inner.role))) throw new Error(`missing role file for ${inner.id}: ${inner.role}`);
    }
  }
  return {
    definition: value,
    file: absolute,
    directory: path.dirname(absolute),
  };
}

/** @param {Workflow} definition @returns {void} */
export function validateDefinition(definition) {
  if (
    !definition || typeof definition.id !== "string" ||
    !Array.isArray(definition.steps) || !definition.inputs ||
    typeof definition.inputs !== "object" || Array.isArray(definition.inputs)
  ) throw new Error("invalid workflow shape");
  if (definition.components !== undefined && typeof definition.components !== "string") {
    throw new Error("components must be a directory path");
  }
  const ids = new Set();
  for (const step of definition.steps) {
    if (!step || typeof step.id !== "string" || ids.has(step.id)) {
      throw new Error(`invalid or duplicate step id: ${step?.id}`);
    }
    ids.add(step.id);
    if (!["llm", "exec", "decide", "map"].includes(step.kind)) {
      throw new Error(`invalid kind for ${step.id}`);
    }
    for (const key of ["inputs", "optionalInputs"]) {
      if (step[key] !== undefined && (!Array.isArray(step[key]) ||
        step[key].some((input) => typeof input !== "string"))) {
        throw new Error(`invalid ${key} for ${step.id}`);
      }
    }
  }
  const artifacts = new Set(Object.keys(definition.inputs));
  for (const step of definition.steps) {
    for (
      const output of [
        ...(step.output ? [step.output] : []),
        ...(step.outputs ?? []),
      ]
    ) artifacts.add(output);
  }
  for (const step of definition.steps.filter((item) => item.kind === "map")) {
    if (typeof step.items !== "string" || !artifacts.has(step.items) ||
      typeof step.itemArtifact !== "string" || !Array.isArray(step.steps) ||
      !step.steps.length || typeof step.output !== "string" ||
      (step.maxConcurrency !== undefined && (!Number.isInteger(step.maxConcurrency) || step.maxConcurrency < 1))) {
      throw new Error(`invalid map: ${step.id}`);
    }
    const innerIds = new Set();
    const visible = new Set([...Object.keys(definition.inputs), step.itemArtifact]);
    const innerOutputs = new Set();
    for (const inner of step.steps) {
      if (!inner || typeof inner.id !== "string" || ids.has(inner.id) || innerIds.has(inner.id)) throw new Error(`invalid or duplicate step id: ${inner?.id}`);
      innerIds.add(inner.id);
      if (!["exec", "llm"].includes(inner.kind)) throw new Error(`invalid kind for ${inner.id}`);
      if (inner.next !== undefined || inner.waitFor !== undefined || inner.goto !== undefined) throw new Error(`invalid inner control flow: ${inner.id}`);
      for (const key of ["inputs", "optionalInputs"]) {
        if (inner[key] !== undefined && (!Array.isArray(inner[key]) || inner[key].some((v) => typeof v !== "string"))) throw new Error(`invalid ${key} for ${inner.id}`);
        for (const input of inner[key] ?? []) if (!visible.has(input)) throw new Error(`unresolved input ${input} in ${inner.id}`);
      }
      if (inner.kind === "llm") {
        if (typeof inner.role !== "string" || typeof inner.route !== "string" || typeof inner.output !== "string") throw new Error(`llm requires role, route, and output: ${inner.id}`);
        visible.add(inner.output); innerOutputs.add(inner.output);
      } else {
        if ((inner.argv === undefined) === (inner.component === undefined) || (inner.argv !== undefined && (!Array.isArray(inner.argv) || !inner.argv.length || inner.argv.some((v) => typeof v !== "string"))) || !Array.isArray(inner.outputs) || inner.outputs.some((v) => typeof v !== "string")) throw new Error(`exec requires exactly one of argv or component, and outputs: ${inner.id}`);
        for (const output of inner.outputs) { visible.add(output); innerOutputs.add(output); }
      }
    }
    for (const id of innerIds) ids.add(id);
    artifacts.add(step.output);
  }
  for (const step of definition.steps) {
    for (const input of [...(step.inputs ?? []), ...(step.optionalInputs ?? [])]) {
      if (!artifacts.has(input)) {
        throw new Error(`unresolved input ${input} in ${step.id}`);
      }
    }
    if (step.kind === "llm") {
      if (
        typeof step.role !== "string" || typeof step.route !== "string" ||
        typeof step.output !== "string"
      ) throw new Error(`llm requires role, route, and output: ${step.id}`);
    }
    if (step.kind === "exec") {
      if (
        (step.argv === undefined) === (step.component === undefined) ||
        (step.argv !== undefined && (!Array.isArray(step.argv) || !step.argv.length ||
          step.argv.some((arg) => typeof arg !== "string"))) ||
        (step.component !== undefined && (typeof step.component !== "string" ||
          !/^[a-zA-Z0-9_-]+$/.test(step.component))) ||
        !Array.isArray(step.outputs) || step.outputs.some((output) =>
          typeof output !== "string"
        )
      ) throw new Error(`exec requires exactly one of argv or component, and outputs: ${step.id}`);
    }
    if (step.kind === "decide") {
      if (
        !step.source || !artifacts.has(step.source) ||
        !Array.isArray(step.cases) || Object.hasOwn(step, "max")
      ) throw new Error(`invalid decide: ${step.id}`);
      for (const item of step.cases) {
        if (
          !Array.isArray(item.when) || item.when.some((value) =>
            typeof value !== "string"
          ) || typeof item.goto !== "string" ||
          (Object.hasOwn(item, "max") && (!Number.isInteger(item.max) || item.max < 1))
        ) throw new Error(`invalid case in ${step.id}`);
      }
    }
  }
  for (const step of definition.steps) {
    for (const key of ["next", "waitFor"]) {
      if (step[key] !== undefined && (!Array.isArray(step[key]) ||
        step[key].some((id) => typeof id !== "string" || !ids.has(id)))) {
        throw new Error(`invalid ${key} target in ${step.id}`);
      }
    }
    if (step.kind === "decide" && step.default !== undefined && !ids.has(step.default)) {
      throw new Error(`unknown default target in ${step.id}`);
    }
    if (step.kind === "decide") {
      for (const item of step.cases) {
        if (!ids.has(item.goto)) {
          throw new Error(`unknown goto target ${item.goto} in ${step.id}`);
        }
      }
    }
  }
}
