// T-07 preview — the audio-only file you listen to at stop 4 (A-9).
//
// Red first: `node --test test/preview.test.mjs` before bin/preview.mjs existed failed with
// code ERR_MODULE_NOT_FOUND, url file:///home/stuart/workspace/claude-narrate/bin/preview.mjs
// — behaviour missing, not a runner that could not start.
//
// F-13: the audio here comes from the REAL voice step, never from a hand-made fixture, so
// the file names voice writes and the file names preview reads are one naming.
import assert from 'node:assert';
import { test } from 'node:test';
import { run } from '../lib/run.mjs';
import { writeJson } from '../lib/json.mjs';
import { stat } from 'node:fs/promises';
import { RESULT_SCHEMA, parseScript, blankShot, SHOT_SCHEMA } from '../lib/contract.mjs';
import { speak, audioPathOf } from '../bin/voice.mjs';
import { joinAudio } from '../bin/preview.mjs';
import { mkdtemp, writeFile, readFile, mkdir, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SENTENCES = [
  'The harbour opens at five.',
  'The gulls come before the light.',
  'Then the water goes flat.',
];

// A labelled local engine: a low tone, not a voice. It needs no network and no key, so the
// join is tested on real files on every run, online or off.
const TONE = {
  argv: ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=1',
    '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2', '{out}'],
  ext: 'wav', timeoutMs: 20000, speech: false, network: false,
  note: 'Not a voice: a low tone, so this test needs no network and no key.',
};

async function makeRoot(label) {
  return await mkdtemp(join(tmpdir(), `narrate-preview-${label}-`));
}

// The stage products stop 2 and stop 3 leave behind, written the way those steps write them.
async function work(root, sentences) {
  const dir = join(root, '.narrate', 'w');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'script.txt'),
    sentences.map((s, i) => `${i + 1}. ${s}`).join('\n') + '\n');
  const rows = parseScript(await readFile(join(dir, 'script.txt'), 'utf8'));
  await writeJson(join(dir, 'shots.json'), {
    schema: SHOT_SCHEMA, work: 'w', aspect: 'landscape',
    shots: rows.map((r) => ({ ...blankShot(r.id), sentence: r.sentence })),
  });
  return 'w';
}

async function enginesFile(root, engines) {
  const p = join(root, 'config', 'engines.json');
  await mkdir(join(root, 'config'), { recursive: true });
  await writeJson(p, { schema: 'narrate/engines@1', default: Object.keys(engines)[0], engines });
  return p;
}

function audioDir(root, workName) {
  return join(root, '.narrate', workName, 'audio');
}

async function durationOf(path) {
  const r = await run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', path]);
  return r.ok ? Number(r.stdout.trim()) : null;
}

// A-9 says the file plays in ffplay. ffplay needs eyes, so the machine check is the same
// thing from the other side: ffprobe sees an audio stream, and a full decode pass leaves
// ffmpeg's error channel empty.
async function decodeClean(path) {
  const r = await run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'null', '-']);
  return r.ok && r.stderr === '';
}

async function audioFiles(root, workName) {
  const dir = audioDir(root, workName);
  const r = await run(['find', dir, '-name', '*.wav', '-type', 'f']);
  return r.ok ? r.stdout.split('\n').filter(Boolean).sort() : [];
}

// ------------------------------------------------------------------ the real join

await test('F-13 / A-9: the real voice step feeds the real preview step', async () => {
  const root = await makeRoot('join');
  const w = await work(root, SENTENCES);
  const cfg = await enginesFile(root, { tone: TONE });

  const v = await speak({ work: w, root, config: cfg });
  assert.ok(v.ok, `voice ran: ${v.ok ? '' : v.error + ' ' + v.message}`);
  assert.equal(v.audio.length, SENTENCES.length, 'one recording per sentence');

  const r = await joinAudio({ work: w, root });
  assert.ok(r.ok, `preview ran: ${r.ok ? '' : r.error + ' ' + r.message}`);

  const files = await audioFiles(root, w);
  assert.equal(files.length, SENTENCES.length, 'every sentence has a file on disk');
  assert.equal(r.parts, SENTENCES.length, 'the join used every planned sentence');

  const expected = v.audio.reduce((sum, a) => sum + a.durationSec, 0);
  const drift = Math.abs(r.durationSec - expected);
  // Measured on this host: a stream-copy of three 1 s parts drifts by 0.000 s. 0.02 s is
  // the floor: looser would hide a part that is not in the join at all.
  assert.ok(drift <= 0.02, `preview is ${r.durationSec} s, the parts sum to ${expected} s (drift ${drift})`);

  const probe = await durationOf(join(root, '.narrate', w, 'preview.wav'));
  assert.ok(probe !== null, 'ffprobe can read preview.wav');
  assert.ok(await decodeClean(join(root, '.narrate', w, 'preview.wav')),
    'a full decode pass leaves no errors');
  assert.ok(Math.abs(probe - expected) <= 0.02, 'the file on disk is the length we measured');
});

