// T-05 — bin/pick.mjs. Read the sentence list and the per-clip records, run the three-layer
// funnel, write the shot list, and report every sentence that got no clip.
//
// Red-first: this file did not exist when test/pick.test.mjs was written, so the first run
// of that test failed with ERR_MODULE_NOT_FOUND (behaviour missing), not with a broken runner.
//
// The funnel, in the order the requirements document gives it:
//   1. duration  a clip that cannot cover the line from its own start is out. The length
//      estimate errs long on purpose, so "cannot cover" is honest, not a coin flip.
//   2. text      the English query against the words the user wrote about the clip, weighted
//      by rarity. Real stock and archive clips carry 20-32 tags and most of them are filler
//      ("Royalty Free"), so a word only one clip uses must outweigh them.
//   3. visual    optional. It runs only when the frames are still on disk.
// Layer 2 reads fromYou (the user's own words) and layer 3 reads fromMachine (what the frames
// said), so the two layers never blur into one score.

import {
  FILL, availableLength, DEMOTE_MIN_RATIO, displayWidth, FRAMES,
  CLIP_SCHEMA, SHOT_SCHEMA, blankShot, blankShots,
  resultOk, resultError,
} from '../lib/contract.mjs';
import { readJson, writeJson } from '../lib/json.mjs';
import { walk, MEDIA_EXT, jsonPathFor } from '../bin/index.mjs';
import { readFile, stat } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';

const SELF = fileURLToPath(import.meta.url);

// A Chinese character. A Chinese sentence shares no words with English tags, so layer 2
// needs the English query Claude wrote for it. Without that query the sentence is reported,
// never guessed at.
const CJK = /[\p{Script=Han}]/u;

// One reuse costs a quarter of the score. A clip used twice still beats a rival that is
// clearly worse, and a clip used four times is pushed to the bottom of its own pool.
const DEMOTE_STEP = 0.25;

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- word shapes

export function tokenize(text) {
  // Lower case, then split into Chinese runs and other words.
  // A Chinese word does not end at a space, so a Chinese run becomes overlapping two-
  // character pieces. Measured: a Chinese sentence's intersection with the English tags was
  // empty either way, so the bigrams only ever match other Chinese text.
  // A single Latin letter is an article ("a") or a fragment: it carries no keyword, and
  // letting it match made a sentence about a red door look like every clip in the folder.
  const out = [];
  const seen = new Set();
  const add = (t) => {
    if (t !== '' && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  let cjk = '';
  let word = '';
  const flushCjk = () => {
    if (cjk.length === 1) add(cjk);
    else for (let i = 0; i + 1 < cjk.length; i += 1) add(cjk.slice(i, i + 2));
    cjk = '';
  };
  const flushWord = () => {
    if (word.length > 1) add(word);
    word = '';
  };
  for (const ch of text.toLowerCase()) {
    if (CJK.test(ch)) {
      flushWord();
      cjk += ch;
      continue;
    }
    if (/[\p{L}\p{N}_]/u.test(ch)) {
      flushCjk();
      word += ch;
      continue;
    }
    flushCjk();
    flushWord();
  }
  flushCjk();
  flushWord();
  return out;
}

export function idf(df, total) {
  // Rarity weight. A word in one clip of four weighs log(5); the same word in all four
  // weighs log(2). Boilerplate tags sit in every clip, so their weight never grows with
  // the folder.
  return Math.log(1 + total / df);
}

export function scoreText(query, own, df) {
  // The weighted share of the query this clip covers, 0-100. A clip that covers none of it
  // scores 0, which is how "not relevant" is told from "a worse match".
  // The corpus total is the biggest document frequency, not the clip count: a tag that
  // appears in every clip is boilerplate, and its weight must not grow with the folder.
  const total = Math.max(Math.max(...Object.values(df), 1), 1);
  let all = 0;
  let covered = 0;
  for (const t of query) {
    // A term no clip uses is rare, so it gets the rarest weight: df 0 reads as 1.
    const w = idf(Math.max(df[t] ?? 0, 1), total);
    all += w;
    if (own.has(t)) covered += w;
  }
  if (all === 0) return 0;
  return Math.round(100 * covered / all);
}

export function estimateSec(text) {
  // The contract's estimate: 3 characters per second, which errs long on purpose.
  return displayWidth(text) / FILL.ESTIMATE_CHARS_PER_SEC;
}

export function demote(scores, useCount, best) {
  // Demote an already-used clip only among candidates scoring at least 80% of the best one,
  // so a weak clip is never punished for a sentence it was never a rival for.
  const out = { scores: { ...scores }, demotions: [] };
  for (const [clip, score] of Object.entries(scores)) {
    if (score < best * DEMOTE_MIN_RATIO) continue;
    const used = useCount[clip] ?? 0;
    if (used === 0) continue;
    const after = score * (1 - DEMOTE_STEP * used);
    out.scores[clip] = after;
    out.demotions.push({ clip, useCount: used, before: score, after });
  }
  return out;
}

// ------------------------------------------------------------- stage products

function parseScript(text) {
  // script.txt is stop 2's product: one numbered line per sentence. A line that does not
  // start with a number continues the sentence before it, so a wrapped sentence stays one
  // sentence.
  const rows = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\d{1,3})[.)]\s+(.+)$/.exec(line);
    if (m) rows.push({ id: `S-${m[1].padStart(3, '0')}`, sentence: m[2] });
    else if (rows.length) rows[rows.length - 1].sentence += ' ' + line;
  }
  return rows;
}

