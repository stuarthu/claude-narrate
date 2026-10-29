// T-09 — the concat step: the parts become one file, and the join is believed only after it
// is measured.
//
// This runs after the approval, like segment does (NEW-1): a run with no --approved flag
// fails, it does not warn. The parts are already on disk when this step is asked to run.
//
// The join discipline is the same one the preview step holds (section 11): probe every part,
// stream-copy only when every part shares one shape, write the part list to a file (never a
// shell string), write to a temp name, then check the result by duration AND a full decode
// pass. A concat that exits 0 is not believed on its exit code (F-12) — measured, a stream-copy
// of parts whose codec, size or frame rate differ gave a file ffmpeg was happy with, whose
// duration was off and which decoded to "no frame!" after the join.
import {
  RESULT_SCHEMA, resultOk, resultError, parseScript,
  SHAPE_PROBE, PART_SHAPE, concatTolerance,
} from '../lib/contract.mjs';
// One owner for the part names and the shape probe: segment wrote these files, and concat
// asks the same question about them through the same functions (F-13).
import { partPathOf, shapeOf, durationOf } from '../bin/segment.mjs';
import { writeText, ensureDir } from '../lib/json.mjs';
import { run } from '../lib/run.mjs';
import { readFile, stat, rename, unlink, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

const FLAGS = { '--work': 1, '--root': 1, '--out': 1 };

function parseArgv(argv) {
  const opts = { approved: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    // --approved is the only flag with no value: it is the yes at stop 4, and its presence
    // is the whole check (F-14).
    if (flag === '--approved') {
      opts.approved = true;
      continue;
    }
    if (!FLAGS[flag]) return { ok: false, message: `unknown or missing argument: ${flag}` };
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) return { ok: false, message: `${flag} needs a value` };
    opts[flag.slice(2)] = value;
    i++;
  }
  return { ok: true, opts };
}

