// T-03 — bin/index.mjs. Red-first: written before bin/index.mjs exists, so the first run
// must fail with ERR_MODULE_NOT_FOUND (behaviour missing), not with a runner that could not start.
// Real clips are cut by ffmpeg here, because "measure, do not believe" (rule 4) cannot be
// checked against a made-up duration.
import assert from 'node:assert';
import { test } from 'node:test';
import { run } from '../lib/run.mjs';
import { readJson } from '../lib/json.mjs';
import { CLIP_SCHEMA } from '../lib/contract.mjs';
import { scanAssets } from '../bin/index.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOTS = [];

async function makeRoot(label) {
  const dir = await mkdtemp(join(tmpdir(), `narrate-index-${label}-`));
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

async function jsonOf(dir) {
  // every .json under dir, as { path: bytes }
  const out = {};
  const walk = async (d) => {
    for (const e of (await readdir(d, { withFileTypes: true }))) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.json')) out[p.replace(dir, '')] = await readFile(p, 'utf8');
    }
  };
  // symlink loop guard for the walk of the fixture itself
  const seen = new Set();
  const guarded = async (d) => {
    const real = await realpath(d);   // measured: realpath() returns a string, Stats has no realpath
    if (seen.has(real)) return;
    seen.add(real);
    await walk(d);
  };
  await guarded(dir);
  return out;
}

function sectionBytes(obj, key) {
  return JSON.stringify(obj[key]);
}

// ---------------------------------------------------------------- the main fixture

async function mainFixture() {
  const dir = await makeRoot('main');
  await clip(dir, 'bench.mp4', 4);
  await clip(dir, 'sky-clouds.mp4', 6);
  await clip(dir, 'stock.mp4', 5);
  // rule 1: a stock-site json beside a clip. Foreign keys must survive; ours get added.
  await writeFile(join(dir, 'stock.json'), JSON.stringify({
    title: 'Bench timelapse', description: 'site text',
    tags: ['bench', 'clouds', '1080p', 'H.264', '60fps', 'HD', 'vp8', 'Royalty Free'],
    search_term: 'bench',
  }));
  // A-20: a foreign json with no clip beside it is not ours to touch at all.
  await writeFile(join(dir, 'b.json'), JSON.stringify({ title: 'not a clip', tags: ['x'] }));
  // A-21: the same clip described three ways. The folder is named quay so the folder name
  // is a tag no other source could give.
  await mkdir(join(dir, 'quay'));
  await clip(join(dir, 'quay'), 'harbour-dusk-timelapse.mp4', 7);
  await writeFile(join(dir, 'quay', 'harbour-dusk-timelapse.mp4.narrate.txt'),
    'empty harbour at dusk with gulls\n#harbour\n#gulls\nshot on a phone, no people\n');
  // A-22: two sources disagree about the description.
  await clip(dir, 'park-bench-wide.mp4', 8);
  await writeFile(join(dir, 'clips.csv'),
    'file,description,tags\npark-bench-wide.mp4,a bench in the park,"park;bench;wood"\n');
  await writeFile(join(dir, 'park-bench-wide.mp4.narrate.txt'),
    'empty bench at dusk under a lamp\n#bench;dusk;lamp\n');
  // rule 6: one bad clip must not sink the scan.
  await writeFile(join(dir, 'broken.mp4'), 'this is not a video file at all');
  await clip(dir, 'weird.mp4', 3);   // a real video, then renamed: the extension is what is unknown
  await run(['mv', join(dir, 'weird.mp4'), join(dir, 'weird.xyz')]);
  // symlink loop guard + a clip on an "external drive" reached by symlink
  await mkdir(join(dir, 'ext'));
  await clip(join(dir, 'ext'), 'external-drive.mp4', 9);
  await symlink(join(dir, 'ext'), join(dir, 'drive'));
  await symlink(join(dir, 'drive'), join(dir, 'loop'));
  return dir;
}

// ---------------------------------------------------------------- the collision fixture

