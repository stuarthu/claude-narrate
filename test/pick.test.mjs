// T-05 — bin/pick.mjs. Red-first: this file exists before bin/pick.mjs, so the first run
// must fail with ERR_MODULE_NOT_FOUND (behaviour missing), not with a runner that could
// not start. Real clips are cut by ffmpeg here, because the duration filter (layer 1 of the
// funnel) is only honest against a measured length.
import assert from 'node:assert';
import { test } from 'node:test';
import { run } from '../lib/run.mjs';
import { readJson, writeJson, ensureDir } from '../lib/json.mjs';
import { scanAssets } from '../bin/index.mjs';
import {
  FILL, availableLength, DEMOTE_MIN_RATIO, displayWidth,
  SHOT_SCHEMA, blankShot, blankQueries, QUERY_SCHEMA,
} from '../lib/contract.mjs';
import { plan, tokenize, estimateSec, scoreText, demote, idf } from '../bin/pick.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';

const ROOTS = [];
const CJK = /[\p{Script=Han}]/u;

async function makeRoot(label) {
  const dir = await mkdtemp(join(tmpdir(), `narrate-pick-${label}-`));
  ROOTS.push(dir);
  return dir;
}

async function clip(dir, name, seconds) {
  const r = await run(['ffmpeg', '-y', '-f', 'lavfi',
    '-i', `testsrc=duration=${seconds}:size=320x240:rate=30`,
    '-c:v', 'h264', '-pix_fmt', 'yuv420p', join(dir, name)]);
  assert.ok(r.ok && r.code === 0, `ffmpeg made ${name}`);
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function sidecarBytes(dir) {
  // every .json under dir, as { path: bytes } — used to prove pick never writes there
  const out = {};
  // Dot entries are skipped, the same rule walk() uses in bin/index.mjs. The rule this
  // test proves is about the clips: pick never writes a json beside one. .narrate/<work>/
  // is our declared work area, and plan() has to write shots.json inside it.
  const walk = async (d) => {
    for (const e of (await readdir(d, { withFileTypes: true }))) {
      if (e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.json')) out[p.replace(dir, '')] = await readFile(p, 'utf8');
    }
  };
  await walk(dir);
  return out;
}

function sidecarPath(dir, clipName) {
  return join(dir, `${clipName.replace(/\.[^.]*$/, '')}.json`);   // doc §8: bench.mp4 gets bench.json
}

// ---------------------------------------------------------------- fixtures

// Boilerplate tags are on every clip, as measured on real stock and archive footage
// (20-32 tags, most of them "Royalty Free" style filler). Rarity weighting must not let
// that filler win a match.
const BOILER = 'Royalty Free;Fair Use;Stock Footage';

async function assetsMain() {
  const dir = await makeRoot('main');
  const spec = [
    ['sky-clouds.mp4', 12, 'time lapse of clouds moving across a bright sky\n' +
      `#clouds;sky;bright;moving;time;lapse;${BOILER}\n`],
    ['bench-park.mp4', 12, 'a wooden bench beside a path in the park\n' +
      `#bench;park;wood;path;${BOILER}\n`],
    ['harbour-dusk.mp4', 12, 'empty harbour at dusk with gulls on the water\n' +
      `#harbour;dusk;gulls;water;quay;${BOILER}\n`],
    ['tiny-clip.mp4', 3, 'a close up of a clock hand\n' +
      `#clock;hand;${BOILER}\n`],
  ];
  for (const [name, seconds, sidecar] of spec) {
    await clip(dir, name, seconds);
    await writeFile(join(dir, `${name}.narrate.txt`), sidecar);
  }
  const scan = await scanAssets({ assets: dir });
  assert.ok(scan.ok, 'the index step wrote the records pick will read');
  return dir;
}

async function understand(dir, clipName, segments, visualDir) {
  const path = sidecarPath(dir, clipName);
  const one = await readJson(path);
  assert.equal(one.ok, true, 'the sidecar parses');
  one.value.fromMachine.segments = segments;
  one.value.fromMachine.visualSearchDir = visualDir;
  one.value.fromMachine.engine = visualDir ? 'claude-frames' : '';
  assert.equal((await writeJson(path, one.value)).ok, true, 'the machine section landed');
}

async function writeWork(dir, work, script, queries) {
  const dir2 = join(dir, '.narrate', work);
  assert.equal((await ensureDir(dir2)).ok, true, 'the work folder exists');
  await writeFile(join(dir2, 'script.txt'), script);
  if (queries !== null) await writeFile(join(dir2, 'queries.json'), JSON.stringify(queries));
  return dir2;
}

const MAIN_SCRIPT = [
  '1. clouds across a bright sky',
  '2. a wooden bench beside a path',
  '3. empty harbour at dusk with gulls',
  '4. gulls on the quay at dusk',
  '5. a red door opens onto a narrow street',
].join('\n') + '\n';

const MAIN_QUERIES = { queries: [
  { id: 'S-001', sentence: 'clouds across a bright sky', query: 'bright sky with moving clouds, time lapse' },
  { id: 'S-002', sentence: 'a wooden bench beside a path', query: 'wooden park bench beside a path' },
  { id: 'S-003', sentence: 'empty harbour at dusk with gulls', query: 'empty harbour at dusk with gulls' },
  { id: 'S-004', sentence: 'gulls on the quay at dusk', query: 'gulls on the quay at dusk with harbour' },
  { id: 'S-005', sentence: 'a red door opens onto a narrow street', query: 'a red door opening onto a narrow street' },
] };

// ---------------------------------------------------------------- the tests

await test('the pick error names exist, so a stop says which stage it stopped at', async () => {
  const c = await import('../lib/contract.mjs');
  assert.ok(Array.isArray(c.ERRORS.pick) && c.ERRORS.pick.length > 0, 'pick has its own error group');
  for (const name of ['E_PICK_SCRIPT_MISSING', 'E_PICK_INDEX_MISSING', 'E_PICK_CLIP_UNINDEXED']) {
    assert.ok(c.ERRORS.pick.includes(name), `${name} is a known name`);
  }
  assert.equal(idf(1, 4) > idf(4, 4), true, 'a word in one clip weighs more than a word in every clip');
  assert.equal(idf(4, 4), Math.log(1 + 4 / 4), 'boilerplate carried by all clips gets the lowest weight');
});

await test('rarity weighting: one rare word beats boilerplate carried by every clip', async () => {
  const own = [new Set(['harbour', 'royalty', 'free']), new Set(['royalty', 'free'])];
  const df = { harbour: 1, royalty: 2, free: 2 };
  const query = tokenize('harbour royalty free');
  const a = scoreText(query, own[1], df);   // the clip with only boilerplate
  const b = scoreText(query, own[0], df);   // the clip that also says harbour
  assert.ok(b > a, 'the rare word wins: measured wrong on 36 real archive clips without this');
  assert.equal(a, Math.round(100 * (idf(2, 2) + idf(2, 2)) / (idf(1, 2) + idf(2, 2) + idf(2, 2))),
    'the score is the weighted share of the query terms this clip covers');
});

await test('A-6: every shot-list row carries id, clip file, start second, end second, subtitle text', async () => {
  const dir = await assetsMain();
  await ensureDir(join(dir, 'sky.frames'));
  await understand(dir, 'sky-clouds.mp4',
    [{ startSec: 0, endSec: 12, description: 'clouds moving across a bright sky', tags: ['clouds', 'sky'], confidence: 0.8 }],
    join(dir, 'sky.frames'));
  const work = await writeWork(dir, 'harbour-film', MAIN_SCRIPT, MAIN_QUERIES);
  const r = await plan({ work: 'harbour-film', assets: dir, root: dir, aspect: 'landscape' });
  assert.equal(r.ok, true, 'the shot list was made');
  const shots = await readJson(join(work, 'shots.json'));
  assert.equal(shots.value.schema, SHOT_SCHEMA, 'the shot list carries our schema');
  assert.equal(shots.value.aspect, 'landscape', 'the aspect is stored where segment will read it');
  assert.equal(shots.value.shots.length, 4, 'four sentences got a clip, the fifth did not');
  for (const row of shots.value.shots) {
    assert.deepEqual(Object.keys(row).sort(), Object.keys(blankShot('S-001')).sort(),
      'the row is exactly the shape contract.mjs declares: no side invented a field');
    assert.ok(/^S-\d{3}$/.test(row.id), `${row.id} is a sentence id`);
    assert.ok(typeof row.assetPath === 'string' && row.assetPath.endsWith('.mp4'),
      'the row names the clip file, under the name the renderer reads');
    assert.ok(row.startSec >= 0 && row.endSec > row.startSec, 'the row has a start second and an end second');
    assert.ok(row.sentence.length > 0, 'the row carries the subtitle text');
    assert.ok(row.query.length > 0, 'the row carries the English query: why this clip can be checked later');
  }
  const ids = shots.value.shots.map((s) => s.id);
  assert.deepEqual(ids, ['S-001', 'S-002', 'S-003', 'S-004'], 'rows stay in script order');
});

await test('A-7: a sentence that matches nothing is reported with its id and "no clip"', async () => {
  const dir = await assetsMain();
  const work = await writeWork(dir, 'harbour-film', MAIN_SCRIPT, MAIN_QUERIES);
  const r = await plan({ work: 'harbour-film', assets: dir, root: dir, aspect: 'landscape' });
  assert.equal(r.missing.length, 1, 'one sentence has no clip');
  const miss = r.missing[0];
  assert.equal(miss.id, 'S-005', 'the report names the sentence id');
  assert.equal(miss.reason, 'no clip', 'the report says no clip, in words a reader can act on');
  assert.equal(miss.sentence, 'a red door opens onto a narrow street', 'the report quotes the sentence');
  assert.ok(miss.tooShort.some((c) => c.clip === 'tiny-clip.mp4'), 'the too short list names the clip');
  assert.ok(miss.notRelevant.some((c) => c.clip === 'bench-park.mp4'), 'the not relevant list names the clip');
  assert.equal(r.ok, true, 'a missing clip is a report, not a failure: stop 3 shows it to the user');
});

await test('A-24: a clip that cannot cover the narration from its start is not a candidate', async () => {
  const dir = await assetsMain();
  const work = await writeWork(dir, 'harbour-film', MAIN_SCRIPT, MAIN_QUERIES);
  const r = await plan({ work: 'harbour-film', assets: dir, root: dir, aspect: 'landscape' });
  const chosen = r.shots.map((s) => basename(s.assetPath));
  assert.equal(chosen.includes('tiny-clip.mp4'), false, 'the 3 s clip was never chosen');
  const need = estimateSec('clouds across a bright sky');
  const short = r.missing[0].tooShort.find((c) => c.clip === 'tiny-clip.mp4');
  assert.ok(short.availableSec < short.needSec, 'the report shows the available length against the need');
  assert.ok(r.layers.duration.dropped > 0, 'layer 1 dropped clips before any text was scored');
  assert.ok(r.shots.every((s) => s.sentence !== 'a red door opens onto a narrow street'),
    'the estimate errs long, so a too short clip is really out');
  assert.equal(need, displayWidth('clouds across a bright sky') / FILL.ESTIMATE_CHARS_PER_SEC,
    'the estimate is the contract formula, not a guess');
});

await test('A-24b: a clip described only from 6 s on is used from 6 s, and cannot cover a longer line', async () => {
  const dir = await makeRoot('described-half');
  await clip(dir, 'quay.mp4', 12);
  await writeFile(join(dir, 'quay.mp4.narrate.txt'), 'gulls on the water at the quay\n#gulls;water;quay\n');
  assert.ok((await scanAssets({ assets: dir })).ok, 'the index step ran');
  await understand(dir, 'quay.mp4',
    [{ startSec: 6, endSec: 12, description: 'gulls on the water', tags: ['gulls', 'water'], confidence: 0.7 }], '');
  const script = '1. gulls on the water\n2. gulls on the water at the quay in the evening\n';
  const work = await writeWork(dir, 'half', script, { queries: [
    { id: 'S-001', sentence: 'gulls on the water', query: 'gulls on the water' },
    { id: 'S-002', sentence: 'gulls on the water at the quay in the evening', query: 'gulls on the water at the quay in the evening' },
  ] });
  const r = await plan({ work: 'half', assets: dir, root: dir, aspect: 'landscape' });
  assert.equal(r.shots.length, 1, 'only the short line fits the described part');
  assert.equal(r.shots[0].startSec, 6, 'the shot starts where the description starts');
  assert.equal(r.missing.length, 1, 'the long line has no clip that can cover it from its start');
  assert.equal(r.missing[0].tooShort[0].clip, 'quay.mp4', 'and the report says too short, not not relevant');
  assert.equal(availableLength(12, 12, 6), 6, 'available length is the described end clamped to the file');
});

await test('A-25: nothing to work from in the visual layer falls back to text and says so', async () => {
  const dir = await assetsMain();
  await understand(dir, 'harbour-dusk.mp4',
    [{ startSec: 0, endSec: 12, description: 'gulls over an empty harbour at dusk', tags: ['harbour', 'gulls'], confidence: 0.8 }],
    join(dir, 'moved-frames-harbour'));   // a path-based dir that is not on disk: the folder was moved
  const work = await writeWork(dir, 'harbour-film', MAIN_SCRIPT, MAIN_QUERIES);
  const r = await plan({ work: 'harbour-film', assets: dir, root: dir, aspect: 'landscape' });
  assert.equal(r.ok, true, 'a move is not an error: matching falls back to text');
  assert.ok(r.visualMissing.some((v) => v.clip === 'harbour-dusk.mp4' && v.reason.includes('not on disk')),
    'the report says the visual layer had nothing to work from');
  const harbour = r.shots.find((s) => basename(s.assetPath) === 'harbour-dusk.mp4');
  assert.ok(harbour, 'the harbour sentences still got their clip, from text');
  assert.equal(harbour.chosenBy, 'text', 'the row says which layer decided');
});

await test('A-26: a Chinese sentence gets an English query, stored and echoed', async () => {
  const dir = await makeRoot('chinese');
  await clip(dir, 'harbour-dusk.mp4', 12);
  await writeFile(join(dir, 'harbour-dusk.mp4.narrate.txt'), 'empty harbour at dusk with gulls\n#harbour;dusk;gulls;water\n');
  assert.ok((await scanAssets({ assets: dir })).ok, 'the index step ran');
  const zh = '傍晚，空 harbour 在 dusk 与 gulls';
  const script = `1. ${zh}\n2. 一个红门在窄街道\n`;
  const work = await writeWork(dir, 'evening', script, { queries: [
    { id: 'S-001', sentence: zh, query: 'empty harbour at dusk with gulls' },
    { id: 'S-002', sentence: '一个红门在窄街道', query: '' },
  ] });
  const r = await plan({ work: 'evening', assets: dir, root: dir, aspect: 'portrait' });
  assert.equal(r.ok, true, 'the plan ran');
  assert.equal(r.shots.length, 1, 'the sentence with an English query got a clip');
  const row = r.shots[0];
  assert.ok(CJK.test(row.sentence), 'the sentence is Chinese');
  assert.equal(CJK.test(row.query), false, 'the query is English: bigrams cannot cross languages');
  const stored = await readJson(join(work, 'shots.json'));
  assert.equal(stored.value.shots[0].query, row.query, 'the English query is stored in the work files');
  assert.equal(r.noEnglishQuery.length, 1, 'the sentence with no English query is reported, not guessed at');
  assert.equal(r.noEnglishQuery[0].id, 'S-002', 'the report names it');
  assert.equal(r.missing[0].id, 'S-002', 'and it lands in the missing report');
});

await test('A-27: a clip used by two sentences shows its use count', async () => {
  const dir = await assetsMain();
  const work = await writeWork(dir, 'harbour-film', MAIN_SCRIPT, MAIN_QUERIES);
  const r = await plan({ work: 'harbour-film', assets: dir, root: dir, aspect: 'landscape' });
  const used = r.useCount.find((u) => u.clip === 'harbour-dusk.mp4');
  assert.ok(used, 'the reused clip is in the report');
  assert.equal(used.count, 2, 'two sentences used it');
  assert.deepEqual(used.ids, ['S-003', 'S-004'], 'the report names which sentences');
  assert.ok(r.demotions.some((d) => d.clip === 'harbour-dusk.mp4' && d.useCount === 1),
    'the second use was reached after a demotion, and the report shows both scores');
});

await test('demotion happens only inside the 80% pool, so a weak clip is never punished', async () => {
  const scores = { 'best.mp4': 100, 'rival.mp4': 90, 'weak.mp4': 60 };
  const useCount = { 'rival.mp4': 1, 'weak.mp4': 3 };
  const best = Math.max(...Object.values(scores));
  const pool = Object.keys(scores).filter((k) => scores[k] >= best * DEMOTE_MIN_RATIO);
  assert.deepEqual(pool, ['best.mp4', 'rival.mp4'], 'the pool is candidates at 80% or more of the best');
  const after = demote(scores, useCount, best);
  assert.equal(after.scores['weak.mp4'], 60, 'a clip that was never a rival keeps its score');
  assert.equal(after.scores['rival.mp4'], 90 * (1 - 0.25 * 1), 'a rival that was used is demoted');
  assert.deepEqual(after.demotions.map((d) => d.clip), ['rival.mp4'], 'only the pool member is reported');
});

await test('ping-pong: two neighbouring sentences never swap over the same two clips', async () => {
  const dir = await makeRoot('pingpong');
  for (const name of ['first-clip.mp4', 'second-clip.mp4']) {
    await clip(dir, name, 12);
    await writeFile(join(dir, `${name}.narrate.txt`), 'gulls at dusk over the harbour\n#gulls;dusk;harbour\n');
  }
  assert.ok((await scanAssets({ assets: dir })).ok, 'the index step ran');
  const line = 'gulls at dusk over the harbour';
  const script = ['1. ' + line, '2. ' + line, '3. ' + line].join('\n') + '\n';
  const work = await writeWork(dir, 'swap', script, { queries: [
    { id: 'S-001', sentence: line, query: line },
    { id: 'S-002', sentence: line, query: line },
    { id: 'S-003', sentence: line, query: line },
  ] });
  const r = await plan({ work: 'swap', assets: dir, root: dir, aspect: 'landscape' });
  assert.equal(r.shots.length, 3, 'every sentence got a clip');
  const names = r.shots.map((s) => basename(s.assetPath));
  assert.equal(names[2] === names[0] && names[1] !== names[0], false,
    'A then B then A is forbidden, even when both clips score the same');
  assert.equal(new Set(names).size, 2, 'only the two clips exist, so all three uses are of them');
});

await test('NEW-2: no script from the stage before stops, and writes no shot list', async () => {
  const dir = await assetsMain();
  const work = join(dir, '.narrate', 'no-script');
  assert.equal((await ensureDir(work)).ok, true, 'the work folder exists, the script does not');
  const r = await plan({ work: 'no-script', assets: dir, root: dir, aspect: 'landscape' });
  assert.equal(r.ok, false, 'the stage stopped instead of inventing a script');
  assert.equal(r.error, 'E_PICK_SCRIPT_MISSING', 'the error names the stage that is missing');
  assert.ok(r.message.includes('script.txt'), 'the message says what it looked for');
  assert.equal(await exists(join(work, 'shots.json')), false, 'no shot list was written');
});

await test('NEW-2: clips with no index records stop too, rather than planning from nothing', async () => {
  const dir = await makeRoot('unindexed');
  await clip(dir, 'bench.mp4', 12);
  const work = await writeWork(dir, 'w', '1. a bench in the park\n', { queries: [
    { id: 'S-001', sentence: 'a bench in the park', query: 'bench park' }] });
  const r = await plan({ work: 'w', assets: dir, root: dir, aspect: 'landscape' });
  assert.equal(r.ok, false, 'the stage stopped');
  assert.equal(r.error, 'E_PICK_INDEX_MISSING', 'the error names the index step');
  assert.ok(r.message.includes('index'), 'the message points at the step to run first');
  assert.equal(await exists(join(work, 'shots.json')), false, 'no shot list was written');
});

await test('rule 6: one clip with no record is reported, the rest are still planned', async () => {
  const dir = await assetsMain();
  await rm(sidecarPath(dir, 'bench-park.mp4'), { force: true });
  const work = await writeWork(dir, 'harbour-film', MAIN_SCRIPT, MAIN_QUERIES);
  const r = await plan({ work: 'harbour-film', assets: dir, root: dir, aspect: 'landscape' });
  assert.equal(r.ok, true, 'one bad clip does not sink the plan');
  assert.ok(r.clipErrors.some((e) => e.clip === 'bench-park.mp4' && e.error === 'E_PICK_CLIP_UNINDEXED'),
    'the clip without a record is named');
  assert.ok(r.shots.some((s) => basename(s.assetPath) === 'sky-clouds.mp4'), 'the others still got planned');
});

await test('pick never writes in the assets folder: every sidecar byte is unchanged', async () => {
  const dir = await assetsMain();
  const work = await writeWork(dir, 'harbour-film', MAIN_SCRIPT, MAIN_QUERIES);
  const before = await sidecarBytes(dir);
  const r = await plan({ work: 'harbour-film', assets: dir, root: dir, aspect: 'landscape' });
  assert.equal(r.ok, true, 'the plan ran');
  assert.deepEqual(await sidecarBytes(dir), before,
    'the shot list only reads: ownership rule, nothing else writes here');
});

await test('the CLI prints one JSON object on stdout and nothing on stderr', async () => {
  const dir = await assetsMain();
  await writeWork(dir, 'harbour-film', MAIN_SCRIPT, MAIN_QUERIES);
  const r = await run(['node', 'bin/pick.mjs', '--work', 'harbour-film',
    '--assets', dir, '--root', dir, '--aspect', 'landscape']);
  assert.equal(r.code, 0, 'exit 0');
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true, 'one object, ok');
  assert.equal(out.command, 'pick', 'the result names the command');
  assert.equal(r.stderr, '', 'stderr is empty on the success path');
  const bad = await run(['node', 'bin/pick.mjs', '--work', 'harbour-film',
    '--assets', dir, '--root', dir, '--aspect', 'square-ish']);
  assert.notEqual(bad.code, 0, 'an aspect we have no frame for exits non-zero');
  assert.equal(JSON.parse(bad.stderr).error, 'E_PICK_ASPECT_UNKNOWN', 'and says which value was bad');
});

for (const dir of ROOTS) await rm(dir, { recursive: true, force: true });
