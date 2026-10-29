// The fixtures the QA runner builds, kept as a recipe rather than as files.
//
// Why a recipe: a fixture has to be a real clip, made by the same ffmpeg the product uses,
// before any check means anything. A checked-in .mp4 would be a binary blob nobody can read,
// and it would go stale against the shape the contract names. This file says, in words, what
// each fixture is for, so a reader can tell a check from a fixture.
//
// Nothing here writes inside the repository. The runner hands this a fresh temp folder.
import { run } from '../../lib/run.mjs';
import { mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';

// A clip in the shape the contract says every part will have: 30 fps, 44100 Hz, 2 channels.
// The picture is one flat colour on purpose: it makes the subtitle pixel check possible,
// because every pixel that is not that colour came from the burned-in text.
async function clip(dir, name, seconds, size = '1920x1080') {
  const r = await run(['ffmpeg', '-y', '-f', 'lavfi',
    '-i', `color=0x0a0a0a:size=${size}:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=300:duration=${seconds}`,
    '-map', '0:v', '-map', '1:a', '-c:v', 'h264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2', join(dir, name)]);
  if (!r.ok || r.code !== 0) throw new Error(`ffmpeg could not make ${name}: ${r.stderr}`);
}

// The sidecar text file the index step reads. The name is the WHOLE clip file name plus
// .narrate.txt, because that is the rule bin/index.mjs uses (`${clipPath}.narrate.txt`).
async function sidecar(dir, name, text) {
  await writeFile(join(dir, `${name}.narrate.txt`), text);
}

async function write(dir, name, text) {
  await writeFile(join(dir, name), text);
}

// ------------------------------------------------------------------ the main flow
// Three landscape clips, one of them too short on purpose. The short clip is what makes
// A-24 show up inside the main flow: a clip that cannot cover the sentence from its start
// is not a candidate, so the sentence that needs 6 seconds must not pick the 2 second clip.
const MAIN_CLIPS = [
  ['sky', 'clouds-wide.mp4', 30, '1920x1080',
    'time lapse of clouds moving across a bright sky\n' +
    '#clouds;sky;bright;moving;time;lapse;Royalty Free;Fair Use;Stock Footage\n'],
  ['harbour', 'gulls-dusk.mp4', 30, '1920x1080',
    'empty harbour at dusk with gulls on the water\n' +
    '#harbour;dusk;gulls;water;quay;Royalty Free;Fair Use;Stock Footage\n'],
  ['short', 'blink.mp4', 2, '1920x1080',
    'one short blink of a bright sky\n#sky;blink;short\n'],
];

// What the frames step would have said, in the shape describe writes. Stands in for a real
// call: this machine has no image encoder to read a frame with, so the words come in through
// --said and the report says so. Everything that READS them is the real step.
const MAIN_SAID = {
  'clouds-wide.mp4': [{ startSec: 0, endSec: 30, confidence: 0.9,
    description: 'Clouds move across a bright sky in a time lapse.',
    tags: ['clouds', 'sky', 'bright', 'moving'] }],
  'gulls-dusk.mp4': [{ startSec: 0, endSec: 30, confidence: 0.9,
    description: 'Gulls turn over the water at dusk near an empty harbour.',
    tags: ['harbour', 'dusk', 'gulls', 'water'] }],
  'blink.mp4': [{ startSec: 0, endSec: 2, confidence: 0.9,
    description: 'A bright sky for one short blink.',
    tags: ['sky', 'blink'] }],
};

// ------------------------------------------------------------------ the long join
// A-16 asks for a join of 60+ parts. Three clips are enough: the renderer may reuse a clip,
// and the demote rule only lowers a score, it never removes a candidate.
const LONG_CLIPS = [
  ['a', 'wide-a.mp4', 30], ['b', 'wide-b.mp4', 30], ['c', 'wide-c.mp4', 30],
];

export async function makeFixtures(root) {
  const paths = {};

  // ---- the main flow: landscape, English, the whole chain runs over it
  const assets = join(root, 'assets');
  await mkdir(assets, { recursive: true });
  for (const [folder, name, seconds, size, text] of MAIN_CLIPS) {
    await mkdir(join(assets, folder), { recursive: true });
    await clip(join(assets, folder), name, seconds, size);
    await sidecar(join(assets, folder), name, text);
  }
  paths.assets = assets;

  // ---- portrait: A-17 wants 1080x1920 and a subtitle that stays inside the sides
  const pt = join(root, 'assets-portrait');
  await mkdir(join(pt, 'vertical'), { recursive: true });
  await clip(join(pt, 'vertical'), 'river-tall.mp4', 20, '1080x1920');
  await sidecar(join(pt, 'vertical'), 'river-tall.mp4',
    'a tall river falling through a narrow canyon\n#river;tall;canyon;water\n');
  paths.portrait = pt;

  // ---- the long join: A-16
  const long = join(root, 'assets-long');
  await mkdir(long, { recursive: true });
  for (const [folder, name, seconds] of LONG_CLIPS) {
    await mkdir(join(long, folder), { recursive: true });
    await clip(join(long, folder), name, seconds);
    await sidecar(join(long, folder), name,
      `wide clip ${folder} with clouds and water and a bright sky\n` +
      `#clouds;sky;bright;water;${folder}\n`);
  }
  paths.long = long;

  // ---- the stem collision: A-19. Its own folder, because the scan stops and would stop
  // every other check that ran over the same folder.
  const collide = join(root, 'assets-collide');
  await mkdir(collide, { recursive: true });
  await clip(collide, 'a.mp4', 4);
  await clip(collide, 'a.mov', 4);
  paths.collide = collide;

  // ---- the index sources: A-21 (one clip, three ways in), A-22 (two sources disagree),
  // A-20 (a .json that is not ours, sitting in the assets folder).
  const idx = join(root, 'assets-index');
  await mkdir(join(idx, 'quay'), { recursive: true });
  await clip(join(idx, 'quay'), 'harbour-dusk-timelapse.mp4', 7);
  await sidecar(join(idx, 'quay'), 'harbour-dusk-timelapse.mp4',
    'empty harbour at dusk with gulls\n#harbour\n#gulls\nshot on a phone, no people\n');
  // The csv keys the clip by its file name alone, the way bin/index.mjs looks it up.
  await write(idx, 'clips.csv',
    'file,description,tags\nharbour-dusk-timelapse.mp4,a bench in the park,"harbour;dusk;bench;wood"\n');
  // Not ours: no clip of that name exists, and the shape is not a narrate record.
  await write(idx, 'b.json', '{"note":"a file that is not ours","schema":"someone-else/1"}\n');
  paths.index = idx;

  // ---- the visual layer that went missing: A-25. One clip, frames pulled, folder removed.
  const vis = join(root, 'assets-visual');
  await mkdir(join(vis, 'one'), { recursive: true });
  await clip(join(vis, 'one'), 'one-clip.mp4', 6);
  await sidecar(join(vis, 'one'), 'one-clip.mp4',
    'a bright sky over water with clouds\n#sky;water;clouds\n');
  paths.visual = vis;

  // ---- one clip only, and it is short: A-24 on its own, so the too-short answer is the
  // whole story rather than one row among many.
  const short = join(root, 'assets-short');
  await mkdir(join(short, 'one'), { recursive: true });
  await clip(join(short, 'one'), 'blink.mp4', 2);
  await sidecar(join(short, 'one'), 'blink.mp4', 'a bright sky for one short blink\n#sky;blink\n');
  paths.short = short;

  return paths;
}

export const MAIN_SAID_PATHS = MAIN_SAID;
export const MAIN_CLIPS_TABLE = MAIN_CLIPS;
export const LONG_CLIPS_TABLE = LONG_CLIPS;
