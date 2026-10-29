// The QA runner. Section 10 of the requirements is the source of this file, not the code:
// every row below names a check in the words the requirements use, and asks the real product
// for the answer. A row that cannot run prints SKIP and says why, so a red run always means
// our code is wrong rather than the machine is missing something (section 12).
//
// Red first, measured before this file existed:
//   $ node qa/qa.mjs
//   Error: Cannot find module '/home/stuart/workspace/claude-narrate/qa/qa.mjs'
//   exit=1
// The behaviour was missing, not a runner that could not start (F-9).
//
// Nothing here writes inside the repository. The clips and every work folder live in one
// fresh temp folder, and the recipe for the clips is checked in at qa/fixtures/make.mjs.
import assert from 'node:assert';
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir, stat, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from '../lib/run.mjs';
import { makeFixtures, MAIN_SAID_PATHS } from './fixtures/make.mjs';
import { jsonPathFor } from '../bin/index.mjs';
import { partPathOf } from '../bin/segment.mjs';
import { audioPathOf } from '../bin/voice.mjs';
import { concatListPathOf } from '../bin/concat.mjs';
import { displayWidth, subStyle, SUB_FONT, FRAMES, FILL, SHAPE_PROBE, PART_SHAPE } from '../lib/contract.mjs';

const ROOT = await mkdtemp(join(tmpdir(), 'narrate-qa-'));
const FIX = await makeFixtures(ROOT);

// The engine every row that is not about the voice uses: a tone, so the runner needs no
// network and no key. A-13 asks about the shipped default on its own row, out loud.
function toneEngine(seconds) {
  return {
    argv: ['ffmpeg', '-y', '-f', 'lavfi', '-i', `sine=frequency=300:duration=${seconds}`,
      '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2', '{out}'],
    ext: 'wav', timeoutMs: 20000, speech: false, network: false,
    note: 'Not a voice: a tone, so this run needs no network and no key.',
  };
}
const CFG = join(ROOT, 'config', 'engines.json');
await mkdir(join(ROOT, 'config'), { recursive: true });
await writeFile(CFG, `${JSON.stringify({
  schema: 'narrate/engines@1', default: 'tone',
  engines: { tone: toneEngine(1.2) },
}, null, 2)}\n`);

async function exists(path) { try { await stat(path); return true; } catch { return false; } }
async function read(path) { try { return await readFile(path, 'utf8'); } catch { return null; } }
async function size(path) { try { return (await stat(path)).size; } catch { return -1; } }
async function bytes(path) { try { return await readFile(path, 'utf8'); } catch { return null; } }

function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }

// One way to run a product script: argv array, never a shell string, so text the model
// wrote can never reach a shell. stdout is JSON for every script; an error is JSON too.
async function cli(name, args, timeoutMs = 180000) {
  const r = await run(['node', `bin/${name}.mjs`, ...args], { timeoutMs, stderrCap: 8192 });
  const out = parseJson(r.stdout);
  if (out) return { r, json: out };
  const err = parseJson(r.stderr);
  if (err) return { r, json: err };
  throw new Error(`${name} answered no JSON: stdout ${JSON.stringify(r.stdout.slice(0, 200))} / ` +
    `stderr ${JSON.stringify(r.stderr.slice(0, 200))} code=${r.code}`);
}

async function ok(name, args, timeoutMs = 180000) {
  const got = await cli(name, args, timeoutMs);
  assert.ok(got.json.ok === true,
    `${name} said: ${got.json.ok ? '' : `${got.json.error} ${got.json.message}`}`);
  return got.json;
}

async function probe(path, entries) {
  const r = await run(['ffprobe', '-v', 'error', '-show_entries',
    `stream=codec_type,${entries.join(',')}`, '-print_format', 'json', path]);
  if (!r.ok) return null;
  const j = parseJson(r.stdout);
  const one = {};
  for (const half of (j?.streams ?? [])) for (const [k, v] of Object.entries(half)) one[k] = v;
  return one;
}

async function durationOf(path) {
  const r = await run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', path]);
  return r.ok && r.stdout.trim() !== '' ? Number(r.stdout.trim()) : null;
}

// A frame of a finished video, as raw pixels. The fixture clips are one flat colour, so
// every pixel that is not that colour came from the burned-in subtitle.
async function frame(path, atSec) {
  const ppm = `${path}.frame.ppm`;
  const r = await run(['ffmpeg', '-v', 'error', '-y', '-ss', String(atSec), '-i', path,
    '-frames:v', '1', '-c:v', 'ppm', ppm]);
  if (!r.ok) throw new Error(`could not read a frame at ${atSec}: ${r.stderr}`);
  const buf = await readFile(ppm);
  // P6: header "P6", then width height 255, one whitespace after each.
  let at = 0, parts = [];
  while (parts.length < 4 && at < buf.length) {
    const nl = buf.indexOf(0x0a, at);
    const chunk = buf.slice(at, nl < 0 ? buf.length : nl).toString();
    at = (nl < 0 ? buf.length : nl + 1);
    if (chunk === '' || chunk.startsWith('#')) continue;
    for (const w of chunk.split(/\s+/)) if (w) parts.push(w);
  }
  if (parts[0] !== 'P6') throw new Error(`not a P6 frame: ${parts.join(' ')}`);
  const width = Number(parts[1]), height = Number(parts[2]);
  return { width, height, pixels: buf.slice(at), ppm: ppm };
}

// ------------------------------------------------------------------ the report
// One printed line per check in section 10, as it finishes, so a long run shows progress and
// a reader can tell a skip from a pass without reading the code.
const LINES = [];
let nPass = 0, nFail = 0, nSkip = 0;

async function row(id, what, fn) {
  try {
    const skip = await fn();
    if (typeof skip === 'string') {
      nSkip += 1;
      LINES.push(`SKIP  ${id}  ${what}\n      skipped because: ${skip}`);
    } else {
      nPass += 1;
      LINES.push(`PASS  ${id}  ${what}`);
    }
  } catch (e) {
    nFail += 1;
    LINES.push(`FAIL  ${id}  ${what}\n      ${String(e.message).replace(/\s+/g, ' ').slice(0, 400)}`);
  }
  process.stdout.write(`${LINES[LINES.length - 1]}\n`);
}