await test('A-9: the joined order is the script order', async () => {
  const root = await makeRoot('order');
  const w = await work(root, SENTENCES);
  const cfg = await enginesFile(root, { tone: TONE });
  const v = await speak({ work: w, root, config: cfg });
  assert.ok(v.ok, 'voice ran');

  const files = await audioFiles(root, w);
  assert.equal(files.length, SENTENCES.length, 'three parts on disk');
  const r = await joinAudio({ work: w, root });
  assert.ok(r.ok, `preview ran: ${r.ok ? '' : r.error + ' ' + r.message}`);
  assert.deepEqual(r.ids, ['S-001', 'S-002', 'S-003'],
    'the join names the sentences in script order');
  assert.deepEqual(r.files, ['S-001', 'S-002', 'S-003'].map((id) => audioPathOf('w', id, root)),
    'the join reads the files voice names, in script order');
});

await test('A-9: parts of different shapes still join to one playable file', async () => {
  const root = await makeRoot('shape');
  const w = await work(root, SENTENCES);
  const cfg = await enginesFile(root, { tone: TONE });
  const v = await speak({ work: w, root, config: cfg });
  assert.ok(v.ok, 'voice ran');

  // Rewrite one part at another rate and channel count: the shapes no longer match, so a
  // stream-copy would be a lie and the join has to re-encode.
  const dir = audioDir(root, w);
  // ffmpeg refuses to write onto the file it is reading, so the odd part is made under a
  // second name and moved into place.
  const odd = join(dir, 'S-002.wav');
  const madeOdd = join(dir, 'S-002.odd.wav');
  const made = await run(['ffmpeg', '-y', '-i', odd,
    '-ar', '8000', '-ac', '1', '-acodec', 'pcm_s16le', madeOdd]);
  if (made.ok) await run(['mv', madeOdd, odd]);
  assert.ok(made.ok, 'the odd part was written');

  const r = await joinAudio({ work: w, root });
  assert.ok(r.ok, `preview ran: ${r.ok ? '' : r.error + ' ' + r.message}`);
  assert.equal(r.copy, false, 'a shape mismatch re-encodes instead of copying');
  const expected = v.audio.reduce((sum, a) => sum + a.durationSec, 0);
  assert.ok(Math.abs(r.durationSec - expected) <= 0.02,
    `re-encoded join is ${r.durationSec} s, parts sum to ${expected} s`);
  assert.ok(await decodeClean(join(root, '.narrate', w, 'preview.wav')), 'the file decodes');
});

// ------------------------------------------------------------------ the stop rule

await test('NEW-2: no audio folder means the step stops and says so', async () => {
  const root = await makeRoot('noaudio');
  const w = await work(root, SENTENCES);
  const r = await joinAudio({ work: w, root });
  assert.equal(r.ok, false, 'no audio on disk is not a pass');
  assert.equal(r.error, 'E_PREVIEW_AUDIO_MISSING', 'the name says what is missing');
  assert.ok(r.message.includes(audioDir(root, w)), 'the message names the folder it looked in');
  let seen = true;
  try { await readFile(join(root, '.narrate', w, 'preview.wav')); } catch { seen = false; }
  assert.equal(seen, false, 'no preview.wav was invented');
});

await test('NEW-2: a sentence with no recording is named, and the run stops', async () => {
  const root = await makeRoot('partial');
  const w = await work(root, SENTENCES);
  const cfg = await enginesFile(root, { tone: TONE });
  const v = await speak({ work: w, root, config: cfg, only: 'S-001,S-003' });
  assert.ok(v.ok, 'voice wrote the two recordings it was asked for');

  const r = await joinAudio({ work: w, root });
  assert.equal(r.ok, false, 'a missing sentence is not quietly skipped');
  assert.equal(r.error, 'E_PREVIEW_AUDIO_MISSING', 'the name says what is missing');
  assert.ok(r.missing.includes('S-002'), 'the message names the sentence id that has no file');
});

