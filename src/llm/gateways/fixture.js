// @ts-ignore Node built-in declarations are supplied by the runtime.
import path from 'node:path';
import { readText, exists } from '../../io/files.js';

export function fixtureGateway(root) {
  return async ({ step, version }) => {
    const versioned = path.join(root, step.id, `v${version}.md`);
    const fallback = path.join(root, `${step.id}.md`);
    const file = await exists(versioned) ? versioned : fallback;
    if (!await exists(file)) throw new Error(`stopped: fixture-missing ${file}`);
    return readText(file);
  };
}