// ------------------------------------------------------------------ the flows
// Each flow is built once, on demand, and shared by the rows that ask about it. Building on
// demand rather than at the top keeps one broken flow from stopping every other row.

const MAIN_SCRIPT = [
  'Clouds cross the bright sky before the rain.',
  'Gulls turn over the water at dusk near the empty harbour.',
  'The light comes back over the water and the quay.',
  'A short blink of a bright sky shows the clouds again.',
  'The harbour stays quiet while the gulls rest on the water.',
  'Time lapse clouds move across a bright sky.',
];
const MAIN_QUERIES = [
  'bright sky with moving clouds in a time lapse',
  'gulls over the water at dusk near a harbour',
  'water and a quay at dusk',
  'a bright sky, short',
  'an empty harbour at dusk with gulls',
  'clouds moving across a bright sky',
];

async function putScript(work, sentences) {
  const dir = join(ROOT, '.narrate', work);
  await mkdir(dir, { recursive: true });
  const text = `${sentences.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`;
  await writeFile(join(dir, 'script.txt'), text);
  return text;
}

// The English picture descriptions stop 2 writes, through the real store step.
async function putQueries(work, sentences, queries) {
  const inPath = join(ROOT, `queries-${work}.in.json`);
  await writeFile(inPath, `${JSON.stringify({
    queries: sentences.map((s, i) => ({ id: `S-${String(i + 1).padStart(3, '0')}`, sentence: s, query: queries[i] })),
  }, null, 2)}\n`);
  return await cli('describe', ['--work', work, '--queries', inPath, '--root', ROOT]);
}

let MAIN = null;
async function mainFlow() {
  if (MAIN) return MAIN;
  const assets = FIX.assets;
  const work = 'main';
  const scan = await cli('index', ['--assets', assets]);
  assert.ok(scan.json.ok === true, `index said: ${scan.json.error} ${scan.json.message}`);
  assert.ok(scan.json.clips.length === 3, 'the index step found the three fixture clips');

  const frames = {};
    // About six frames per clip, never fewer than one: a 2 s clip pulled at every 5 s gives
    // zero frames and ffmpeg exits 0, so a fixed step would read as "no frames" for a clip
    // that is only short. The step is measured, not guessed.
  for (const rec of scan.json.clips) {
    const abs = join(assets, rec.clip);
    const pull = await cli('describe', ['--clip', abs, '--every', String(Math.max(1, Math.floor(rec.durationSec / 6))), '--root', ROOT]);
    assert.ok(pull.json.ok === true, `the frame puller said: ${pull.json.error} ${pull.json.message}`);
    frames[rec.clip] = pull.json.framesDir;
  }

  // What Claude would have said about the frames, in the shape describe writes. This run
  // supplies the words because this machine has no way to read a frame back as a picture;
  // every step that READS them is the real one.
  for (const rec of scan.json.clips) {
    const abs = join(assets, rec.clip);
    const base = rec.clip.split('/').pop();
    const stem = base.replace(/\.[^.]*$/, '');
    const saidPath = join(ROOT, `said-${stem}.json`);
    await writeFile(saidPath, `${JSON.stringify({ segments: MAIN_SAID_PATHS[base] }, null, 2)}\n`);
    const stored = await cli('describe', ['--clip', abs, '--said', saidPath, '--root', ROOT]);
    assert.ok(stored.json.ok === true, `describe said: ${stored.json.error} ${stored.json.message}`);
  }

  const script = await putScript(work, MAIN_SCRIPT);
  const q = await putQueries(work, MAIN_SCRIPT, MAIN_QUERIES);
  assert.ok(q.json.ok === true, `describe said: ${q.json.error} ${q.json.message}`);

  const p = await ok('pick', ['--work', work, '--assets', assets, '--root', ROOT, '--aspect', 'landscape']);
  const v = await ok('voice', ['--work', work, '--root', ROOT, '--config', CFG]);
  const preview = await ok('preview', ['--work', work, '--root', ROOT]);
  const c = await ok('segment', ['--work', work, '--root', ROOT, '--approved']);
  const out = join(ROOT, 'out', `${work}.mp4`);
  const j = await ok('concat', ['--work', work, '--root', ROOT, '--approved', '--out', out]);

  MAIN = { assets, work, scan: scan.json, frames, script, p, v, preview, c, j, out };
  return MAIN;
}

const ZH_SCRIPT = [
  '云在明亮天空移动。',
  '空港口在黄昏。',
];
const ZH_QUERIES = [
  'bright sky with moving clouds in a time lapse',
  'empty harbour at dusk with gulls on the water',
];

let ZH = null;
async function zhFlow() {
  if (ZH) return ZH;
  const work = 'zh';
  const q = await putQueries(work, ZH_SCRIPT, ZH_QUERIES);
  assert.ok(q.json.ok === true, `describe said: ${q.json.error} ${q.json.message}`);
  const script = await putScript(work, ZH_SCRIPT);
  const p = await ok('pick', ['--work', work, '--assets', FIX.assets, '--root', ROOT, '--aspect', 'landscape']);
  const v = await ok('voice', ['--work', work, '--root', ROOT, '--config', CFG]);
  const c = await ok('segment', ['--work', work, '--root', ROOT, '--approved']);
  const out = join(ROOT, 'out', `${work}.mp4`);
  const j = await ok('concat', ['--work', work, '--root', ROOT, '--approved', '--out', out]);
  ZH = { work, script, q: q.json, p, v, c, j, out };
  return ZH;
}

const PT_SCRIPT = [
  'A tall river falls through a narrow canyon.',
  'The water runs on under the light.',
];
const PT_QUERIES = [
  'a tall river falling through a narrow canyon',
  'water running under the light',
];