await test('NEW-2: no script.txt means the step stops and says so', async () => {
  const root = await makeRoot('noscript');
  const r = await joinAudio({ work: 'w', root });
  assert.equal(r.ok, false, 'no script is not a pass');
  assert.equal(r.error, 'E_PREVIEW_SCRIPT_MISSING', 'the name says stop 2 never ran');
  assert.ok(r.message.includes('script.txt'), 'the message names the file it looked for');
});

await test('NEW-1 / F-14: a command line we cannot read is an error, not a guess', async () => {
  const root = await makeRoot('args');
  const r = await joinAudio({});
  assert.equal(r.ok, false, 'no --work is not a pass');
  assert.equal(r.error, 'E_PREVIEW_ARGS', 'the name says the command line was bad');
  assert.ok(r.message.includes('--work'), 'the message shows how to call it');
});

// ------------------------------------------------------------------ the checks

await test('F-12: a part that does not decode is caught before the join', async () => {
  const root = await makeRoot('badpart');
  const w = await work(root, SENTENCES);
  const cfg = await enginesFile(root, { tone: TONE });
  const v = await speak({ work: w, root, config: cfg });
  assert.ok(v.ok, 'voice ran');
  await writeFile(join(audioDir(root, w), 'S-002.wav'), 'not audio at all');

  const r = await joinAudio({ work: w, root });
  assert.equal(r.ok, false, 'a broken part is not a pass');
  assert.equal(r.error, 'E_PREVIEW_BAD_PART', 'the name says a part is not audio');
  assert.ok(r.message.includes('S-002'), 'the message names the part');
  let seen = true;
  try { await readFile(join(root, '.narrate', w, 'preview.wav')); } catch { seen = false; }
  assert.equal(seen, false, 'nothing half-made is left as the answer');
});

await test('F-12: a join that exits 0 but is the wrong length is caught', async () => {
  const root = await makeRoot('wronglength');
  const w = await work(root, SENTENCES);
  const cfg = await enginesFile(root, { tone: TONE });
  const v = await speak({ work: w, root, config: cfg });
  assert.ok(v.ok, 'voice ran');

  // Cut the bytes of one part in half and leave its wav header alone: the header still
  // claims 1 s, the data holds 0.5 s. ffmpeg exits 0 and writes a file that is 0.5 s short.
  const f = join(audioDir(root, w), 'S-002.wav');
  const size = (await stat(f)).size;
  await truncate(f, Math.floor(size / 2));

  const r = await joinAudio({ work: w, root });
  assert.equal(r.ok, false, 'the exit code is not believed');
  assert.equal(r.error, 'E_PREVIEW_MISMATCH', 'the name says the join is the wrong length');
  assert.ok(r.message.includes('s'), 'the message carries the numbers');
});

await test('F-12: the join is written to a temp name first, then moved', async () => {
  const root = await makeRoot('tmpname');
  const w = await work(root, SENTENCES);
  const cfg = await enginesFile(root, { tone: TONE });
  const v = await speak({ work: w, root, config: cfg });
  assert.ok(v.ok, 'voice ran');
  const r = await joinAudio({ work: w, root });
  assert.ok(r.ok, 'preview ran');

  const left = await run(['find', join(root, '.narrate', w), '-maxdepth', '1', '-name', '*.tmp*']);
  assert.ok(left.ok, 'the folder can be listed');
  assert.equal(left.stdout, '', 'no temp file is left behind');
  const probe = await durationOf(join(root, '.narrate', w, 'preview.wav'));
  assert.ok(probe !== null, 'preview.wav is there and readable');
});

// ------------------------------------------------------------------ the CLI

await test('SPEC 3: the command prints one JSON object and exits non-zero on a stop', async () => {
  const root = await makeRoot('cli');
  const w = await work(root, SENTENCES);
  const cfg = await enginesFile(root, { tone: TONE });
  const v = await speak({ work: w, root, config: cfg });
  assert.ok(v.ok, 'the recordings the command line will join are there');
  const good = await run(['node', 'bin/preview.mjs', '--work', w, '--root', root]);
  assert.equal(good.code, 0, 'a good run exits 0');
  const parsed = JSON.parse(good.stdout);
  assert.equal(parsed.schema, RESULT_SCHEMA, 'the result carries the crossing schema');
  assert.equal(parsed.command, 'preview', 'the result names the command');
  assert.equal(parsed.ok, true, 'a good run says ok');

  const bad = await run(['node', 'bin/preview.mjs', '--work', 'never-ran', '--root', root]);
  assert.notEqual(bad.code, 0, 'a stop exits non-zero');
  const parsedBad = JSON.parse(bad.stdout);
  assert.equal(parsedBad.ok, false, 'the stop is reported, not hidden');
});
