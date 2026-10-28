// T-04 — bin/describe.mjs: pull frames for one clip, and store what Claude said about them.
// Three jobs, one file:
//   pullFrames  — cut pictures out of one clip at a stated interval, and write the path
//                 they live at into that clip's JSON.
//   storeSaid   — put Claude's words into fromMachine, never into fromYou.
//   storeQueries— keep the English visual query Claude wrote for every sentence, so a later
//                 reader can check a choice (doc section 11: layer 2 cannot cross languages,
//                 so the English query is required, not optional).
// Rules that shape this file:
// - rule 3: what Claude said is understanding, so it goes to fromMachine only.
// - rule 1: keys we did not create survive; our own keys are added, never replaced wholesale.
// - rule 4: measure, do not believe. Seconds Claude claims are checked against the length
//   ffprobe measured here, never against what Claude said the clip looked like.
// - rule 7: model text is data. It is written into JSON and passed as an argv element; it
//   never reaches a shell.
// - rule 14: describe must work on its own, without the index step having run first.

import { CLIP_SCHEMA, QUERY_SCHEMA, blankIndex, blankQueries, resultOk, resultError } from '../lib/contract.mjs';
import { readJson, writeJson, copyOnce, ensureDir } from '../lib/json.mjs';
import { run } from '../lib/run.mjs';
import { readdir, readFile, stat, realpath, mkdir, rm } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

// The frames of one clip live here, inside the one .narrate place the doc allows.
const FRAMES_ROOT = '.narrate/frames';
// A work folder may not be called frames: that name belongs to the frames place above.
const RESERVED_WORK = ['frames'];
// What we call the picture reader. The doc fixes understanding as Claude reading frames,
// so the name is written down rather than guessed at run time.
const ENGINE = 'claude-frames';
// Measured: a 1920x1080 source gives 1024x576 frames with this scale, and a 320x240 source
// stays 320x240 — min(1024,iw) caps the width and never blows a small clip up.
const FRAME_MAX_WIDTH = 1024;
// A Han-script letter anywhere in a query means the query is not English. Measured on 36
// archive.org clips: layer 2 scored 0 for everything when the query and the clip text were
// different languages, so a non-English query is reported instead of quietly used.
const NOT_ENGLISH = /[\p{Script=Han}\p{Script=Cyrillic}\p{Script=Arabic}]/u;

// ------------------------------------------------------------------------ small helpers

function fingerprintOf(st) {
  // size + mtime, and no path: a move keeps fromMachine (rule 12). Same shape as index.mjs.
  return `size:${st.size}|mtime:${Math.round(st.mtimeMs / 1000)}`;
}

