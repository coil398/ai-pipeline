import path from "node:path";
import { exists, readJson } from "../io/files.js";

/** @typedef {{ id: string, kind: 'llm'|'exec'|'decide', inputs?: string[], role?: string, route?: string, output?: string, outputs?: string[], argv?: string[], source?: string, field?: string, cases?: Array<{when: string[], goto: string}>, max?: number }} WorkflowStep */
/** @typedef {{ id: string, inputs: Record<string, string>, steps: WorkflowStep[] }} Workflow */

/** @param {string} file @returns {Promise<{definition: Workflow, file: string, directory: string}>} */
export async function loadDefinition(file) {
  const absolute = path.resolve(file);
  const value = await readJson(absolute);
  validateDefinition(value);
  for (const [id, input] of Object.entries(value.inputs)) {
    if (
      typeof input !== "string" ||
      !await exists(path.resolve(path.dirname(absolute), input))
    ) throw new Error(`missing input file for ${id}: ${input}`);
  }
  for (const step of value.steps) {
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
        !Array.isArray(step.argv) || !step.argv.length ||
        step.argv.some((arg) => typeof arg !== "string") ||
        !Array.isArray(step.outputs) || step.outputs.some((output) =>
          typeof output !== "string"
        )
      ) throw new Error(`exec requires argv and outputs: ${step.id}`);
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
    if (step.kind === "decide") {
      for (const item of step.cases) {
        if (!ids.has(item.goto)) {
          throw new Error(`unknown goto target ${item.goto} in ${step.id}`);
        }
      }
    }
  }
}