let PT = null;
async function ptFlow() {
  if (PT) return PT;
  const work = 'pt';
  const scan = await cli('index', ['--assets', FIX.portrait]);
  assert.ok(scan.json.ok === true, `index said: ${scan.json.error} ${scan.json.message}`);
  for (const rec of scan.json.clips) {
    const pull = await cli('describe', ['--clip', join(FIX.portrait, rec.clip), '--every', String(Math.max(1, Math.floor(rec.durationSec / 6))), '--root', ROOT]);
    assert.ok(pull.json.ok === true, `the frame puller said: ${pull.json.error} ${pull.json.message}`);
    const base = rec.clip.split('/').pop();
    const stem = base.replace(/\.[^.]*$/, '');
    const saidPath = join(ROOT, `said-${stem}.json`);
    await writeFile(saidPath, `${JSON.stringify({ segments: [{ startSec: 0, endSec: 20, confidence: 0.9,
      description: 'A tall river falls through a narrow canyon.', tags: ['river', 'tall', 'canyon', 'water'] }] }, null, 2)}\n`);
    const stored = await cli('describe', ['--clip', join(FIX.portrait, rec.clip), '--said', saidPath, '--root', ROOT]);
    assert.ok(stored.json.ok === true, `describe said: ${stored.json.error} ${stored.json.message}`);
  }
  const script = await putScript(work, PT_SCRIPT);
  const q = await putQueries(work, PT_SCRIPT, PT_QUERIES);
  assert.ok(q.json.ok === true, `describe said: ${q.json.error} ${q.json.message}`);
  const p = await ok('pick', ['--work', work, '--assets', FIX.portrait, '--root', ROOT, '--aspect', 'portrait']);
  const v = await ok('voice', ['--work', work, '--root', ROOT, '--config', CFG]);
  const c = await ok('segment', ['--work', work, '--root', ROOT, '--approved']);
  const out = join(ROOT, 'out', `${work}.mp4`);
  const j = await ok('concat', ['--work', work, '--root', ROOT, '--approved', '--out', out]);
  PT = { work, scan: scan.json, script, q: q.json, p, v, c, j, out };
  return PT;
}

// A-16 wants a join of 60+ parts. The sentences are short on purpose: the part follows the
// recording, so 61 short sentences stay a short video and the run stays a few minutes.
const LONG_SCRIPT = [];
const LONG_QUERIES = [];
for (let i = 0; i < 61; i += 1) {
  const folder = 'abc'[i % 3];
  LONG_SCRIPT.push(`Clouds move over the water in folder ${folder}.`);
  LONG_QUERIES.push(`clouds and water and a bright sky in folder ${folder}`);
}

let LONG = null;
async function longFlow() {
  if (LONG) return LONG;
  const work = 'long';
  const scan = await cli('index', ['--assets', FIX.long]);
  assert.ok(scan.json.ok === true, `index said: ${scan.json.error} ${scan.json.message}`);
  for (const rec of scan.json.clips) {
    const pull = await cli('describe', ['--clip', join(FIX.long, rec.clip), '--every', String(Math.max(1, Math.floor(rec.durationSec / 6))), '--root', ROOT]);
    assert.ok(pull.json.ok === true, `the frame puller said: ${pull.json.error} ${pull.json.message}`);
    const base = rec.clip.split('/').pop();
    const stem = base.replace(/\.[^.]*$/, '');
    const saidPath = join(ROOT, `said-${stem}.json`);
    await writeFile(saidPath, `${JSON.stringify({ segments: [{ startSec: 0, endSec: 30, confidence: 0.9,
      description: 'A wide clip with clouds and water under a bright sky.', tags: ['clouds', 'sky', 'bright', 'water'] }] }, null, 2)}\n`);
    const stored = await cli('describe', ['--clip', join(FIX.long, rec.clip), '--said', saidPath, '--root', ROOT]);
    assert.ok(stored.json.ok === true, `describe said: ${stored.json.error} ${stored.json.message}`);
  }
  const script = await putScript(work, LONG_SCRIPT);
  const q = await putQueries(work, LONG_SCRIPT, LONG_QUERIES);
  assert.ok(q.json.ok === true, `describe said: ${q.json.error} ${q.json.message}`);
  const p = await ok('pick', ['--work', work, '--assets', FIX.long, '--root', ROOT, '--aspect', 'landscape']);
  const v = await ok('voice', ['--work', work, '--root', ROOT, '--config', CFG]);
  const c = await ok('segment', ['--work', work, '--root', ROOT, '--approved']);
  const out = join(ROOT, 'out', `${work}.mp4`);
  const j = await ok('concat', ['--work', work, '--root', ROOT, '--approved', '--out', out]);
  LONG = { work, scan: scan.json, script, q: q.json, p, v, c, j, out };
  return LONG;
}

// ------------------------------------------------------------------ the small flows
// One flow per check that needs its own world, so the answer is the whole story rather than
// one row among many rows that share a chain.

// A-7: a sentence that matches nothing. These words meet no word in any fixture description or
// tag. (pick keeps three-letter words, so even "the" would have matched the sidecar text.)
const NONSENSE = 'Purple zebras orbit obsidian quasars.';
let NOCLIP = null;
async function noClipFlow() {
  if (NOCLIP) return NOCLIP;
  const work = 'noclip';
  const sentences = ['Clouds cross the bright sky before the rain.', NONSENSE];
  const queries = ['bright sky with moving clouds', 'purple zebras orbit obsidian quasars'];
  const scan = await cli('index', ['--assets', FIX.assets]);
  assert.ok(scan.json.ok === true, `index said: ${scan.json.error} ${scan.json.message}`);
  await putScript(work, sentences);
  const q = await putQueries(work, sentences, queries);
  assert.ok(q.json.ok === true, `describe said: ${q.json.error} ${q.json.message}`);
  const p = await cli('pick', ['--work', work, '--assets', FIX.assets, '--root', ROOT,
    '--aspect', 'landscape']);
  assert.ok(p.json.ok === true, `pick said: ${p.json.error} ${p.json.message}`);
  NOCLIP = { work, p: p.json };
  return NOCLIP;
}

// A-24: one clip that is 2 s long, and a sentence that needs far more picture than that. The
// clip cannot cover the narration from its start, so it is not a candidate.
const TOO_LONG_SENTENCE = 'A bright sky for one short blink, which is far too little picture for this much narration.';
let SHORTY = null;
async function shortFlow() {
  if (SHORTY) return SHORTY;
  const work = 'shorty';
  const sentences = [TOO_LONG_SENTENCE];
  const queries = ['a bright sky for one short blink'];
  const scan = await cli('index', ['--assets', FIX.short]);
  assert.ok(scan.json.ok === true, `index said: ${scan.json.error} ${scan.json.message}`);
  await putScript(work, sentences);
  const q = await putQueries(work, sentences, queries);
  assert.ok(q.json.ok === true, `describe said: ${q.json.error} ${q.json.message}`);
  const p = await cli('pick', ['--work', work, '--assets', FIX.short, '--root', ROOT,
    '--aspect', 'landscape']);
  assert.ok(p.json.ok === true, `pick said: ${p.json.error} ${p.json.message}`);
  SHORTY = { work, p: p.json, scan: scan.json };
  return SHORTY;
}