function stemOf(path) {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function sidecarOf(path) {
  // doc section 8: bench.mp4 gets bench.json, beside the clip.
  return join(dirname(path), `${stemOf(path)}.json`);
}

function keyOf(stem, fingerprint) {
  // The interval is NOT in the key: re-pulling the same clip at a different interval reuses
  // one dir, and we clear it, so no stale frame can survive a shorter pull.
  return `${stem}--${fingerprint.replace(/[^A-Za-z0-9._-]+/g, '-')}`;
}

function stemOfKey(name) {
  const at = name.lastIndexOf('--');
  return at < 0 ? null : name.slice(0, at);
}

async function listDirs(root) {
  try { return await readdir(root); } catch { return []; }
}

// One ffprobe call gives the length and the picture shape. The exit code alone is not
// trusted: the JSON must also carry a usable duration. Measured on this host: ffprobe
// prints {"streams":[...],"format":{"duration":"4.000000"}} and exits 0 for a real clip.
async function measure(path) {
  const r = await run(['ffprobe', '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_name,width,height',
    '-of', 'json', '-i', path]);
  if (!r.ok || r.code !== 0) return { ok: false, message: `ffprobe could not read it (exit ${r.code ?? 'spawn failed'}): ${(r.stderr || r.stdout).trim()}` };
  let parsed;
  try { parsed = JSON.parse(r.stdout); }
  catch { return { ok: false, message: 'ffprobe printed nothing parseable' }; }
  const durationSec = Number(parsed?.format?.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return { ok: false, message: `no usable duration (got ${JSON.stringify(parsed?.format?.duration)})` };
  }
  const stream = (parsed?.streams ?? [])[0] ?? {};
  const width = Number(stream.width);
  const height = Number(stream.height);
  const shape = (!width || !height) ? 0 : (width === height ? 3 : width > height ? 2 : 1);
  return { ok: true, durationSec, shape };
}

async function probeFrame(path) {
  // Read the picture back, so "we made a frame" is a checked fact and not a hope.
  const r = await run(['ffprobe', '-v', 'error',
    '-show_entries', 'stream=codec_name,width,height', '-of', 'json', '-i', path]);
  if (!r.ok || r.code !== 0) return null;
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { return null; }
  const stream = (parsed?.streams ?? [])[0];
  if (!stream) return null;
  return { codec: stream.codec_name, width: Number(stream.width), height: Number(stream.height) };
}

// The sidecar merge, shared by pullFrames and storeSaid. An existing file keeps every key we
// never created; a missing one starts from blankIndex. fromYou is copied, never rewritten.
async function loadSidecar(clipPath) {
  const path = sidecarOf(clipPath);
  const blank = blankIndex(basename(clipPath));
  const found = await readJson(path);
  if (!found.ok) {
    if (found.errno !== 'ENOENT') return { ok: false, message: `the sidecar cannot be read: ${found.message}` };
    return { ok: true, path, value: blank, created: true, foreign: {} };
  }
  const value = found.value;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: `the sidecar is not an object: ${path}` };
  }
  if (value.schema && value.schema !== CLIP_SCHEMA) {
    return { ok: false, message: `the sidecar carries a foreign schema (${value.schema}): ${path}` };
  }
  return { ok: true, path, value, created: false, foreign: value };
}

async function saveSidecar(loaded, machine, measured, fingerprint) {
  // Back up the original bytes once, before the first touch (rule 1).
  const merged = { ...loaded.value };
  merged.schema = CLIP_SCHEMA;
  merged.clip = loaded.value.clip || basename(loaded.path);
  merged.fingerprint = fingerprint;
  merged.measured = { shape: measured.shape, durationSec: measured.durationSec };
  merged.fromMachine = { ...blankIndex(merged.clip).fromMachine, ...loaded.value.fromMachine ?? {}, ...machine };
  // fromYou is carried by the spread above: we never write into it here.
  const wrote = await writeJson(loaded.path, merged);
  if (!wrote.ok) return { ok: false, message: `could not write ${loaded.path}: ${wrote.message}` };
  return { ok: true, path: loaded.path, merged };
}

// --------------------------------------------------------------------------- pullFrames

