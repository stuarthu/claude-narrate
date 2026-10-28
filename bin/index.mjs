// T-03 — bin/index.mjs. Walk the assets folder, read the seven input sources, write one
// JSON beside each clip, and report what happened.
// Red-first: this file did not exist when test/index.test.mjs was written, so the first
// test run failed with ERR_MODULE_NOT_FOUND (behaviour missing), not with a broken runner.
//
// Two rules drive every choice here.
// - rule 1: we never change a key we did not create. A stock-site json beside a clip keeps
//   its own keys and only gains ours.
// - rule 4: measure, do not believe. The length comes from ffprobe on every scan, never
//   from a stored field and never from what a model thought the clip looked like.

import { CLIP_SCHEMA, blankIndex, resultOk, resultError } from '../lib/contract.mjs';
import { readJson, writeJson, copyOnce } from '../lib/json.mjs';
import { run } from '../lib/run.mjs';
import { readdir, stat, readFile, realpath } from 'node:fs/promises';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

// The extensions we are willing to cut. Anything else in the assets folder is reported,
// not guessed at: E_UNKNOWN_MEDIA means "we do not know how to cut this".
const MEDIA_EXT = new Set(['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mpg', 'mpeg',
  'mts', 'm2ts', 'ts', 'flv', 'wmv', 'gif']);

// Files we (or a stock site) write beside a clip. They are metadata, never clips.
function isOwnSidecar(name) {
  return name.endsWith('.json') || name.endsWith('.json.bak')
    || name.endsWith('.narrate.txt') || name.endsWith('.csv');
}

// The seven input sources, highest precedence first (section 11 of the requirements).
const RANK = { conversation: 1, handEdit: 2, sidecar: 3, csv: 4, stockJson: 5, filename: 6, folder: 7 };

// rule 3, measured: four clips tagged 1080p / H.264 included a 640x360, a 532x300 and a
// vp8 one, so a tag that names the file's technical shape is a lie about its content.
// Boilerplate like "Royalty Free" is a real keyword: pick.mjs gives it a low rarity weight
// instead of deleting it here.
const FILLER = [
  /^\d{3,4}[ip]$/i,                       // 1080p, 720i
  /^\d+p?fps$/i,                          // 60fps
  /^(hd|uhd|4k|8k)$/i,                    // filler that says nothing about the picture
  /^(h\.?264|h\.?265|h\.?evc|hevc|x264|x265|vp8|vp9|avc|mpeg|mp4|mov|mkv|webm|avi|flv)$/i,
];
function keepTag(tag) {
  const t = tag.trim();
  if (!t) return false;
  return !FILLER.some((re) => re.test(t));
}

function shapeOf(width, height) {
  // 0 unknown, 1 portrait, 2 landscape, 3 square. The shot list needs the aspect class,
  // not the pixel size, so a 640x360 clip and a 1920x1080 clip are both 2.
  if (!width || !height) return 0;
  if (width === height) return 3;
  return width > height ? 2 : 1;
}

function jsonPathFor(absPath) {
  return `${absPath.replace(/\.[^.]*$/, '')}.json`;
}

// ------------------------------------------------------------------ the walk

async function walk(root) {
  // Symlinks are followed so a clip on an external drive is found.
  // The guard is the chain of real folder paths on the current descent: a folder that
  // contains itself would loop forever. A folder reached by two different paths IS walked
  // twice on purpose, so the second path can be reported as an alias rather than dropped.
  // Measured: fs.Stats has no realpath field, so the guard uses realpath(), which returns a string.
  const files = [];
  const unreadableDirs = [];
  const brokenLinks = [];   // a link that points at nothing: reported per entry, not a folder-level problem
  let listings = 0;
  const LISTING_BUDGET = 5000;   // a runaway walk is a bug, not something to hang CI on

  const step = async (abs, rel, chain) => {
    if (listings >= LISTING_BUDGET) return;
    listings += 1;
    let real = null;
    try { real = await realpath(abs); } catch { real = abs; }
    if (chain.includes(real)) return;   // cycle: stop here, do not hang
    const below = [...chain, real];
    let items;
    try {
      items = await readdir(abs, { withFileTypes: true });
    } catch (err) {
      unreadableDirs.push({ rel, message: `cannot list ${err.code ?? err}` });
      return;
    }
    for (const e of (items)) {
      if (e.name.startsWith('.')) continue;
      const childAbs = join(abs, e.name);
      const childRel = rel === '' ? e.name : join(rel, e.name);
      if (e.isSymbolicLink()) {
        // readdir does not follow a link, so ask stat (which does) what it points at.
        let target;
        try { target = await stat(childAbs); }
        catch { brokenLinks.push({ rel: childRel, message: 'the link points at nothing' }); continue; }
        if (target.isDirectory()) await step(childAbs, childRel, below);
        else files.push({ rel: childRel, abs: childAbs });
      } else if (e.isDirectory()) {
        await step(childAbs, childRel, below);
      } else {
        files.push({ rel: childRel, abs: childAbs });
      }
    }
  };

  await step(root, '', []);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, unreadableDirs, brokenLinks, listings };
}

