// T-07 — the preview step: the recordings become one audio-only file you can listen to.
//
// This is stop 4's product, so it runs BEFORE the approval: you cannot say "yes, render it"
// about a voice you have never heard. That is why this step needs no --approved flag, while
// segment and concat do (NEW-1, NEW-2).
//
// The same join discipline as the picture join (section 11): probe every part, stream-copy
// only when every part shares one shape, write the part list to a file (never a shell string),
// write to a temp name, then check the result by duration AND a full decode pass. A join
// that exits 0 is not believed on its exit code (F-12).
import {
  PREVIEW, RESULT_SCHEMA, resultOk, resultError, parseScript,
} from '../lib/contract.mjs';
import { audioPathOf } from '../bin/voice.mjs'; // one owner for the audio names (F-13)
import { writeText } from '../lib/json.mjs';
import { run } from '../lib/run.mjs';
import { readFile, stat, rename, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';

const SELF = fileURLToPath(import.meta.url);

const FLAGS = { '--work': 1, '--root': 1 };

function parseArgv(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
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

export async function joinAudio(opts = {}) {
  const root = opts.root ?? process.cwd();
  const work = opts.work;
  if (!work) {
    return resultError('preview', 'E_PREVIEW_ARGS',
      'usage: node bin/preview.mjs --work <name> [--root <dir>]', { work });
  }

  const dir = join(root, '.narrate', work);
  const audioDir = join(dir, 'audio');
  const scriptPath = join(dir, 'script.txt');
  const out = join(dir, 'preview.wav');

  // Stop rule (NEW-2): this step reads stop 2's product. No script means stop 2 never ran,
  // so it stops and says so. It never invents sentences to join.
  let scriptText;
  try {
    scriptText = await readFile(scriptPath, 'utf8');
  } catch (e) {
    return resultError('preview', 'E_PREVIEW_SCRIPT_MISSING',
      `no script here: ${scriptPath} is not there, so stop 2 never ran. Write the numbered script first.`,
      { work, scriptPath });
  }

  const rows = parseScript(scriptText);
  if (!rows.length) {
    return resultError('preview', 'E_PREVIEW_SCRIPT_MISSING',
      `${scriptPath} is there but holds no numbered sentence.`, { work, scriptPath });
  }

  // The ids come from the script and the file names come from voice, so the two can never
  // disagree about where a recording lives.
  const ids = rows.map((r) => r.id);
  const files = ids.map((id) => audioPathOf(work, id, root));

  // Probe every part before anything is joined. A part that does not decode is named, and
  // a planned sentence with no file at all is named — the run stops, it does not skip.
  const parts = [];
  const missing = [];
  for (let i = 0; i < ids.length; i++) {
    const path = files[i];
    let size = -1;
    try { size = (await stat(path)).size; } catch { void 0; }
    if (size <= 0) { missing.push(ids[i]); continue; }

    const probe = await run(['ffprobe', '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type,codec_name,sample_rate,channels',
      '-of', 'json', path]);
    if (!probe.ok) {
      return resultError('preview', 'E_PREVIEW_BAD_PART',
        `${ids[i]} is on disk (${size} bytes) but ffprobe cannot read it as media: ${path}.`,
        { work, ids, files, id: ids[i], path, parts: parts.length });
    }
    let parsed;
    try { parsed = JSON.parse(probe.stdout); } catch { parsed = null; }
    const streams = parsed?.streams ?? [];
    const audio = streams.length && streams[0].codec_type === 'audio' ? streams[0] : null;
    const durationSec = Number(parsed?.format?.duration ?? NaN);
    if (!audio || !(durationSec > 0)) {
      return resultError('preview', 'E_PREVIEW_BAD_PART',
        `${ids[i]} is on disk but holds no audio we can measure (${audio ? streams[0].codec_name : 'no audio stream'}, ${durationSec} s) at ${path}.`,
        { work, ids, files, id: ids[i], path, parts: parts.length });
    }
    parts.push({ id: ids[i], path, codec: audio.codec_name, sampleRate: Number(audio.sample_rate),
      channels: Number(audio.channels), durationSec, bytes: size });
  }

  if (missing.length) {
    return resultError('preview', 'E_PREVIEW_AUDIO_MISSING',
      `${missing.length} of ${ids.length} planned sentence(s) have no recording — first: ${missing[0]}. `
      + `Looked in ${audioDir}. Run the voice step for these ids first; nothing was joined.`,
      { work, ids, files, missing, audioDir, parts: parts.length });
  }

  // A stream-copy is only honest when every part shares one shape. Measured on this host:
  // parts whose rate or channel count differ, stream-copied, gave a file ffmpeg liked
  // (3 parts, one at 8000 Hz / 1 channel, 2.09 s out of 3.00 s of parts).
  const first = parts[0];
  const sameShape = parts.every((p) => p.codec === first.codec
    && p.sampleRate === first.sampleRate && p.channels === first.channels);

  const expectedSec = parts.reduce((sum, p) => sum + p.durationSec, 0);

  // Mismatched shapes are put into one shape first, one re-encode per part, and then the
  // join itself is a stream-copy. Measured: re-encoding inside one concat of mismatched
  // parts loses data (2.09 s out of 3.00 s); normalising first and copying after gives
  // 3.000 s exactly. The normalised parts are kept on failure, deleted on success.
  const normDir = join(dir, 'preview-parts');
  const copy = sameShape; // what the result reports: were the parts copied as voice wrote them
  let joinFiles = parts.map((p) => p.path);
  const normalized = []; // parts re-encoded into one shape, ours to clean up
  if (!sameShape) {
    await mkdir(normDir, { recursive: true });
    joinFiles = [];
    for (const p of parts) {
      const norm = join(normDir, `${p.id}.wav`);
      const made = await run(['ffmpeg', '-y', '-i', p.path,
        '-acodec', PREVIEW.codec, '-ar', String(PREVIEW.sampleRate),
        '-ac', String(PREVIEW.channels), norm], { timeoutMs: PREVIEW.timeoutMs });
      if (!made.ok) {
        return resultError('preview', 'E_PREVIEW_WRITE_FAILED',
          `cannot put ${p.id} into the join's shape (exit ${made.code}): ${p.path} -> ${norm}`,
          { work, ids, files, normDir, copy: false, parts: parts.length, expectedSec });
      }
      joinFiles.push(norm);
      normalized.push(norm);
    }
    // The join itself is now a stream-copy, because every part above it shares one shape.
    // The result still says copy: false — the parts voice wrote were not copied as they
    // stood, they were re-encoded first.
  }

  // The part list goes to a file, written atomically with fsync, so ffmpeg cannot read a
  // half-written list. It is kept on failure and deleted on success. Absolute paths: the
  // concat demuxer reads a relative path against the list file's own folder, so a relative
  // list silently points at a folder that does not exist.
  const listPath = `${out}.concat.txt`;
  const list = joinFiles.map((p) => listLine(p.startsWith('/') ? p : join(root, p))).join('');
  const wrote = await writeText(listPath, list);
  if (!wrote.ok) {
    return resultError('preview', 'E_PREVIEW_WRITE_FAILED',
      `cannot write the part list: ${listPath} (${wrote.errno ?? ''})`,
      { work, ids, files, listPath, parts: parts.length });
  }

  // Write to a temp name first: a broken join never leaves a file named preview.wav.
  const tmpPath = join(dir, 'preview.wav.tmp.wav');
  const joinArgv = ['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy', tmpPath];

  const joined = await run(joinArgv, { timeoutMs: PREVIEW.timeoutMs });
  if (!joined.ok && !joined.timedOut) {
    return resultError('preview', 'E_PREVIEW_WRITE_FAILED',
      `ffmpeg could not join the parts (exit ${joined.code}): ${listPath} -> ${tmpPath}`,
      { work, ids, files, listPath, tmpPath, copy, parts: parts.length, expectedSec });
  }

  let tmpSize = -1;
  try { tmpSize = (await stat(tmpPath)).size; } catch { void 0; }
  if (tmpSize <= 0) {
    return resultError('preview', 'E_PREVIEW_WRITE_FAILED',
      `the join wrote nothing (${tmpSize} bytes) to ${tmpPath}.`,
      { work, ids, files, listPath, tmpPath, copy, parts: parts.length, expectedSec });
  }

  // Two checks, not one: the length, then a full decode pass. An ffmpeg that exits 0 can
  // still be short or still be broken, so both have to agree.
  const after = await run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', tmpPath]);
  const gotSec = after.ok ? Number(after.stdout.trim()) : NaN;
  const drift = Math.abs(gotSec - expectedSec);
  const decode = await run(['ffmpeg', '-v', 'error', '-i', tmpPath, '-f', 'null', '-']);
  const decodeClean = decode.ok && decode.stderr === '';

  const cleanup = async () => { try { await unlink(tmpPath); } catch { void 0; } };

  if (!(gotSec > 0) || drift > PREVIEW.toleranceSec) {
    await cleanup();
    return resultError('preview', 'E_PREVIEW_MISMATCH',
      `the join is ${gotSec} s but the parts sum to ${expectedSec} s (drift ${drift.toFixed(3)} s, `
      + `tolerance ${PREVIEW.toleranceSec} s) at ${tmpPath}; nothing was kept.`,
      { work, ids, files, listPath, tmpPath, copy, parts: parts.length, expectedSec, gotSec, drift });
  }
  if (!decodeClean) {
    await cleanup();
    return resultError('preview', 'E_PREVIEW_MISMATCH',
      `the join decodes with errors (${decode.stderr.slice(0, 200).trim()}) at ${tmpPath}; nothing was kept.`,
      { work, ids, files, listPath, tmpPath, copy, parts: parts.length, expectedSec, gotSec });
  }

  // A checked file is moved into place with one rename. A failed rename leaves the temp
  // name there, so the answer is still missing rather than half-there.
  let moved = { errno: null };
  try { await rename(tmpPath, out); moved.ok = true; } catch (e) { moved = { ok: false, errno: e.code }; }
  if (!moved.ok) {
    return resultError('preview', 'E_PREVIEW_WRITE_FAILED',
      `cannot move the checked join into place: ${tmpPath} -> ${out} (${moved.errno ?? ''})`,
      { work, ids, files, listPath, tmpPath, out, copy, parts: parts.length, expectedSec });
  }
  for (const p of normalized) {
    try { await unlink(p); } catch { void 0; } // ours, and the join is checked: they are dust
  }
  try { await unlink(listPath); } catch { void 0; }

  return resultOk('preview', {
    work, ids, files,
    parts: parts.length,
    copy,
    durationSec: gotSec,
    expectedSec,
    drift,
    toleranceSec: PREVIEW.toleranceSec,
    sameShape,
    normalized: normalized.length,
    normDir,
    audioDir,
    out,
    listPath,
    tmpPath,
  });
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${resultError('preview', 'E_PREVIEW_ARGS', parsed.message, {})}\n`);
    process.exit(1);
  }
  const r = await joinAudio(parsed.opts);
  process.stdout.write(`${JSON.stringify(r)}\n`);
  process.exit(r.ok ? 0 : 1);
}

if (await realpath(process.argv[1]) === await realpath(SELF)) await main();