export async function pullFrames(opts) {
  const clipPath = opts.clip ?? '';
  const root = opts.root || process.cwd();
  const every = Number(opts.every);
  if (!clipPath) return resultError('describe', 'E_SCAN_INTERNAL', 'usage: pullFrames({ clip, every, root })', {});
  if (!Number.isFinite(every) || every <= 0) {
    return resultError('describe', 'E_SCAN_INTERNAL', `every must be a positive number of seconds (got ${JSON.stringify(opts.every)})`, {});
  }

  let st;
  try { st = await stat(clipPath); }
  catch { return resultError('describe', 'E_ASSET_MISSING', `no clip to pull at ${clipPath}`, { framesDir: '', stale: [] }); }

  const stem = stemOf(clipPath);
  const fingerprint = fingerprintOf(st);
  const framesDir = join(root, FRAMES_ROOT, keyOf(stem, fingerprint));

  // A dir for this clip that carries a different fingerprint is the same clip after it
  // changed. Report it, so a reader can see what is left over, and never read it by accident.
  const stale = [];
  for (const name of await listDirs(join(root, FRAMES_ROOT))) {
    if (stemOfKey(name) === stem && name !== keyOf(stem, fingerprint)) {
      stale.push(join(root, FRAMES_ROOT, name));
    }
  }

  // Clear our own dir first, then make it again: a shorter pull leaves no stale frame behind.
  await rm(framesDir, { recursive: true, force: true });
  const dir = await ensureDir(framesDir);
  if (!dir.ok) return resultError('describe', 'E_SCAN_INTERNAL', `could not make ${framesDir}: ${dir.message}`, { framesDir, stale });

  const measured = await measure(clipPath);
  if (!measured.ok) {
    return resultError('describe', 'E_ASSET_MISSING', `the clip has no measurable length: ${measured.message}`, { framesDir, stale });
  }

  // Measured here: this exact filter gives 4 frames for a 7 s clip at every 2 s, 1 frame for
  // a 4 s clip at every 4 s, and 1024x576 pictures from a 1920x1080 source. An audio-only
  // clip exits 234 with "Output file does not contain any stream" and writes 0 frames.
  const pull = await run(['ffmpeg', '-y', '-i', clipPath,
    '-vf', `fps=1/${every},scale='min(${FRAME_MAX_WIDTH},iw)':-2`,
    join(framesDir, 'frame-%04d.jpg')], { timeoutMs: 120000 });
  if (!pull.ok || pull.code !== 0) {
    return resultError('describe', 'E_UNDERSTAND_FAILED',
      `no frames could be pulled (exit ${pull.code ?? 'spawn failed'}): ${(pull.stderr || pull.stdout).trim()}`,
      { framesDir, stale, count: 0 });
  }

  const names = (await listDirs(framesDir)).filter((n) => n.startsWith('frame-')).sort();
  if (names.length === 0) {
    return resultError('describe', 'E_UNDERSTAND_FAILED', 'ffmpeg wrote no frames', { framesDir, stale, count: 0 });
  }

  const frames = [];
  for (let i = 0; i < names.length; i += 1) {
    const path = join(framesDir, names[i]);
    const probed = await probeFrame(path);
    if (!probed) {
      return resultError('describe', 'E_UNDERSTAND_FAILED', `${names[i]} cannot be read back as a picture`, { framesDir, stale, count: frames.length });
    }
    // ffmpeg's fps filter puts frame i at i*every seconds in. With count = ceil(len/every)
    // that is always inside the clip, which the test checks against the measured length.
    frames.push({ name: names[i], atSec: i * every, codec: probed.codec, width: probed.width, height: probed.height });
  }

  // pullFrames is the thing that made this dir, so it writes the path-based field and the
  // engine name. visualSearchDir is path-based: a move invalidates it, and matching falls
  // back to text rather than erroring (rule 12).
  const loaded = await loadSidecar(clipPath);
  if (!loaded.ok) return resultError('describe', 'E_CLIP_JSON_UNREADABLE', loaded.message, { framesDir, stale });
  // The backup goes first: rule 1 says the .bak is the original, saved before the first
  // touch. A sidecar we made ourselves has no original to keep.
  const backed = loaded.created ? { ok: true, copied: false } : await copyOnce(loaded.path, `${loaded.path}.bak`);
  if (!backed.ok) {
    return resultError('describe', 'E_BACKUP_FAILED', `the original sidecar was not saved: ${backed.message}`, { framesDir, stale });
  }
  const saved = await saveSidecar(loaded, { visualSearchDir: framesDir, engine: ENGINE }, measured, fingerprint);
  if (!saved.ok) return resultError('describe', 'E_SCAN_INTERNAL', saved.message, { framesDir, stale });

  return resultOk('describe', {
    action: 'frames',
    clip: basename(clipPath),
    clipPath,
    every,
    framesDir,
    count: frames.length,
    frames,
    durationSec: measured.durationSec,
    fingerprint,
    stale,
    created: loaded.created,
    written: [loaded.path],
    backup: backed.copied ? [`${loaded.path}.bak`] : [],
  });
}

// --------------------------------------------------------------------------- storeSaid