// ------------------------------------------------------------------ one clip

async function probe(path) {
  // One ffprobe call gives the length and the picture shape. The exit code alone is not
  // trusted: the file must also decode. Measured on this host: ffprobe prints
  // {"streams":[{"codec_name":"h264","width":320,"height":240}],"format":{"duration":"4.000000"}}
  // for a 4 second test clip, and exits 8 with "Unknown encoder" when asked for a codec
  // that is not built in (the encoder name here is h264, not x264).
  const r = await run(['ffprobe', '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_name,width,height',
    '-of', 'json', '-i', path]);
  if (!r.ok || r.code !== 0) {
    return { ok: false, message: `ffprobe could not read it (exit ${r.code ?? 'spawn failed'}): ${(r.stderr || r.stdout).trim()}` };
  }
  let parsed;
  try { parsed = JSON.parse(r.stdout); }
  catch { return { ok: false, message: 'ffprobe printed nothing parseable' }; }
  const raw = parsed?.format?.duration;
  const stream = (parsed?.streams ?? [])[0] ?? {};
  const durationSec = Number(raw);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return { ok: false, message: `no usable duration (got ${JSON.stringify(raw)})` };
  }
  return { ok: true, durationSec, width: Number(stream.width ?? 0), height: Number(stream.height ?? 0) };
}

function fingerprintOf(st) {
  // size + mtime, and deliberately no path: moving the folder must not invalidate fromMachine.
  return `size:${st.size}|mtime:${Math.round(st.mtimeMs / 1000)}`;
}

function parseSidecar(text) {
  // The sidecar text file beside a clip: first line is the description, a line starting
  // with # is a tag (several on one line split on ;), everything else becomes notes.
  const lines = text.split('\n');
  const description = (lines[0] ?? '').trim();
  const tags = [];
  const notes = [];
  for (const line of lines.slice(1)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) tags.push(...t.slice(1).split(';'));
    else notes.push(t);
  }
  return { description, tags, notes: notes.join('\n') };
}

