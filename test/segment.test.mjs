// T-08 — bin/segment.mjs: one planned sentence becomes one real part, with the subtitle
// burned in.
//
// Red first: `node --test test/segment.test.mjs` before bin/segment.mjs existed failed with
// code ERR_MODULE_NOT_FOUND, url file:///home/stuart/workspace/claude-narrate/bin/segment.mjs
// — behaviour missing, not a runner that could not start. The red run is kept in the commit
// note.
//
// F-13: the shot list here comes from the REAL pick step and the audio from the REAL voice
// step, never from a hand-made file, so the names pick writes and the names segment reads
// are one naming.
import assert from 'node:assert';
import { test } from 'node:test';
import { run } from '../lib/run.mjs';
import { readJson, writeJson, ensureDir } from '../lib/json.mjs';
import { scanAssets } from '../bin/index.mjs';
import { estimateSec, plan } from '../bin/pick.mjs';
import { speak, audioPathOf } from '../bin/voice.mjs';
import { cut, partPathOf } from '../bin/segment.mjs';
import {
  RESULT_SCHEMA, SHOT_SCHEMA, QUERY_SCHEMA, FRAMES, PART_SHAPE, SHAPE_PROBE, TOLERANCE_SEGMENT,
  FILL, SUB_FONT, parseScript, blankShot, blankShots, blankQueries,
  subStyle, assHeader, assEvent, assEscape, breakLines, displayWidth, ERRORS,
} from '../lib/contract.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const ROOTS = [];

async function makeRoot(label) {
  const dir = await mkdtemp(join(tmpdir(), `narrate-segment-${label}-`));
  ROOTS.push(dir);
  return dir;
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function durationOf(path) {
  const r = await run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', path]);
  return r.ok ? Number(r.stdout.trim()) : null;
}

// The shape probe uses the contract's own field list, so the test asks the same question
// the renderer asks.
// Measured on this host (ffmpeg 6.1.1): the csv writer here refuses `no_prompt=1`, and csv
// prints fields in ffprobe's own order while skipping the ones a stream does not have, so the
// video line holds 5 fields and the audio line 4. json answers every stream on its own, so the
// two halves are merged back into one shape.
async function shapeOf(path) {
  const r = await run(['ffprobe', '-v', 'error', '-show_entries',
    `stream=codec_type,${SHAPE_PROBE.join(',')}`, '-print_format', 'json', path]);
  if (!r.ok) return null;
  const j = JSON.parse(r.stdout);
  const one = {};
  for (const f of SHAPE_PROBE) one[f] = null;
  for (const want of ['video', 'audio']) {
    const s = j.streams.find((x) => x.codec_type === want) ?? {};
    for (const f of SHAPE_PROBE) {
      if (one[f] === null && s[f] !== undefined)
        one[f] = typeof s[f] === 'number' ? s[f] : (/^\d+$/.test(String(s[f])) ? Number(s[f]) : s[f]);
    }
  }
  for (const f of SHAPE_PROBE) if (one[f] === null) return null;
  return one;
}

async function decodeClean(path) {
  const r = await run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'null', '-']);
  return r.ok && r.stderr === '';
}

// A dark source, so near-white pixels inside the frame can only come from the burned
// subtitle. Measured: a black/white/noise source makes cropdetect answer nonsense, so the
// pixel scan below is ours, not a filter. 4:3 also exercises the letterbox the fit adds.
async function clip(dir, name, seconds) {
  const r = await run(['ffmpeg', '-y', '-f', 'lavfi',
    '-i', `color=0x0a0a0a:size=320x240:rate=30:duration=${seconds}`,
    '-c:v', 'h264', '-pix_fmt', 'yuv420p', join(dir, name)]);
  assert.ok(r.ok && r.code === 0, `ffmpeg made ${name}`);
}

// A labelled local engine: a low tone, not a voice. Two lengths, so the fill rules can be
// tested against audio that is genuinely shorter or longer than the picture window.
function tone(seconds) {
  return {
    argv: ['ffmpeg', '-y', '-f', 'lavfi', '-i', `sine=frequency=300:duration=${seconds}`,
      '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2', '{out}'],
    ext: 'wav', timeoutMs: 20000, speech: false, network: false,
    note: `Not a voice: a ${seconds} s tone, so this test needs no network and no key.`,
  };
}

