// The skill layer (layer 9 in SPEC §2): SKILL.md owns the flow, the four stops and the
// checklist. A skill is instructions, so the only honest check is that the instructions
// are in the file and say the same thing the requirements say. The stop itself is held by
// test/stop.test.mjs (a file on disk plus a required flag), not here.
//
// Red first, measured against a clone of the commit before this change: the clone has this
// file and no SKILL.md, so every row below fails with "the file is not there" — behaviour
// missing, not a runner that could not start (F-9).
import assert from 'node:assert';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SKILL = '.claude-plugin/plugin.json';
const MARKET = '.claude-plugin/marketplace.json';
const DOC = 'skills/narrate/SKILL.md';

async function text(path) {
  try { return await readFile(path, 'utf8'); } catch { return null; }
}

const doc = await text(DOC);
const manifest = await text(SKILL);
const market = await text(MARKET);

await test('NEW-2 / the skill layer: SKILL.md is there, and says which skill it is', async () => {
  assert.ok(doc !== null, 'the file is not there');
  const head = doc.slice(0, doc.indexOf('\n---\n', 4));
  assert.ok(head.startsWith('---\nname: narrate\n'), 'the frontmatter names the skill narrate');
  assert.ok(head.includes('description:'), 'and a line that says when to use it');
});

await test('A-4 / A-5 / the four stops are in the file, in the requirements own words', async () => {
  assert.ok(doc !== null, 'the file is not there');
  for (const words of [
    'Before the script is written',
    'how long, who is watching, what tone, the one line you want remembered',
    'Script finished',
    'one numbered sentence per line',
    'Before any audio is made',
    'no matching clip',
    'Before rendering',
    'the narration with no picture',
  ]) {
    assert.ok(doc.includes(words), `the file carries "${words}"`);
  }
  assert.ok(doc.includes('Nothing moves past a stop without a clear yes'),
    'and the one line that says the stop is a stop');
});

await test('F-14: the checklist the agent can re-read is present, one line per stop', async () => {
  assert.ok(doc !== null, 'the file is not there');
  assert.ok(doc.includes('The stop checklist'), 'the checklist has a heading to find');
  // The checklist is the section under its own heading, and each item may wrap onto more
  // lines. Read the whole item, not just the line the box starts on.
  const lines = doc.split('\n');
  const section = lines.slice(lines.findIndex((l) => l.includes('The stop checklist')) + 1).join('\n').split(/^## /m)[0];
  const items = section.split(/^\s*- \[ \] /m).slice(1);
  assert.equal(items.length, 4, 'four boxes, one per stop, nothing merged');
  for (const item of items) {
    assert.ok(/\*\*Stop [1-4]/.test(item), 'each box names the stop it is for');
    assert.ok(/ask/i.test(item), 'each stop tells the agent to print the state and ask');
  }
});

await test('F-14: the file says to pass --approved only after yes, and names the failure', async () => {
  assert.ok(doc !== null, 'the file is not there');
  assert.ok(doc.includes('Pass `--approved` only after the user said yes'),
    'the flag rule is stated once, plainly');
  for (const name of ['E_SEGMENT_NOT_APPROVED', 'E_CONCAT_NOT_APPROVED']) {
    assert.ok(doc.includes(name), `the file names ${name} so the agent knows it rendered too early`);
  }
});

await test('NEW-2: the stage products are named, so a stage with no file has somewhere to stop', async () => {
  assert.ok(doc !== null, 'the file is not there');
  for (const product of ['script.txt', 'shots.json', 'preview.wav', 'subs.ass']) {
    assert.ok(doc.includes(product), `the file names ${product}`);
  }
  assert.ok(doc.includes('There is no flow-state file'),
    'and says the files are the state, not a memory');
});

await test('A-7 / the copyright reminder sits at stop 3, not at the end', async () => {
  assert.ok(doc !== null, 'the file is not there');
  const at3 = doc.indexOf('Stop 3 — before any audio is made');
  const said = doc.indexOf('did not check whether they may be used');
  assert.ok(at3 >= 0 && said > at3, 'the reminder is in stop 3\'s own step');
  const at4 = doc.indexOf('**Stop 4.**', at3);
  assert.ok(said < at4, 'and it is stop 3\'s, not a line at the bottom');
});

await test('The commands the skill tells the agent to run are real files', async () => {
  assert.ok(doc !== null, 'the file is not there');
  const names = [...new Set(doc.split('\n')
    .flatMap((line) => [...line.matchAll(/node (bin\/[a-z-]+\.mjs)/g)].map((m) => m[1])))];
  assert.ok(names.length >= 7, 'the flow names every work script');
  for (const name of names) {
    assert.ok((await text(name)) !== null, `${name} is a file the agent can really run`);
  }
});

await test('The plugin is packaged so the skill loads: the manifest points at ./skills', async () => {
  assert.ok(manifest !== null, 'the file is not there');
  const j = JSON.parse(manifest);
  assert.equal(j.name, 'narrate', 'the plugin is named narrate');
  assert.equal(j.skills, './skills', 'and the skills folder is the one this repo has');
  assert.ok((await text(DOC)) !== null, 'that folder holds the skill');
  assert.ok(market !== null, 'the marketplace file is not there');
  const m = JSON.parse(market);
  assert.equal(m.name, 'claude-narrate', 'the marketplace is named claude-narrate');
  assert.ok(m.plugins.some((p) => p.name === 'narrate' && p.source === './'),
    'and it points at this folder, so the install line matches SPEC');
});

await test('The honest note is in the file: these are instructions, not a wall', async () => {
  assert.ok(doc !== null, 'the file is not there');
  assert.ok(doc.includes('instructions, not a wall'), 'the file says what the stops are');
  assert.ok(!/the (skill|plugin) refuses/i.test(doc),
    'and does not word a stop as something that refuses, which would sound stronger than it is');
});