// A-25: the visual layer has nothing to work from. The frames folder is pulled away between the
// pull and the match, so the match step finds the folder it was told about is gone.
let VIS = null;
async function visualFlow() {
  if (VIS) return VIS;
  const work = 'vis';
  const scan = await cli('index', ['--assets', FIX.visual]);
  assert.ok(scan.json.ok === true, `index said: ${scan.json.error} ${scan.json.message}`);
  const rec = scan.json.clips[0];
  const abs = join(FIX.visual, rec.clip);
  const pull = await cli('describe', ['--clip', abs, '--every', String(Math.max(1, Math.floor(rec.durationSec / 6))), '--root', ROOT]);
  assert.ok(pull.json.ok === true, `the frame puller said: ${pull.json.error} ${pull.json.message}`);
  const framesDir = pull.json.framesDir;
  assert.ok(await exists(framesDir), 'the frames folder was there before we took it away');
  await rm(framesDir, { recursive: true, force: true });
  const sentences = ['Clouds over the sky.'];
  const queries = ['clouds over the sky'];
  await putScript(work, sentences);
  const q = await putQueries(work, sentences, queries);
  assert.ok(q.json.ok === true, `describe said: ${q.json.error} ${q.json.message}`);
  const p = await cli('pick', ['--work', work, '--assets', FIX.visual, '--root', ROOT,
    '--aspect', 'landscape']);
  assert.ok(p.json.ok === true, `pick said: ${p.json.error} ${p.json.message}`);
  VIS = { work, p: p.json, framesDir };
  return VIS;
}

// The index-only checks: A-2 A-3 A-19 A-20 A-21 A-22 A-23. Two scans over one folder, and the
// bytes of the files that are not ours before and after each scan.
let IDX = null;
async function indexFlow() {
  if (IDX) return IDX;
  const foreign = join(FIX.index, 'b.json');
  const foreignBefore = await bytes(foreign);
  assert.ok(foreignBefore !== null, 'the foreign b.json is in the asset folder');
  const collide = await cli('index', ['--assets', FIX.collide]);
  const first = await cli('index', ['--assets', FIX.index]);
  assert.ok(first.json.ok === true, `index said: ${first.json.error} ${first.json.message}`);
  const rec = first.json.clips[0];
  const own = join(FIX.index, rec.json);
  const sidecar1 = await bytes(own);
  const second = await cli('index', ['--assets', FIX.index]);
  assert.ok(second.json.ok === true, `index said: ${second.json.error} ${second.json.message}`);
  const sidecar2 = await bytes(own);
  const foreignAfter = await bytes(foreign);
  IDX = { first: first.json, second: second.json, collide: collide.json, rec,
    foreignBefore, foreignAfter, sidecar1, sidecar2 };
  return IDX;
}

// The files that make up the product: every script and every library. A-14 compares these
// before and after a voice swap, so "config only" means these bytes did not move.
async function productBytes() {
  const map = {};
  for (const dir of ['bin', 'lib']) {
    for (const name of await readdir(join(process.cwd(), dir))) {
      if (!name.endsWith('.mjs')) continue;
      const path = join(dir, name);
      map[path] = await bytes(path);
    }
  }
  return map;
}

function sameBytes(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const moved = [];
  for (const k of keys) if (a[k] !== b[k]) moved.push(k);
  return moved;
}

// A-13 asks about the shipped default engine, which speaks over a network. The gate asks that
// engine alone, so a machine with no network skips the row out loud instead of failing it
// (section 12: a red run must mean our code is wrong, never the machine).
let EDGE_GATE = null;
async function edgeGate() {
  if (EDGE_GATE !== null) return EDGE_GATE;
  const textPath = join(ROOT, 'edge-gate.txt');
  await writeFile(textPath, 'Hello.\n');
  const r = await run(['node', 'bin/voice-edge.mjs', textPath, join(ROOT, 'edge-gate.mp3'),
    'en-US-AriaNeural'], { timeoutMs: 30000 });
  if (r.timedOut || r.spawnFailed) {
    EDGE_GATE = 'the edge adapter could not start on this machine (no network, or it timed out)';
  } else if (r.code === 3) {
    EDGE_GATE = `the edge adapter exited 3: ${r.stderr.replace(/\s+/g, ' ').slice(0, 120)} (no network for the shipped default voice)`;
  } else if (r.code !== 0) {
    throw new Error(`the edge adapter we ship exited ${r.code} for our own code: ${r.stderr.slice(0, 200)}`);
  } else {
    EDGE_GATE = '';
  }
  return EDGE_GATE;
}

let EDGE = null;
async function edgeFlow() {
  if (EDGE) return EDGE;
  const work = 'edge';
  const scan = await cli('index', ['--assets', FIX.assets]);
  assert.ok(scan.json.ok === true, `index said: ${scan.json.error} ${scan.json.message}`);
  const sentences = ['Clouds cross the bright sky before the rain.'];
  await putScript(work, sentences);
  const q = await putQueries(work, sentences, ['bright sky with moving clouds']);
  assert.ok(q.json.ok === true, `describe said: ${q.json.error} ${q.json.message}`);
  const p = await ok('pick', ['--work', work, '--assets', FIX.assets, '--root', ROOT,
    '--aspect', 'landscape']);
  assert.ok(p.shots.length === 1, 'pick found a clip for the one sentence');
  // No --config: the default is the file the repository ships, which is the point of A-13.
  const v = await cli('voice', ['--work', work, '--root', ROOT]);
  EDGE = { work, v: v.json };
  return EDGE;
}