async function enginesFile(root, engines) {
  const p = join(root, 'config', 'engines.json');
  await mkdir(join(root, 'config'), { recursive: true });
  await writeJson(p, { schema: 'narrate/engines@1', default: Object.keys(engines)[0], engines });
  return p;
}

const BOILER = 'Royalty Free;Fair Use;Stock Footage';

// ---------------------------------------------------------------- the real chain

// assets -> index -> work (script.txt + queries.json) -> pick -> voice -> segment.
// The described windows come from the index record's fromMachine.segments, which is what
// the describe step writes, so the -ss the renderer uses is a planned window, not 0.
async function chain(label, spec, script, queries, aspect) {
  const dir = await makeRoot(label);
  for (const entry of spec) {
    const [name, seconds, text] = entry;
    await clip(dir, name, seconds);
    await writeFile(join(dir, `${name.replace(/\.[^.]*$/, '')}.narrate.txt`), text);
  }
  const scan = await scanAssets({ assets: dir });
  assert.ok(scan.ok, 'the index step wrote the records pick will read');
  // The describe step runs after the index step, and it writes into the record the index
  // step just made, so the window read here is a planned window, never a made-up one.
  for (const entry of spec) {
    if (!entry[3]) continue;
    const path = join(dir, `${entry[0].replace(/\.[^.]*$/, '')}.json`);
    const one = await readJson(path);
    assert.equal(one.ok, true, 'the sidecar parses');
    one.value.fromMachine.segments = entry[3];
    assert.equal((await writeJson(path, one.value)).ok, true, 'the machine section landed');
  }
  await ensureDir(join(dir, '.narrate', 'w'));
  await writeFile(join(dir, '.narrate', 'w', 'script.txt'), script);
  await writeJson(join(dir, '.narrate', 'w', 'queries.json'),
    { schema: QUERY_SCHEMA, work: 'w', queries });
  // The real pick step, so the window segment cuts is the window pick planned (F-13).
  const p = await plan({ work: 'w', assets: dir, root: dir, aspect });
  assert.ok(p.ok, `pick ran: ${p.ok ? '' : p.error + ' ' + p.message}`);
  assert.equal(p.missing.length, 0, 'pick kept every sentence, so segment has one part per row');
  return dir;
}

const SKY = [
  ['sky-clouds.mp4', 30, 'time lapse of clouds moving across a bright sky\n' +
    `#clouds;sky;bright;moving;time;lapse;${BOILER}\n`,
    [{ startSec: 0, endSec: 30, description: 'clouds cross a bright sky', tags: ['clouds', 'sky'] }]],
  ['harbour-dusk.mp4', 30, 'empty harbour at dusk with gulls on the water\n' +
    `#harbour;dusk;gulls;water;quay;${BOILER}\n`,
    [{ startSec: 0, endSec: 30, description: 'gulls on the water at dusk', tags: ['gulls', 'water'] }]],
];

const S1 = 'Clouds cross the bright sky before the rain.';
const S2 = 'Gulls turn over the water at dusk.';
const MAIN_SCRIPT = `1. ${S1}\n2. ${S2}\n`;
const MAIN_QUERIES = [
  { id: 'S-001', sentence: S1, query: 'bright sky with moving clouds, time lapse' },
  { id: 'S-002', sentence: S2, query: 'gulls on the water at dusk with harbour' },
];

// ------------------------------------------------------------------ the real join

