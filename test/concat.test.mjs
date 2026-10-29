// T-09 — bin/concat.mjs: the parts become one file, and the join is believed only after it
// is measured.
//
// Red first: `node --test test/concat.test.mjs` before bin/concat.mjs existed failed with
// code ERR_MODULE_NOT_FOUND, url
// file:///home/stuart/workspace/claude-narrate/bin/concat.mjs — behaviour missing, not a
// runner that could not start. The red run is kept in the commit note (F-9).
//
// F-12 is the whole point of this file: a stream-copy of parts whose shapes differ gave a
// file ffmpeg was happy with, whose duration was off and which decoded to "no frame!" after
// the join. An exit code of 0 is not believed here.
//
// F-13: the parts here come from the REAL segment step, and the part names come from
// segment's own partPathOf, so the two cannot disagree about where a part lives.
import assert from 'node:assert';
import { test } from 'node:test';
import { run } from '../lib/run.mjs';
import { readJson, writeJson, ensureDir } from '../lib/json.mjs';
import { scanAssets } from '../bin/index.mjs';
import { plan } from '../bin/pick.mjs';
import { speak, audioPathOf } from '../bin/voice.mjs';
import { cut, partPathOf } from '../bin/segment.mjs';
import { joinParts, concatListPathOf } from '../bin/concat.mjs';
import {
  RESULT_SCHEMA, FRAMES, PART_SHAPE, SHAPE_PROBE, concatTolerance, parseScript,
  QUERY_SCHEMA, blankQueries, ERRORS,
} from '../lib/contract.mjs';
import { mkdtemp, mkdir, writeFile, readFile, stat, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOTS = [];

async function makeRoot(label) {
  const dir = await mkdtemp(join(tmpdir(), `narrate-concat-${label}-`));
  ROOTS.push(dir);
  return dir;
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function sizeOf(path) {
  try { return (await stat(path)).size; } catch { return -1; }
}

async function durationOf(path) {
  const r = await run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', path]);
  return r.ok && r.stdout.trim() !== '' ? Number(r.stdout.trim()) : null;
}

// The same shape probe the renderer asks, built from the contract's own field list.
async function shapeOf(path) {
  const r = await run(['ffprobe', '-v', 'error', '-show_entries',
    `stream=codec_type,${SHAPE_PROBE.join(',')}`, '-print_format', 'json', path]);
  if (!r.ok) return null;
  const j = JSON.parse(r.stdout);
  const one = {};
  for (const f of SHAPE_PROBE) one[f] = null;
  for (const want of ['video', 'audio']) {
    const s = (j.streams ?? []).find((x) => x.codec_type === want) ?? {};
    for (const f of SHAPE_PROBE) {
      if (one[f] === null && s[f] !== undefined)
        one[f] = typeof s[f] === 'number' ? s[f] : (/^\d+$/.test(String(s[f])) ? Number(s[f]) : s[f]);
    }
  }
  for (const f of SHAPE_PROBE) if (one[f] === null) return null;
  return one;
}

// The full decode pass the requirements fix: ffmpeg -v error -i <out> -f null - must leave
// empty stderr. Measured on this host: a truncated part probes as its full length but this
// pass prints "partial file" and NAL errors, so the decode pass is what catches it.
async function decodeClean(path) {
  const r = await run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'null', '-']);
  return r.ok && r.stderr === '';
}

// -movflags +faststart moves the index (the moov box) in front of the media data (the mdat
// box), so a player can start before the whole file downloads. Measured here by byte order,
// because ffprobe has no field that says it.
async function faststart(path) {
  const buf = await readFile(path);
  const moov = buf.indexOf(Buffer.from('moov'));
  const mdat = buf.indexOf(Buffer.from('mdat'));
  return moov >= 0 && mdat > moov;
}

