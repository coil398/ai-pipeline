import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { validateDefinition } from '../src/definition/load.js';
import { initializeState } from '../src/engine/state.js';
import { schedule } from '../src/engine/scheduler.js';

async function setup(t, steps) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aip-optional-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'role.md'), 'Evaluate the input.');
  await writeFile(path.join(dir, 'source.md'), 'source text');
  const definition = { id: 'optional', inputs: { source: 'source.md' }, steps };
  validateDefinition(definition);
  const runDir = path.join(dir, 'run');
  await mkdir(runDir);
  const state = await initializeState(runDir, definition, path.join(dir, 'workflow.json'), { source: path.join(dir, 'source.md') });
  // A known artifact whose recorded file no longer exists must also be omitted.
  state.artifacts.absent = { path: path.join(dir, 'missing.md'), version: 1, producer: 'unused' };
  return { dir, runDir, state, definition, definitionDir: dir };
}

const unused = { id: 'unused', kind: 'exec', argv: ['true'], outputs: ['absent'], next: [] };

test('optional LLM inputs omit missing artifacts and include the previous output on reentry', async (t) => {
  const options = await setup(t, [
    { id: 'evaluate', kind: 'llm', role: 'role.md', route: 'test', inputs: ['source'], optionalInputs: ['result', 'absent', 'never', 'source'], output: 'result', next: ['again'] },
    { id: 'again', kind: 'decide', source: 'result', cases: [{ when: ['FAIL'], goto: 'evaluate' }], default: 'finish', max: 2 },
    { id: 'finish', kind: 'exec', argv: ['true'], outputs: [], next: [] },
    { ...unused, outputs: ['absent', 'never'] },
  ]);
  const prompts = [];
  await schedule({ ...options, gateway: async ({ prompt }) => {
    prompts.push(prompt);
    return prompts.length === 1 ? 'VERDICT: FAIL\nprevious findings' : 'VERDICT: PASS';
  } });
  assert.equal(options.state.status, 'completed', options.state.error);
  assert.equal(prompts.length, 2);
  assert.doesNotMatch(prompts[0], /## (result|absent|never)\n/);
  assert.match(prompts[1], /## result\nVERDICT: FAIL\nprevious findings/);
  assert.doesNotMatch(prompts[1], /## (absent|never)\n|undefined/);
  assert.equal(prompts[1].match(/## source\n/g).length, 1);
  assert.ok(prompts[1].indexOf('## source\n') < prompts[1].indexOf('## result\n'));
});

test('optional exec inputs use the regular manifest and their latest saved value', async (t) => {
  const options = await setup(t, [
    { id: 'transform', kind: 'exec', argv: [process.execPath, 'transform.mjs'], inputs: ['source'], optionalInputs: ['result', 'absent', 'source'], outputs: ['result'], next: [] },
    unused,
  ]);
  await writeFile(path.join(options.dir, 'transform.mjs'), `import fs from 'node:fs';
const m = JSON.parse(fs.readFileSync(process.env.AIP_MANIFEST, 'utf8'));
const prior = m.inputs.result ? fs.readFileSync(m.inputs.result.path, 'utf8') : '';
fs.writeFileSync(m.outputs.result, prior + 'next');\n`);
  await schedule({ ...options, gateway: () => assert.fail('no LLM call') });
  assert.equal(options.state.status, 'completed', options.state.error);
  const first = JSON.parse(await readFile(path.join(options.runDir, 'steps/transform/v1/a1/manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(first.inputs), ['source']);
  options.state.frontier = ['transform'];
  await schedule({ ...options, gateway: () => assert.fail('no LLM call') });
  assert.equal(options.state.status, 'completed', options.state.error);
  const second = JSON.parse(await readFile(path.join(options.runDir, 'steps/transform/v2/a1/manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(second.inputs), ['source', 'result']);
  assert.equal(second.inputs.result.path, options.state.artifacts.result.path);
  assert.deepEqual(second.inputs.result.previous, [path.join(options.runDir, 'steps/transform/v1/a1/outputs/result')]);
  assert.equal(await readFile(options.state.artifacts.result.path, 'utf8'), 'nextnext');
});

test('optional input references and shapes are validated like required inputs', () => {
  const definition = optionalInputs => ({ id: 'test', inputs: {}, steps: [{ ...unused, optionalInputs }] });
  assert.throws(() => validateDefinition(definition(['unknown'])), /unresolved input unknown/);
  assert.throws(() => validateDefinition(definition('absent')), /invalid optionalInputs/);
  assert.throws(() => validateDefinition(definition([42])), /invalid optionalInputs/);
  assert.doesNotThrow(() => validateDefinition(definition(['absent'])));
});
