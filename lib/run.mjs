// Spawn a process with an argv array. There is no path from any string to a shell here,
// because no shell is ever started. Model-written text is data: a script is model output
// and must never reach a shell.
//
// Measured on this host: a non-detached child shares the parent's process group, so
// process.kill(-child.pid) fails with ESRCH. A detached child becomes the group leader,
// the group kill works, and it also kills the children that child spawned. So every run
// here is detached, and the exit code is collected by the child writing a small json
// file when its own child exits.

import { spawn } from 'node:child_process';
import { writeFile, readFile, mkdtemp, rm, rename } from 'node:fs/promises';
import { openSync, fsyncSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SELF = fileURLToPath(import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wait(child) {
  return new Promise((done) => {
    child.once('error', (e) => done({ spawnFailed: true, errno: e.code, code: null, signal: null }));
    child.once('exit', (code, signal) => done({ spawnFailed: false, code, signal }));
  });
}

// The detached group leader: it runs the real command, sends its output to files it owns,
// fsyncs them, then reports the exit code. It is this same file, re-invoked with --child.
async function childMain(spec) {
  const fdOut = openSync(spec.out, 'w');
  const fdErr = openSync(spec.err, 'w');
  // The stdio array is [stdin, stdout, stderr]: the two files sit in slots 2 and 3.
  const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['ignore', fdOut, fdErr] });
  const result = await wait(child);
  // Flush the output before the code file appears, so a reader never sees a code file
  // whose output is still short.
  fsyncSync(fdOut);
  fsyncSync(fdErr);
  closeSync(fdOut);
  closeSync(fdErr);
  const tmp = `${spec.code}.tmp`;
  await writeFile(tmp, JSON.stringify(result));
  await rename(tmp, spec.code);
}

export async function run(argv, opts = {}) {
  const { timeoutMs = 60000, stderrCap = 4096, cwd = process.cwd() } = opts;
  const started = Date.now();
  const dir = await mkdtemp(join(tmpdir(), 'narrate-run-'));
  const spec = join(dir, 'spec.json');
  const code = join(dir, 'code.json');
  const out = join(dir, 'out.txt');
  const err = join(dir, 'err.txt');
  await writeFile(spec, JSON.stringify({ argv, cwd, out, err, code }));

  const child = spawn('node', [SELF, '--child', spec], { detached: true, cwd, stdio: 'ignore' });
  const pid = child.pid;

  let payload = null;
  const deadline = started + timeoutMs;
  let step = 2;
  while (Date.now() < deadline) {
    try {
      payload = JSON.parse(await readFile(code, 'utf8'));
      break;
    } catch {
      // No file yet, or a read that failed: the run is still going, so keep waiting.
    }
    await sleep(step);
    step = Math.min(25, step * 2);
  }

  let groupKill = null;
  if (!payload) {
    // The command is still alive. Kill the whole group, which also kills anything the
    // command spawned. This is the measured way; it works because the child is detached.
    try {
      process.kill(-pid, 'SIGKILL');
      groupKill = 'ok';
    } catch (e) {
      groupKill = e.code;
    }
    await sleep(25);
    try {
      payload = JSON.parse(await readFile(code, 'utf8'));
    } catch {}
  }

  let stdout = '';
  let stderr = '';
  let stderrTruncated = false;
  try {
    stdout = await readFile(out, 'utf8');
  } catch {}
  try {
    const raw = await readFile(err, 'utf8');
    stderr = raw.slice(0, stderrCap);
    stderrTruncated = raw.length > stderrCap;
  } catch {}

  await rm(dir, { recursive: true, force: true });

  if (!payload) {
    return {
      ok: false, timedOut: true, spawnFailed: false, code: null, signal: 'SIGKILL',
      stdout, stderr, stderrTruncated, elapsedMs: Date.now() - started, groupKill, pid,
    };
  }
  return {
    ok: !payload.spawnFailed && payload.code === 0,
    timedOut: false,
    spawnFailed: payload.spawnFailed === true,
    errno: payload.errno ?? null,
    code: payload.code,
    signal: payload.signal,
    stdout, stderr, stderrTruncated,
    elapsedMs: Date.now() - started,
    groupKill,
    pid,
  };
}

// Re-invoked as the detached group leader. On import, argv[2] is undefined, so this never
// runs for a caller.
if (process.argv[2] === '--child') {
  const spec = JSON.parse(await readFile(process.argv[3], 'utf8'));
  await childMain(spec);
}
