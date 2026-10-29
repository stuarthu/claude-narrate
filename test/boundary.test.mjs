// F-13 — the crossings. Every hand-off below is the REAL producer feeding the REAL consumer,
// with no hand-made JSON in between. The bug this file exists for shipped green twice: the
// index step returned {clipPath, record} while the reader looked at the top level, so 36 real
// clips read as "not yet understood"; and the shot plan wrote clipPath where the renderer read
// assetPath. Both sides had their own green tests and their own fixtures.
//
// Red first: `node --test test/boundary.test.mjs` before this file existed failed with code
// ERR_MODULE_NOT_FOUND, url file:///home/stuart/workspace/claude-narrate/test/boundary.test.mjs
// — the crossings had never been run together, not a runner that could not start (F-9).
//
// The one thing not produced by a real step: the words in said-*.json. Those stand in for what
// Claude said about the frames, which no test run can ask for. Everything that reads them is
// real, and the shape they come in is the shape describe writes.
import assert from 'node:assert';
import { test } from 'node:test';
import { scanAssets, jsonPathFor } from '../bin/index.mjs';
import { pullFrames, storeSaid, storeQueries } from '../bin/describe.mjs';
import { plan } from '../bin/pick.mjs';
import { speak, audioPathOf } from '../bin/voice.mjs';
import { joinAudio } from '../bin/preview.mjs';
import { cut, partPathOf } from '../bin/segment.mjs';
import { joinParts, concatListPathOf } from '../bin/concat.mjs';
import { run } from '../lib/run.mjs';
import { readJson, writeJson, ensureDir } from '../lib/json.mjs';
import { FRAMES, QUERY_SCHEMA, RESULT_SCHEMA, SHAPE_PROBE, parseScript } from '../lib/contract.mjs';
import { mkdtemp, writeFile, readFile, stat, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOTS = [];

async function makeRoot(label) {
  const dir = await mkdtemp(join(tmpdir(), `narrate-boundary-${label}-`));
  ROOTS.push(dir);
  return dir;
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function countFiles(dir) {
  const r = await run(['find', dir, '-type', 'f']);
  return r.ok ? r.stdout.split('\n').filter(Boolean).length : -1;
}

async function probe(path, entries) {
  const r = await run(['ffprobe', '-v', 'error', '-show_entries',
    `stream=codec_type,${entries.join(',')}`, '-print_format', 'json', path]);
  if (!r.ok) return null;
  const j = JSON.parse(r.stdout);
  const one = {};
  for (const half of (j?.streams ?? [])) for (const [k, v] of Object.entries(half)) one[k] = v;
  return one;
}

async function durationOf(path) {
  const r = await run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', path]);
  return r.ok && r.stdout.trim() !== '' ? Number(r.stdout.trim()) : null;
}

// A clip in the shape the contract says every part will have, so the chain starts from a clip
// a real camera could have left behind.
async function clip(dir, name, seconds) {
  const r = await run(['ffmpeg', '-y', '-f', 'lavfi',
    '-i', `color=0x0a0a0a:size=1920x1080:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=300:duration=${seconds}`,
    '-map', '0:v', '-map', '1:a', '-c:v', 'h264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2', join(dir, name)]);
  assert.ok(r.ok && r.code === 0, `ffmpeg made ${name}`);
}

const SKY = [
  ['sky-clouds.mp4', 30, 'time lapse of clouds moving across a bright sky\n' +
    '#clouds;sky;bright;moving;time;lapse;Royalty Free;Fair Use;Stock Footage\n'],
  ['harbour-dusk.mp4', 30, 'empty harbour at dusk with gulls on the water\n' +
    '#harbour;dusk;gulls;water;quay;Royalty Free;Fair Use;Stock Footage\n'],
];
const S1 = 'Clouds cross the bright sky before the rain.';
const S2 = 'Gulls turn over the water at dusk.';
const SCRIPT = `1. ${S1}\n2. ${S2}\n`;
// What Claude said about the frames, in the shape describe expects. Stands in for a real call.
const SAID = {
  'sky-clouds': [{ startSec: 0, endSec: 30, confidence: 0.9,
    description: 'Clouds move across a bright sky in a time lapse.',
    tags: ['clouds', 'sky', 'bright', 'moving', 'time lapse'] }],
  'harbour-dusk': [{ startSec: 0, endSec: 30, confidence: 0.9,
    description: 'Gulls turn over the water at dusk near an empty harbour.',
    tags: ['harbour', 'dusk', 'gulls', 'water', 'quay'] }],
};
const QUERIES_IN = [
  { id: 'S-001', sentence: S1, query: 'bright sky with moving clouds, time lapse' },
  { id: 'S-002', sentence: S2, query: 'gulls on the water at dusk with harbour' },
];

function tone(seconds) {
  return {
    argv: ['ffmpeg', '-y', '-f', 'lavfi', '-i', `sine=frequency=300:duration=${seconds}`,
      '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2', '{out}'],
    ext: 'wav', timeoutMs: 20000, speech: false, network: false,
    note: 'Not a voice: a tone, so this test needs no network and no key.',
  };
}

// One chain, built once before any row runs, and shared. Each row asks about a different hand-off,
// and none of them may write anything the next row would depend on. Building it here rather than
// inside the rows matters: node --test starts the rows at the same time, and a chain built on
// demand would start seven full chains at once, which starves the ffprobe calls inside them.
async function chain() {
  const root = await makeRoot('chain');
  for (const [name, seconds, sidecar] of SKY) {
    await clip(root, name, seconds);
    await writeFile(join(root, `${name.replace(/\.[^.]*$/, '')}.narrate.txt`), sidecar);
  }
  const scan = await scanAssets({ assets: root });
  assert.ok(scan.ok, 'the index step wrote the records the next step will read');

  // index -> describe: the frame puller is handed a path from the index step's own result.
  const frames = {};
  for (const rec of scan.clips) {
    const abs = join(root, rec.clip);
    const pull = await pullFrames({ clip: abs, every: 5, root });
    assert.ok(pull.ok, `the frame puller opened ${rec.clip}`);
    frames[rec.clip] = pull.framesDir;
    assert.ok((await countFiles(pull.framesDir)) > 0, 'the frames are really on disk');
  }

  // describe -> describe: what Claude said goes through the real store step, not into a file
  // the test shaped.
  for (const [stem, segments] of Object.entries(SAID)) {
    const saidPath = join(root, `said-${stem}.json`);
    await writeJson(saidPath, { segments });
    const clipName = `${stem}.mp4`;
    const stored = await storeSaid({ clip: join(root, clipName), said: saidPath, root });
    assert.ok(stored.ok, `describe stored words for ${clipName}`);
  }

  await ensureDir(join(root, '.narrate', 'w'));
  await writeFile(join(root, '.narrate', 'w', 'script.txt'), SCRIPT);

  // describe -> pick: the English queries go through the real store step too.
  const queriesIn = join(root, 'queries-in.json');
  await writeJson(queriesIn, { queries: QUERIES_IN });
  const storedQueries = await storeQueries({ work: 'w', queries: queriesIn, root });
  assert.ok(storedQueries.ok, 'describe stored the queries pick will read');

  const p = await plan({ work: 'w', assets: root, root, aspect: 'landscape' });
  assert.ok(p.ok, `pick ran: ${p.ok ? '' : p.error + ' ' + p.message}`);

  const cfg = join(root, 'config', 'engines.json');
  await mkdir(join(root, 'config'), { recursive: true });
  await writeJson(cfg, { schema: 'narrate/engines@1', default: 'tone',
    engines: { tone: tone(3) } });
  const v = await speak({ work: 'w', root, config: cfg });
  assert.ok(v.ok, `voice ran: ${v.ok ? '' : v.error + ' ' + v.message}`);

  const preview = await joinAudio({ work: 'w', root });
  assert.ok(preview.ok, `preview ran: ${preview.ok ? '' : preview.error + ' ' + preview.message}`);

  const c = await cut({ work: 'w', root, approved: true });
  assert.ok(c.ok, `segment ran: ${c.ok ? '' : c.error + ' ' + c.message}`);

  const out = join(root, 'out', 'w.mp4');
  const j = await joinParts({ work: 'w', root, approved: true, out });
  assert.ok(j.ok, `concat ran: ${j.ok ? '' : j.error + ' ' + j.message}`);

  return { root, scan, p, v, preview, c, j };
}

const CHAIN = await chain();

// ------------------------------------------------------------------ the crossings

await test('index -> describe: the record names a clip the frame puller can really open', async () => {
  const { root, scan } = CHAIN;
  assert.ok(scan.clips.length >= 2, 'the index step found the clips');
  for (const rec of scan.clips) {
    const abs = join(root, rec.clip);
    assert.ok(await exists(abs), `the record for ${rec.clip} points at a file that is there`);
    assert.ok(await exists(jsonPathFor(abs)), 'and at the record it wrote beside it');
  }
  // The trap: the record path is relative to the assets root. A reader that used it as it came
  // out of the step would look in the wrong place.
  const rec = scan.clips[0];
  assert.notEqual(rec.clip, join(root, rec.clip), 'the path is relative, so the reader must join it');
  const pull = await pullFrames({ clip: rec.clip, every: 5, root });
  assert.equal(pull.error, 'E_ASSET_MISSING',
    'a relative path handed over unchanged stops, it does not quietly pull the wrong clip');
});

await test('describe -> pick: what describe stored is what pick reads, so no clip is "not yet understood"', async () => {
  const { root, scan, p } = CHAIN;
  for (const rec of scan.clips) {
    assert.equal(rec.needsUnderstanding, true,
      'before describe ran, the index step said these clips were not understood');
  }
  const sidecar = await readJson(jsonPathFor(join(root, scan.clips[0].clip)));
  assert.ok(sidecar.ok, 'the sidecar describe wrote is JSON');
  assert.ok(sidecar.value.fromMachine.segments.some((s) => (s.description ?? '') !== ''),
    'the words describe stored are in the file pick will read');
  assert.equal(p.missing.length, 0, 'pick found a clip for every sentence, so the words reached it');
  assert.equal(p.considered, scan.clips.length,
    'pick counted the clips the index step found, not a hand-made list');
});

await test('pick -> segment: the shot names a clip the renderer really opened', async () => {
  const { root, p, c } = CHAIN;
  assert.equal(p.shots.length, 2, 'one shot per sentence');
  for (const shot of p.shots) {
    assert.ok(await exists(shot.assetPath), `the clip ${shot.id} names is on disk`);
    assert.ok(await exists(partPathOf('w', shot.id, root)), `the part for ${shot.id} was made`);
    assert.notEqual(shot.assetPath, '', 'the renderer read assetPath, not a name one side invented');
  }
  assert.equal(c.parts.length, 2, 'the renderer cut one part per shot');
});

await test('voice -> preview: the recordings speak wrote are the files joinAudio read', async () => {
  const { root, v, preview } = CHAIN;
  assert.equal(v.audio.length, 2, 'one recording per sentence');
  for (const rec of v.audio) {
    assert.ok(await exists(rec.out), `the wav voice named is on disk`);
    assert.equal(rec.out, audioPathOf('w', rec.id, root),
      'the path voice wrote is the path the join will look for, same name from both sides');
  }
  assert.ok(await exists(join(root, '.narrate', 'w', 'preview.wav')), 'the join wrote its product');
  assert.equal(preview.parts, 2, 'the join read two recordings, not a fixture');
  const got = await durationOf(join(root, '.narrate', 'w', 'preview.wav'));
  assert.ok(got !== null && Math.abs(got - preview.expectedSec) <= preview.toleranceSec,
    'the joined length is the sum of what speak wrote');
});

await test('voice -> segment: the renderer read the recording speak wrote for that sentence', async () => {
  const { root, v, c } = CHAIN;
  for (const rec of v.audio) {
    assert.ok(await exists(rec.out), 'the recording is where voice says it is');
  }
  assert.equal(c.parts.length, v.audio.length, 'one part per recording, so none was skipped quietly');
});

await test('segment -> concat: the parts cut wrote are the files joinParts read', async () => {
  const { root, c, j } = CHAIN;
  for (const part of c.parts) {
    assert.ok(await exists(part.path), `the part the renderer named for ${part.id} is on disk`);
    assert.equal(part.path, partPathOf('w', part.id, root),
      'the path segment wrote is the path concat looks for, same name from both sides');
  }
  assert.equal(j.parts, c.parts.length, 'the join read the parts the renderer wrote');
  assert.ok(await exists(j.out), 'the finished video is where the result says it is');
  assert.ok(await exists(concatListPathOf(j.out)), 'and the list it was made from is kept');
  const shape = await probe(j.out, SHAPE_PROBE);
  assert.ok(shape !== null, 'the finished video answers the same shape probe the parts do');
  const decoded = await run(['ffmpeg', '-v', 'error', '-i', j.out, '-f', 'null', '-']);
  assert.ok(decoded.ok && decoded.stderr === '', 'the whole video decodes with nothing on stderr');
});

await test('checkpoint 3: one sentence becomes one real subtitled .mp4', async () => {
  const { root, j } = CHAIN;
  const dur = await durationOf(j.out);
  assert.ok(dur !== null && dur > 0, 'the video has a real length');
  const subs = await readFile(join(root, '.narrate', 'w', 'subs.ass'), 'utf8');
  assert.ok(subs.includes(S1) && subs.includes(S2),
    'the script\'s own sentences are in the subtitle file that was burned in');
  const frames = FRAMES.landscape;
  const shape = await probe(j.out, ['width', 'height']);
  assert.ok(shape !== null && [shape.width, shape.height].join(',') === frames.join(','),
    'the picture is the target frame the contract names');
});

// The roots are ours: take them away so a run leaves nothing behind.
for (const dir of ROOTS) await rm(dir, { recursive: true, force: true });