function parseCsv(text) {
  // A small csv reader: the tags column is quoted and holds ; inside it.
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted && ch === ',') { row.push(field); field = ''; continue; }
    if (!quoted && ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (!quoted && ch === '\r') continue;
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function readCsv(root) {
  // clips.csv lives in the asset root only (section 11).
  const path = join(root, 'clips.csv');
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (err) {
    if ((err.code ?? '') === 'ENOENT') return { ok: true, rows: new Map(), conflicts: [] };
    return { ok: false, message: `clips.csv cannot be read (${err.code ?? err})`, rows: new Map(), conflicts: [] };
  }
  const rows = parseCsv(text);
  const head = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  const iFile = head.indexOf('file');
  const iDesc = head.indexOf('description');
  const iTags = head.indexOf('tags');
  if (iFile < 0) return { ok: false, message: 'clips.csv has no file column', rows: new Map(), conflicts: [] };
  const map = new Map();
  const conflicts = [];
  for (const row of rows) {
    if (!row.length || (row.length === 1 && !row[0])) continue;
    const file = (row[iFile] ?? '').trim();
    if (!file) continue;
    const entry = {
      description: (iDesc >= 0 ? row[iDesc] : '').trim(),
      tags: (iTags >= 0 ? row[iTags] : '').split(';'),
    };
    if (map.has(file)) {
      if (map.get(file).description !== entry.description) {
        conflicts.push({ file, message: 'two rows in clips.csv give different descriptions' });
      }
      continue;
    }
    map.set(file, entry);
  }
  return { ok: true, rows: map, conflicts };
}

// ------------------------------------------------------------------ the scan

export async function scanAssets(opts) {
  const assets = opts.assets;
  const told = opts.told ?? {};
  const dry = opts.dry ?? false;

  const errors = [];
  const records = [];
  const aliases = [];
  const foreign = [];
  const written = [];
  const backup = [];
  const visualSearchDirInvalid = [];
  const needsUnderstanding = [];
  const out = [];   // one result record per clip that got a record
  let reUnderstands = 0;

  // 1. the root itself
  try { await stat(assets); }
  catch {
    return resultError('scan', 'E_ASSETS_ROOT_UNREADABLE',
      `the assets folder ${assets} cannot be listed`, { assets });
  }

  // 2. the walk
  const walked = await walk(assets);
  if (walked.unreadableDirs.length) {
    return resultError('scan', 'E_ASSETS_ROOT_UNREADABLE',
      `a folder inside the assets tree cannot be listed: ${walked.unreadableDirs[0].rel}`,
      { assets, folders: walked.unreadableDirs.map((d) => d.rel) });
  }

  // a broken link is one entry's problem, not the folder's: report it and keep scanning.
  for (const b of walked.brokenLinks) {
    errors.push({ clip: b.rel, error: 'E_ASSET_MISSING', message: b.message });
  }

  // 3. drop our own metadata files; everything else in the tree is a media candidate
  const candidates = walked.files.filter((f) => !isOwnSidecar(basename(f.rel)));
  const totalWalked = candidates.length;

  // 4. one real file on disk gets one record. Two paths that reach the same file would
  // fight over one sidecar, so the second path is reported as an alias instead.
  const byReal = new Map();
  for (const f of candidates) {
    let real;
    try { real = await realpath(f.abs); } catch { real = f.abs; }
    if (byReal.has(real)) {
      aliases.push({ clip: f.rel, also: byReal.get(real) });
      continue;
    }
    byReal.set(real, f.rel);
    records.push(f);
  }

  // 5. a stem collision is the one folder-level problem that stops everything: a.mp4 and
  // a.mov would both write a.json. Checked before any file is written.
  const byStem = new Map();
  for (const f of records) {
    const stem = basename(f.rel).replace(/\.[^.]*$/, '');
    const key = `${dirname(f.rel)}/${stem}`;
    if (byStem.has(key)) {
      return resultError('scan', 'E_STEM_COLLISION',
        `two clips in one folder would write the same ${stem}.json`,
        { assets, names: [byStem.get(key), f.rel].sort() });   // sorted: the report order must not depend on readdir
    }
    byStem.set(key, f.rel);
  }

  // 6. clips.csv is read once for the whole scan
  const csv = await readCsv(assets);
  if (!csv.ok) {
    return resultError('scan', 'E_SOURCE_UNREADABLE', csv.message, { assets, source: 'clips.csv' });
  }
  for (const c of csv.conflicts) {
    errors.push({ clip: c.file, error: 'E_SOURCE_CONFLICT', message: c.message });
  }

  for (const f of records) {
    const ext = extname(f.rel).toLowerCase().replace(/^\./, '');
    if (!MEDIA_EXT.has(ext)) {
      // reported, not guessed: we do not know how to cut this file
      errors.push({ clip: f.rel, error: 'E_UNKNOWN_MEDIA', message: `extension .${ext} is not one we can cut` });
      continue;
    }

    // rule 6: one bad clip never sinks a scan. Every clip catches its own error, and the
    // list is reported at the end.
    const media = await probe(f.abs);
    if (!media.ok) {
      errors.push({ clip: f.rel, error: 'E_ASSET_UNREADABLE', message: media.message });
      continue;
    }

    const st = await stat(f.abs);
    const fp = fingerprintOf(st);
    const jsonPath = jsonPathFor(f.abs);

    let existing = null;
    let hasJson = false;
    try { await stat(jsonPath); hasJson = true; } catch { hasJson = false; }
    if (hasJson) {
      const got = await readJson(jsonPath);
      if (!got.ok) {
        errors.push({ clip: f.rel, error: 'E_CLIP_JSON_UNREADABLE', message: got.message });
        continue;
      }
      if (typeof got.value !== 'object' || Array.isArray(got.value)) {
        errors.push({ clip: f.rel, error: 'E_FOREIGN_JSON',
          message: 'the json beside this clip is not an object, so there is nothing to merge into' });
        continue;
      }
      if (got.value.schema && got.value.schema !== CLIP_SCHEMA) {
        errors.push({ clip: f.rel, error: 'E_CLIP_SCHEMA_UNKNOWN',
          message: `the sidecar claims schema ${got.value.schema}, not ${CLIP_SCHEMA}` });
        continue;
      }
      existing = got.value;
    }

    const ours = existing && existing.schema === CLIP_SCHEMA;
    const base = blankIndex(f.rel);
    const merged = existing ? { ...existing } : { ...base };

    // measured is re-measured every scan, never trusted from what is stored
    merged.measured = { shape: shapeOf(media.width, media.height), durationSec: media.durationSec };

    // fromMachine is rewritten wholesale only when the fingerprint changed
    const fpChanged = !existing || existing.fingerprint !== fp;
    if (fpChanged) {
      merged.fromMachine = { ...base.fromMachine };
      if (existing?.fromMachine?.segments?.some((s) => (s.description ?? '') !== '')) reUnderstands += 1;
    } else {
      merged.fromMachine = { ...base.fromMachine, ...(existing.fromMachine ?? {}) };
    }

    // fromYou is never rewritten. A description is written once: we fill only an empty
    // field, and clearing a field is how a user asks us to fill it again (rule 2).
    const fy = { ...base.fromYou, ...(existing?.fromYou ?? {}) };
    const origin = { ...base.fromYou.origin, ...(existing?.fromYou?.origin ?? {}) };
    merged.fromYou = fy;
    fy.origin = origin;

    const descCands = [];
    const tagCands = [];

    if (told[f.rel]?.description) {
      descCands.push({ rank: RANK.conversation, name: 'conversation', text: told[f.rel].description });
    }
    if (!ours && existing) {
      // the json already beside the clip: we read its keys, we never rewrite them
      if (typeof existing.description === 'string' && existing.description.trim()) {
        descCands.push({ rank: RANK.stockJson, name: 'stockJson', text: existing.description });
      }
      if (Array.isArray(existing.tags)) {
        tagCands.push({ rank: RANK.stockJson, name: 'stockJson', tags: existing.tags });
      }
    }
    const sidecarPath = `${f.abs}.narrate.txt`;
    try {
      const side = parseSidecar(await readFile(sidecarPath, 'utf8'));
      if (side.description) descCands.push({ rank: RANK.sidecar, name: 'sidecar', text: side.description });
      if (side.tags.length) tagCands.push({ rank: RANK.sidecar, name: 'sidecar', tags: side.tags });
      if (side.notes && fy.notes === '') fy.notes = side.notes;
    } catch (err) {
      if ((err.code ?? '') !== 'ENOENT') {
        errors.push({ clip: f.rel, error: 'E_SOURCE_UNREADABLE',
          message: `the sidecar text file beside this clip cannot be read (${err.code ?? err})` });
      }
    }
    const csvRow = csv.rows.get(basename(f.rel));
    if (csvRow) {
      if (csvRow.description) descCands.push({ rank: RANK.csv, name: 'csv', text: csvRow.description });
      if (csvRow.tags.length) tagCands.push({ rank: RANK.csv, name: 'csv', tags: csvRow.tags });
    }
    const stemWords = basename(f.rel).replace(/\.[^.]*$/, '').split(/[-_\s]+/).filter(Boolean);
    if (stemWords.length) tagCands.push({ rank: RANK.filename, name: 'filename', tags: stemWords });
    descCands.push({ rank: RANK.filename, name: 'filename', text: stemWords.join(' ') });
    const folder = dirname(f.rel);
    if (folder !== '.') {
      const leaf = folder.split('/').pop();
      if (leaf) tagCands.push({ rank: RANK.folder, name: 'folder', tags: [leaf] });
    }

    // the description: an explicit line from the conversation wins, otherwise we fill only
    // an empty field with the highest-ranked source
    let descriptionFrom = null;
    const toldDesc = descCands.find((c) => c.rank === RANK.conversation);
    if (toldDesc && fy.description !== toldDesc.text) {
      fy.description = toldDesc.text;
      origin.description = toldDesc.text;
      if (!fy.sources.includes('conversation')) fy.sources.push('conversation');
      if (!origin.derived.includes('conversation')) origin.derived.push('conversation');
      descriptionFrom = 'conversation';
    } else if (fy.description === '') {
      const best = descCands
        .filter((c) => (c.text ?? '').trim() !== '')
        .sort((a, b) => a.rank - b.rank)[0];
      if (best) {
        fy.description = best.text;
        origin.description = best.text;
        if (!fy.sources.includes(best.name)) fy.sources.push(best.name);
        if (!origin.derived.includes(best.name)) origin.derived.push(best.name);
        descriptionFrom = best.name;
      }
    } else {
      descriptionFrom = fy.sources[0] ?? 'handEdit';
    }

    // tags merge, deduplicated, and the filter drops only technical filler (rule 3)
    for (const cand of tagCands.sort((a, b) => a.rank - b.rank)) {
      const added = [];
      for (const raw of cand.tags) {
        const tag = raw.trim();
        if (!keepTag(tag)) continue;
        if (fy.tags.includes(tag)) continue;
        if (added.includes(tag)) continue;
        added.push(tag);
      }
      if (!added.length) continue;
      fy.tags.push(...added);
      origin.tags.push(...added);
      if (!fy.sources.includes(cand.name)) fy.sources.push(cand.name);
      if (!origin.derived.includes(cand.name)) origin.derived.push(cand.name);
    }

    merged.schema = CLIP_SCHEMA;   // a json beside a clip gains our key, and only ours
    merged.fingerprint = fp;
    merged.clip = f.rel;

    // a json we did not write is copied to .json.bak exactly once before we touch it, so
    // the original bytes are still there if a future version reads it
    if (existing && !ours) {
      const bak = `${jsonPath}.bak`;
      const copied = await copyOnce(jsonPath, bak);
      if (!copied.ok) {
        errors.push({ clip: f.rel, error: 'E_BACKUP_FAILED', message: copied.message });
        continue;
      }
      if (copied.copied) backup.push(bak.replace(`${assets}/`, ''));
      foreign.push(basename(jsonPath));
    }

    if (!dry) {
      const wrote = await writeJson(jsonPath, merged);
      if (!wrote.ok) {
        errors.push({ clip: f.rel, error: 'E_SCAN_INTERNAL', message: wrote.message });
        continue;
      }
      written.push(jsonPath.replace(`${assets}/`, ''));
    }

    // a stored visual-search folder is path-based, so a move invalidates it. That is
    // reported, not an error: matching falls back to text (A-25, and the move rule).
    const dir = merged.fromMachine.visualSearchDir;
    if (dir) {
      try { await stat(dir); }
      catch { visualSearchDirInvalid.push(f.rel); }
    }

    if (!merged.fromMachine.segments.some((s) => (s.description ?? '') !== '')) {
      needsUnderstanding.push(f.rel);
    }

    out.push({
      clip: f.rel,
      json: jsonPath.replace(`${assets}/`, ''),
      fingerprint: fp,
      durationSec: media.durationSec,
      shape: merged.measured.shape,
      description: fy.description,
      descriptionFrom,
      tags: [...fy.tags],
      sources: [...fy.sources],
      needsUnderstanding: !merged.fromMachine.segments.some((s) => (s.description ?? '') !== ''),
    });
  }

  return resultOk('scan', {
    assets,
    walked: totalWalked,
    clips: out,
    needsUnderstanding,
    understandCalls: 0,
    reUnderstands,
    foreign,
    aliases,
    errors,
    visualSearchDirInvalid,
    written,
    backup,
  });
}

// ---------------------------------------------------------------- the command line
// SPEC section 3: one JSON object on stdout and nothing else. An error goes to stderr as
// JSON and the script exits non-zero, so the agent can never ignore a silent script.

async function isMain() {
  // true when run as a command (node bin/index.mjs), false when a test imports it.
  // Measured: fs.Stats has no realpath field, so compare realpath(), which returns a string.
  try { return (await realpath(process.argv[1])) === (await realpath(SELF)); }
  catch { return false; }
}

function parseArgs(argv) {
  const opts = { assets: '', told: {}, dry: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--assets') { opts.assets = argv[i + 1] ?? ''; i += 1; continue; }
    if (flag === '--dry') { opts.dry = true; continue; }
    if (flag === '--told') {
      const raw = argv[i + 1] ?? '';
      i += 1;
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch { return { ok: false, message: `--told is not valid JSON: ${raw}` }; }
      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, message: '--told must be a JSON object keyed by clip path' };
      }
      opts.told = parsed;
      continue;
    }
    return { ok: false, message: `unknown argument ${flag}` };
  }
  if (!opts.assets) {
    return { ok: false, message: 'usage: node bin/index.mjs --assets <path> [--told <json>] [--dry]' };
  }
  return { ok: true, opts };
}

if (await isMain()) {
  const parsed = await parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${JSON.stringify(resultError('scan', 'E_SCAN_INTERNAL', parsed.message, {}), null, 2)}\n`);
    process.exit(1);
  }
  const result = await scanAssets(parsed.opts);
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (result.ok) process.stdout.write(text);
  else {
    process.stderr.write(text);
    process.exit(1);
  }
}
