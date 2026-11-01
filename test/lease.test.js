import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acquireLease } from '../src/engine/lease.js';

test('a lease owned by a zombie process can be acquired again', async (t) => {
  if (process.platform !== 'linux') return t.skip('requires Linux /proc');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aip-lease-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const child = spawn('python3', ['-c', 'import os,time; pid=os.fork(); (os._exit(0) if pid == 0 else None); print(pid, flush=True); time.sleep(30)'], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => child.kill('SIGKILL'));
  const pid = Number((await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) resolve(output.trim()); });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`holder exited early: ${code}`)));
  })));
  const statPath = `/proc/${pid}/stat`;
  let state;
  for (let attempt = 0; attempt < 100; attempt++) {
    const stat = await readFile(statPath, 'utf8');
    state = stat.slice(stat.lastIndexOf(')') + 1).trimStart().split(/\s+/)[0];
    if (state === 'Z') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(state, 'Z', `expected process ${pid} to be a zombie`);

  const lease = path.join(dir, 'run.lease');
  await writeFile(lease, JSON.stringify({ pid, host: os.hostname(), startedAt: 'old' }));
  const release = await acquireLease(lease);
  assert.equal(JSON.parse(await readFile(lease, 'utf8')).pid, process.pid);
  await release();
});