await test('F-13 / A-10: the real pick step feeds the real segment step', async () => {
  const dir = await chain('join', SKY, MAIN_SCRIPT, MAIN_QUERIES, 'landscape');
  const cfg = await enginesFile(dir, { tone: tone(2) });
  const v = await speak({ work: 'w', root: dir, config: cfg });
  assert.ok(v.ok, `voice ran: ${v.ok ? '' : v.error + ' ' + v.message}`);
  assert.equal(v.audio.length, 2, 'one recording per sentence');

  const r = await cut({ work: 'w', root: dir, approved: true });
  assert.ok(r.ok, `segment ran: ${r.ok ? '' : r.error + ' ' + r.message}`);
  assert.equal(r.approved, true, 'the render only runs on an approved plan');
  assert.equal(r.aspect, 'landscape', 'the aspect is the one pick stored, not one we pass in');
  assert.deepEqual(r.frame, FRAMES.landscape, 'the frame is the contract target frame');

  assert.equal(r.parts.length, 2, 'one part per planned sentence');
  for (const part of r.parts) {
    const path = partPathOf('w', part.id, dir);
    assert.equal(part.path, path, 'the part is where the contract naming says');
    assert.ok(await exists(path), `${basename(path)} is on disk`);
    assert.ok(await decodeClean(path), 'a full decode pass leaves no errors');

    const audio = await durationOf(audioPathOf('w', part.id, dir));
    const video = await durationOf(path);
    assert.ok(Math.abs(video - audio) <= TOLERANCE_SEGMENT,
      `part ${part.id} is ${video} s, its audio is ${audio} s (tolerance ${TOLERANCE_SEGMENT})`);
    // A-10: the picture length follows the audio length, never the other way round.
    assert.ok(Math.abs(video - audio) <= 0.2, `A-10: part ${part.id} picture and audio agree`);
    assert.equal(part.wantedSec, audio, 'the part was cut to the real audio, not to the estimate');
    // The estimate is what pick used; it is not what the cut used.
    assert.notEqual(part.wantedSec, estimateSec(part.sentence),
      'the length came from the recording, not from the estimate');

    const shape = await shapeOf(path);
    assert.ok(shape, 'the part can be probed');
    assert.equal(shape.width, FRAMES.landscape[0], 'the part is the target width');
    assert.equal(shape.height, FRAMES.landscape[1], 'the part is the target height');
    assert.equal(shape.codec_name, PART_SHAPE.videoCodec, 'the part is h264');
    assert.equal(shape.pix_fmt, PART_SHAPE.pixFmt, 'the part is yuv420p');
    assert.equal(shape.r_frame_rate, `${PART_SHAPE.fps}/1`, 'the part is 30 fps');
    assert.equal(shape.sample_rate, PART_SHAPE.sampleRate, 'the part is 44100');
    assert.equal(shape.channels, PART_SHAPE.channels, 'the part is 2 channels');
  }

  // A-12: the middle products exist on disk, so the next step can read them.
  const shots = await readJson(join(dir, '.narrate', 'w', 'shots.json'));
  assert.ok(shots.ok, 'shots.json is still there for the next step');
  for (const row of shots.value.shots) {
    assert.ok(['none', 'slow', 'loop'].includes(row.fill), `row ${row.id} records the fill it used`);
  }
  const subs = await readFile(join(dir, '.narrate', 'w', 'subs.ass'), 'utf8');
  assert.ok(subs.includes('[Events]'), 'subs.ass is a subtitle file, not a note');
  assert.equal(subs.split('\n').filter((l) => l.startsWith('Dialogue:')).length, 2,
    'one event per part');
});

// ------------------------------------------------- the burned subtitle is really there

// The trap this test exists for: a subtitle file libass refuses (a short event line, a
// malformed Style line) makes ffmpeg exit 0 and write a file that is byte-identical to the
// plain clip. Measured: `Bad timestamp`, `Added subtitle file: ... (2 styles, 0 events)`,
// ink 0, and both files 6062 bytes. So "the command worked" proves nothing; the pixels do.
async function plainPart(dir, row, wantedSec) {
  // The same command the renderer runs, with the ass= filter taken out.
  const [w, h] = FRAMES.landscape;
  const out = join(dir, '.narrate', 'w', 'plain-parts', `${row.id}.mp4`);
  await ensureDir(join(dir, '.narrate', 'w', 'plain-parts'));
  const r = await run(['ffmpeg', '-y', '-i', row.assetPath, '-ss', String(row.startSec),
    '-t', String(row.endSec - row.startSec), '-i', audioPathOf('w', row.id, dir),
    '-map', '0:v', '-map', '1:a',
    '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
    '-r', '30', '-c:v', 'h264', '-profile:v', 'high', '-level', '4.0',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', '-ac', '2',
    '-t', String(wantedSec), out]);
  assert.ok(r.ok, 'the plain render ran');
  return out;
}

// One frame to a .ppm file. Measured: writing ppm to a pipe fails on this build
// ("Requested output format 'ppm' is not known", exit 234, 0 bytes), so the frame goes to a
// real file and is read back as bytes.
async function frameOf(path, atSec, dir, name) {
  const ppm = join(dir, name);
  const r = await run(['ffmpeg', '-y', '-i', path, '-ss', String(atSec), '-frames:v', '1', ppm]);
  assert.ok(r.ok && r.code === 0, 'the frame was written');
  return ppm;
}

