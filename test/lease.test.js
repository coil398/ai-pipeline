import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
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

test('a competing lease read is safe while the creator is writing its owner', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aip-lease-race-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lease = path.join(dir, 'run.lease');
  const probe = await open(path.join(dir, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalWriteFile = prototype.writeFile;
  let markEntered; let allowWrite;
  const entered = new Promise(resolve => { markEntered = resolve; });
  const writeGate = new Promise(resolve => { allowWrite = resolve; });
  prototype.writeFile = async function (...args) {
    markEntered();
    await writeGate;
    return originalWriteFile.apply(this, args);
  };
  let release;
  let competingError;
  let leaseOwner;
  try {
    const first = acquireLease(lease);
    const state = await Promise.race([
      first.then(value => ({ release: value })),
      entered.then(() => ({ blocked: true })),
    ]);
    if (state.blocked) {
      const competing = await acquireLease(lease).then(
        () => null,
        error => error,
      );
      competingError = competing;
      allowWrite();
      release = await first;
    } else {
      release = state.release;
      competingError = await acquireLease(lease).then(
        () => null,
        error => error,
      );
    }
    leaseOwner = JSON.parse(await readFile(lease, 'utf8'));
  } finally {
    allowWrite();
    prototype.writeFile = originalWriteFile;
    if (release) await release();
  }
  assert.match(competingError?.message ?? '', /^run is leased:/);
  assert.equal(leaseOwner.pid, process.pid);
});