// The parts of a clip that can be used. A described window is the only honest one: a clip
// described only from 6 s on has nothing we know about before 6 s.
// Measured: allowing the whole clip next to the machine segment gave 2 shots where the test
// expects 1, so a described window replaces the whole clip, it does not add to it.
function windowsOf(rec, durationSec) {
  const usable = (list) => (list ?? []).filter(
    (s) => typeof s.startSec === 'number' && typeof s.endSec === 'number' && s.endSec > s.startSec,
  );
  const machine = usable(rec.fromMachine?.segments);
  if (machine.length) return machine;
  const yours = usable(rec.fromYou?.segments);
  if (yours.length) return yours;
  return [{ startSec: 0, endSec: durationSec }];
}

// Layer 2's haystack: the user's own words. Layer 3's: what the frames said.
function ownText(rec) {
  const you = rec.fromYou ?? {};
  return `${you.description ?? ''} ${(you.tags ?? []).join(' ')}`;
}
function machineText(rec) {
  const parts = (rec.fromMachine?.segments ?? []).map(
    (s) => `${s.description ?? ''} ${(s.tags ?? []).join(' ')}`,
  );
  return parts.join(' ');
}

// --------------------------------------------------------------------- the plan

export async function plan(opts) {
  const work = opts.work ?? '';
  const assets = opts.assets ?? '';
  const root = opts.root || assets;
  const aspect = opts.aspect ?? '';

  if (!work || !assets) {
    return resultError('pick', 'E_PICK_ARGS',
      'usage: node bin/pick.mjs --work <name> --assets <dir> [--root <dir>] --aspect <landscape|portrait>', {});
  }
  if (!Object.hasOwn(FRAMES, aspect)) {
    return resultError('pick', 'E_PICK_ASPECT_UNKNOWN',
      `--aspect ${aspect} is not one of the target frames (${Object.keys(FRAMES).join(', ')}): the shot list stores the aspect the renderer will read`,
      { aspect, allowed: Object.keys(FRAMES) });
  }

  // Stop rule (NEW-2): the stage reads the previous stage's product. No file means stop and
  // say so, never invent one.
  const workDir = join(root, '.narrate', work);
  const scriptPath = join(workDir, 'script.txt');
  let scriptText;
  try {
    scriptText = await readFile(scriptPath, 'utf8');
  } catch (e) {
    return resultError('pick', 'E_PICK_SCRIPT_MISSING',
      `no script.txt for this work folder (${scriptPath}): stop 2 never ran, so the sentence list is not there to read`,
      { work, scriptPath });
  }
  const rows = parseScript(scriptText);
  if (!rows.length) {
    return resultError('pick', 'E_PICK_SCRIPT_EMPTY',
      `script.txt is there but holds no numbered sentence: ${scriptPath}`, { scriptPath });
  }

  // The English queries Claude wrote at stop 2. A missing file is not an error here: a
  // sentence with no query is reported below, not guessed at.
  const queries = {};
  const gotQueries = await readJson(join(workDir, 'queries.json'));
  if (gotQueries.ok) {
    for (const q of gotQueries.value.queries ?? []) {
      if (typeof q.id === 'string') queries[q.id] = q.query ?? '';
    }
  }

  const listing = await walk(assets);
  const found = listing.files.filter((f) => MEDIA_EXT.has(extname(f.abs).slice(1).toLowerCase()));
  const clipErrors = [];
  const records = [];
  for (const f of found) {
    const clipName = basename(f.abs);
    const got = await readJson(jsonPathFor(f.abs));
    if (!got.ok) {
      // One bad clip never sinks the run: report it, keep the rest.
      clipErrors.push({ clip: clipName, error: 'E_PICK_CLIP_UNINDEXED', message: got.message });
      continue;
    }
    if (got.value.schema !== CLIP_SCHEMA) {
      clipErrors.push({ clip: clipName, error: 'E_PICK_CLIP_UNINDEXED', message: `the record beside ${clipName} is not ours (schema ${got.value.schema ?? 'none'})` });
      continue;
    }
    const rec = got.value;
    const durationSec = Number(rec.measured?.durationSec ?? 0);
    if (!(durationSec > 0)) {
      clipErrors.push({ clip: clipName, error: 'E_PICK_CLIP_UNINDEXED', message: `the record beside ${clipName} has no measured length` });
      continue;
    }
    records.push({
      rec,
      clipName,
      abs: f.abs,
      durationSec,
      windows: windowsOf(rec, durationSec),
      own: new Set(tokenize(ownText(rec))),
    });
  }
  if (!records.length) {
    return resultError('pick', 'E_PICK_INDEX_MISSING',
      found.length
        ? `no clip in ${assets} has an index record: run bin/index.mjs --assets ${assets} first, so pick has measured lengths and your own words to match against`
        : `no media file was found under ${assets}: run bin/index.mjs --assets ${assets} first, so pick has an index to read`,
      { assets, clipErrors });
  }

  // The corpus for layer 2: how many clips use each of the user's words.
  const df = {};
  for (const r of records) for (const t of r.own) df[t] = (df[t] ?? 0) + 1;

  // Layer 3 needs the frames. A named folder that is gone means the clip moved: fall back
  // to text and say so. An empty name means the visual layer was never asked for: silent.
  const visualMissing = [];
  for (const r of records) {
    const dir = r.rec?.fromMachine?.visualSearchDir ?? '';
    r.visualDir = dir;
    r.visualOnDisk = dir !== '' && await exists(dir);
    if (r.visualOnDisk) r.visual = new Set(tokenize(machineText(r.rec ?? {})));
    else if (dir !== '') {
      visualMissing.push({ clip: r.clipName, reason: `the visual search folder ${dir} is not on disk: the frames were moved, so matching falls back to text` });
    }
  }

  const shots = [];
  const missing = [];
  const noEnglishQuery = [];
  const demotions = [];
  const used = new Map(); // clip name -> the sentence ids it already took
  const layers = {
    duration: { considered: 0, dropped: 0, kept: 0 },
    text: { considered: 0, zero: 0 },
    visual: { considered: 0, missing: visualMissing.length },
  };

  for (const row of rows) {
    const id = row.id;
    const sentence = row.sentence;
    const need = estimateSec(sentence);
    const query = queries[id] ?? '';
    const hasEnglish = query !== '' && !CJK.test(query);
    if (!hasEnglish) {
      noEnglishQuery.push({ id, sentence, reason: query === '' ? 'no English query was written for this sentence' : 'the query is not English' });
    }
    const queryTokens = hasEnglish ? tokenize(query) : [];

    const candidates = [];
    const tooShort = [];
    const notRelevant = [];
    for (const r of records) {
      layers.duration.considered += 1;
      // The best window of this clip: the one that can cover the most.
      let best = null;
      for (const win of r.windows) {
        const avail = availableLength(win.endSec, r.durationSec, win.startSec);
        if (!best || avail > best.avail) best = { startSec: win.startSec, endSec: win.endSec, avail };
      }
      // The estimate errs long, so a small shortfall is still usable. A big one is not.
      if (best.avail < need && (need - best.avail) / need > FILL.SLOW_LIMIT) {
        layers.duration.dropped += 1;
        tooShort.push({ clip: r.clipName, availableSec: best.avail, needSec: need });
        continue;
      }
      layers.duration.kept += 1;
      layers.text.considered += 1;
      const textScore = scoreText(queryTokens, r.own, df);
      let visualScore = 0;
      if (r.visualOnDisk) {
        layers.visual.considered += 1;
        visualScore = scoreText(queryTokens, r.visual, df);
      }
      const score = Math.max(textScore, visualScore);
      if (score === 0) {
        layers.text.zero += 1;
        notRelevant.push({ clip: r.clipName, score: 0 });
        continue;
      }
      candidates.push({
        clipName: r.clipName,
        abs: r.abs,
        score,
        chosenBy: visualScore > textScore ? 'visual' : 'text',
        win: best,
      });
    }

    if (!candidates.length) {
      missing.push({ id, reason: 'no clip', sentence, tooShort, notRelevant });
      continue;
    }

    const scores = {};
    const useCount = {};
    for (const c of candidates) {
      scores[c.clipName] = c.score;
      useCount[c.clipName] = (used.get(c.clipName) ?? []).length;
    }
    const best = Math.max(...Object.values(scores));
    const dem = demote(scores, useCount, best);
    for (const d of dem.demotions) demotions.push(d);

    // Forbid A then B then A: the clip used two sentences back is out when the sentence
    // before used a different clip. If that leaves nothing, the ban is dropped rather than
    // leaving a sentence with no clip.
    const chosen = shots.map((s) => basename(s.assetPath));
    let pool = candidates;
    if (chosen.length >= 2) {
      const twoBack = chosen[chosen.length - 2];
      if (twoBack !== chosen[chosen.length - 1]) {
        const without = candidates.filter((c) => c.clipName !== twoBack);
        if (without.length) pool = without;
      }
    }
    const ranked = pool.slice().sort((a, b) => {
      const as = dem.scores[a.clipName];
      const bs = dem.scores[b.clipName];
      if (as !== bs) return bs - as;
      return a.clipName < b.clipName ? -1 : (a.clipName > b.clipName ? 1 : 0);
    });
    const pick = ranked[0];

    const shot = { ...blankShot(id) };
    shot.sentence = sentence;
    shot.assetPath = pick.abs;
    shot.startSec = pick.win.startSec;
    // The shot ends at the described end, or where the line is done, whichever is first.
    shot.endSec = Math.min(pick.win.endSec, pick.win.startSec + need);
    shot.query = query;
    shot.chosenBy = pick.chosenBy;
    // The row keeps the match quality before the reuse penalty, so "why this clip" stays
    // checkable against the words, not against our own bookkeeping.
    shot.score = pick.score;
    // fill, slowTo and overflow stay as the contract blank has them: that decision needs
    // the real audio, which bin/segment.mjs measures.
    shots.push(shot);
    const ids = used.get(pick.clipName) ?? [];
    ids.push(id);
    used.set(pick.clipName, ids);
  }

  // The shot list is the stage product the renderer reads. Nothing is written beside a clip:
  // pick only reads inside assets.
  const doc = blankShots(work, aspect);
  doc.shots = shots;
  const shotsPath = join(workDir, 'shots.json');
  const wrote = await writeJson(shotsPath, doc);
  if (!wrote.ok) {
    return resultError('pick', 'E_PICK_WRITE_FAILED',
      `the shot list could not be written at ${shotsPath}: ${wrote.message}`,
      { shotsPath, work });
  }

  return resultOk('pick', {
    work,
    aspect,
    shots,
    missing,
    noEnglishQuery,
    useCount: [...used.entries()].map(([clip, ids]) => ({ clip, count: ids.length, ids })).sort((a, b) => a.clip < b.clip ? -1 : 1),
    demotions,
    clipErrors,
    visualMissing,
    layers,
    sentences: rows.length,
    considered: records.length,
  });
}

// ------------------------------------------------------------------------ the CLI

async function isMain() {
  // Measured: fs.Stats has no realpath field, so compare realpath(), which returns a string.
  try {
    return (await realpath(process.argv[1])) === (await realpath(SELF));
  } catch {
    return false;
  }
}

if (await isMain()) {
  function parseArgv(argv) {
    const opts = {};
    for (let i = 0; i < argv.length; i += 1) {
      if (!argv[i].startsWith('--')) return { ok: false, message: `"${argv[i]}" is not a --flag` };
      const name = argv[i].slice(2);
      if (i + 1 >= argv.length) return { ok: false, message: `--${name} has no value` };
      opts[name] = argv[i + 1];
      i += 1;
    }
    return { ok: true, opts };
  }

  const parsed = parseArgv(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${JSON.stringify(resultError('pick', 'E_PICK_ARGS', parsed.message, {}), null, 2)}\n`);
    process.exit(1);
  }
  const result = await plan(parsed.opts);
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (result.ok) process.stdout.write(text);
  else {
    process.stderr.write(text);
    process.exit(1);
  }
}
