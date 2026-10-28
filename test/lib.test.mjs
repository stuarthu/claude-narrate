// T-02 — lib/json.mjs and lib/run.mjs. Red-first: written before either file exists.
import assert from 'node:assert';
import { test } from 'node:test';
import { readFile, writeFile, rm, stat, mkdir } from 'node:fs/promises';
import { run } from '../lib/run.mjs';
import { readJson, writeJson, copyOnce } from '../lib/json.mjs';
import { VOICE, CLIP_SCHEMA } from '../lib/contract.mjs';

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

const DANGER = ['a; rm -rf /tmp/narrate-did-it', '$(id)', '`id`', '*', 'two words', 'x\ny'];

await test('run passes argv as data: a dangerous string never reaches a shell', async () => {
  const r = await run(['node', 'test/helpers/echo-args.mjs', ...DANGER]);
  assert.equal(r.spawnFailed, false, 'the command ran');
  assert.equal(r.code, 0, 'exit code');
  assert.deepEqual(JSON.parse(r.stdout), DANGER, 'every dangerous string arrived as one literal argument');
  assert.equal(await exists('/tmp/narrate-did-it'), false, 'nothing was created: no shell ran');
});

await test('run spawns detached so the process-group kill works, and a timeout kills the tree', async () => {
  await rm('/tmp/narrate-run', { recursive: true, force: true });
  const r = await run(['node', 'test/helpers/hang.mjs'], { timeoutMs: 300 });
  assert.equal(r.timedOut, true, 'timedOut is reported');
  assert.ok(r.elapsedMs < 1500, 'the run returned promptly, it did not wait for the child');
  assert.equal(r.groupKill, 'ok', 'process.kill(-pid,SIGKILL) worked, which is why the child is detached');
  assert.equal(await exists('/tmp/narrate-run/marker.txt'), false, 'the child never reached the point past the timeout');
});

await test('run kills the engine child AND its own children', async () => {
  const r = await run(['node', 'test/helpers/grandchild.mjs'], { timeoutMs: 300 });
  assert.equal(r.timedOut, true, 'timed out');
  assert.equal(r.groupKill, 'ok', 'group kill reported ok');
  const ps = await run(['ps', '-eo', 'pid,comm']);
  const left = ps.stdout.split('\n').filter((line) => line.includes(' sleep'));
  assert.equal(left.length, 0, 'no sleep survived the group kill');
});

await test('captured stderr is capped, and the cap says so', async () => {
  const r = await run(['node', 'test/helpers/noisy.mjs']);
  assert.equal(r.stderr.length, VOICE.stderrCap, 'stderr capped at 4096');
  assert.equal(r.stderrTruncated, true, 'truncation is reported, not hidden');
  assert.equal(r.stdout, 'done', 'stdout is kept whole');
});

await test('a missing executable is a spawn failure, not an engine failure', async () => {
  const r = await run(['definitely-not-a-real-command']);
  assert.equal(r.spawnFailed, true, 'spawnFailed is reported');
  assert.equal(r.code, null, 'there is no exit code to trust');
});

await test('writeJson keeps keys we did not create, and a second write changes nothing', async () => {
  const dir = '/tmp/narrate-json';
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/stock.json`, JSON.stringify({
    title: 'Bench timelapse', description: 'site text', tags: ['clouds', '1080p'],
    search_term: 'bench', weird: { nested: [1, 2, 3] },
  }), 'utf8');
  const first = await readJson(`${dir}/stock.json`);
  assert.equal(first.ok, true, 'a foreign json parses');
  const merged = { ...first.value, schema: CLIP_SCHEMA, measured: { shape: 2, durationSec: 63.2 } };
  await writeJson(`${dir}/stock.json`, merged);
  const after = await readJson(`${dir}/stock.json`);
  for (const key of Object.keys(first.value)) {
    assert.deepEqual(after.value[key], first.value[key], `key ${key} kept byte for byte`);
  }
  const once = await readFile(`${dir}/stock.json`, 'utf8');
  await writeJson(`${dir}/stock.json`, after.value);
  const twice = await readFile(`${dir}/stock.json`, 'utf8');
  assert.equal(once, twice, 'a re-scan writes the same bytes: our writing survives');
});

await test('a write that cannot finish leaves the old file intact', async () => {
  const path = '/tmp/narrate-json/atomic.json';
  await mkdir('/tmp/narrate-json', { recursive: true });
  await writeFile(path, '{"keep":1}', 'utf8');
  const circular = { a: 1 };
  circular.self = circular;
  const r = await writeJson(path, circular);
  assert.equal(r.ok, false, 'the failure is returned, not thrown past the caller');
  assert.equal(await readFile(path, 'utf8'), '{"keep":1}', 'the old bytes are still there');
});

await test('copyOnce saves the .json.bak exactly once', async () => {
  const src = '/tmp/narrate-json/clip.json';
  const bak = '/tmp/narrate-json/clip.json.bak';
  await mkdir('/tmp/narrate-json', { recursive: true });
  await writeFile(src, '{"v":1}', 'utf8');
  const one = await copyOnce(src, bak);
  assert.equal(one.copied, true, 'first copy happens');
  await writeFile(src, '{"v":2}', 'utf8');
  const two = await copyOnce(src, bak);
  assert.equal(two.copied, false, 'a second call never overwrites the backup');
  assert.equal(await readFile(bak, 'utf8'), '{"v":1}', 'the backup still holds the original bytes');
});

await test('fsync is on the write path (mechanism check: it cannot be seen from outside)', async () => {
  const src = await readFile('lib/json.mjs', 'utf8');
  const calls = src.match(/fsync(?:Sync)?\(/g) ?? [];
  assert.ok(calls.length >= 2, 'both the file and its directory are fsynced');
});