function inkOf(ppmBytes) {
  // Read the 4 header tokens as bytes, then scan. Measured: reading a .ppm as utf8 gives
  // NaN dimensions, because the pixel data is binary.
  let i = 0;
  const tok = [];
  while (tok.length < 4 && i < ppmBytes.length) {
    if (ppmBytes[i] > 32) {
      const s = i;
      while (i < ppmBytes.length && ppmBytes[i] > 32) i++;
      tok.push(ppmBytes.slice(s, i).toString());
    } else i++;
  }
  const w = Number(tok[1]);
  const h = Number(tok[2]);
  return { w, h, data: ppmBytes.slice(i + 1) };
}

function inkDiff(a, b) {
  // Pixels that are near-white in a but not in b: ink the subtitle added, on any source.
  const near = (d, p) => d[p] >= 235 && d[p + 1] >= 235 && d[p + 2] >= 235;
  let count = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
  const n = Math.min(a.data.length, b.data.length);
  for (let p = 0; p + 2 < n; p += 3) {
    if (near(a.data, p) && !near(b.data, p)) {
      const px = (p / 3) % a.w;
      const py = ((p / 3) / a.w) | 0;
      count++;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
    }
  }
  return { count, x0, x1, y0, y1 };
}

await test('A-11: the burned subtitle is really in the picture', async () => {
  const dir = await chain('burned', SKY, MAIN_SCRIPT, MAIN_QUERIES, 'landscape');
  const cfg = await enginesFile(dir, { tone: tone(3) });
  await speak({ work: 'w', root: dir, config: cfg });
  const r = await cut({ work: 'w', root: dir, approved: true });
  assert.ok(r.ok, `segment ran: ${r.ok ? '' : r.error + ' ' + r.message}`);

  const row = (await readJson(join(dir, '.narrate', 'w', 'shots.json'))).value.shots[0];
  const part = r.parts[0];
  const plain = await plainPart(dir, row, part.wantedSec);
  const scratch = join(dir, 'scratch');
  await ensureDir(scratch);
  const mid = part.wantedSec / 2;
  const a = inkOf(await readFile(await frameOf(part.path, mid, scratch, 'burned.ppm')));
  const b = inkOf(await readFile(await frameOf(plain, mid, scratch, 'plain.ppm')));
  assert.deepEqual([a.w, a.h], FRAMES.landscape, 'the frame is the target size');
  const ink = inkDiff(a, b);
  assert.ok(ink.count > 500, `the subtitle added ${ink.count} pixels of ink`);
  assert.ok(ink.y0 > FRAMES.landscape[1] / 2, 'the ink is in the lower band, where the subtitle sits');
  // The byte-identical trap: if the burn did nothing, the two files are the same size.
  assert.notEqual((await stat(part.path)).size, (await stat(plain)).size,
    'the burned part is not the plain part');
});

await test('A-17: no subtitle crosses the left or right edge (portrait)', async () => {
  const dir = await chain('portrait', SKY, MAIN_SCRIPT, MAIN_QUERIES, 'portrait');
  const cfg = await enginesFile(dir, { tone: tone(3) });
  await speak({ work: 'w', root: dir, config: cfg });
  const r = await cut({ work: 'w', root: dir, approved: true });
  assert.ok(r.ok, `segment ran: ${r.ok ? '' : r.error + ' ' + r.message}`);

  const [w, h] = FRAMES.portrait;
  const style = subStyle(w, h, 'portrait');
  assert.equal(r.aspect, 'portrait', 'the renderer read the aspect pick stored');
  assert.deepEqual(r.frame, [w, h], 'the parts are the portrait target frame');
  const shape = await shapeOf(r.parts[0].path);
  assert.equal(shape.width, w, 'the part really is 1080 wide');
  assert.equal(shape.height, h, 'the part really is 1920 tall');

  const row = (await readJson(join(dir, '.narrate', 'w', 'shots.json'))).value.shots[0];
  const part = r.parts[0];
  const plain = await plainPart(dir, row, part.wantedSec);
  const scratch = join(dir, 'scratch');
  await ensureDir(scratch);
  const a = inkOf(await readFile(await frameOf(part.path, part.wantedSec / 2, scratch, 'p-burned.ppm')));
  const b = inkOf(await readFile(await frameOf(plain, part.wantedSec / 2, scratch, 'p-plain.ppm')));
  const ink = inkDiff(a, b);
  assert.ok(ink.count > 500, `the subtitle added ${ink.count} pixels of ink`);
  // The margin is the contract's own marginH; the outline sticks out by its own width, so
  // the allowed box is the margin plus the outline, both measured values.
  const left = style.marginH - style.outline;
  const right = w - style.marginH + style.outline;
  assert.ok(ink.x0 >= left, `ink starts at ${ink.x0}, not left of the margin ${left}`);
  assert.ok(ink.x1 <= right, `ink ends at ${ink.x1}, not right of the margin ${right}`);
  assert.ok(ink.x0 >= 0 && ink.x1 < w, 'no ink is outside the frame at all');
});

