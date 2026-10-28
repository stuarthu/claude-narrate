// T-04 — bin/describe.mjs. Red-first: written before bin/describe.mjs exists, so the first
// run must fail with ERR_MODULE_NOT_FOUND (behaviour missing), not with a runner that could
// not start. Real clips are cut by ffmpeg here, because "measure, do not believe" (rule 4)
// cannot be checked against a made-up duration.
import assert from 'node:assert';
import { test } from 'node:test';
import { run } from '../lib/run.mjs';
import { readJson, writeJson } from '../lib/json.mjs';
import { CLIP_SCHEMA, QUERY_SCHEMA, blankIndex } from '../lib/contract.mjs';
import { pullFrames, storeSaid, storeQueries } from '../bin/describe.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const ROOTS = [];

async function makeRoot(label) {
  const dir = await mkdtemp(join(tmpdir(), `narrate-describe-${label}-`));
  ROOTS.push(dir);
  return dir;
}

async function clip(dir, name, seconds, size = '320x240') {
  const r = await run(['ffmpeg', '-y', '-f', 'lavfi',
    '-i', `testsrc=duration=${seconds}:size=${size}:rate=30`,
    '-c:v', 'h264', '-pix_fmt', 'yuv420p', join(dir, name)]);
  assert.ok(r.ok && r.code === 0, `ffmpeg made ${name}`);
}