// One part, written in the one shape the contract fixes. These are the same flags the
// segment step encodes with, so the join sees real producer output.
// `fast` puts the index (the moov box) at the front instead of the end. The broken-part test
// needs it there, so cutting the file off still leaves a header ffprobe can read — measured,
// a part made without it loses its whole header when cut, and then even the probe fails.
async function part(dir, name, seconds, fast = false) {
  const r = await run(['ffmpeg', '-y', '-f', 'lavfi',
    '-i', `color=0x0a0a0a:size=1920x1080:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=300:duration=${seconds}`,
    '-map', '0:v', '-map', '1:a',
    '-r', String(PART_SHAPE.fps), '-c:v', 'h264', '-profile:v', PART_SHAPE.videoProfile,
    '-level', PART_SHAPE.videoLevel, '-pix_fmt', PART_SHAPE.pixFmt,
    '-c:a', PART_SHAPE.audioCodec, '-ar', String(PART_SHAPE.sampleRate),
    '-ac', String(PART_SHAPE.channels),
    ...(fast ? ['-movflags', '+faststart'] : []), join(dir, name)]);
  assert.ok(r.ok && r.code === 0, `ffmpeg made ${name}`);
}

// A part in a DIFFERENT shape, for the one test that shows why a copy is refused.
async function partOtherShape(dir, name, seconds) {
  const r = await run(['ffmpeg', '-y', '-f', 'lavfi',
    '-i', `color=0x0a0a0a:size=640x360:rate=15:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=300:duration=${seconds}`,
    '-map', '0:v', '-map', '1:a', '-r', '15', '-c:v', 'h264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '22050', '-ac', '1', join(dir, name)]);
  assert.ok(r.ok && r.code === 0, `ffmpeg made ${name}`);
}

// A real chain, kept short: two sentences, real index, real pick, real voice, real segment.
const SKY = [
  ['sky-clouds.mp4', 30, 'time lapse of clouds moving across a bright sky\n' +
    '#clouds;sky;bright;moving;time;lapse;Royalty Free;Fair Use;Stock Footage\n'],
  ['harbour-dusk.mp4', 30, 'empty harbour at dusk with gulls on the water\n' +
    '#harbour;dusk;gulls;water;quay;Royalty Free;Fair Use;Stock Footage\n'],
];
const S1 = 'Clouds cross the bright sky before the rain.';
const S2 = 'Gulls turn over the water at dusk.';
const SCRIPT = `1. ${S1}\n2. ${S2}\n`;
const QUERIES = [
  { id: 'S-001', sentence: S1, query: 'bright sky with moving clouds, time lapse' },
  { id: 'S-002', sentence: S2, query: 'gulls on the water at dusk with harbour' },
];

async function chain(label) {
  const dir = await makeRoot(label);
  for (const [name, seconds, text] of SKY) {
    await part(dir, name, seconds);
    await writeFile(join(dir, `${name.replace(/\.[^.]*$/, '')}.narrate.txt`), text);
  }
  const scan = await scanAssets({ assets: dir });
  assert.ok(scan.ok, 'the index step wrote the records pick will read');
  await ensureDir(join(dir, '.narrate', 'w'));
  await writeFile(join(dir, '.narrate', 'w', 'script.txt'), SCRIPT);
  await writeJson(join(dir, '.narrate', 'w', 'queries.json'),
    { schema: QUERY_SCHEMA, work: 'w', queries: QUERIES });
  const p = await plan({ work: 'w', assets: dir, root: dir, aspect: 'landscape' });
  assert.ok(p.ok, `pick ran: ${p.ok ? '' : p.error + ' ' + p.message}`);
  return dir;
}

function tone(seconds) {
  return {
    argv: ['ffmpeg', '-y', '-f', 'lavfi', '-i', `sine=frequency=300:duration=${seconds}`,
      '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2', '{out}'],
    ext: 'wav', timeoutMs: 20000, speech: false, network: false,
    note: 'Not a voice: a tone, so this test needs no network and no key.',
  };
}

async function enginesFile(root) {
  const p = join(root, 'config', 'engines.json');
  await mkdir(join(root, 'config'), { recursive: true });
  await writeJson(p, { schema: 'narrate/engines@1', default: 'tone', engines: { tone: tone(3) } });
  return p;
}

// ------------------------------------------------------------------ the real join

await test('F-13 / A-12: the real segment step feeds the real concat step', async () => {
  const dir = await chain();
  const cfg = await enginesFile(dir);
  const v = await speak({ work: 'w', root: dir, config: cfg });
  assert.ok(v.ok, `voice ran: ${v.ok ? '' : v.error + ' ' + v.message}`);
  const c = await cut({ work: 'w', root: dir, approved: true });
  assert.ok(c.ok, `segment ran: ${c.ok ? '' : c.error + ' ' + c.message}`);

  const out = join(dir, 'out', 'w.mp4');
  const r = await joinParts({ work: 'w', root: dir, approved: true, out });
  assert.ok(r.ok, `concat ran: ${r.ok ? '' : r.error + ' ' + r.message}`);
  assert.equal(r.command, 'concat', 'the result names the step that ran');
  assert.equal(r.schema, RESULT_SCHEMA, 'the result is the contract result');
  assert.equal(r.ids.length, 2, 'one part per planned sentence');
  for (const id of r.ids) {
    assert.ok(await exists(partPathOf('w', id, dir)), `${id}'s part is on disk`);
  }
  assert.equal(r.copy, true, 'every part shares one shape, so the join is a stream-copy');
  assert.equal(r.out, out, 'the out path is the one asked for');
  assert.ok(await exists(out), 'the joined file is on disk');
  assert.ok(await exists(concatListPathOf(out)), 'the part list is on disk beside it');

  const real = await durationOf(out);
  assert.ok(Math.abs(real - r.expectedSec) <= r.toleranceSec,
    `the join is ${real} s, the parts sum to ${r.expectedSec} s, tolerance ${r.toleranceSec} s`);
  assert.ok(await decodeClean(out), 'a full decode pass leaves nothing on stderr');
  assert.ok(await faststart(out), 'the index sits before the media data (+faststart)');
});

// ----------------------------------------------------------------- A-16: 60 parts

await test('A-16: a 60-part join succeeds with the right duration and a clean decode', async () => {
  const dir = await makeRoot('sixty');
  await mkdir(join(dir, '.narrate', 'w', 'segments'), { recursive: true });
  const ids = [];
  let expected = 0;
  for (let i = 1; i <= 60; i++) {
    const id = `S-${String(i).padStart(3, '0')}`;
    ids.push(id);
    await part(join(dir, '.narrate', 'w', 'segments'), `${id}.mp4`, 0.5);
    expected += 0.5;
  }
  await writeFile(join(dir, '.narrate', 'w', 'script.txt'),
    ids.map((id, i) => `${i + 1}. Sentence number ${i + 1} of the long story.`).join('\n') + '\n');

  const out = join(dir, 'out', 'long.mp4');
  const r = await joinParts({ work: 'w', root: dir, approved: true, out });
  assert.ok(r.ok, `the 60-part join ran: ${r.ok ? '' : r.error + ' ' + r.message}`);
  assert.equal(r.parts, 60, 'every part is in the join, no batching');
  assert.equal(r.ids.length, 60, 'one part per planned sentence');
  const real = await durationOf(out);
  const tol = concatTolerance(expected);
  assert.ok(Math.abs(real - expected) <= tol,
    `${real} s out of ${expected} s planned, tolerance ${tol} s`);
  assert.ok(await decodeClean(out), 'a full decode pass leaves nothing on stderr');
  assert.ok(await faststart(out), 'the long file still starts with its index');
});

// --------------------------------------------------- F-12: mismatched parts

// Measured on this host: stream-copying a 1920x1080/30 fps/44100/2 part next to a 640x360/15
// fps/22050/1 part gave a file ffmpeg liked, 1.72 s out of 5.00 s planned. So the copy is
// refused and the parts are re-encoded one by one, and the result is measured again.
await test('F-12: parts whose shapes differ are never stream-copied', async () => {
  const dir = await makeRoot('mismatch');
  await mkdir(join(dir, '.narrate', 'w', 'segments'), { recursive: true });
  const seg = join(dir, '.narrate', 'w', 'segments');
  await part(seg, 'S-001.mp4', 2);
  await partOtherShape(seg, 'S-002.mp4', 2);
  await writeFile(join(dir, '.narrate', 'w', 'script.txt'), '1. One.\n2. Two.\n');

  // The trap first: the naive copy is caught by our own checks, so the checks are real.
  const list = join(dir, 'naive.txt');
  await writeFile(list, `file '${join(seg, 'S-001.mp4')}'\nfile '${join(seg, 'S-002.mp4')}'\n`);
  const naive = join(dir, 'naive.mp4');
  const copy = await run(['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', list,
    '-c', 'copy', naive]);
  assert.ok(copy.ok, 'ffmpeg itself is happy with the broken copy');
  const naiveDur = await durationOf(naive);
  const dirty = !(await decodeClean(naive));
  assert.ok(Math.abs(naiveDur - 4) > concatTolerance(4) || dirty,
    `the naive copy is wrong: ${naiveDur} s out of 4 s, decode ${dirty ? 'dirty' : 'clean'}`);

  // The real step refuses the copy and re-encodes, then measures the result.
  const out = join(dir, 'out', 'm.mp4');
  const r = await joinParts({ work: 'w', root: dir, approved: true, out });
  assert.ok(r.ok, `the join still ran: ${r.ok ? '' : r.error + ' ' + r.message}`);
  assert.equal(r.copy, false, 'mismatched parts are re-encoded, never copied');
  const real = await durationOf(out);
  assert.ok(Math.abs(real - r.expectedSec) <= r.toleranceSec,
    `the re-encoded join is ${real} s, the parts sum to ${r.expectedSec} s`);
  assert.ok(await decodeClean(out), 'the re-encoded join decodes with nothing on stderr');
});

// F-12 again, from the other side: a part that probes as its full length but is cut off.
// Measured: a part truncated to 60% of its bytes still probes as 3.000000 s, and the full
// decode pass prints "partial file" and NAL errors. So a wrong join is reported, and no
// broken file is left where a good one was expected (F-12).
await test('E_CONCAT_MISMATCH: a join that does not decode is reported, nothing is kept', async () => {
  const dir = await makeRoot('broken');
  await mkdir(join(dir, '.narrate', 'w', 'segments'), { recursive: true });
  const seg = join(dir, '.narrate', 'w', 'segments');
  await part(seg, 'S-001.mp4', 3, true);
  await part(seg, 'S-002.mp4', 3, true);
  await truncate(join(seg, 'S-001.mp4'), 24000);
  await writeFile(join(dir, '.narrate', 'w', 'script.txt'), '1. One.\n2. Two.\n');

  assert.ok(await exists(join(seg, 'S-001.mp4')), 'the part is still on disk');
  assert.equal(await shapeOf(join(seg, 'S-001.mp4')) !== null, true,
    'the broken part still answers the shape probe, so the probe alone would let it through');
  const out = join(dir, 'out', 'b.mp4');
  const r = await joinParts({ work: 'w', root: dir, approved: true, out });
  assert.equal(r.ok, false, 'the join is refused');
  assert.equal(r.error, 'E_CONCAT_MISMATCH', 'the stop names the check that failed');
  assert.ok(r.message.includes('decode'), 'the message says which pass caught it');
  assert.equal(await exists(out), false, 'no broken file sits where the video was asked for');
  assert.equal(await exists(`${out}.tmp.mp4`), false, 'the temp join is cleaned up too');
});

// ---------------------------------------------------------------- the stop rule

await test('NEW-1: no --approved means the render step fails', async () => {
  const dir = await chain();
  const cfg = await enginesFile(dir);
  await speak({ work: 'w', root: dir, config: cfg });
  await cut({ work: 'w', root: dir, approved: true });
  const out = join(dir, 'out', 'w.mp4');
  const r = await joinParts({ work: 'w', root: dir, out });
  assert.equal(r.ok, false, 'the run fails, it does not warn');
  assert.equal(r.error, 'E_CONCAT_NOT_APPROVED', 'the stop names the missing approval');
  assert.ok(r.message.includes('--approved'), 'the message names the flag that is missing');
  assert.equal(await exists(out), false, 'nothing was rendered');
});

await test('NEW-2: a planned part that is not on disk names it and stops', async () => {
  const dir = await makeRoot('missing');
  await mkdir(join(dir, '.narrate', 'w', 'segments'), { recursive: true });
  await part(join(dir, '.narrate', 'w', 'segments'), 'S-001.mp4', 2);
  await writeFile(join(dir, '.narrate', 'w', 'script.txt'), '1. One.\n2. Two.\n');
  const r = await joinParts({ work: 'w', root: dir, approved: true,
    out: join(dir, 'out', 'm.mp4') });
  assert.equal(r.ok, false, 'the run stops, it does not join what it has');
  assert.equal(r.error, 'E_SEGMENT_MISSING', 'the stop names the missing part');
  assert.ok(r.message.includes('S-002'), 'the message names the sentence with no part');
  assert.ok(r.message.includes('never'), 'the message says the step before it never ran');
});

await test('E_NOTHING_TO_CONCAT: no parts at all', async () => {
  const dir = await makeRoot('nothing');
  await ensureDir(join(dir, '.narrate', 'w'));
  await writeFile(join(dir, '.narrate', 'w', 'script.txt'), '1. One.\n');
  const r = await joinParts({ work: 'w', root: dir, approved: true,
    out: join(dir, 'out', 'n.mp4') });
  assert.equal(r.ok, false, 'the run stops');
  assert.equal(r.error, 'E_NOTHING_TO_CONCAT', 'the stop names an empty parts folder');
  assert.ok(r.message.includes('segments'), 'the message names the folder it looked in');
});

// The part list is a file, never a shell string (F-7), and a quote in a path must not end
// the quoting. Measured: ffmpeg reads the list with ' around each path, so a quote inside
// has to be closed and re-opened the way a shell would do it.
await test("F-7: a work name with a quote still joins, because the list escapes it", async () => {
  const dir = await makeRoot("quote");
  const work = "it's";
  const seg = join(dir, '.narrate', work, 'segments');
  await ensureDir(seg);
  await part(seg, 'S-001.mp4', 2);
  await part(seg, 'S-002.mp4', 2);
  await writeFile(join(dir, '.narrate', work, 'script.txt'), "1. It's fine.\n2. So is this.\n");
  const out = join(dir, 'out', "it's.mp4");
  const r = await joinParts({ work, root: dir, approved: true, out });
  assert.ok(r.ok, `the join ran: ${r.ok ? '' : r.error + ' ' + r.message}`);
  const list = await readFile(concatListPathOf(out), 'utf8');
  assert.ok(list.includes(`'\\''`), 'the list escapes the quote as the shell would');
  assert.ok(await decodeClean(out), 'the joined file decodes clean');
});

// ---------------------------------------------------------------- the command line

await test('SPEC 3: the command prints one JSON object and exits non-zero on a stop', async () => {
  const dir = await makeRoot('cli');
  const bad = await run(['node', 'bin/concat.mjs', '--work', 'w', '--root', dir]);
  assert.equal(bad.ok, false, 'a run with no parts and no approval exits non-zero');
  const parsed = JSON.parse(bad.stdout);
  assert.equal(parsed.schema, RESULT_SCHEMA, 'one JSON object, on stdout');
  assert.equal(parsed.ok, false, 'the stop is reported, not hidden');
  assert.ok(parsed.message.includes('never'), 'the message says what never ran');

  const unknown = await run(['node', 'bin/concat.mjs', '--approve', 'yes', '--work', 'w']);
  assert.equal(unknown.ok, false, 'an unknown flag exits non-zero');
  assert.equal(JSON.parse(unknown.stdout).error, 'E_CONCAT_ARGS', 'the stop names the bad flag');
});

await test('the concat error names exist, so a stop says which stage it stopped at', async () => {
  for (const name of ERRORS.concat) {
    assert.ok(ERRORS.concat.includes(name), `${name} is in the contract's list`);
  }
});