await test('A-11: Chinese shows real glyphs, not empty boxes', async () => {
  const [w, h] = FRAMES.portrait;
  const style = subStyle(w, h, 'portrait');

  // The font we ask for has to resolve to a font that is on this host and covers Chinese.
  // Measured: fontconfig answers NotoSansCJK-Regular.ttc for this name, and CI installs
  // fonts-noto-cjk. A missing font falls back, it does not fail the render, so this is the
  // check that matters: the font that answers here still has the glyphs.
  const fc = await run(['fc-match', '-f', '%{file}', SUB_FONT]);
  assert.ok(fc.ok, 'fontconfig can answer for the subtitle font');
  assert.ok(/CJK/i.test(fc.stdout), `the font that answers is ${fc.stdout}, which covers Chinese`);
  assert.ok(await exists(fc.stdout.trim()), 'that font file is on disk');

  const text = '云 山 水 光 城 车 门 树';
  const br = breakLines(text, style);
  assert.equal(br.overflow, false, 'the CJK line fits the preset');
  const cjkRoot = await makeRoot('cjk');
  const ass = join(cjkRoot, 'cjk.ass');
  await writeFile(ass, assHeader(w, h, style) + '\n' +
    assEvent(0, 2, style, assEscape(text)) + '\n');
  const out = join(cjkRoot, 'cjk.mp4');
  const mk = await run(['ffmpeg', '-y', '-f', 'lavfi', '-i',
    'color=0x0a0a0a:size=1080x1920:rate=30:duration=2', '-vf', `ass=${ass}`,
    '-frames:v', '1', '-pix_fmt', 'yuv420p', out]);
  assert.ok(mk.ok, 'the CJK frame rendered');
  const f = inkOf(await readFile(await frameOf(out, 0, cjkRoot, 'cjk.ppm'))); // the render wrote one frame, so the only frame is at 0
  const blank = { w: f.w, h: f.h, data: Buffer.alloc(f.data.length) };
  const ink = inkDiff(f, blank);
  assert.ok(ink.count > 500, 'the CJK line drew ink');
  const units = displayWidth(text);
  const perUnit = (ink.x1 - ink.x0 + 1) / units;
  // Measured on this host: 5 Han chars at fontSize 68 drew 230 px, so 23 px per display
  // unit. The contract's half-cell model says fontSize/2 = 34 px, which is wider, so the
  // model is the conservative one and A-17 keeps its margin.
  assert.ok(perUnit <= style.fontSize / 2,
    `a display unit drew ${perUnit} px, the model allows ${style.fontSize / 2}`);
});

// ---------------------------------------------------------------- the stop rule

await test('NEW-1 / F-14: no --approved means the render step fails', async () => {
  const dir = await chain('notapproved', SKY, MAIN_SCRIPT, MAIN_QUERIES, 'landscape');
  const cfg = await enginesFile(dir, { tone: tone(2) });
  await speak({ work: 'w', root: dir, config: cfg });

  const r = await cut({ work: 'w', root: dir });
  assert.equal(r.ok, false, 'an unapproved plan is not a pass');
  assert.equal(r.error, 'E_SEGMENT_NOT_APPROVED', 'the name says stop 4 never said yes');
  assert.ok(r.message.includes('--approved'), 'the message says what to pass');
  const left = await run(['find', join(dir, '.narrate', 'w', 'segments'), '-type', 'f']);
  assert.equal(left.stdout, '', 'nothing rendered, so nothing is on disk');
});

