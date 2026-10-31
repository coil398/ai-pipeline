/** @param {{steps: Array<{id: string, output?: string, outputs?: string[], inputs?: string[], kind: string, source?: string}>}} definition @param {string} start @returns {Set<string>} */
export function dependentSteps(definition, start) {
  if (!definition.steps.some((step) => step.id === start)) {
    throw new Error(`unknown step: ${start}`);
  }
  const selected = definition.steps.find((step) => step.id === start);
  const outputs = new Set([
    ...(selected.output ? [selected.output] : []),
    ...(selected.outputs ?? []),
  ]);
  const steps = new Set([start]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of definition.steps) {
      if (steps.has(step.id)) continue;
      const inputs = [
        ...(step.inputs ?? []),
        ...(step.kind === "decide" ? [step.source] : []),
      ];
      if (inputs.some((input) => outputs.has(input))) {
        steps.add(step.id);
        for (
          const output of [
            ...(step.output ? [step.output] : []),
            ...(step.outputs ?? []),
          ]
        ) outputs.add(output);
        changed = true;
      }
    }
  }
  return steps;
}