// A-14: a different engine, reached by changing the config file only. The tone engine in the
// repository config is not a voice, and says so; that is the honest answer, not a pass dressed
// up as one.
const CFG_SWAP = join(ROOT, 'config', 'engines-swap.json');
let SWAP = null;
async function swapFlow() {
  if (SWAP) return SWAP;
  const repo = parseJson(await bytes(join(process.cwd(), 'config', 'engines.json')));
  assert.ok(repo && repo.engines?.['local-tone'], 'the repository config ships a second engine');
  const swapped = { ...repo, default: 'local-tone',
    note: 'The same engines, one default changed. This is the whole swap.' };
  await writeFile(CFG_SWAP, `${JSON.stringify(swapped, null, 2)}\n`);
  const work = 'swap';
  const scan = await cli('index', ['--assets', FIX.assets]);
  assert.ok(scan.json.ok === true, `index said: ${scan.json.error} ${scan.json.message}`);
  const sentences = ['Clouds cross the bright sky before the rain.'];
  await putScript(work, sentences);
  const q = await putQueries(work, sentences, ['bright sky with moving clouds']);
  assert.ok(q.json.ok === true, `describe said: ${q.json.error} ${q.json.message}`);
  const p = await ok('pick', ['--work', work, '--assets', FIX.assets, '--root', ROOT,
    '--aspect', 'landscape']);
  assert.ok(p.shots.length === 1, 'pick found a clip for the one sentence');
  const before = await productBytes();
  const v = await cli('voice', ['--work', work, '--root', ROOT, '--config', CFG_SWAP]);
  assert.ok(v.json.ok === true, `voice said: ${v.json.error} ${v.json.message}`);
  const after = await productBytes();
  SWAP = { work, v: v.json, moved: sameBytes(before, after), repoDefault: repo.default };
  return SWAP;
}

// The subtitle text as it was written, with our own line breaks taken out. A sentence wider
// than one line is broken by breakLines and the break is written as \\N, so the burned-in text
// and the script are compared with every space gone: the check asks whether the words match,
// not where the wrap happened.
function spoken(text) {
  const said = text.split('\n').filter((l) => l.startsWith('Dialogue:'))
    .map((l) => l.replace(/^Dialogue: (?:[^,]*,){8}/, ''));
  return said.join('').replace(/\\N/g, '').replace(/\s+/g, '');
}

// The fixture picture is one flat colour, so any bright pixel came from the burned-in text.
// Two things must hold: the text really drew (the measured trap: a bad .ass header burns
// nothing and leaves a byte-identical video), and no bright pixel sits in the side margins.
async function pixelCheck(video, atSec, marginH) {
  const f = await frame(video, atSec);
  const px = f.pixels;
  const flat = (i) => px[i] < 40 && px[i + 1] < 40 && px[i + 2] < 40;
  const text = (i) => px[i] > 180 && px[i + 1] > 180 && px[i + 2] > 180;
  let drawn = 0, inMargin = 0, notFlat = 0;
  for (let y = 0; y < f.height; y += 1) {
    for (let x = 0; x < f.width; x += 1) {
      const i = (y * f.width + x) * 3;
      if (text(i)) {
        drawn += 1;
        if (x < marginH || x >= f.width - marginH) inMargin += 1;
      } else if (!flat(i)) notFlat += 1;
    }
  }
  return { width: f.width, height: f.height, drawn, inMargin, notFlat };
}

// Where in the finished video a given part sits: the parts are joined in order.
function partOffsetOf(parts, index) {
  let t = 0;
  for (let i = 0; i < index; i += 1) t += parts[i].videoSec;
  return t;
}

async function decodeClean(path) {
  const r = await run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'null', '-']);
  return r.ok && r.stderr === '';
}

// ------------------------------------------------------------------ the rows
// One line each, in the order section 10 lists them.

await row('A-1', 'Put 3 videos in assets, run the index step, and every file has a record with a text description.', async () => {
  const m = await mainFlow();
  assert.ok(m.scan.clips.length === 3, 'the index step found three clips');
  for (const rec of m.scan.clips) {
    assert.ok(await exists(jsonPathFor(join(m.assets, rec.clip))), `${rec.clip} has a record beside it`);
    assert.notEqual(rec.description, '', `${rec.clip} record has a text description`);
  }
});

await row('A-2', 'Run the index step again with no new files: 0 re-understands, index content unchanged.', async () => {
  const i = await indexFlow();
  assert.ok(i.second.reUnderstands === 0, `the second scan re-understood ${i.second.reUnderstands} clips`);
  const again = i.second.clips.find((r) => r.clip === i.rec.clip);
  assert.ok(again.needsUnderstanding === i.rec.needsUnderstanding, 'the second scan says the same thing about understanding as the first');
  assert.equal(JSON.stringify(again), JSON.stringify(i.rec), 'the record the second scan returned is the same as the first');
  assert.equal(i.sidecar1, i.sidecar2, 'the record on disk is the same after the second scan');
});

await row('A-3', 'Hand-write one clip\'s fromYou.description, re-scan, and your line is unchanged byte for byte.', async () => {
  const i = await indexFlow();
  const hand = 'empty harbour at dusk with gulls';
  assert.equal(i.rec.description, hand, 'the hand-written sidecar line is the description');
  const a = parseJson(i.sidecar1), b = parseJson(i.sidecar2);
  assert.ok(a && b, 'the record is JSON both times');
  assert.equal(JSON.stringify(a.fromYou), JSON.stringify(b.fromYou), 'the yours section did not move');
  assert.equal(b.fromYou.description, hand, 'and the hand-written line is still there after the re-scan');
});

await row('A-4', 'Give one idea. The skill asks at least 3 questions and produces no script file before you answer.', async () => {
  return 'A-4 and A-5 are about a real Claude session talking to you. This runner has no session to talk to. test/skill.test.mjs holds the same two checks against the words of skills/narrate/SKILL.md, which is what a session follows.';
});

await row('A-5', 'After the script is written the flow stops. Without a yes, no shot list is produced.', async () => {
  return 'Same reason as A-4: the stop is a step the agent takes, and an agent cannot be forced into an order (F-14). The part a check CAN hold is NEW-1, below: a render without the approval flag fails.';
});