await test('NEW-2: no shots.json means the render step stops and says so', async () => {
  const dir = await makeRoot('noshots');
  const r = await cut({ work: 'w', root: dir, approved: true });
  assert.equal(r.ok, false, 'no shot list is not a pass');
  assert.equal(r.error, 'E_SEGMENT_SHOTS_MISSING', 'the name says stop 3 never ran');
  assert.ok(r.message.includes('shots.json'), 'the message names the file it looked for');
  assert.ok(r.message.includes('never ran'), 'the message says why: the stage before it did not run');
});

await test('NEW-2: no script.txt means the render step stops and says so', async () => {
  const dir = await makeRoot('noscript');
  await ensureDir(join(dir, '.narrate', 'w'));
  await writeJson(join(dir, '.narrate', 'w', 'shots.json'), blankShots('w', 'landscape'));
  const r = await cut({ work: 'w', root: dir, approved: true });
  assert.equal(r.ok, false, 'no script is not a pass');
  assert.equal(r.error, 'E_SEGMENT_SCRIPT_MISSING', 'the name says stop 2 never ran');
  assert.ok(r.message.includes('script.txt'), 'the message names the file');
});

await test('NEW-2: a sentence with no recording names the file and stops', async () => {
  const dir = await chain('noaudio', SKY, MAIN_SCRIPT, MAIN_QUERIES, 'landscape');
  const cfg = await enginesFile(dir, { tone: tone(2) });
  await speak({ work: 'w', root: dir, config: cfg, only: 'S-001' });

  const r = await cut({ work: 'w', root: dir, approved: true });
  assert.equal(r.ok, false, 'a missing recording is not quietly skipped');
  assert.equal(r.error, 'E_AUDIO_MISSING', 'the name is the contract name for it');
  assert.ok(r.message.includes(audioPathOf('w', 'S-002', dir)),
    'the message names the exact file that is missing');
  const left = await run(['find', join(dir, '.narrate', 'w', 'segments'), '-type', 'f']);
  assert.equal(left.stdout, '', 'no part was made for the sentence that has no audio');
});

await test('E_SENTENCE_UNPLANNED: a sentence with no shot is reported, never filled in', async () => {
  const dir = await chain('unplanned', SKY, MAIN_SCRIPT, MAIN_QUERIES, 'landscape');
  const cfg = await enginesFile(dir, { tone: tone(2) });
  await speak({ work: 'w', root: dir, config: cfg });
  // Drop one row from the shot list: the sentence is still in script.txt, so the render
  // would be missing it. Never substitute another clip for it.
  const shotsPath = join(dir, '.narrate', 'w', 'shots.json');
  const doc = await readJson(shotsPath);
  doc.value.shots = doc.value.shots.slice(0, 1);
  assert.equal((await writeJson(shotsPath, doc.value)).ok, true, 'the row was dropped');

  const r = await cut({ work: 'w', root: dir, approved: true });
  assert.equal(r.ok, false, 'a missing sentence is not a pass');
  assert.equal(r.error, 'E_SENTENCE_UNPLANNED', 'the contract name for it');
  assert.ok(r.unplanned.includes('S-002'), 'the message names the sentence id');
  assert.ok(r.message.includes('never'), 'the message says nothing was substituted');
});

await test('E_ASSET_TOO_SHORT: the clip moved since the plan, and we name it', async () => {
  const dir = await chain('tooshort', SKY, MAIN_SCRIPT, MAIN_QUERIES, 'landscape');
  const cfg = await enginesFile(dir, { tone: tone(2) });
  await speak({ work: 'w', root: dir, config: cfg });
  const shotsPath = join(dir, '.narrate', 'w', 'shots.json');
  const doc = await readJson(shotsPath);
  const row = doc.value.shots[0];
  // Re-cut the clip the plan chose to a length shorter than the planned window.
  const short = join(dir, 'short.mp4');
  const rec = await run(['ffmpeg', '-y', '-i', row.assetPath, '-t', '1', '-c', 'copy', short]);
  assert.ok(rec.ok, 'the short clip was made');
  const mv = await run(['mv', short, row.assetPath]);
  assert.ok(mv.ok, 'the clip is now shorter than the plan says');

  const r = await cut({ work: 'w', root: dir, approved: true });
  assert.equal(r.ok, false, 'a clip shorter than its window is not a pass');
  assert.equal(r.error, 'E_ASSET_TOO_SHORT', 'the contract name for it');
  assert.ok(r.message.includes(basename(row.assetPath)), 'the message names the clip');
  assert.ok(r.message.includes('never'), 'the message says nothing was substituted');
});