export async function storeSaid(opts) {
  const clipPath = opts.clip ?? '';
  const saidPath = opts.said ?? '';
  const root = opts.root || process.cwd();
  if (!clipPath || !saidPath) {
    return resultError('describe', 'E_SCAN_INTERNAL', 'usage: storeSaid({ clip, said, root })', {});
  }

  // Read what Claude wrote first. A file we cannot read at all is a source problem, not an
  // understanding failure (rule 6); a file that is not JSON is understanding.
  let text;
  try { text = await readFile(saidPath, 'utf8'); }
  catch (err) {
    return resultError('describe', 'E_SCAN_INTERNAL', `cannot read ${saidPath}: ${err.code ?? err.message}`, {});
  }
  let said;
  try { said = JSON.parse(text); }
  catch { return resultError('describe', 'E_UNDERSTAND_FAILED', `${saidPath} is not JSON: what Claude wrote cannot be trusted, and the sidecar was left alone`, {}); }
  if (typeof said !== 'object' || Array.isArray(said)) {
    return resultError('describe', 'E_UNDERSTAND_FAILED', `${saidPath} is not a JSON object`, {});
  }

  const measured = await measure(clipPath);
  if (!measured.ok) return resultError('describe', 'E_ASSET_MISSING', `the clip has no measurable length: ${measured.message}`, {});
  const durationSec = measured.durationSec;

  const raw = Array.isArray(said.segments) ? said.segments : [];
  const stored = [];
  const dropped = [];
  for (let i = 0; i < raw.length; i += 1) {
    const seg = raw[i];
    const keep = keepSegment(seg, durationSec);
    if (keep) stored.push(keep);
    else dropped.push({ clip: basename(clipPath), index: i, reason: keepReason(seg, durationSec) });
  }
  if (stored.length === 0) {
    return resultError('describe', 'E_UNDERSTAND_FAILED', 'no segment survived the length check', { dropped });
  }

  const loaded = await loadSidecar(clipPath);
  if (!loaded.ok) return resultError('describe', 'E_CLIP_JSON_UNREADABLE', loaded.message, {});
  const st = await stat(clipPath);
  const backed = loaded.created ? { ok: true, copied: false } : await copyOnce(loaded.path, `${loaded.path}.bak`);
  if (!backed.ok) {
    return resultError('describe', 'E_BACKUP_FAILED', `the original sidecar was not saved: ${backed.message}`, {});
  }
  const saved = await saveSidecar(loaded, { segments: stored, engine: opts.engine || ENGINE }, measured, fingerprintOf(st));
  if (!saved.ok) return resultError('describe', 'E_SCAN_INTERNAL', saved.message, {});

  return resultOk('describe', {
    action: 'said',
    clip: basename(clipPath),
    clipPath,
    engine: opts.engine || ENGINE,
    stored,
    dropped,
    durationSec,
    created: loaded.created,
    written: [loaded.path],
    backup: backed.copied ? [`${loaded.path}.bak`] : [],
  });
}

function keepReason(seg, durationSec) {
  if (typeof seg !== 'object' || Array.isArray(seg) || seg === null) return 'not an object';
  const startSec = Number(seg.startSec);
  const endSec = Number(seg.endSec);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return 'seconds that are not numbers';
  if (startSec < 0) return 'starts before the clip does';
  if (startSec >= durationSec) return `starts past the measured length (${durationSec} s)`;
  if (!(Math.min(endSec, durationSec) > startSec)) return 'ends before it starts';
  if (typeof seg.description !== 'string' || !seg.description) return 'no words in it';
  return 'kept';
}

function keepSegment(seg, durationSec) {
  // rule 4: seconds Claude claimed are checked against the measured length. A segment that
  // reaches past the clip is clamped, and the clamp is reported in the result so the agent
  // can see it; a segment that cannot exist at all is dropped and reported.
  if (keepReason(seg, durationSec) !== 'kept') return null;
  const startSec = Number(seg.startSec);
  const endSec = Math.min(Number(seg.endSec), durationSec);
  const confidence = Number(seg.confidence);
  const tags = Array.isArray(seg.tags)
    ? [...new Set(seg.tags.filter((t) => typeof t === 'string' && t).map((t) => t.trim()))]
    : [];
  return { startSec, endSec, description: seg.description, tags, confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0 };
}

// ------------------------------------------------------------------------ storeQueries