await row('A-6', 'Every shot-list row has: sentence id, clip file, start second, end second, subtitle text.', async () => {
  const m = await mainFlow();
  assert.ok(m.p.shots.length > 0, 'the shot list has rows');
  for (const shot of m.p.shots) {
    assert.ok(/^[S]-[0-9]{3}$/.test(shot.id), `${shot.id} is a sentence id`);
    assert.notEqual(shot.assetPath, '', `${shot.id} names a clip file`);
    assert.ok(await exists(shot.assetPath), `${shot.id} clip file is on disk`);
    assert.ok(typeof shot.startSec === 'number' && typeof shot.endSec === 'number' &&
      shot.endSec > shot.startSec, `${shot.id} has a start second and a later end second`);
    assert.notEqual(shot.sentence, '', `${shot.id} carries the subtitle text`);
  }
});

await row('A-7', 'Put in a sentence that matches nothing. Stop 3\'s report lists that sentence id and "no clip".', async () => {
  const n = await noClipFlow();
  const hit = n.p.missing.filter((x) => x.id === 'S-002');
  assert.ok(hit.length === 1, 'the nonsense sentence is the one missing row');
  assert.equal(hit[0].reason, 'no clip', 'the report says "no clip" in those words');
  assert.equal(n.p.shots.length, 1, 'the sentence that does match still got a clip');
});

await row('A-8', 'After voice, one audio file per sentence, and the name maps back to the sentence id.', async () => {
  const m = await mainFlow();
  assert.ok(m.v.audio.length === MAIN_SCRIPT.length, 'one recording per sentence');
  const ids = m.p.shots.map((s) => s.id);
  assert.equal(m.v.audio.map((a) => a.id).join(','), ids.join(','), 'the recordings are the sentence ids, in order');
  for (const rec of m.v.audio) {
    assert.ok(await exists(rec.out), `${rec.id} recording is on disk`);
    assert.equal(rec.out, audioPathOf(m.work, rec.id, ROOT), 'the name maps back to the sentence id');
  }
});

await row('A-9', 'Stop 4\'s audio-only file plays in ffplay and matches the script.', async () => {
  const m = await mainFlow();
  const wav = join(ROOT, '.narrate', m.work, 'preview.wav');
  assert.ok(await exists(wav), 'stop 4 wrote its audio-only file');
  const r = await run(['timeout', '20', 'ffplay', '-loglevel', 'error', '-t', '0.2',
    '-autoexit', wav]);
  assert.ok(r.ok && r.stderr === '', `ffplay: ${r.stderr.replace(/\s+/g, ' ').slice(0, 160)} code=${r.code}`);
  const got = await durationOf(wav);
  assert.ok(got !== null && Math.abs(got - m.preview.expectedSec) <= m.preview.toleranceSec,
    `the file measures ${got} s against the ${m.preview.expectedSec} s the step expected`);
  assert.equal(m.preview.parts, MAIN_SCRIPT.length, 'the join read one recording per sentence');
});

await row('A-10', 'The finished video plays. Each sentence\'s picture length differs from its audio length by no more than 0.2 s.', async () => {
  const m = await mainFlow();
  assert.ok(await decodeClean(m.out), 'the whole finished video decodes with nothing on stderr');
  const dur = await durationOf(m.out);
  assert.ok(dur !== null && dur > 0, 'the finished video has a real length');
  for (const part of m.c.parts) {
    const drift = Math.abs(part.videoSec - part.audioSec);
    assert.ok(drift <= FILL.SLOW_LIMIT, `${part.id} picture ${part.videoSec} s against audio ${part.audioSec} s is ${drift.toFixed(3)} s apart`);
  }
});

await row('A-11', 'Subtitles are burned in, the text matches the script, and Chinese shows no empty boxes.', async () => {
  const m = await mainFlow();
  const z = await zhFlow();
  const subs = await read(join(ROOT, '.narrate', m.work, 'subs.ass'));
  assert.ok(subs !== null, 'the subtitle file is there');
  for (const s of MAIN_SCRIPT) assert.ok(spoken(subs).includes(spoken(s)), 'the burned-in text is the script, sentence by sentence');
  const px = await pixelCheck(m.out, partOffsetOf(m.c.parts, 0) + m.c.parts[0].videoSec / 2, 48);
  assert.ok(px.drawn > 200, 'bright pixels: the text really drew');
  assert.equal(px.inMargin, 0, 'no bright pixel crossed the left or right edge');
  const zhSubs = await read(join(ROOT, '.narrate', z.work, 'subs.ass'));
  assert.ok(zhSubs !== null, 'the Chinese run wrote its subtitle file');
  for (const s of ZH_SCRIPT) assert.ok(spoken(zhSubs).includes(spoken(s)), 'the Chinese sentences are in the burned-in text');
  const zhPx = await pixelCheck(z.out, partOffsetOf(z.c.parts, 0) + z.c.parts[0].videoSec / 2, 48);
  assert.ok(zhPx.drawn > 200, 'the Chinese text drew pixels rather than nothing');
  const fc = await run(['fc-match', '--format', '%{fontfile}', SUB_FONT]);
  const zh = await run(['fc-list', ':lang=zh']);
  assert.ok(fc.ok && zh.ok && zh.stdout !== '', 'the font the contract names resolves to a file that covers Chinese, so no empty boxes');
});

await row('A-12', 'Middle products all exist: index, script, shot list, per-sentence audio, .ass.', async () => {
  const m = await mainFlow();
  for (const rec of m.scan.clips) assert.ok(await exists(jsonPathFor(join(m.assets, rec.clip))), 'the index records');
  assert.ok(await exists(join(ROOT, '.narrate', m.work, 'script.txt')), 'the script');
  assert.ok(await exists(join(ROOT, '.narrate', m.work, 'shots.json')), 'the shot list');
  for (const rec of m.v.audio) assert.ok(await exists(rec.out), 'the per-sentence audio');
  assert.ok(await exists(join(ROOT, '.narrate', m.work, 'subs.ass')), 'the .ass');
});

await row('A-13', 'With no new API key configured, the default voice engine speaks.', async () => {
  const gate = await edgeGate();
  if (gate !== '') return `no network for the shipped default voice: ${gate}`;
  const e = await edgeFlow();
  // §12: a network row skips out loud, it never fails. The adapter's own exit 3 means its
  // network was cut part way through, which says nothing about our code.
  if (e.v.ok !== true && (e.v.failed ?? [])[0]?.code === 3)
    return `the voice adapter lost its network mid-run (exit 3): ${e.v.failed[0].message}`;
  assert.ok(e.v.ok === true, `voice said: ${e.v.error} ${e.v.message}`);
  assert.equal(e.v.engineNeedsKey, false, 'the default engine needs no key');
  assert.ok(e.v.audio.length === 1, 'the default engine spoke the one sentence');
  assert.ok(await exists(e.v.audio[0].out), 'and left a real file');
});