// ---------------------------------------------------------------- the fill rules

// The estimate errs long on purpose, so the real audio is usually shorter than the window.
// The two other rules need audio that is genuinely longer, which is what the tone engines
// give: the recording came out longer than the estimate.
const ONE_CLIP = [['sky-clouds.mp4', 6, 'time lapse of clouds moving across a bright sky\n' +
  `#clouds;sky;bright;moving;time;lapse;${BOILER}\n`,
  [{ startSec: 0, endSec: 6, description: 'clouds cross a bright sky', tags: ['clouds', 'sky'] }]]];
const SHORT_SCRIPT = '1. The clock ticks twice.\n';
const SHORT_QUERIES = [{ id: 'S-001', sentence: 'The clock ticks twice.', query: 'clouds moving across a bright sky' }];

await test('fill: audio a little longer than the picture slows the picture', async () => {
  const dir = await chain('slow', ONE_CLIP, SHORT_SCRIPT, SHORT_QUERIES, 'landscape');
  const cfg = await enginesFile(dir, { t7: tone(7) });
  await speak({ work: 'w', root: dir, config: cfg });

  const r = await cut({ work: 'w', root: dir, approved: true });
  assert.ok(r.ok, `segment ran: ${r.ok ? '' : r.error + ' ' + r.message}`);
  const part = r.parts[0];
  assert.equal(part.fill, 'slow', 'a gap inside SLOW_LIMIT slows the picture');
  assert.ok(part.slowTo > 1 && part.slowTo <= 1 + FILL.SLOW_LIMIT + 1e-6,
    `slowTo ${part.slowTo} is inside the ${FILL.SLOW_LIMIT} limit`);
  const video = await durationOf(part.path);
  const audio = await durationOf(audioPathOf('w', part.id, dir));
  assert.ok(Math.abs(video - audio) <= TOLERANCE_SEGMENT,
    `the slowed picture is ${video} s, the audio is ${audio} s`);
  const row = (await readJson(join(dir, '.narrate', 'w', 'shots.json'))).value.shots[0];
  assert.equal(row.fill, 'slow', 'the shot list records the fill the renderer used');
  assert.ok(Math.abs(row.slowTo - part.slowTo) < 1e-6, 'and the factor it used');
});

await test('fill: audio much longer than the picture loops from the start of the window', async () => {
  const dir = await chain('loop', ONE_CLIP, SHORT_SCRIPT, SHORT_QUERIES, 'landscape');
  const cfg = await enginesFile(dir, { t9: tone(9) });
  await speak({ work: 'w', root: dir, config: cfg });

  const r = await cut({ work: 'w', root: dir, approved: true });
  assert.ok(r.ok, `segment ran: ${r.ok ? '' : r.error + ' ' + r.message}`);
  const part = r.parts[0];
  assert.equal(part.fill, 'loop', 'past SLOW_LIMIT the window repeats from its start');
  const video = await durationOf(part.path);
  const audio = await durationOf(audioPathOf('w', part.id, dir));
  assert.ok(Math.abs(video - audio) <= TOLERANCE_SEGMENT,
    `the looped picture is ${video} s, the audio is ${audio} s`);
  assert.ok(video > 6, 'the part is longer than one window, so the loop really ran');
});

await test('fill: audio shorter than the picture cuts the window, nothing is stretched', async () => {
  const dir = await chain('cutonly', SKY, MAIN_SCRIPT, MAIN_QUERIES, 'landscape');
  const cfg = await enginesFile(dir, { tone: tone(2) });
  await speak({ work: 'w', root: dir, config: cfg });
  const r = await cut({ work: 'w', root: dir, approved: true });
  assert.ok(r.ok, `segment ran: ${r.ok ? '' : r.error + ' ' + r.message}`);
  for (const part of r.parts) {
    assert.equal(part.fill, 'none', 'no gap means no fill');
    assert.equal(part.slowTo, 0, 'nothing was slowed');
    const row = (await readJson(join(dir, '.narrate', 'w', 'shots.json'))).value.shots
      .find((s) => s.id === part.id);
    const have = row.endSec - row.startSec;
    const video = await durationOf(part.path);
    assert.ok(video <= have + TOLERANCE_SEGMENT,
      `the picture is ${video} s, the window is ${have} s: never stretched`);
  }
});

