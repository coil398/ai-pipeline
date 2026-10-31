import path from "node:path";
import { exists, readJson } from "../io/files.js";

const process = /** @type {any} */ (globalThis).process;

/** @typedef {{ id: string, kind: 'llm'|'exec'|'decide', inputs?: string[], role?: string, route?: string, output?: string, outputs?: string[], argv?: string[], component?: string, source?: string, field?: string, cases?: Array<{when: string[], goto: string}>, max?: number, next?: string[], waitFor?: string[], default?: string }} WorkflowStep */
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
    for (const ref of step.argv ?? []) {
      if (
        typeof ref === "string" && (ref.includes("/") || ref.startsWith(".")) &&
        !await exists(path.resolve(path.dirname(absolute), ref))
      ) {
        throw new Error(`missing file for ${step.id}: ${ref}`);
      }
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
    if (!["llm", "exec", "decide"].includes(step.kind)) {
      throw new Error(`invalid kind for ${step.id}`);
    }
    if (
      step.inputs !== undefined &&
      (!Array.isArray(step.inputs) ||
        step.inputs.some((input) => typeof input !== "string"))
    ) throw new Error(`invalid inputs for ${step.id}`);
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
  for (const step of definition.steps) {
    for (const input of step.inputs ?? []) {
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
        !Array.isArray(step.cases) || !Number.isInteger(step.max) ||
        step.max < 1
      ) throw new Error(`invalid decide: ${step.id}`);
      for (const item of step.cases) {
        if (
          !Array.isArray(item.when) || item.when.some((value) =>
            typeof value !== "string"
          ) || typeof item.goto !== "string"
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