async function audioOnly(dir, name, seconds) {
  const r = await run(['ffmpeg', '-y', '-f', 'lavfi', '-i', `sine=duration=${seconds}`,
    join(dir, name)]);
  assert.ok(r.ok && r.code === 0, `ffmpeg made ${name}`);
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function frameNames(dir) {
  try { return (await readdir(dir)).filter((n) => n.startsWith('frame-')); } catch { return []; }
}

const CJK = /[\p{Script=Han}]/u;

// ------------------------------------------------------------------------ the tests

await test('A-1: one clip understood ends with a text description in fromMachine', async () => {
  const dir = await makeRoot('said');
  await clip(dir, 'bench.mp4', 4);
  const pull = await pullFrames({ clip: join(dir, 'bench.mp4'), every: 2, root: dir });
  assert.equal(pull.ok, true, 'the frames came back');
  assert.equal(pull.count, 2, 'a 4 s clip at every 2 s gives 2 frames');
  for (const f of pull.frames) {
    assert.ok(f.atSec < pull.durationSec, `${f.name} sits inside the clip, not past its end`);
  }
  const said = join(dir, 'said.json');
  await writeFile(said, JSON.stringify({ segments: [
    { startSec: 0, endSec: 4, description: 'a wooden bench under a tree',
      tags: ['bench', 'tree'], confidence: 0.7 },
  ] }));
  const store = await storeSaid({ clip: join(dir, 'bench.mp4'), said, root: dir });
  assert.equal(store.ok, true, 'what Claude said was stored');
  const side = await readJson(join(dir, 'bench.json'));
  assert.equal(side.ok, true, 'the sidecar parses');
  const seg = side.value.fromMachine.segments;
  assert.equal(seg.length, 1, 'one segment stored');
  assert.ok(typeof seg[0].description === 'string' && seg[0].description.length > 0,
    'the description is text, not an empty field');
  assert.deepEqual(seg[0].tags, ['bench', 'tree'], 'the tags landed');
  assert.equal(store.stored[0].description, seg[0].description, 'the result echoes what was stored');
});

await test('the frames are real pictures, and a big clip never gives a frame wider than 1024', async () => {
  const dir = await makeRoot('frames');
  await clip(dir, 'big.mp4', 7, '1920x1080');
  const pull = await pullFrames({ clip: join(dir, 'big.mp4'), every: 2, root: dir });
  assert.equal(pull.ok, true, 'the pull finished');
  assert.equal(pull.count, 4, 'a 7 s clip at every 2 s gives 4 frames');
  for (const f of pull.frames) {
    assert.equal(f.codec, 'mjpeg', `${f.name} is a real picture ffmpeg can read back`);
    assert.ok(f.width <= 1024, `${f.name} is small enough for Claude to read`);
    assert.ok(f.height > 0, `${f.name} has a height`);
  }
  assert.ok(pull.framesDir.startsWith(join(dir, '.narrate') + '/'),
    'the frames live inside .narrate: two places, nothing else');
  const side = await readJson(join(dir, 'big.json'));
  assert.equal(side.value.fromMachine.visualSearchDir, pull.framesDir,
    'the path-based visual dir is stored where pick can find it');
  assert.deepEqual(side.value.fromYou, blankIndex('big.mp4').fromYou,
    'pulling frames invented nothing in your section');
});

await test('a clip with no video stream is E_UNDERSTAND_FAILED, not an empty success', async () => {
  const dir = await makeRoot('audio-only');
  await audioOnly(dir, 'voice.mp4', 3);
  const pull = await pullFrames({ clip: join(dir, 'voice.mp4'), every: 1, root: dir });
  assert.equal(pull.ok, false, 'the pull failed');
  assert.equal(pull.error, 'E_UNDERSTAND_FAILED',
    'the error names understanding, not the file write (rule 6: a real failure gets a real name)');
  assert.equal(pull.count, 0, 'no frames were claimed');
  assert.equal((await frameNames(pull.framesDir)).length, 0, 'the frames dir holds nothing');
});

await test('a re-pull clears its own dir, so a shorter pull leaves no stale frame behind', async () => {
  const dir = await makeRoot('stale');
  await clip(dir, 'quay.mp4', 7);
  const wide = await pullFrames({ clip: join(dir, 'quay.mp4'), every: 2, root: dir });
  assert.equal(wide.count, 4, 'every 2 s gives 4 frames');
  const tight = await pullFrames({ clip: join(dir, 'quay.mp4'), every: 4, root: dir });
  assert.equal(tight.count, 2, 'every 4 s gives 2 frames: ceil(7/4), measured here');
  assert.equal(tight.framesDir, wide.framesDir, 'the same clip and fingerprint reuse one dir');
  assert.equal((await frameNames(tight.framesDir)).length, 2,
    'the dir was cleared: no stale frame survives a shorter pull');
  await clip(dir, 'quay.mp4', 9);   // the file changed, so the fingerprint changed
  const again = await pullFrames({ clip: join(dir, 'quay.mp4'), every: 2, root: dir });
  assert.notEqual(again.framesDir, tight.framesDir, 'a changed clip gets a new dir');
  assert.equal(again.stale.length, 1, 'the old dir is reported, so a reader can see it');
});

await test('A-3 + rule 1: what Claude said lands in fromMachine, your writing and foreign keys survive', async () => {
  const dir = await makeRoot('fromYou');
  await clip(dir, 'stock.mp4', 5);
  const path = join(dir, 'stock.json');
  const seed = blankIndex('stock.mp4');
  seed.fromYou.description = 'mine, do not rewrite';
  seed.fromYou.notes = 'I wrote this';
  seed.fromYou.tags = ['mine'];
  const foreign = { title: 'Bench timelapse', description: 'site text', tags: ['bench', '1080p'],
    weird: { nested: [1, 2, 3] } };
  await writeJson(path, { ...foreign, ...seed });
  const yoursBefore = JSON.stringify((await readJson(path)).value.fromYou);
  const said = join(dir, 'said.json');
  await writeFile(said, JSON.stringify({ segments: [
    { startSec: 0, endSec: 5, description: 'a bench, from frames', tags: ['bench'], confidence: 0.6 },
  ] }));
  const store = await storeSaid({ clip: join(dir, 'stock.mp4'), said, root: dir });
  assert.equal(store.ok, true, 'the store ran');
  const after = await readJson(path);
  assert.equal(JSON.stringify(after.value.fromYou), yoursBefore,
    'fromYou is unchanged byte for byte, including the line you wrote once');
  for (const key of ['title', 'description', 'tags', 'weird']) {
    assert.deepEqual(after.value[key], foreign[key], `key ${key} we never created is kept`);
  }
  assert.equal(after.value.schema, CLIP_SCHEMA, 'our schema is there');
});

await test('rule 4: seconds Claude claimed are checked against the measured length', async () => {
  const dir = await makeRoot('clamp');
  await clip(dir, 'short.mp4', 4);
  const said = join(dir, 'said.json');
  await writeFile(said, JSON.stringify({ segments: [
    { startSec: 0, endSec: 40, description: 'claims a minute that is not there', tags: [], confidence: 0.9 },
    { startSec: 3, endSec: 2, description: 'ends before it starts', tags: [], confidence: 0.9 },
    { startSec: 'x', endSec: 4, description: 'seconds that are not numbers', tags: [], confidence: 0.9 },
    { startSec: 1, endSec: 3, description: 'this one is fine', tags: ['ok'], confidence: 0.4 },
  ] }));
  const store = await storeSaid({ clip: join(dir, 'short.mp4'), said, root: dir });
  assert.equal(store.ok, true, 'one bad segment does not sink the store (rule 6)');
  const side = await readJson(join(dir, 'short.json'));
  assert.equal(side.value.fromMachine.segments.length, 2, 'two segments survived');
  const clamped = side.value.fromMachine.segments.find((s) => s.description.startsWith('claims'));
  assert.ok(clamped, 'the over-long segment is still there');
  assert.equal(clamped.endSec, side.value.measured.durationSec,
    'it was clamped to the measured length, not to what Claude said');
  assert.equal(store.dropped.length, 2, 'the two impossible segments are reported, not hidden');
});

await test('a said file that does not parse names understanding, and leaves the sidecar alone', async () => {
  const dir = await makeRoot('bad-said');
  await clip(dir, 'bench.mp4', 4);
  await writeFile(join(dir, 'bench.json'), JSON.stringify({ keep: 1 }));
  await writeFile(join(dir, 'said.json'), '{ "segments": [ ');
  const store = await storeSaid({ clip: join(dir, 'bench.mp4'), said: join(dir, 'said.json'), root: dir });
  assert.equal(store.ok, false, 'the store failed');
  assert.equal(store.error, 'E_UNDERSTAND_FAILED', 'the error names understanding, not the write');
  assert.equal(await readFile(join(dir, 'bench.json'), 'utf8'), JSON.stringify({ keep: 1 }),
    'the sidecar bytes are untouched');
});

await test('A-26: the English visual query for a Chinese sentence is stored and echoed', async () => {
  const dir = await makeRoot('queries');
  const file = join(dir, 'written.json');
  await writeFile(file, JSON.stringify({ queries: [
    { id: 'S-001', sentence: '傍晚，空 harbour 在 dusk 与 gulls', query: 'empty harbour at dusk with gulls' },
    { id: 'S-002', sentence: 'a bench in the park', query: 'bench park wood' },
  ] }));
  const r = await storeQueries({ work: 'harbour-film', queries: file, root: dir });
  assert.equal(r.ok, true, 'the queries were stored');
  const stored = await readJson(join(dir, '.narrate', 'harbour-film', 'queries.json'));
  assert.equal(stored.value.schema, QUERY_SCHEMA, 'the file carries our schema');
  assert.equal(stored.value.queries.length, 2, 'both rows stored');
  const row = stored.value.queries.find((q) => q.id === 'S-001');
  assert.ok(CJK.test(row.sentence), 'the sentence is Chinese');
  assert.equal(CJK.test(row.query), false,
    'the query is English: layer 2 cannot cross languages, so the English query is required');
  assert.equal(r.echoed.find((q) => q.id === 'S-001').query, row.query,
    'the query is echoed back so the agent can read it');
});

await test('a query that is not English is flagged: matching falls back to text, it is not an error', async () => {
  const dir = await makeRoot('bad-query');
  const file = join(dir, 'written.json');
  await writeFile(file, JSON.stringify({ queries: [
    { id: 'S-003', sentence: '一个木 bench', query: '空  harbour 在 dusk' },
    { id: 'S-004', sentence: 'a bench in the park', query: '' },
  ] }));
  const r = await storeQueries({ work: 'park-film', queries: file, root: dir });
  assert.equal(r.ok, true, 'storing still succeeded: a bad query is a warning, not a failure');
  assert.equal(r.notEnglish.length, 1, 'the Chinese query is reported');
  assert.equal(r.notEnglish[0].id, 'S-003', 'the report names the row');
  assert.ok(r.empty.some((q) => q.id === 'S-004'), 'an empty query is reported too');
  const stored = await readJson(join(dir, '.narrate', 'park-film', 'queries.json'));
  assert.equal(stored.value.queries.length, 2, 'both rows are still stored, so pick can fall back to text');
});

await test('rule 14: describe does not need the index step to have run first', async () => {
  const dir = await makeRoot('standalone');
  await clip(dir, 'bench.mp4', 4);
  const said = join(dir, 'said.json');
  await writeFile(said, JSON.stringify({ segments: [
    { startSec: 0, endSec: 4, description: 'a bench, from frames', tags: ['bench'], confidence: 0.6 },
  ] }));
  const store = await storeSaid({ clip: join(dir, 'bench.mp4'), said, root: dir });
  assert.equal(store.created, true, 'the sidecar was made here, not assumed to exist');
  const side = await readJson(join(dir, 'bench.json'));
  assert.ok(typeof side.value.measured.durationSec === 'number' && side.value.measured.durationSec > 0,
    'the length was measured here too, not copied from a scan');
  assert.deepEqual(side.value.fromYou, blankIndex('bench.mp4').fromYou,
    'your section was left blank, not filled with guesses');
});

await test('rule 7: what Claude said is data — a dangerous string never runs', async () => {
  const dir = await makeRoot('danger');
  await clip(dir, 'bench.mp4', 4);
  const said = join(dir, 'said.json');
  await writeFile(said, JSON.stringify({ segments: [
    { startSec: 0, endSec: 4, description: 'a; rm -rf /tmp/narrate-did-it $(id) `id` {} \n',
      tags: ['*'], confidence: 0.5 },
  ] }));
  const store = await storeSaid({ clip: join(dir, 'bench.mp4'), said, root: dir });
  assert.equal(store.ok, true, 'the store ran');
  const side = await readJson(join(dir, 'bench.json'));
  assert.ok(side.value.fromMachine.segments[0].description.includes('rm -rf'),
    'the text was kept as a string, exactly as Claude wrote it');
  assert.equal(await exists('/tmp/narrate-did-it'), false, 'nothing was created: no shell ran');
});

await test('the CLI prints one JSON object on stdout and nothing on stderr', async () => {
  const dir = await makeRoot('cli');
  await clip(dir, 'bench.mp4', 4);
  const r = await run(['node', 'bin/describe.mjs', '--clip', join(dir, 'bench.mp4'),
    '--every', '2', '--root', dir]);
  assert.equal(r.code, 0, 'exit 0');
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true, 'one object, ok');
  assert.equal(out.command, 'describe', 'the result names the command');
  assert.equal(r.stderr, '', 'stderr is empty on the success path');
});

for (const dir of ROOTS) await rm(dir, { recursive: true, force: true });