// ---------------------------------------------------------------- the middle product

await test('A-12: subs.ass holds the whole video, with cumulative times', async () => {
  const dir = await chain('subs', SKY, MAIN_SCRIPT, MAIN_QUERIES, 'landscape');
  const cfg = await enginesFile(dir, { tone: tone(2) });
  await speak({ work: 'w', root: dir, config: cfg });
  const r = await cut({ work: 'w', root: dir, approved: true });
  assert.ok(r.ok, `segment ran: ${r.ok ? '' : r.error + ' ' + r.message}`);

  const subs = await readFile(join(dir, '.narrate', 'w', 'subs.ass'), 'utf8');
  assert.ok(subs.includes(`PlayResX: ${FRAMES.landscape[0]}`), 'the file pins the frame width');
  assert.ok(subs.includes(`PlayResY: ${FRAMES.landscape[1]}`), 'the file pins the frame height');
  const events = subs.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.equal(events.length, r.parts.length, 'one event per part');
  const toSec = (s) => {
    const [hh, mm, rest] = s.split(':');
    return Number(hh) * 3600 + Number(mm) * 60 + Number(rest);
  };
  // The times are cumulative over the parts, so the file describes the whole video.
  let cursor = 0;
  for (let i = 0; i < r.parts.length; i++) {
    const f = events[i].split(',');
    assert.ok(Math.abs(toSec(f[1]) - cursor) <= 0.01,
      `event ${i + 1} starts at ${f[1]}, the parts before it end at ${cursor.toFixed(2)} s`);
    assert.ok(Math.abs(toSec(f[2]) - (cursor + r.parts[i].wantedSec)) <= 0.01,
      `event ${i + 1} ends where its part ends`);
    cursor += r.parts[i].wantedSec;
  }
  // The per-part files are what the render reads, and they exist for every part.
  for (const part of r.parts) {
    assert.ok(await exists(part.subsPath), `${basename(part.subsPath)} is on disk`);
  }
});

// ---------------------------------------------------------------- the CLI

await test('SPEC 3: the command prints one JSON object and exits non-zero on a stop', async () => {
  const dir = await chain('cli', SKY, MAIN_SCRIPT, MAIN_QUERIES, 'landscape');
  const cfg = await enginesFile(dir, { tone: tone(2) });
  await speak({ work: 'w', root: dir, config: cfg });

  const good = await run(['node', 'bin/segment.mjs', '--work', 'w', '--root', dir, '--approved']);
  assert.equal(good.code, 0, 'an approved run exits 0');
  const parsed = JSON.parse(good.stdout);
  assert.equal(parsed.schema, RESULT_SCHEMA, 'the result carries the crossing schema');
  assert.equal(parsed.command, 'segment', 'the result names the command');
  assert.equal(parsed.ok, true, 'an approved run says ok');

  const bad = await run(['node', 'bin/segment.mjs', '--work', 'w', '--root', dir]);
  assert.notEqual(bad.code, 0, 'a run without --approved exits non-zero');
  const parsedBad = JSON.parse(bad.stdout);
  assert.equal(parsedBad.ok, false, 'the stop is reported, not hidden');
  assert.equal(parsedBad.error, 'E_SEGMENT_NOT_APPROVED', 'the name says why nothing rendered');

  const args = await run(['node', 'bin/segment.mjs', '--nope']);
  assert.notEqual(args.code, 0, 'a command line we cannot read exits non-zero');
  assert.equal(JSON.parse(args.stdout).error, 'E_SEGMENT_ARGS', 'and says the command line was bad');
});

// ---------------------------------------------------------------- the error names

await test('the segment error names exist, so a stop says which stage it stopped at', async () => {
  for (const name of ['E_SEGMENT_ARGS', 'E_SEGMENT_NOT_APPROVED', 'E_SEGMENT_SCRIPT_MISSING',
    'E_SEGMENT_SHOTS_MISSING', 'E_SEGMENT_WRITE_FAILED', 'E_SEGMENT_BAD_SHAPE',
    'E_SENTENCE_UNPLANNED', 'E_AUDIO_MISSING', 'E_ASSET_TOO_SHORT', 'E_RENDER_OUTPUT_UNREADABLE']) {
    assert.ok(ERRORS.segment.includes(name), `${name} is a known name`);
  }
});

for (const dir of ROOTS) await rm(dir, { recursive: true, force: true });