await row('A-14', 'Swapping in another voice engine changes config only, and no product code.', async () => {
  const s = await swapFlow();
  assert.equal(s.moved.length, 0, `these product files changed: ${s.moved.join(', ')}`);
  assert.equal(s.v.engine, 'local-tone', 'the run used the other engine');
  assert.notEqual(s.repoDefault, 'local-tone', 'the repository config still defaults to the shipped voice');
  assert.ok(s.v.engineSpeech === false && s.v.engineNote !== '',
    'the other engine says it is not a voice, so the report cannot read a tone as a pass');
});
await row('A-16', 'A 60+ part join succeeds: right duration and a clean full decode.', async () => {
  const L = await longFlow();
  assert.ok(L.j.parts >= 60, `the join read ${L.j.parts} parts`);
  assert.ok(Math.abs(L.j.drift) <= L.j.toleranceSec,
    `the join is ${L.j.gotSec} s against the ${L.j.expectedSec} s expected, drift ${L.j.drift}`);
  assert.ok(await decodeClean(L.out), 'the whole 60+ part video decodes with nothing on stderr');
  const dur = await durationOf(L.out);
  assert.ok(dur !== null && Math.abs(dur - L.j.gotSec) <= 0.2, 'ffprobe agrees with the join on the length');
});

await row('A-17', 'Portrait outputs 1080x1920 per ffprobe, and no subtitle crosses the left or right edge.', async () => {
  const P = await ptFlow();
  const shape = await probe(P.out, ['width', 'height']);
  assert.ok(shape !== null, 'the finished portrait video answers the size probe');
  assert.ok([Number(shape.width), Number(shape.height)].join(',') === FRAMES.portrait.join(','),
    `the picture is ${shape.width}x${shape.height}, the contract says ${FRAMES.portrait.join('x')}`);
  // The rule the contract holds instead of trusting libass: our own .ass pins PlayResX/PlayResY,
  // so a line half as wide as maxWidth at our font size must fit inside the margins.
  const st = subStyle(FRAMES.portrait[0], FRAMES.portrait[1], 'portrait');
  assert.ok(st.maxWidth * st.fontSize / 2 <= FRAMES.portrait[0] - 2 * st.marginH,
    `the widest line we can write is ${st.maxWidth * st.fontSize / 2} px of half-width inside ${FRAMES.portrait[0] - 2 * st.marginH} px of picture`);
  const px = await pixelCheck(P.out, partOffsetOf(P.c.parts, 0) + P.c.parts[0].videoSec / 2, st.marginH);
  assert.ok(px.drawn > 200, 'the text really drew');
  assert.equal(px.inMargin, 0, 'no bright pixel crossed the left or right edge');
});

await row('A-18', 'An English script runs end to end.', async () => {
  const m = await mainFlow();
  for (const s of MAIN_SCRIPT) assert.ok(!/[㐀-鿿]/.test(s), 'the script is English');
  assert.ok(await exists(m.out), 'the finished video is where the join says it is');
  assert.ok((await durationOf(m.out)) > 0, 'it has a real length');
  assert.ok(await decodeClean(m.out), 'it decodes all the way through');
});

await row('A-19', 'a.mp4 + a.mov: E_STEM_COLLISION, both names listed, no a.json written.', async () => {
  const i = await indexFlow();
  assert.equal(i.collide.error, 'E_STEM_COLLISION', 'the scan named the collision in those words');
  assert.ok(Array.isArray(i.collide.names) && i.collide.names.length === 2,
    `both names are listed: ${(i.collide.names ?? []).join(', ')}`);
  assert.ok(i.collide.names.includes('a.mp4') && i.collide.names.includes('a.mov'),
    'the two names are the two files');
  assert.notEqual(await exists(join(FIX.collide, 'a.json')), true, 'no a.json was written');
});

await row('A-20', 'A foreign b.json is unchanged in bytes and content after a scan.', async () => {
  const i = await indexFlow();
  assert.equal(i.foreignBefore, i.foreignAfter, 'the bytes of b.json did not move');
  assert.notEqual(i.second.foreign.includes('b.json'), true,
    'the scan did not claim b.json as a file it had to back up');
  const b = parseJson(i.foreignAfter);
  assert.ok(b && b.schema === 'someone-else/1', 'the content is still the content that was there');
});

await row('A-21', 'One clip\'s info given three ways (folder name, file name, sidecar text) all land in its JSON.', async () => {
  const i = await indexFlow();
  const tags = i.rec.tags;
  assert.ok(tags.includes('quay'), 'the folder name landed');
  for (const w of ['harbour', 'dusk', 'timelapse']) assert.ok(tags.includes(w), `the file name word ${w} landed`);
  assert.ok(tags.includes('gulls'), 'the sidecar text landed');
  assert.notEqual(i.rec.description, '', 'and there is a description');
});

await row('A-22', 'Two sources give different descriptions: higher precedence wins, tags merge deduplicated.', async () => {
  const i = await indexFlow();
  assert.equal(i.rec.description, 'empty harbour at dusk with gulls',
    'the sidecar (rank 3) won over the csv (rank 4)');
  assert.notEqual(i.rec.description, 'a bench in the park', 'the csv did not win');
  const tags = i.rec.tags;
  assert.ok(tags.includes('gulls'), 'the sidecar tag is in');
  assert.ok(tags.includes('bench') && tags.includes('wood'), 'the csv tags merged in');
  assert.equal(tags.length, new Set(tags).size, 'the tags are deduplicated');
});

await row('A-23', 'No input source changed: two scans leave the "yours" section unchanged byte for byte.', async () => {
  const i = await indexFlow();
  const again = i.second.clips.filter((x) => x.clip === i.rec.clip);
  assert.equal(again.length, 1, 'the same clip came back from the second scan');
  assert.equal(JSON.stringify(again[0].fromYou), JSON.stringify(i.rec.fromYou),
    'the yours section is the same bytes both times');
  assert.equal(JSON.stringify(again[0].origin), JSON.stringify(i.rec.origin), 'and so is where it came from');
});

