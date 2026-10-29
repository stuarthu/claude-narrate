// T-06 — the voice step: one sentence becomes one real .wav.
//
// The order is fixed and measured, not a guess: run the engine -> check the file -> trim
// silence -> measure. Measuring first makes the picture longer than the voice, which is
// the bug this step exists to avoid. The exit code is never trusted on its own: an engine
// that exits 0 and writes nothing is the most common engine bug, and a good file with a
// bad exit code still counts.
//
// The engine itself lives in config/engines.json (A-14): swapping an engine changes that
// file only, never this code. The default engine needs no API key (A-13).
import {
  VOICE, RESULT_SCHEMA, resultOk, resultError, SHOT_SCHEMA, parseScript,
} from '../lib/contract.mjs';
import { readJson, ensureDir } from '../lib/json.mjs';
import { run } from '../lib/run.mjs';
import { readFile, writeFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';

const SELF = fileURLToPath(import.meta.url);

const FLAGS = { '--work': 1, '--engine': 1, '--root': 1, '--config': 1, '--only': 1, '--timeout': 1 };

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

export async function speak(opts = {}) {
  const root = opts.root ?? process.cwd();
  const work = opts.work;
  if (!work) {
    return resultError('voice', 'E_VOICE_ARGS',
      'usage: node bin/voice.mjs --work <name> [--engine <name>] [--root <dir>] [--config <path>] [--only S-002,S-003] [--timeout <ms>]');
  }

  const dir = join(root, '.narrate', work);
  const audioDir = join(dir, 'audio');
  const scriptPath = join(dir, 'script.txt');
  const shotsPath = join(dir, 'shots.json');

  // Stop rule (NEW-2): this stage reads stop 2's product. No file means stop 2 never ran,
  // so it stops and says so. It never invents a script.
  let scriptText;
  try {
    scriptText = await readFile(scriptPath, 'utf8');
  } catch (e) {
    return resultError('voice', 'E_VOICE_SCRIPT_MISSING',
      `no script here: ${scriptPath} is not there, so stop 2 never ran. Write the numbered script first.`,
      { work, scriptPath });
  }

  // And stop 3's product. The audio is for the sentences the plan will render, so a run
  // with no shot list has nothing to speak for.
  const shots = await readJson(shotsPath);
  if (!shots.ok) {
    const why = shots.code === 'ENOENT' ? 'is not there, so stop 3 never ran'
      : `cannot be read (${shots.code}: ${shots.message ?? ''})`;
    return resultError('voice', 'E_VOICE_SHOTS_MISSING',
      `no shot list here: ${shotsPath} ${why}. Run the pick step first.`,
      { work, shotsPath });
  }
  if (shots.value.schema !== SHOT_SCHEMA) {
    return resultError('voice', 'E_VOICE_SHOTS_MISSING',
      `${shotsPath} is not a shot list we wrote (schema ${shots.value.schema}, wanted ${SHOT_SCHEMA}).`,
      { work, shotsPath });
  }

  const rows = parseScript(scriptText);
  if (!rows.length) {
    return resultError('voice', 'E_VOICE_SCRIPT_MISSING',
      `${scriptPath} is there but holds no numbered sentence.`, { work, scriptPath });
  }

  const configPath = opts.config ?? join(process.cwd(), 'config', 'engines.json');
  const cfg = await readJson(configPath);
  if (!cfg.ok) {
    return resultError('voice', 'E_VOICE_CONFIG_UNREADABLE',
      `cannot read the engine config: ${configPath} (${cfg.code} ${(cfg.message ?? '').trim()})`.trim(),
      { work, configPath });
  }
  const engines = cfg.value.engines;
  if (typeof engines !== 'object') {
    return resultError('voice', 'E_VOICE_CONFIG_INVALID',
      `${configPath} has no engines to run.`, { work, configPath });
  }
  const names = Object.keys(engines);
  const name = opts.engine ?? cfg.value.default ?? (names.length === 1 ? names[0] : null);
  if (!name) {
    return resultError('voice', 'E_VOICE_CONFIG_INVALID',
      `${configPath} names no default engine and there is more than one: ${names.join(', ')}. Pass --engine.`,
      { work, configPath });
  }
  const eng = engines[name];
  if (!eng || !Array.isArray(eng.argv) || !eng.argv.length) {
    return resultError('voice', 'E_ENGINE_NOT_CONFIGURED',
      `engine "${name}" is not in ${configPath} as something we can run. Engines here: ${names.join(', ')}.`,
      { work, configPath, engine: name });
  }

  const ext = eng.ext ?? 'wav';
  const timeoutMs = Number(opts.timeout ?? eng.timeoutMs ?? VOICE.timeoutMs);
  const planned = new Set((shots.value.shots ?? []).map((s) => s.id));

  const only = opts.only
    ? new Set(opts.only.split(',').map((s) => s.trim()).filter(Boolean))
    : null;
  const wanted = rows.filter((r) => !only || only.has(r.id));
  const onlyUnknown = only
    ? [...only].filter((id) => !rows.some((r) => r.id === id))
    : [];

  await ensureDir(audioDir);

  const audio = [];
  const failed = [];
  let groupKill = null;

  for (const row of wanted) {
    const out = join(audioDir, `${row.id}.wav`);
    const raw = join(audioDir, `${row.id}.raw.${ext}`);
    const textPath = `${out}.txt`;

    // The sentence goes into a file, never onto a command line: model-written text must
    // not reach a shell.
    await writeFile(textPath, row.sentence);

    const argv = eng.argv.map((a) => a.replaceAll('{text}', textPath).replaceAll('{out}', raw));
    const r = await run(argv, { timeoutMs, stderrCap: VOICE.stderrCap });
    groupKill = r.groupKill ?? groupKill;

    const fail = (error, message) => {
      failed.push({ id: row.id, error, message, textFile: textPath, code: r.code, timedOut: r.timedOut });
    };

    if (r.spawnFailed) {
      // No such executable is a config problem, not an engine that broke: the fix is in
      // the config file, and the message says so.
      fail('E_ENGINE_NOT_CONFIGURED',
        `the engine executable \`${argv[0]}\` is not here (${r.errno ?? ''}): check ${configPath}.`);
      continue;
    }
    if (r.timedOut) {
      fail('E_ENGINE_TIMEOUT',
        `the engine ran past ${timeoutMs} ms and the whole process group was killed (groupKill ${r.groupKill}).`);
      continue;
    }

    // Check the file before anything else: this is the "exited 0 but wrote nothing" case.
    let rawSize = -1;
    try { rawSize = (await stat(raw)).size; } catch { void 0; }
    if (rawSize <= 0) {
      if (r.code !== 0) fail('E_ENGINE_FAILED', `the engine said it failed (exit ${r.code}) and left no file.`);
      else fail('E_ENGINE_NO_OUTPUT', `the engine exited 0 but wrote nothing to ${raw}.`);
      continue;
    }

    // Trim silence, then measure. One filter string, forward and back, as measured.
    const trim = VOICE.trimFilter;
    const trimRun = await run(['ffmpeg', '-y', '-i', raw,
      '-af', `${trim},areverse,${trim},areverse`,
      '-acodec', VOICE.outCodec, '-ar', '44100', '-ac', '2', out]);
    if (!trimRun.ok) {
      fail('E_ENGINE_BAD_AUDIO', `the file the engine wrote does not decode to audio: ${raw}.`);
      continue;
    }

    const probe = await run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'csv=p=0', out]);
    if (!probe.ok) {
      fail('E_ENGINE_BAD_AUDIO', `the trimmed file cannot be probed: ${out}.`);
      continue;
    }
    const durationSec = Number(probe.stdout.trim());
    if (!(durationSec > 0)) {
      fail('E_ENGINE_BAD_AUDIO', `the trimmed file measures ${durationSec} s: nothing was spoken.`);
      continue;
    }

    // Success: the raw engine file and the text file are both cleaned up. On failure they
    // stay, so a person can debug the engine with the exact text it was given.
    for (const p of [raw, textPath]) {
      try { await unlink(p); } catch { void 0; }
    }
    let bytes = 0;
    try { bytes = (await stat(out)).size; } catch { void 0; }
    audio.push({ id: row.id, sentence: row.sentence, out, durationSec, bytes, code: r.code });
  }

  const fields = {
    work,
    engine: name,
    engineNote: eng.note ?? '',
    engineSpeech: eng.speech !== false,
    engineNetwork: eng.network === true,
    engineNeedsKey: eng.needsKey === true,
    timeoutMs,
    audio,
    failed,
    unplanned: rows.filter((r) => !planned.has(r.id)).map((r) => r.id),
    onlyUnknown,
    scriptPath,
    shotsPath,
    configPath,
    groupKill,
  };

  if (failed.length) {
    const first = failed[0];
    return resultError('voice', first.error,
      `${failed.length} of ${wanted.length} sentence(s) failed; first: ${first.id} ${first.error}: ${first.message}`,
      fields);
  }
  return resultOk('voice', fields);
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${resultError('voice', 'E_VOICE_ARGS', parsed.message, {})}\n`);
    process.exit(1);
  }
  const r = await speak(parsed.opts);
  process.stdout.write(`${JSON.stringify(r)}\n`);
  process.exit(r.ok ? 0 : 1);
}

if (await realpath(process.argv[1]) === await realpath(SELF)) await main();
