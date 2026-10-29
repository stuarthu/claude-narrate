// T-08 — the segment step: one planned sentence becomes one real part, with the subtitle
// burned in.
//
// The order is fixed, and it is the order that kills the common bug: read the plan -> measure
// the real audio -> decide the fill from that measurement -> render. Measuring the recording
// is what makes the picture follow the voice. Using pick's estimate for the cut would make
// the picture a different length than the voice, which is what this step exists to avoid
// (F-5, A-10).
//
// Nothing is rendered before the plan is approved (F-14, NEW-1): a render attempt with no
// --approved fails, it does not warn. And every check over every row runs before the first
// render, so a stop leaves no half-made part on disk.
import {
  RESULT_SCHEMA, resultOk, resultError, SHOT_SCHEMA, parseScript,
  FRAMES, PART_SHAPE, SHAPE_PROBE, TOLERANCE_SEGMENT, FILL, SUB_FONT,
  subStyle, assHeader, assEvent, assEscape, breakLines, displayWidth,
} from '../lib/contract.mjs';
import { readJson, writeJson, writeText, ensureDir } from '../lib/json.mjs';
import { run } from '../lib/run.mjs';
import { audioPathOf } from '../bin/voice.mjs';
import { estimateSec } from '../bin/pick.mjs';
import { readFile, stat, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';

const SELF = fileURLToPath(import.meta.url);

const FLAGS = { '--work': 1, '--root': 1 };

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

// The names segment writes. concat reads them through this same function, so one file owns
// the naming and a rename here cannot leave the next step looking in the wrong place (F-13).
export function partPathOf(work, id, root = process.cwd()) {
  return join(root, '.narrate', work, 'segments', `${id}.mp4`);
}

// ffprobe answers every stream on its own, and the csv writer here skips the fields a stream
// does not have (measured: the video line held 5 fields, the audio line 4), so json is asked
// and the two halves are merged back into one shape.
// Exported: concat asks the same question about the same files, so one file owns the probe
// and the two cannot disagree about what a part's shape is (F-13).
export async function shapeOf(path) {
  const r = await run(['ffprobe', '-v', 'error', '-show_entries',
    `stream=codec_type,${SHAPE_PROBE.join(',')}`, '-print_format', 'json', path]);
  if (!r.ok) return null;
  let j;
  try { j = JSON.parse(r.stdout); } catch { return null; }
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

// Exported for the same reason as shapeOf: concat measures the parts it joins with this.
export async function durationOf(path) {
  const r = await run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', path]);
  return r.ok && r.stdout.trim() !== '' ? Number(r.stdout.trim()) : null;
}

async function probeSize(path) {
  try { return (await stat(path)).size; } catch { return -1; }
}

// The one fit order the requirements fix: slow the picture, then scale it down to fit, then
// pad the leftover to the target frame, then burn the subtitle. The burn comes last, so the
// subtitle is drawn at the target size and never scaled with the picture (F-11).
function fitChain(w, h) {
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`;
}

const ENCODE = ['-r', String(PART_SHAPE.fps), '-c:v', 'h264', '-profile:v', PART_SHAPE.videoProfile,
  '-level', PART_SHAPE.videoLevel, '-pix_fmt', PART_SHAPE.pixFmt,
  '-c:a', PART_SHAPE.audioCodec, '-ar', String(PART_SHAPE.sampleRate), '-ac', String(PART_SHAPE.channels)];

export async function cut(opts = {}) {
  const root = opts.root ?? process.cwd();
  const work = opts.work;

  // A command line we cannot read is an error before anything else: no path is built from
  // a name we do not have, so nothing is guessed (NEW-1, F-14).
  if (!work) {
    return resultError('segment', 'E_SEGMENT_ARGS',
      'usage: node bin/segment.mjs --work <name> --approved [--root <dir>]');
  }

  const dir = join(root, '.narrate', work);
  const shotsPath = join(dir, 'shots.json');
  const scriptPath = join(dir, 'script.txt');
  const segmentsDir = join(dir, 'segments');
  const subsPartsDir = join(dir, 'subs-parts');
  const tmpDir = join(dir, 'segment-tmp');
  const subsPath = join(dir, 'subs.ass');

  // The approval wall comes first, before any folder is made and before any render: an
  // unapproved plan must leave nothing on disk (F-14, NEW-1).
  if (opts.approved !== true) {
    return resultError('segment', 'E_SEGMENT_NOT_APPROVED',
      `the plan was not approved, so nothing was rendered. Pass --approved only after stop 4 said yes: node bin/segment.mjs --work ${work} --approved`,
      { work, shotsPath, scriptPath });
  }

  // Stop rule (NEW-2): this stage reads stop 3's product. No file means stop 3 never ran.
  const shotsDoc = await readJson(shotsPath);
  if (!shotsDoc.ok) {
    const why = shotsDoc.errno === 'ENOENT' ? 'is not there, so stop 3 never ran'
      : `cannot be read (${shotsDoc.errno} ${(shotsDoc.message ?? '').trim()})`;
    return resultError('segment', 'E_SEGMENT_SHOTS_MISSING',
      `no shot list here: ${shotsPath} ${why}. Run the pick step first.`,
      { work, shotsPath });
  }
  if (shotsDoc.value.schema !== SHOT_SCHEMA) {
    return resultError('segment', 'E_SEGMENT_SHOTS_MISSING',
      `${shotsPath} is not a shot list we wrote (schema ${shotsDoc.value.schema}, wanted ${SHOT_SCHEMA}).`,
      { work, shotsPath });
  }
  let scriptText = '';
  try { scriptText = await readFile(scriptPath, 'utf8'); }
  catch (e) {
    return resultError('segment', 'E_SEGMENT_SCRIPT_MISSING',
      `${scriptPath} is not there (${e.code}), so stop 2 never ran. Write the numbered script first.`,
      { work, scriptPath });
  }
  const rows = parseScript(scriptText);
  if (!rows.length) {
    return resultError('segment', 'E_SEGMENT_SCRIPT_MISSING',
      `${scriptPath} is not there, or holds no numbered sentence, so stop 2 never ran. Write the numbered script first.`,
      { work, scriptPath });
  }

  // The aspect is the one pick stored, never one passed in here: the plan and the parts must
  // agree on one frame.
  const aspect = shotsDoc.value.aspect;
  const frame = FRAMES[aspect];
  if (!frame) {
    return resultError('segment', 'E_SEGMENT_BAD_SHAPE',
      `shots.json names aspect ${aspect}, which has no target frame (only ${Object.keys(FRAMES).join(', ')}).`,
      { work, aspect });
  }
  const [w, h] = frame;
  let style;
  try { style = subStyle(w, h, aspect); } catch (e) {
    return resultError('segment', 'E_SEGMENT_BAD_SHAPE', `the subtitle style cannot be built: ${e.message}`,
      { work, aspect });
  }

  const planned = new Map(shotsDoc.value.shots.map((s) => [s.id, s]));
  const unplanned = rows.filter((r) => !planned.has(r.id)).map((r) => r.id);
  if (unplanned.length) {
    return resultError('segment', 'E_SENTENCE_UNPLANNED',
      `${unplanned.join(', ')} are in the script but have no shot in ${shotsPath}, so this step stopped and never rendered anything, and no other clip was substituted for them. Re-run the pick step.`,
      { work, unplanned, scriptPath, shotsPath });
  }

  // ---------------------------------------------------- check everything, then render

  // Every row is checked before the first render, so a stop cannot leave one part made and
  // the next missing.
  const jobs = [];
  for (const row of shotsDoc.value.shots) {
    const audio = audioPathOf(work, row.id, root);
    const audioSec = await durationOf(audio);
    if (audioSec === null) {
      return resultError('segment', 'E_AUDIO_MISSING',
        `no recording for ${row.id}: ${audio} is not there, so the voice step never wrote it. Nothing was rendered.`,
        { work, id: row.id, audio, audioPath: audio });
    }
    if (!(audioSec > 0)) {
      return resultError('segment', 'E_AUDIO_ZERO_DURATION',
        `${audio} measures ${audioSec} s: a 0-second recording cannot hold a picture. Nothing was rendered.`,
        { work, id: row.id, audio });
    }

    // The plan names the clip the way the user typed it, so the name means the folder the
    // command ran in. The render runs in the work folder instead, so the name is turned into
    // an absolute path once here: one name, one file, for the probe and for ffmpeg.
    const assetAbs = resolve(row.assetPath);
    const assetSec = await durationOf(assetAbs);
    if (assetSec === null) {
      return resultError('segment', 'E_ASSET_MISSING',
        `the clip the plan names, ${row.assetPath}, is not on disk or cannot be probed. Nothing was rendered.`,
        { work, id: row.id, assetPath: row.assetPath });
    }
    if (assetSec + TOLERANCE_SEGMENT < row.endSec) {
      return resultError('segment', 'E_ASSET_TOO_SHORT',
        `${row.assetPath} is ${assetSec} s but the plan wants it to reach ${row.endSec} s, so the clip changed since the plan. This step stopped and never rendered anything, and no other clip was substituted.`,
        { work, id: row.id, assetPath: row.assetPath, assetSec, endSec: row.endSec });
    }

    // The fill decision, from the measured audio and the planned window.
    const have = row.endSec - row.startSec;
    const wanted = audioSec;
    let fill = 'none';
    let slowTo = 0;
    if (wanted > have) {
      const gap = wanted / have - 1;
      if (gap <= FILL.SLOW_LIMIT) { fill = 'slow'; slowTo = wanted / have; }
      else fill = 'loop';
    }
    jobs.push({ row, audio, audioSec, have, wanted, fill, slowTo, assetAbs });
  }

  await ensureDir(segmentsDir);
  await ensureDir(subsPartsDir);
  await ensureDir(tmpDir);

  const parts = [];
  const events = [];
  let cursor = 0;

  for (const job of jobs) {
    const { row, audio, audioSec, have, wanted, fill, slowTo, assetAbs } = job;
    const out = partPathOf(work, row.id, root);
    const tmp = `${out}.making.mp4`;
    const subsRel = join('subs-parts', `${row.id}.ass`);
    const subsAbs = join(dir, subsRel);

    // The subtitle for this part, broken by the contract's own line rules for this frame.
    const br = breakLines(row.sentence, style);
    const subText = assEscape(br.lines.join('\n'));
    const oneAss = `${assHeader(w, h, style)}\n${assEvent(0, wanted, style, subText)}\n`;
    if ((await writeText(subsAbs, oneAss)).ok !== true) {
      return resultError('segment', 'E_SEGMENT_SUBTITLES_MISSING',
        `the subtitle file for ${row.id} could not be written at ${subsAbs}, so nothing was rendered for it.`,
        { work, id: row.id, subsPath: subsAbs });
    }

    const burn = `${fitChain(w, h)},ass=${subsRel}`;
    let made = null;

    if (fill === 'loop') {
      // Past the slow limit the window repeats from its own start. The window is cut to a
      // file first, because -stream_loop needs a file it can read again.
      const reps = Math.ceil(wanted / have);
      const win = join(tmpDir, `${row.id}.mp4`);
      const winRun = await run(['ffmpeg', '-y', '-ss', String(row.startSec), '-t', String(have),
        '-i', assetAbs, '-c:v', 'h264', '-profile:v', PART_SHAPE.videoProfile,
        '-level', PART_SHAPE.videoLevel, '-pix_fmt', PART_SHAPE.pixFmt, '-r', String(PART_SHAPE.fps),
        win], { cwd: dir });
      if (!winRun.ok) {
        return resultError('segment', 'E_RENDER_OUTPUT_UNREADABLE',
          `the loop window for ${row.id} could not be cut from ${row.assetPath}: exit ${winRun.code}.`,
          { work, id: row.id, assetPath: row.assetPath });
      }
      made = await run(['ffmpeg', '-y', '-stream_loop', String(reps - 1), '-i', win,
        '-i', audio, '-map', '0:v', '-map', '1:a', '-vf', burn, ...ENCODE,
        '-t', String(wanted), tmp], { cwd: dir });
      await quiet(win);
    } else {
      const chain = fill === 'slow' ? `setpts=${slowTo.toFixed(6)}*PTS,${burn}` : burn;
      made = await run(['ffmpeg', '-y', '-ss', String(row.startSec), '-t', String(have),
        '-i', assetAbs, '-i', audio, '-map', '0:v', '-map', '1:a', '-vf', chain, ...ENCODE,
        '-t', String(wanted), tmp], { cwd: dir });
    }

    if (!made.ok) {
      await quiet(tmp);
      return resultError('segment', 'E_RENDER_OUTPUT_UNREADABLE',
        `the render for ${row.id} did not work (exit ${made.code}, timedOut ${made.timedOut}): ${made.stderr.slice(0, 400)}`,
        { work, id: row.id, assetPath: row.assetPath, audio });
    }
    if (probeSize(tmp) <= 0) {
      await quiet(tmp);
      return resultError('segment', 'E_RENDER_OUTPUT_UNREADABLE',
        `the render for ${row.id} exited 0 but wrote nothing at ${tmp}.`,
        { work, id: row.id });
    }

    // The exit code is never believed: the part is probed, decoded whole, and measured.
    const shape = await shapeOf(tmp);
    if (!shape) {
      await quiet(tmp);
      return resultError('segment', 'E_RENDER_OUTPUT_UNREADABLE',
        `the part we just made for ${row.id} cannot be probed: ${tmp}.`, { work, id: row.id, tmp });
    }
    const want = {
      codec_name: PART_SHAPE.videoCodec, width: w, height: h, pix_fmt: PART_SHAPE.pixFmt,
      r_frame_rate: `${PART_SHAPE.fps}/1`, sample_rate: PART_SHAPE.sampleRate,
      channels: PART_SHAPE.channels,
    };
    for (const f of SHAPE_PROBE) {
      if (shape[f] !== want[f]) {
        await quiet(tmp);
        return resultError('segment', 'E_SEGMENT_BAD_SHAPE',
          `${row.id} came out ${shape[f]} for ${f}, the parts must all be ${want[f]} (the one shape every part shares).`,
          { work, id: row.id, field: f, got: shape[f], want: want[f] });
      }
    }
    const decode = await run(['ffmpeg', '-v', 'error', '-i', tmp, '-f', 'null', '-']);
    if (!decode.ok || decode.stderr !== '') {
      await quiet(tmp);
      return resultError('segment', 'E_RENDER_OUTPUT_UNREADABLE',
        `a full decode pass over ${row.id} left errors: ${(decode.stderr.slice(0, 400) || `exit ${decode.code}`)}`,
        { work, id: row.id, tmp });
    }
    const videoSec = await durationOf(tmp);
    if (videoSec === null) {
      await quiet(tmp);
      return resultError('segment', 'E_RENDER_OUTPUT_UNREADABLE',
        `${row.id} cannot be measured after the render: ${tmp}.`, { work, id: row.id, tmp });
    }
    if (Math.abs(videoSec - wanted) > TOLERANCE_SEGMENT) {
      await quiet(tmp);
      return resultError('segment', 'E_DURATION_MISMATCH',
        `${row.id} came out ${videoSec} s but its audio is ${wanted} s, so the picture does not follow the voice.`,
        { work, id: row.id, videoSec, wanted });
    }

    try { await rename(tmp, out); }
    catch (e) {
      return resultError('segment', 'E_SEGMENT_WRITE_FAILED',
        `the part for ${row.id} could not be put in place at ${out}: ${e.code}`,
        { work, id: row.id, out });
    }

    row.fill = fill;
    row.slowTo = slowTo;
    row.overflow = br.overflow;

    events.push(assEvent(cursor, cursor + wanted, style, subText));
    cursor += wanted;

    parts.push({
      id: row.id, sentence: row.sentence, path: out, subsPath: subsAbs,
      wantedSec: wanted, audioSec, videoSec, fill, slowTo,
      assetPath: row.assetPath, startSec: row.startSec, endSec: row.endSec, haveSec: have,
      estimateSec: estimateSec(row.sentence), cells: displayWidth(row.sentence),
      lines: br.lines, overflow: br.overflow, bytes: probeSize(out), shape,
    });
  }

  // subs.ass describes the whole video: the times run on over the parts, so the next step
  // can read one file for the whole film (A-12).
  const whole = `${assHeader(w, h, style)}\n${events.join('\n')}\n`;
  if ((await writeText(subsPath, whole)).ok !== true) {
    return resultError('segment', 'E_SEGMENT_WRITE_FAILED',
      `subs.ass could not be written at ${subsPath}.`, { work, subsPath });
  }

  const saved = await writeJson(shotsPath, shotsDoc.value);
  if (!saved.ok) {
    return resultError('segment', 'E_SEGMENT_WRITE_FAILED',
      `the shot list could not record the fill it used: ${saved.message}`, { work, shotsPath });
  }

  // The scratch window files are cleaned up: they are not a product the next step reads.
  for (const job of jobs) {
    if (job.fill !== 'loop') continue;
    await quiet(join(tmpDir, `${job.row.id}.mp4`));
  }

  return resultOk('segment', {
    work, approved: true, aspect, frame, style, font: SUB_FONT,
    parts, subsPath, subsEvents: events.length, segmentsDir, shotsPath, scriptPath,
    subsPartsDir, tmpDir, toleranceSec: TOLERANCE_SEGMENT,
  });
}

// Cleaning up is not a product: a scratch file that is already gone is not a failure, and
// saying so here keeps a cleanup from turning into a stop.
async function quiet(path) {
  try { await unlink(path); } catch {}
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2));
  if (!parsed.ok) {
    process.stdout.write(`${JSON.stringify(resultError('segment', 'E_SEGMENT_ARGS', parsed.message))}\n`);
    process.exit(1);
  }
  const r = await cut(parsed.opts);
  process.stdout.write(`${JSON.stringify(r)}\n`);
  process.exit(r.ok ? 0 : 1);
}

if (await realpath(process.argv[1]) === await realpath(SELF)) await main();