await row('A-24', 'A clip that cannot cover the sentence\'s narration from its start is not a candidate.', async () => {
  const s = await shortFlow();
  assert.equal(s.p.shots.length, 0, 'no shot was made from the clip that is too short');
  assert.equal(s.p.missing.length, 1, 'the sentence is reported as missing');
  const short = s.p.missing[0].tooShort;
  assert.ok(short.length === 1 && short[0].availableSec < short[0].needSec,
    `the clip offers ${short[0].availableSec} s for ${short[0].needSec} s of narration`);
  assert.equal(s.p.layers.duration.dropped, 1, 'the duration layer says one candidate was dropped');
});

await row('A-25', 'A visual layer with nothing to work from falls back to text and says so, not an error.', async () => {
  const v = await visualFlow();
  assert.ok(v.p.ok === true, 'the match step still answered ok');
  assert.equal(v.p.visualMissing.length, 1, 'it said which clip had no visual layer');
  assert.ok(v.p.visualMissing[0].reason.includes('falls back to text'), 'and said it fell back to text');
  assert.equal(v.p.layers.visual.missing, 1, 'the layers report counts it');
  assert.equal(v.p.shots.length, 1, 'the sentence still got a clip, from text');
  assert.equal(v.p.shots[0].chosenBy, 'text', 'and the row says the text layer chose it');
});

await row('A-26', 'A Chinese sentence\'s visual query is translated to an English picture description, stored in the work files and echoed back.', async () => {
  const z = await zhFlow();
  assert.equal(z.q.notEnglish.length, 0, 'no query stayed in Chinese');
  assert.equal(z.q.empty.length, 0, 'no sentence came in without a query');
  assert.equal(z.q.echoed.length, ZH_SCRIPT.length, 'every query was echoed back to you');
  for (const row2 of z.q.echoed) {
    assert.ok(!/[㐀-鿿]/.test(row2.query), `${row2.id} query is English words`);
    assert.ok(/[㐀-鿿]/.test(row2.sentence), `${row2.id} sentence is still the Chinese you wrote`);
  }
  const stored = parseJson(await bytes(join(ROOT, '.narrate', z.work, 'queries.json')));
  assert.ok(stored, 'the work folder holds the queries file');
  assert.equal(stored.queries.length, ZH_SCRIPT.length, 'and it holds every one of them');
  assert.equal(z.p.shots.length, ZH_SCRIPT.length, 'so the match step read English words and found a clip for each');
});

await row('A-27', 'A clip used by two or more sentences shows its use count.', async () => {
  const L = await longFlow();
  const used = L.p.useCount.filter((u) => u.count >= 2);
  assert.ok(used.length > 0, 'at least one clip served more than one sentence');
  for (const u of used) {
    assert.equal(u.ids.length, u.count, `${u.clip} count ${u.count} matches the ${u.ids.length} sentences it served`);
  }
  const counts = L.c.parts.map((part) => L.p.useCount.filter((u) => u.ids.includes(part.id)).length);
  assert.equal(counts.filter((n) => n === 0).length, 0, 'every sentence appears in the use counts');
});

await row('A-28', 'A scan with no understanding step at all returns the list of clips needing understanding and calls understanding zero times.', async () => {
  const m = await mainFlow();
  assert.equal(m.scan.understandCalls, 0, 'the index step called understanding zero times');
  assert.equal(m.scan.needsUnderstanding.length, 3, 'and it listed all three clips as needing it');
  assert.equal(m.scan.needsUnderstanding.join(','), m.scan.clips.map((c) => c.clip).join(','),
    'the list is the clips it found, nothing invented');
});

await row('NEW-1', 'A render attempt with no approval flag exits non-zero.', async () => {
  const m = await mainFlow();
  const seg = await cli('segment', ['--work', m.work, '--root', ROOT]);
  assert.notEqual(seg.json.ok, true, 'segment without the flag did not answer ok');
  assert.equal(seg.json.error, 'E_SEGMENT_NOT_APPROVED', 'and said why in the named error');
  assert.notEqual(seg.r.code, 0, `segment exited ${seg.r.code}, not zero`);
  const con = await cli('concat', ['--work', m.work, '--root', ROOT]);
  assert.notEqual(con.json.ok, true, 'concat without the flag did not answer ok');
  assert.equal(con.json.error, 'E_CONCAT_NOT_APPROVED', 'and said why in the named error');
  assert.notEqual(con.r.code, 0, `concat exited ${con.r.code}, not zero`);
});

await row('NEW-2', 'A stage that reads the previous stage\'s product and finds no file stops and says so rather than inventing one.', async () => {
  const work = 'nothing-here';
  await mkdir(join(ROOT, '.narrate', work), { recursive: true });
  await writeFile(join(ROOT, '.narrate', work, 'script.txt'), '1. One sentence with no shot list behind it.\n');
  const seg = await cli('segment', ['--work', work, '--root', ROOT, '--approved']);
  assert.notEqual(seg.json.ok, true, 'segment did not answer ok');
  assert.equal(seg.json.error, 'E_SEGMENT_SHOTS_MISSING', 'it named the file it was missing');
  assert.ok(seg.json.message.includes('shot list') && !(await exists(seg.json.shotsPath)), 'and named the file it was missing instead of inventing one');
  assert.notEqual(seg.r.code, 0, `segment exited ${seg.r.code}, not zero`);
  const v = await cli('voice', ['--work', work, '--root', ROOT]);
  assert.notEqual(v.json.ok, true, 'voice did not answer ok either');
  assert.equal(v.json.error, 'E_VOICE_SHOTS_MISSING', 'it named the same missing file');
  assert.notEqual(await exists(join(ROOT, '.narrate', work, 'segments')), true,
    'and no stage wrote a product of its own');
});

// ------------------------------------------------------------------ the tally
for (const dir of [ROOT]) await rm(dir, { recursive: true, force: true });
process.stdout.write(`\n${nPass} pass, ${nFail} fail, ${nSkip} skipped of ${LINES.length} checks in section 10\n`);
process.exit(nFail ? 1 : 0);