export async function storeQueries(opts) {
  const work = opts.work ?? '';
  const queriesPath = opts.queries ?? '';
  const root = opts.root || process.cwd();
  if (!work || !queriesPath) {
    return resultError('describe', 'E_SCAN_INTERNAL', 'usage: storeQueries({ work, queries, root })', {});
  }
  if (RESERVED_WORK.includes(work)) {
    return resultError('describe', 'E_SCAN_INTERNAL', `${work} is a reserved name: .narrate/frames belongs to the frames of a clip`, {});
  }

  let text;
  try { text = await readFile(queriesPath, 'utf8'); }
  catch (err) { return resultError('describe', 'E_SOURCE_UNREADABLE', `cannot read ${queriesPath}: ${err.code ?? err.message}`, {}); }
  let written;
  try { written = JSON.parse(text); }
  catch { return resultError('describe', 'E_SOURCE_UNREADABLE', `${queriesPath} is not JSON`, {}); }
  const raw = Array.isArray(written?.queries) ? written.queries : (Array.isArray(written) ? written : []);

  const rows = [];
  const notEnglish = [];
  const empty = [];
  for (const row of raw) {
    if (typeof row !== 'object' || Array.isArray(row) || row === null) continue;
    const id = String(row.id ?? '');
    if (!id) continue;
    const sentence = typeof row.sentence === 'string' ? row.sentence : '';
    const query = typeof row.query === 'string' ? row.query.trim() : '';
    rows.push({ id, sentence, query });
    if (!query) empty.push({ id, sentence });
    else if (NOT_ENGLISH.test(query)) notEnglish.push({ id, sentence, query });
  }

  // doc section 8: the queries live in the one .narrate place, under the work name.
  const file = join(root, '.narrate', work, 'queries.json');
  const made = await ensureDir(dirname(file));
  if (!made.ok) return resultError('describe', 'E_SCAN_INTERNAL', `cannot make ${dirname(file)}: ${made.message}`, {});
  const found = await readJson(file);
  const base = (found.ok && typeof found.value === 'object' && !Array.isArray(found.value)) ? found.value : blankQueries(work);
  const merged = { ...base, schema: QUERY_SCHEMA, work, queries: rows };
  const wrote = await writeJson(file, merged);
  if (!wrote.ok) return resultError('describe', 'E_SCAN_INTERNAL', `could not write ${file}: ${wrote.message}`, {});

  // A query that is not English is a warning, not a failure: pick falls back to text
  // matching, it does not stop (rule from section 11).
  return resultOk('describe', {
    action: 'queries',
    work,
    file,
    echoed: rows,
    notEnglish,
    empty,
    stored: rows.length,
    written: [file],
  });
}

// ---------------------------------------------------------------------- the command line
// SPEC section 3: one JSON object on stdout and nothing else. An error goes to stderr as
// JSON and the script exits non-zero, so the agent can never ignore a silent script.

async function isMain() {
  try { return (await realpath(process.argv[1])) === (await realpath(SELF)); }
  catch { return false; }
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--clip' || flag === '--said' || flag === '--work' || flag === '--queries' ||
        flag === '--root' || flag === '--engine') {
      opts[flag.slice(2)] = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (flag === '--every') { opts.every = Number(argv[i + 1] ?? ''); i += 1; continue; }
    return { ok: false, message: `unknown argument ${flag}` };
  }
  return { ok: true, opts };
}

if (await isMain()) {
  const parsed = await parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${JSON.stringify(resultError('describe', 'E_SCAN_INTERNAL', parsed.message, {}), null, 2)}\n`);
    process.exit(1);
  }
  const o = parsed.opts;
  let result;
  if (o.queries) result = await storeQueries({ work: o.work ?? '', queries: o.queries, root: o.root ?? '' });
  else if (o.said) result = await storeSaid({ clip: o.clip ?? '', said: o.said, root: o.root ?? '' });
  else if (o.clip) result = await pullFrames({ clip: o.clip, every: o.every ?? '', root: o.root ?? '' });
  else result = resultError('describe', 'E_SCAN_INTERNAL',
    'usage: node bin/describe.mjs --clip <path> --every <sec> [--root <dir>] | --clip <path> --said <file> | --work <name> --queries <file>', {});
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (result.ok) process.stdout.write(text);
  else {
    process.stderr.write(text);
    process.exit(1);
  }
}
