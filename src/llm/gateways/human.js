// @ts-ignore Node built-in declarations are supplied by the runtime.
import path from 'node:path';
// @ts-ignore Node built-in declarations are supplied by the runtime.
import { writeFile } from 'node:fs/promises';
import { exists, readText } from '../../io/files.js';

export async function humanGateway({ step, version, dir, runDir, prompt, resumeHuman }) {
  const promptFile = path.join(dir, 'prompt.md');
  await writeFile(promptFile, prompt);
  const output = path.join(dir, 'output.md');
  if (resumeHuman) {
    const prior = path.join(runDir, 'steps', step.id, `v${Math.max(1, version - 1)}`, 'a1', 'output.md');
    if (await exists(prior)) return readText(prior);
  }
  if (!await exists(output)) throw new Error('waiting-human');
  return readText(output);
}