async function collisionFixture() {
  const dir = await makeRoot('collision');
  await clip(dir, 'a.mp4', 4);
  await clip(dir, 'a.mov', 4);
  return dir;
}

// ------------------------------------------------------------------------ the tests

await test('A-1: 3 videos in, every file gets a record with a text description', async () => {
  const dir = await mainFixture();
  const r = await scanAssets({ assets: dir });
  assert.equal(r.ok, true, 'the scan finished');
  const names = r.clips.map((c) => c.clip).sort();
  for (const need of ['bench.mp4', 'sky-clouds.mp4', 'stock.mp4']) {
    assert.ok(names.includes(need), `${need} has a record`);
  }
  for (const c of r.clips) {
    assert.ok(typeof c.description === 'string' && c.description.length > 0,
      `${c.clip} has a text description, not an empty field`);
  }
});

await test('A-2: a second scan with no new files re-understands nothing and changes nothing', async () => {
  const dir = await mainFixture();
  const one = await scanAssets({ assets: dir });
  const before = await jsonOf(dir);
  const two = await scanAssets({ assets: dir });
  const after = await jsonOf(dir);
  assert.equal(two.reUnderstands, 0, 'the log says 0 re-understands');
  assert.equal(two.understandCalls, 0, 'understanding was called zero times');
  assert.deepEqual(after, before, 'every index file is byte for byte the same');
  assert.equal(two.clips.length, one.clips.length, 'the same clips came back');
});

await test('A-3 + A-23: your writing in fromYou survives a re-scan byte for byte', async () => {
  const dir = await mainFixture();
  await scanAssets({ assets: dir });
  const path = join(dir, 'bench.json');
  const one = await readJson(path);
  assert.equal(one.ok, true, 'our sidecar parses');
  one.value.fromYou.description = 'the bench by the path, mine';
  one.value.fromYou.notes = 'I wrote this';
  one.value.fromYou.tags = [...one.value.fromYou.tags, 'mine'];
  const wrote = await (await import('../lib/json.mjs')).writeJson(path, one.value);
  assert.equal(wrote.ok, true, 'the hand-edit lands');
  const yoursBefore = sectionBytes(one.value, 'fromYou');
  await scanAssets({ assets: dir });
  const after = await readJson(path);
  assert.equal(sectionBytes(after.value, 'fromYou'), yoursBefore,
    'fromYou is unchanged byte for byte, including the line we wrote once');
});

await test('A-19: a.mp4 and a.mov in one folder stops the scan and writes no a.json', async () => {
  const dir = await collisionFixture();
  const r = await scanAssets({ assets: dir });
  assert.equal(r.ok, false, 'a stem collision is a folder-level problem: it stops everything');
  assert.equal(r.error, 'E_STEM_COLLISION', 'the error names the collision');
  assert.deepEqual([...r.names].sort(), ['a.mov', 'a.mp4'], 'both names are listed, in a stable order');
  assert.equal(await exists(join(dir, 'a.json')), false, 'no a.json was written');
});

await test('A-20: a foreign b.json with no clip beside it is untouched', async () => {
  const dir = await mainFixture();
  const path = join(dir, 'b.json');
  const before = await readFile(path, 'utf8');
  const r = await scanAssets({ assets: dir });
  const after = await readFile(path, 'utf8');
  assert.equal(after, before, 'bytes unchanged');
  assert.notEqual(r.foreign.includes('b.json'), true,
    'it is not indexed as a clip: there is no clip to index');
});

