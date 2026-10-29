// F-14 — a step may only run when BOTH halves of the check pass: the file the step before
// it made is on disk, AND the caller passed the flag that says "I looked at it and said yes".
// One half alone is not enough. This file is the one place that says so for every render
// step, so a step that forgets its flag has somewhere to be caught.
//
// Red first: `node --test test/stop.test.mjs` before bin/segment.mjs existed failed with
// code ERR_MODULE_NOT_FOUND, url file:///home/stuart/workspace/claude-narrate/bin/segment.mjs
// — the render step's stop rule was missing, not a runner that could not start.
//
// The audio here comes from the real voice step, so the files on disk are real producer
// output (F-13), not a fixture we shaped to make a check pass.
import assert from 'node:assert';
import { test } from 'node:test';
import { run } from '../lib/run.mjs';
import { writeJson } from '../lib/json.mjs';
import { RESULT_SCHEMA, SHOT_SCHEMA, parseScript, blankShot } from '../lib/contract.mjs';
import { speak, audioPathOf } from '../bin/voice.mjs';
import { joinAudio } from '../bin/preview.mjs';
import { cut, partPathOf } from '../bin/segment.mjs';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SENTENCES = [
  'The harbour opens at five.',
  'The gulls come before the light.',
  'Then the water goes flat.',
];

// A labelled local engine: a low tone, not a voice. It needs no network and no key.
const TONE = {
  argv: ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=1',
    '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2', '{out}'],
  ext: 'wav', timeoutMs: 20000, speech: false, network: false,
  note: 'Not a voice: a low tone, so this test needs no network and no key.',
};

async function makeRoot(label) {
  return await mkdtemp(join(tmpdir(), `narrate-stop-${label}-`));
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

// Everything the render step would need, in place: the files AND the recordings.
async function ready(label) {
  const root = await makeRoot(label);
  const w = await work(root, SENTENCES);
  const cfg = await enginesFile(root, { tone: TONE });
  const v = await speak({ work: w, root, config: cfg });
  assert.ok(v.ok, 'the recordings the render step reads are there');
  return { root, w, cfg };
}

async function rendered(root) {
  const r = await run(['find', join(root, '.narrate', 'w', 'segments'), '-type', 'f']);
  return r.ok ? r.stdout.split('\n').filter(Boolean) : [];
}

// ------------------------------------------------------------------ the flag half

await test('NEW-1 / F-14: every file is in place, but no --approved means the render fails', async () => {
  const { root, w } = await ready('flag');
  const r = await cut({ work: w, root });
  assert.equal(r.ok, false, 'a render without the approval flag is not a pass');
  assert.equal(r.error, 'E_SEGMENT_NOT_APPROVED', 'the name says the approval never came');
  assert.ok(r.message.includes('--approved'), 'the message shows the flag that was missing');
  // The stop is a stop, not a warning: nothing was rendered.
  assert.deepEqual(await rendered(root), [], 'nothing on disk, so nothing was rendered');
});

await test('NEW-1 / F-14: the command line without --approved exits non-zero', async () => {
  const { root, w } = await ready('cli-flag');
  const bad = await run(['node', 'bin/segment.mjs', '--work', w, '--root', root]);
  assert.notEqual(bad.code, 0, 'a stop exits non-zero, it does not warn and continue');
  const parsed = JSON.parse(bad.stdout);
  assert.equal(parsed.schema, RESULT_SCHEMA, 'the result carries the crossing schema');
  assert.equal(parsed.ok, false, 'the stop is reported, not hidden');
  assert.equal(parsed.error, 'E_SEGMENT_NOT_APPROVED', 'the name says the approval never came');
  assert.deepEqual(await rendered(root), [], 'a stop leaves no part behind');
});

await test('F-14: the flag alone is not enough — a missing stage product still stops it', async () => {
  const root = await makeRoot('product');
  const w = await work(root, SENTENCES);
  const r = await cut({ work: w, root, approved: true });
  assert.equal(r.ok, false, 'the flag does not excuse a stage that never ran');
  assert.equal(r.error, 'E_AUDIO_MISSING', 'the name says what the stage before left missing');
  assert.ok(r.message.includes(audioPathOf('w', 'S-001', root)), 'the message names the file it looked for');
  assert.deepEqual(await rendered(root), [], 'nothing was invented and nothing was rendered');
});

// ------------------------------------------------------------------ the file half

// Stop 3's product is there and stop 2's is not, so the render has to stop at the file it is
// missing, not at the one it has.
async function shotsOnly(root) {
  const dir = join(root, '.narrate', 'w');
  await mkdir(dir, { recursive: true });
  const rows = SENTENCES.map((s, i) => ({ id: `S-00${i + 1}`, sentence: s }));
  await writeJson(join(dir, 'shots.json'), {
    schema: SHOT_SCHEMA, work: 'w', aspect: 'landscape',
    shots: rows.map((r) => ({ ...blankShot(r.id), sentence: r.sentence })),
  });
}

await test('NEW-2: no shots.json means the render step stops and says the stage before never ran', async () => {
  const root = await makeRoot('noshots');
  const r = await cut({ work: 'w', root, approved: true });
  assert.equal(r.ok, false, 'no shot list is not a pass');
  assert.equal(r.error, 'E_SEGMENT_SHOTS_MISSING', 'the name says stop 3 never ran');
  assert.ok(r.message.includes('shots.json'), 'the message names the file it looked for');
  assert.ok(r.message.includes('never ran'), 'the message says why: the stage before it did not run');
  assert.deepEqual(await rendered(root), [], 'nothing was invented');
});

await test('NEW-2: no script.txt means the render step stops and says so', async () => {
  const root = await makeRoot('noscript');
  await shotsOnly(root);
  const r = await cut({ work: 'w', root, approved: true });
  assert.equal(r.ok, false, 'no script is not a pass');
  assert.equal(r.error, 'E_SEGMENT_SCRIPT_MISSING', 'the name says stop 2 never ran');
  assert.ok(r.message.includes('script.txt'), 'the message names the file it looked for');
  assert.deepEqual(await rendered(root), [], 'nothing was invented');
});

await test('NEW-2: the step before the render step has the same rule', async () => {
  const root = await makeRoot('preview-noscript');
  const r = await joinAudio({ work: 'w', root });
  assert.equal(r.ok, false, 'no script is not a pass');
  assert.equal(r.error, 'E_PREVIEW_SCRIPT_MISSING', 'the name says stop 2 never ran');
  assert.ok(r.message.includes('script.txt'), 'the message names the file it looked for');
});

// ------------------------------------------------------------------ a bad command line

await test('NEW-1 / F-14: a command line we cannot read is an error, not a guess', async () => {
  const root = await makeRoot('args');
  const r = await cut({ root });
  assert.equal(r.ok, false, 'no --work is not a pass');
  assert.equal(r.error, 'E_SEGMENT_ARGS', 'the name says the command line was bad');
  assert.ok(r.message.includes('--work'), 'the message shows how to call it');
  assert.deepEqual(await rendered(root), [], 'a bad command line rendered nothing');
});

await test('NEW-1 / F-14: an unknown flag is an error, not a guess', async () => {
  const root = await makeRoot('unknown-flag');
  const bad = await run(['node', 'bin/segment.mjs', '--work', 'w', '--approve', 'yes', '--root', root]);
  assert.notEqual(bad.code, 0, 'an unknown flag exits non-zero');
  const parsed = JSON.parse(bad.stdout);
  assert.equal(parsed.ok, false, 'the stop is reported, not hidden');
  assert.equal(parsed.error, 'E_SEGMENT_ARGS', 'the name says the command line was bad');
});