// ffmpeg's concat list quotes each path with '...'. A path holding a quote would end that
// quote and start a new one, so the quote is escaped the way a shell would escape it.
function listLine(path) {
  return `file '${path.replaceAll("'", `'\\''`)}'\n`;
}

// The part list is named after the file it joins, so a report can point at the parts that
// made a video. Unlike preview, this one is kept: preview.wav is a listen file that is
// thrown away, while this list is the record of what the finished video is made of.
export function concatListPathOf(out) {
  return `${out}.concat.txt`;
}

// The one shape every part must share, written from the contract's numbers. segment encodes
// parts to this shape; a part that came from anywhere else is put into it before the join.
const ENCODE = ['-r', String(PART_SHAPE.fps), '-c:v', PART_SHAPE.videoCodec,
  '-profile:v', PART_SHAPE.videoProfile, '-level', PART_SHAPE.videoLevel,
  '-pix_fmt', PART_SHAPE.pixFmt, '-c:a', PART_SHAPE.audioCodec,
  '-ar', String(PART_SHAPE.sampleRate), '-ac', String(PART_SHAPE.channels)];

export async function joinParts(opts = {}) {
  const root = opts.root ?? process.cwd();
  const work = opts.work;

  // The argument check comes before any path is built: a call with no work name must answer
  // with a stop, not with a crash on a path built from undefined.
  if (!work) {
    return resultError('concat', 'E_CONCAT_ARGS',
      'usage: node bin/concat.mjs --work <name> --approved [--root <dir>] --out <file>',
      { work });
  }

  // NEW-1: a render attempt with no approval fails. It does not warn and carry on.
  if (!opts.approved) {
    return resultError('concat', 'E_CONCAT_NOT_APPROVED',
      `no --approved: stop 4 never said yes, so nothing renders. The parts are already on disk; `
      + `say yes at stop 4 and run this again.`, { work });
  }

  const out = opts.out ?? join(root, 'out', `${work}.mp4`);
  const dir = join(root, '.narrate', work);
  const segmentsDir = join(dir, 'segments');
  const scriptPath = join(dir, 'script.txt');
  const listPath = concatListPathOf(out);

  // Stop rule (NEW-2): this step reads stop 2's product to know which sentences the video
  // must hold. No script means stop 2 never ran, so it stops and says so. It never joins
  // "whatever is in the folder" — a part for a sentence that is not in the script would be
  // silently added to the video.
  let scriptText;
  try {
    scriptText = await readFile(scriptPath, 'utf8');
  } catch {
    return resultError('concat', 'E_CONCAT_SCRIPT_MISSING',
      `no script here: ${scriptPath} is not there, so stop 2 never ran. `
      + `Nothing was joined and nothing was invented.`, { work, scriptPath });
  }

  const rows = parseScript(scriptText);
  if (!rows.length) {
    return resultError('concat', 'E_CONCAT_SCRIPT_MISSING',
      `${scriptPath} is there but holds no numbered sentence, so there is nothing to join.`,
      { work, scriptPath });
  }

  // The ids come from the script and the file names come from segment, so the two cannot
  // disagree about where a part lives.
  const ids = rows.map((r) => r.id);
  const files = ids.map((id) => partPathOf(work, id, root));

  // Probe every part before anything is joined: the shape (what a copy would do to it) and
  // the length (what the joined file must add up to).
  const parts = [];
  const missing = [];
  for (let i = 0; i < ids.length; i++) {
    const path = files[i];
    let size = -1;
    try { size = (await stat(path)).size; } catch { void 0; }
    if (size <= 0) { missing.push(ids[i]); continue; }

    const shape = await shapeOf(path);
    if (!shape) {
      return resultError('concat', 'E_CONCAT_PART_UNREADABLE',
        `${ids[i]} is on disk (${size} bytes) but ffprobe cannot read it as media: ${path}. `
        + `The part is broken, so nothing was joined.`,
        { work, ids, files, id: ids[i], path, segmentsDir, parts: parts.length });
    }
    const durationSec = await durationOf(path);
    if (!(durationSec > 0)) {
      return resultError('concat', 'E_CONCAT_PART_UNREADABLE',
        `${ids[i]} is on disk (${size} bytes) but has no length we can measure (${durationSec} s) `
        + `at ${path}; nothing was joined.`,
        { work, ids, files, id: ids[i], path, segmentsDir, parts: parts.length });
    }
    parts.push({ id: ids[i], path, shape, durationSec, bytes: size });
  }

  // NEW-2 again, one level down: no parts at all means the step before never ran.
  if (!parts.length) {
    return resultError('concat', 'E_NOTHING_TO_CONCAT',
      `no parts to join: ${segmentsDir} holds none, so the segment step never ran. `
      + `Nothing was joined and nothing was invented.`,
      { work, ids, files, segmentsDir, parts: 0 });
  }
  if (missing.length) {
    return resultError('concat', 'E_SEGMENT_MISSING',
      `${missing.length} of ${ids.length} planned sentence(s) have no part — first: ${missing[0]} `
      + `(${partPathOf(work, missing[0], root)}). The segment step never ran for it, so nothing `
      + `was joined: a video with a sentence missing from the middle would be a lie.`,
      { work, ids, files, missing, segmentsDir, parts: parts.length });
  }

  // A stream-copy is only honest when every part shares one shape, on every field ffprobe
  // is asked for. Measured on this host: a 1920x1080/30 fps/44100 Hz/2-channel part copied
  // next to a 640x360/15 fps/22050 Hz/1-channel part gave a file ffmpeg exited 0 on, 3.96 s
  // long (inside the tolerance) whose decode printed aac and NAL errors.
  const first = parts[0];
  const sameShape = parts.every((p) => SHAPE_PROBE.every((f) => String(p.shape[f]) === String(first.shape[f])));

  const expectedSec = parts.reduce((sum, p) => sum + p.durationSec, 0);
  const toleranceSec = concatTolerance(expectedSec);

  // Mismatched parts are put into the one shape first, one re-encode per part, and then the
  // join itself is a stream-copy. Measured: re-encoding inside one concat of mismatched
  // parts loses data, while normalising first and copying after keeps every frame. The
  // normalised parts are ours, and are deleted once the join is checked.
  const normDir = join(dir, 'concat-parts');
  const copy = sameShape;
  let joinFiles = parts.map((p) => p.path);
  const normalized = [];
  if (!sameShape) {
    await mkdir(normDir, { recursive: true });
    joinFiles = [];
    for (const p of parts) {
      const norm = join(normDir, `${p.id}.mp4`);
      const made = await run(['ffmpeg', '-y', '-i', p.path, ...ENCODE, norm]);
      if (!made.ok) {
        for (const q of normalized) { try { await unlink(q); } catch { void 0; } }
        return resultError('concat', 'E_CONCAT_WRITE_FAILED',
          `cannot put ${p.id} into the join's shape (exit ${made.code}): ${p.path} -> ${norm}`,
          { work, ids, files, normDir, copy: false, parts: parts.length, expectedSec });
      }
      joinFiles.push(norm);
      normalized.push(norm);
    }
  }

  // The out folder is made before the list is written, so a first run into an empty place
  // works the same as a re-run.
  const made = await ensureDir(join(root, 'out'));
  if (!made.ok) {
    return resultError('concat', 'E_CONCAT_WRITE_FAILED',
      `cannot write into the out folder: ${join(root, 'out')} (${made.errno ?? ''})`,
      { work, ids, files, out, parts: parts.length, expectedSec });
  }

  // The part list goes to a file, written atomically with fsync, so ffmpeg cannot read a
  // half-written list. Absolute paths: the concat demuxer reads a relative path against the
  // list file's own folder, so a relative list silently points at a folder that does not
  // exist.
  const list = joinFiles.map((p) => listLine(p.startsWith('/') ? p : join(root, p))).join('');
  const wrote = await writeText(listPath, list);
  if (!wrote.ok) {
    return resultError('concat', 'E_CONCAT_WRITE_FAILED',
      `cannot write the part list: ${listPath} (${wrote.errno ?? ''})`,
      { work, ids, files, listPath, parts: parts.length, expectedSec });
  }

  // Write to a temp name first: a broken join never leaves a file named after the video.
  const tmpPath = `${out}.tmp.mp4`;
  const joined = await run(['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy', '-movflags', '+faststart', tmpPath]);
  if (!joined.ok) {
    return resultError('concat', 'E_CONCAT_WRITE_FAILED',
      `ffmpeg could not join the parts (exit ${joined.code}): ${listPath} -> ${tmpPath}`,
      { work, ids, files, listPath, tmpPath, copy, parts: parts.length, expectedSec });
  }

  let tmpSize = -1;
  try { tmpSize = (await stat(tmpPath)).size; } catch { void 0; }
  if (tmpSize <= 0) {
    return resultError('concat', 'E_CONCAT_WRITE_FAILED',
      `the join wrote nothing (${tmpSize} bytes) to ${tmpPath}.`,
      { work, ids, files, listPath, tmpPath, copy, parts: parts.length, expectedSec });
  }

  // Two checks, not one: the length, then a full decode pass. An ffmpeg that exits 0 can
  // still be short or still be broken, so both have to agree before anything is kept.
  const after = await run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', tmpPath]);
  const gotSec = after.ok ? Number(after.stdout.trim()) : NaN;
  const drift = Math.abs(gotSec - expectedSec);
  const decode = await run(['ffmpeg', '-v', 'error', '-i', tmpPath, '-f', 'null', '-']);
  const decodeClean = decode.ok && decode.stderr === '';

  if (!(gotSec > 0) || drift > toleranceSec) {
    try { await unlink(tmpPath); } catch { void 0; }
    return resultError('concat', 'E_CONCAT_MISMATCH',
      `the join is ${gotSec} s but the parts sum to ${expectedSec} s (drift ${drift.toFixed(3)} s, `
      + `tolerance ${toleranceSec} s) at ${tmpPath}; nothing was kept.`,
      { work, ids, files, listPath, tmpPath, copy, parts: parts.length, expectedSec, gotSec, drift });
  }
  if (!decodeClean) {
    try { await unlink(tmpPath); } catch { void 0; }
    return resultError('concat', 'E_CONCAT_MISMATCH',
      `the join decodes with errors (${decode.stderr.slice(0, 200).trim()}) at ${tmpPath}; `
      + `the full decode pass caught it, nothing was kept.`,
      { work, ids, files, listPath, tmpPath, copy, parts: parts.length, expectedSec, gotSec });
  }

  // A checked file is moved into place with one rename. A failed rename leaves the temp
  // name there, so the answer is still missing rather than half-there.
  let moved = { errno: null };
  try { await rename(tmpPath, out); moved.ok = true; } catch (e) { moved = { ok: false, errno: e.code }; }
  if (!moved.ok) {
    return resultError('concat', 'E_CONCAT_WRITE_FAILED',
      `cannot move the checked join into place: ${tmpPath} -> ${out} (${moved.errno ?? ''})`,
      { work, ids, files, listPath, tmpPath, out, copy, parts: parts.length, expectedSec });
  }
  for (const p of normalized) {
    try { await unlink(p); } catch { void 0; } // ours, and the join is checked: they are dust
  }

  return resultOk('concat', {
    work, ids, files, out, listPath,
    parts: parts.length, copy,
    expectedSec, gotSec, drift, toleranceSec,
    frames: parts.map((p) => `${p.shape.width}x${p.shape.height}`).join(','),
  });
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2));
  if (!parsed.ok) {
    process.stdout.write(JSON.stringify(
      resultError('concat', 'E_CONCAT_ARGS', parsed.message, {})) + '\n');
    process.exit(1);
  }
  const r = await joinParts(parsed.opts);
  process.stdout.write(JSON.stringify(r) + '\n');
  process.exit(r.ok ? 0 : 1);
}

if (await realpath(process.argv[1]) === await realpath(SELF)) await main();