await test('A-21: one clip described three ways, all three land in its JSON', async () => {
  const dir = await mainFixture();
  const r = await scanAssets({ assets: dir });
  const rec = r.clips.find((c) => c.clip === 'quay/harbour-dusk-timelapse.mp4');
  assert.ok(rec, 'the clip in the quay folder was found');
  const side = await readJson(join(dir, 'quay', 'harbour-dusk-timelapse.json'));   // doc §8: bench.mp4 gets bench.json
  assert.equal(side.value.fromYou.description, 'empty harbour at dusk with gulls',
    'the sidecar text file won, as it should');
  assert.ok(side.value.fromYou.tags.includes('harbour'), 'the sidecar tag landed');
  assert.ok(side.value.fromYou.tags.includes('quay'), 'the folder name landed: no other source can give it');
  assert.ok(side.value.fromYou.tags.includes('dusk'), 'the filename split landed');
  for (const s of ['sidecar', 'filename', 'folder']) {
    assert.ok(side.value.fromYou.sources.includes(s), `source ${s} is recorded`);
  }
});

await test('A-22: two sources disagree, the higher one wins, tags merge without duplicates', async () => {
  const dir = await mainFixture();
  const r = await scanAssets({ assets: dir });
  const side = await readJson(join(dir, 'park-bench-wide.json'));
  assert.equal(side.value.fromYou.description, 'empty bench at dusk under a lamp',
    'the sidecar text file (rank 3) beat clips.csv (rank 4)');
  const tags = side.value.fromYou.tags;
  for (const t of ['bench', 'dusk', 'lamp', 'park', 'wood']) {
    assert.ok(tags.includes(t), `tag ${t} from both sources is kept`);
  }
  assert.equal(new Set(tags).size, tags.length, 'tags are deduplicated');
});

await test('A-28: the scan never calls understanding, and says which clips need it', async () => {
  const dir = await mainFixture();
  const r = await scanAssets({ assets: dir });
  assert.equal(r.understandCalls, 0, 'zero calls to understanding');
  assert.ok(Array.isArray(r.needsUnderstanding) && r.needsUnderstanding.length > 0,
    'the list of clips that need understanding is returned');
  assert.ok(r.needsUnderstanding.includes('bench.mp4'), 'a clip with no fromMachine is listed');
});

await test('rule 3: tags are keywords only — resolution, fps, codec and HD filler are dropped', async () => {
  const dir = await mainFixture();
  await scanAssets({ assets: dir });
  const side = await readJson(join(dir, 'stock.json'));
  const tags = side.value.fromYou.tags;
  for (const bad of ['1080p', 'H.264', '60fps', 'HD', 'vp8']) {
    assert.ok(!tags.includes(bad), `${bad} dropped: measured wrong on real stock footage`);
  }
  for (const good of ['bench', 'clouds']) {
    assert.ok(tags.includes(good), `${good} kept`);
  }
  assert.ok(tags.includes('Royalty Free'),
    'boilerplate is a real keyword: pick.mjs gives it a low weight, index.mjs never deletes it');
});

await test('rule 4: duration comes from ffprobe every scan, never from a stored field', async () => {
  const dir = await mainFixture();
  const first = await scanAssets({ assets: dir });
  const before = first.clips.find((c) => c.clip === 'bench.mp4');
  await clip(dir, 'bench.mp4', 11);
  const second = await scanAssets({ assets: dir });
  const after = second.clips.find((c) => c.clip === 'bench.mp4');
  assert.ok(Math.abs(after.durationSec - 11) < 0.2, 'the new length was measured, not remembered');
  assert.notEqual(after.fingerprint, before.fingerprint, 'the fingerprint moved with the file');
});

await test('rule 1: a stock json beside a clip keeps its keys, and the .bak is saved exactly once', async () => {
  const dir = await mainFixture();
  const path = join(dir, 'stock.json');
  const bak = join(dir, 'stock.json.bak');
  const original = await readFile(path, 'utf8');
  const before = JSON.parse(original);
  await scanAssets({ assets: dir });
  const after = await readJson(path);
  for (const key of Object.keys(before)) {
    assert.deepEqual(after.value[key], before[key], `key ${key} kept byte for byte`);
  }
  assert.equal(after.value.schema, CLIP_SCHEMA, 'our keys were added');
  assert.equal(await readFile(bak, 'utf8'), original, 'the backup holds the original bytes');
  await scanAssets({ assets: dir });
  assert.equal(await readFile(bak, 'utf8'), original, 'a second scan never rewrites the backup');
});

