// @ts-ignore Node built-in declarations are supplied by the runtime.
import path from 'node:path';
import { readText } from '../io/files.js';

/** @param {{role: string, inputs?: string[], output: string}} step @param {Record<string, string>} inputs @param {string} definitionDir @returns {Promise<string>} */
export async function renderPrompt(step, inputs, definitionDir) {
  const role = await readText(path.resolve(definitionDir, step.role));
  const blocks = [`${role.trimEnd()}`, '# Inputs'];
  for (const input of step.inputs ?? []) blocks.push(`## ${input}\n${inputs[input]}`);
  blocks.push(`# Output\n${step.output}`);
  return `${blocks.join('\n\n')}\n`;
}
/** @param {{step: object, prompt: string, gateway: Function, context: object}} request @returns {Promise<string>} */
export async function runLlm({ step, prompt, gateway, context }) {
  return gateway({ step, prompt, ...context });
}