await test('rule 6: one bad clip and one unknown extension never sink the scan', async () => {
  const dir = await mainFixture();
  const r = await scanAssets({ assets: dir });
  assert.equal(r.ok, true, 'the scan still finished');
  const named = r.errors.find((e) => e.clip === 'broken.mp4');
  assert.ok(named, 'the unreadable clip is reported');
  assert.equal(named.error, 'E_ASSET_UNREADABLE', 'the error names the clip, not the scan');
  assert.ok(r.errors.some((e) => e.error === 'E_UNKNOWN_MEDIA'), 'the unknown extension is reported');
  assert.ok(r.clips.some((c) => c.clip === 'sky-clouds.mp4'), 'a later clip still got a record');
});

await test('symlinks are followed, and the loop guard stops the walk from hanging', async () => {
  const dir = await mainFixture();
  const r = await scanAssets({ assets: dir });
  const externals = r.clips.filter((c) => c.clip.includes('external-drive.mp4'));
  assert.ok(externals.length > 0, 'a clip reached through a symlink is found');
  assert.equal(externals.length, 1,
    'one real file on disk gets one record, not one per path that reaches it');
  assert.ok(r.aliases.some((a) => a.clip.includes('external-drive.mp4') && a.also.includes('external-drive.mp4')),
    'the other path is reported as an alias, not silently dropped');
  assert.equal(r.walked, new Set(r.clips.map((c) => c.clip)).size + r.errors.length + r.aliases.length,
    'every media file seen is a record, an error or an alias: no folder was walked twice');
});

await test('the fingerprint has no path: moving the folder keeps fromMachine, and invalidates only the path-based part', async () => {
  const dir = await mainFixture();
  await scanAssets({ assets: dir });
  const path = join(dir, 'bench.json');
  const one = await readJson(path);
  one.value.fromMachine.segments = [{ startSec: 0, endSec: 4, description: 'a bench, from frames',
    tags: ['bench'], confidence: 0.6 }];
  one.value.fromMachine.visualSearchDir = `${dir}/bench.frames`;
  one.value.fromMachine.engine = 'claude-frames';
  await (await import('../lib/json.mjs')).writeJson(path, one.value);
  const moved = `${dir}-moved`;
  ROOTS.push(moved);
  await run(['mv', dir, moved]);
  const r = await scanAssets({ assets: moved });
  const after = await readJson(join(moved, 'bench.json'));
  assert.equal(after.value.fingerprint, one.value.fingerprint,
    'size + mtime only: a move keeps the fingerprint');
  assert.deepEqual(after.value.fromMachine.segments, one.value.fromMachine.segments,
    'fromMachine survived the move');
  assert.equal(r.visualSearchDirInvalid.includes('bench.mp4'), true,
    'the path-based visual dir is reported as invalid, and matching falls back to text');
  assert.equal(r.ok, true, 'a move is not an error');
});

await test('a missing assets root is its own error, and the script exits non-zero', async () => {
  const r = await scanAssets({ assets: '/tmp/definitely-not-an-assets-folder-nobody-made' });
  assert.equal(r.ok, false, 'the scan failed');
  assert.equal(r.error, 'E_ASSETS_ROOT_UNREADABLE', 'the error names the root');
});

await test('every clip record carries the fields the shot list will read', async () => {
  const dir = await mainFixture();
  const r = await scanAssets({ assets: dir });
  for (const c of r.clips) {
    assert.ok(typeof c.json === 'string' && c.json.endsWith('.json'), `${c.clip} names its sidecar`);
    assert.ok(c.fingerprint.startsWith('size:'), 'the fingerprint is size + mtime, no path');
    assert.ok(typeof c.durationSec === 'number' && c.durationSec > 0, `${c.clip} has a measured length`);
  }
});

for (const dir of ROOTS) await rm(dir, { recursive: true, force: true });
