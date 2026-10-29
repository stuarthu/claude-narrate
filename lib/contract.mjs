// The one place that holds the shapes crossing module lines and every error name.
// Section 11 of the requirements document is the source of truth for every number here.
// Copy, do not re-derive. A number here with no measurement behind it is a bug.

// ---------------------------------------------------------------- error names

// A failure must name the thing that failed. A bug must not hide as "this video was
// hard to understand", so E_SCAN_INTERNAL is for our own broken code.
export const ERRORS = {
  scan: [
    'E_STEM_COLLISION',        // a.mp4 and a.mov in one folder: both would write a.json
    'E_FOREIGN_JSON',          // a json beside a clip that is not ours: we read it, never rewrite it
    'E_CLIP_JSON_UNREADABLE',  // our own sidecar json cannot be parsed
    'E_CLIP_SCHEMA_UNKNOWN',   // a sidecar json from another tool that claims our key
    'E_ASSET_UNREADABLE',      // ffprobe could not read the media file
    'E_ASSET_MISSING',         // the sidecar json is there, the clip is not
    'E_UNDERSTAND_FAILED',     // Claude gave nothing usable for this clip
    'E_ASSETS_ROOT_UNREADABLE',// the assets folder itself cannot be listed
    'E_UNKNOWN_MEDIA',         // an extension we do not know how to cut
    'E_BACKUP_FAILED',         // the one-time .json.bak copy could not be written
    'E_SCAN_INTERNAL',         // our own bug, never a clip problem
    'E_SOURCE_CONFLICT',       // two input sources disagree about the same field
    'E_SOURCE_UNREADABLE',     // a sidecar .narrate.txt or clips.csv cannot be read
  ],
  voice: [
    'E_ENGINE_NOT_CONFIGURED', // the engine name is not in config/engines.json (a config error)
    'E_ENGINE_TIMEOUT',        // the engine ran past its timeout; we killed the process group
    'E_ENGINE_FAILED',         // the engine reported failure
    'E_ENGINE_NO_OUTPUT',      // exited 0 but wrote nothing: the most common engine bug
    'E_ENGINE_BAD_AUDIO',      // a file exists but does not decode to audio
    // voice.mjs additions. The five names above are a keep-list from the requirements
    // document, so these are additions, not replacements. Two of them are the stop rule
    // (NEW-2): a stage that reads the previous stage's product and finds no file must
    // stop and say so, not invent one.
    'E_VOICE_SCRIPT_MISSING',    // .narrate/<work>/script.txt is not there: stop 2 never ran
    'E_VOICE_SHOTS_MISSING',     // shots.json is not there: stop 3 never ran
    'E_VOICE_CONFIG_UNREADABLE', // config/engines.json cannot be read or parsed
    'E_VOICE_CONFIG_INVALID',    // the config is there but names no engine we can run
    'E_VOICE_ARGS',              // the command line was not understood
    'E_VOICE_WRITE_FAILED',      // an audio file could not be written: the folder is not writable
  ],
  segment: [
    'E_SENTENCE_UNPLANNED',    // a sentence has no shot in shots.json
    'E_AUDIO_MISSING',         // audio/S-xxx.wav is not on disk
    'E_AUDIO_ZERO_DURATION',   // a 0-second recording cannot hold a picture
    'E_DURATION_MISMATCH',     // the part came out a different length than the audio
    'E_ASSET_MISSING',         // the clip the plan names is not on disk
    'E_ASSET_TOO_SHORT',       // the clip cannot cover its window
    'E_RENDER_OUTPUT_UNREADABLE', // the part we just made cannot be probed
    // segment.mjs additions. The seven names above are a keep-list from the requirements
    // document, so these are additions, not replacements. Three of them are the stop rule
    // (NEW-2) and one is the approval wall (NEW-1): a render attempt with no approval flag
    // has to fail, not warn.
    'E_SEGMENT_ARGS',            // the command line was not understood
    'E_SEGMENT_NOT_APPROVED',    // no --approved: stop 4 never said yes, so nothing renders
    'E_SEGMENT_SCRIPT_MISSING',  // script.txt is not there: stop 2 never ran
    'E_SEGMENT_SHOTS_MISSING',   // shots.json is not there: stop 3 never ran
    'E_SEGMENT_WRITE_FAILED',    // a part or the .ass could not be written
    'E_SEGMENT_SUBTITLES_MISSING', // subs.ass is not there: the subtitle file was never made
    'E_SEGMENT_BAD_SHAPE',       // a part is not the one fixed shape every part must share
  ],
  concat: [
    'E_NOTHING_TO_CONCAT',     // no parts on disk
    'E_SEGMENT_MISSING',       // a planned part is not on disk
    'E_CONCAT_MISMATCH',       // the joined file is the wrong length or does not decode
  ],

  // preview.mjs. The doc's list is a keep-list, so these are additions, not replacements.
  // Two of them are the stop rule (NEW-2): a stage that reads the previous stage's
  // product and finds no file must stop and say so, not invent one.
  preview: [
    'E_PREVIEW_ARGS',            // the command line was not understood
    'E_PREVIEW_SCRIPT_MISSING',  // script.txt is not there: stop 2 never ran
    'E_PREVIEW_AUDIO_MISSING',   // a planned sentence has no recording: the voice step never ran
    'E_PREVIEW_BAD_PART',        // a recording exists but does not decode to audio
    'E_PREVIEW_MISMATCH',        // the joined file is the wrong length or does not decode
    'E_PREVIEW_WRITE_FAILED',    // preview.wav could not be written
  ],

  // pick.mjs. The doc's list is a keep-list, so these are additions, not replacements.
  // Two of them are the stop rule (NEW-2): a stage that reads the previous stage's
  // product and finds no file must stop and say so, not invent one.
  pick: [
    'E_PICK_SCRIPT_MISSING',   // .narrate/<work>/script.txt is not there: stop 2 never ran
    'E_PICK_SCRIPT_EMPTY',     // script.txt is there but holds no numbered sentences
    'E_PICK_INDEX_MISSING',    // no clip has an index json: the index step never ran
    'E_PICK_CLIP_UNINDEXED',   // one clip has no index json: reported, the run continues
    'E_PICK_ASPECT_UNKNOWN',   // --aspect is not one of the two target frames
    'E_PICK_ARGS',             // the command line was not understood
    'E_PICK_WRITE_FAILED',     // shots.json could not be written: the work folder is not writable
  ],
};

export function isKnownError(name) {
  for (const group of Object.values(ERRORS)) if (group.includes(name)) return true;
  return false;
}

// ------------------------------------------------------------- subtitle presets

// Two sets, not one set plus a parameter. Measured: portrait needs fewer characters per
// line (about 15 CJK), a bigger font (a phone screen), and a bigger vertical margin
// (the phone's control bar covers the bottom of the frame).
export const SUBS = {
  landscape: { maxWidth: 56, maxLines: 2, fontRatio: 0.0333, marginRatio: 0.074 },
  portrait:  { maxWidth: 30, maxLines: 2, fontRatio: 0.070,  marginRatio: 0.208 },
};

// libass scales style values it is given as pixels by frame_height / script_height, and
// script height defaults to 288. Measured: on 1080x1920 a MarginV of 220 drew 1525 px,
// putting the subtitle at the top of the frame. We pin PlayResX/PlayResY to the output
// size and pass ratios, so this number never has to be guessed again.
export const SCRIPT_HEIGHT = 288;

// A CJK or full-width character takes two display cells, a Latin character takes one.
// Counting both as 1 makes a portrait line hold 30 CJK characters and overflow the frame.
export function isWideCell(ch) {
  const c = ch.codePointAt(0);
  return (c >= 0x1100 && c <= 0x115f)   // Hangul jamo
      || (c >= 0x2e80 && c <= 0x33ff)   // CJK punctuation, ideographs, kana
      || (c >= 0x3400 && c <= 0x9fff)   // CJK ideographs
      || (c >= 0xac00 && c <= 0xd7ff)   // Hangul syllables
      || (c >= 0xf000 && c <= 0xff60)   // private use, full-width forms
      || (c >= 0xffe0 && c <= 0xffef)   // full-width punctuation
      || (c >= 0x20000 && c <= 0x31aff);// CJK extension planes
}

export function displayWidth(text) {
  let w = 0;
  for (const ch of text) w += isWideCell(ch) ? 2 : 1;
  return w;
}

// Line breaking, the section 11 rules: prefer a break after punctuation, then at a space,
// then a hard break by width. Past maxLines the text is kept whole and flagged, never cut
// off, because dropping words would make the burned subtitle disagree with script.txt (A-11).
export function breakLines(text, style) {
  const clean = text.replace(/\s+/g, ' ').trim();
  // A chunk is the smallest piece a line may end at: one wide character, or one Latin word
  // with its punctuation stuck on the back.
  const chunks = [];
  for (const word of clean.split(' ')) {
    let buf = '';
    for (const ch of word) {
      if (isWideCell(ch)) {
        if (buf) { chunks.push(buf); buf = ''; }
        chunks.push(ch);
      } else {
        buf += ch;
        if (',.;:!?)]}\u2026\u2014'.includes(ch)) { chunks.push(buf); buf = ''; }
      }
    }
    if (buf) chunks.push(buf);
  }
  const lastChar = (t) => [...t].pop() ?? '';
  const firstChar = (t) => [...t][0] ?? '';
  // Two Latin pieces need a space back; two wide characters do not (CJK has no spaces).
  const joiner = (a, b) => (lastChar(a) && firstChar(b)
    && !isWideCell(lastChar(a)) && !isWideCell(firstChar(b))) ? ' ' : '';
  const lines = [];
  for (let c of chunks) {
    // One word wider than a whole line: cut it by width, that is the last break rule.
    while (displayWidth(c) > style.maxWidth) {
      let cut = c.length;
      while (displayWidth(c.slice(0, cut)) > style.maxWidth) cut--;
      lines.push(c.slice(0, cut));
      c = c.slice(cut);
    }
    const last = lines.length ? lines[lines.length - 1] : '';
    const gap = last ? joiner(last, c) : '';
    if (last && displayWidth(last) + displayWidth(gap) + displayWidth(c) <= style.maxWidth) {
      lines[lines.length - 1] = last + gap + c;
    } else lines.push(c);
  }
  return { lines, overflow: lines.length > style.maxLines };
}

// Font size follows width (a line fits because of width); vertical margin follows height
// (clearing the phone's control bar is a share of height). Ratios, so one preset looks
// the same at 1080p and 720p.
export function subStyle(width, height, aspect) {
  const preset = SUBS[aspect];
  if (!preset) throw new Error(`unknown aspect ${aspect}: only landscape and portrait`);
  const marginH = Math.max(8, Math.round(width * 0.025));
  const fits = Math.floor((width - 2 * marginH) / (preset.maxWidth / 2));
  const fontSize = Math.max(12, Math.min(Math.round(width * preset.fontRatio), fits));
  const outline = Math.max(2, Math.round(fontSize / 16));
  const marginV = Math.max(8, Math.round(height * preset.marginRatio));
  return {
    aspect, maxWidth: preset.maxWidth, maxLines: preset.maxLines,
    fontRatio: preset.fontRatio, marginRatio: preset.marginRatio,
    marginH, fits, fontSize, outline, marginV,
  };
}

// --------------------------------------------------------------- .ass writing

// libass reads {...} as an override block, so a model-written "{note}" silently ate those
// characters. A real newline ends the event and lets the rest forge a second Dialogue:
// line. Escape before writing, never after.
export function assEscape(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

// Measured on this host (ffmpeg 6.1.1, libass 0.17.1): a header that says
// `Script Format Version: v1.00` and `Format: SSA/ASS v1.00` is refused outright. libass
// answers `Could not create a libass track when reading file ...`, ffmpeg exits non-zero
// and burns nothing. The layout libass here accepts is the v4.00+ one: a `[V4+ Styles]`
// section with this 23-field `Format:` line, then `[Events]` with the SSA field list.
// The other half of the trap: a `Style:` line with one field missing shifts every later
// field (ScaleY became 0) and libass draws nothing at all. Measured: that burned file was
// byte-identical to the plain clip, 6062 bytes for both. So the count is checked here,
// never trusted.
export const ASS_STYLE_FORMAT = 'Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding';
export const ASS_EVENT_FORMAT = 'Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';

// The font has to cover CJK (A-11: Chinese shows no empty boxes). Measured: fontconfig
// resolves this name to NotoSansCJK-Regular.ttc on this host, and CI installs
// fonts-noto-cjk. A missing font falls back to another one, it does not fail the render.
export const SUB_FONT = 'Noto Sans CJK SC';

// The style values come from subStyle: ratios turned into pixels for this frame, so one
// preset looks the same at 1080p and 720p. PlayResX/PlayResY are pinned to the output
// size, which is what stops libass scaling by its own default script height of 288.
export function assStyleFields(style) {
  return [
    'Default',              // Name
    SUB_FONT,               // Fontname
    style.fontSize,         // Fontsize
    '&H00FFFFFF',           // PrimaryColour: white, A=00 opaque
    '&H0000FFFF',           // SecondaryColour: not used here, kept so the count is right
    '&H80000000',           // OutlineColour
    '&H80000000',           // BackColour
    0, 0, 0, 0,             // Bold, Italic, Underline, StrikeOut
    100, 100,               // ScaleX, ScaleY: a 0 here draws nothing (measured)
    0, 0,                   // Spacing, Angle
    1,                      // BorderStyle=1: an outline is required
    style.outline,          // Outline
    0,                      // Shadow
    2,                      // Alignment=2: bottom centre
    style.marginH,          // MarginL
    style.marginH,          // MarginR
    style.marginV,          // MarginV
    1,                      // Encoding
  ];
}

export function assHeader(width, height, style) {
  const fields = assStyleFields(style);
  const want = ASS_STYLE_FORMAT.split(',').length;
  if (fields.length !== want) {
    throw new Error(`Style line has ${fields.length} fields, the Format line names ${want}: a wrong count silently draws nothing`);
  }
  return [
    '[Script Info]',
    'Title: narrate',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    `Format: ${ASS_STYLE_FORMAT}`,
    `Style: ${fields.join(',')}`,
    '',
    '[Events]',
    `Format: ${ASS_EVENT_FORMAT}`,
  ].join('\n');
}

// The same values are repeated inside every event, so an event still says what it needs
// if a reader drops the style block. \an2 is bottom centre, \q2 means "do not re-wrap":
// we broke the lines ourselves, so libass must break only where we said.
// ASS override blocks need curly braces. Measured: the unbraced form drew the override
// characters as visible text across the frame, so a subtitle became garbage instead of style.
// This block is added AFTER assEscape, so a model-written "{" in the sentence stays escaped
// and inert while these braces are real.
export function assStyleOf(style) {
  return `{\\an2\\q2\\fs${style.fontSize}\\bord${style.outline}\\1c&H00FFFFFF&\\3c&H80000000&}`;
}

// One event line. Measured: a short line that stops after the style name is refused
// outright — libass answers "Bad timestamp" and reports 0 events, so nothing is drawn and
// the burned file looks exactly like the plain clip. The full field list the Format line
// names is written in full, with the margins left to the style block (measured: the style's
// MarginV is what moved the text up from the bottom edge).
export function assEvent(startSec, endSec, style, text) {
  return `Dialogue: 0,${assTime(startSec)},${assTime(endSec)},Default,,0,0,0,,${assStyleOf(style)}${text}`;
}

// ASS is precise to 1/100 s, so times are written h:mm:ss.cs.
export function assTime(sec) {
  const cs = Math.round(sec * 100);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${Math.floor(cs / 360000)}:${p2(Math.floor(cs / 6000) % 60)}:${p2(Math.floor(cs / 100) % 60)}.${p2(cs % 100)}`;
}

// ------------------------------------------------------------- picture shapes

export const FRAMES = { landscape: [1920, 1080], portrait: [1080, 1920] };

// Every part is encoded to one fixed shape so the join needs no re-encode. Measured:
// stream-copying parts whose codec, size or frame rate differ gave a file ffmpeg liked,
// whose duration was off by 0.02 s and which decoded to "no frame!" after the join.
export const PART_SHAPE = {
  fps: 30,
  sampleRate: 44100,
  channels: 2,
  videoCodec: 'h264',            // measured: ffprobe reports codec_name "h264" for both libx264 and the built-in encoder
  videoProfile: 'high',
  videoLevel: '4.0',
  audioCodec: 'aac',
  pixFmt: 'yuv420p',
};

// The fields a part must be probed on before a stream-copy is allowed.
export const SHAPE_PROBE = ['codec_name', 'width', 'height', 'pix_fmt', 'r_frame_rate', 'sample_rate', 'channels'];

export const TOLERANCE_SEGMENT = 0.05;   // seconds, measured against real parts

// A concat that exits 0 can still be broken, so the join is checked by duration too.
export function concatTolerance(expectedSec) {
  return Math.max(0.5, expectedSec * 0.03);
}

// --------------------------------------------------------- the audio-only join

// preview joins the per-sentence recordings for stop 4. Measured on this host: a stream-copy
// of three 1 s pcm_s16le parts drifts by 0.000 s from the sum of the parts. 0.02 s is the
// floor — looser would let a part that is missing from the join pass.
export const PREVIEW = {
  toleranceSec: 0.02,
  timeoutMs: 60000,
  // The shape a re-encoded join is written in, used only when the parts do not share one
  // shape. voice writes pcm_s16le / 44100 / 2 for every part, so a normal run copies.
  codec: 'pcm_s16le', sampleRate: 44100, channels: 2,
};

// ---------------------------------------------------------------------- fill

export const FILL = {
  SLOW_LIMIT: 0.20,             // gap at or under 20% -> slow the picture; over that -> loop
  ESTIMATE_CHARS_PER_SEC: 3,    // errs long on purpose: Chinese reads 4-5, so real audio
                                // is usually shorter than the estimate and needs no fill
};

// A candidate can only be used for the part of the clip that is both described and present.
export function availableLength(describedEndSec, assetDurationSec, startSec) {
  return Math.min(describedEndSec, assetDurationSec - startSec);
}

// Demote an already-used clip only among candidates scoring at least 80% of the best one,
// so a weak clip is not punished for a sentence it was never a rival for.
export const DEMOTE_MIN_RATIO = 0.80;

// ------------------------------------------------------- the script numbering

// script.txt is stop 2's product: one numbered line per sentence. A line that does not
// start with a number continues the sentence before it, so a wrapped sentence stays one
// sentence. One parser here, so pick's ids and voice's file names can never disagree.
export function parseScript(text) {
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

// ---------------------------------------------------------------- voice engine

export const VOICE = {
  timeoutMs: 60000,             // default engine timeout; on timeout the whole group is killed
  stderrCap: 4096,              // captured stderr is capped so one engine cannot flood stdout
  // Trimming before measuring is the point: measure first and the picture comes out
  // longer than the voice. Forward, reverse, forward again, reverse back.
  trimFilter: 'silenceremove=start_periods=1:start_duration=0:start_threshold=-50dB:detection=peak',
  // pcm_s16le output, so the final name must be .wav
  outCodec: 'pcm_s16le',
};

// ------------------------------------------------------- crossing JSON shapes

// The per-clip sidecar. Three sections, three owners: fromYou is the user's, measured is
// ours every scan, fromMachine is ours and is rewritten wholesale when the fingerprint
// changes. The scan must never rewrite a section it does not own.
export const CLIP_SCHEMA = 'narrate/clip@1';

export function blankIndex(clipName) {
  return {
    schema: CLIP_SCHEMA,
    clip: clipName,
    fingerprint: '',                       // "size:<bytes>|mtime:<seconds>", no path: a move keeps fromYou
    fromYou: {
      description: '',
      tags: [],
      notes: '',
      segments: [{ startSec: 0, endSec: 0, description: '' }],
      sources: [],
      origin: { description: '', tags: [], derived: [] },  // derived = what we wrote, the baseline
    },
    measured: { shape: 0, durationSec: 0 },               // re-measured every scan, never trusted from metadata
    fromMachine: {
      segments: [{ startSec: 0, endSec: 0, description: '', tags: [], confidence: 0 }],
      visualSearchDir: '',                 // path-based, so a move invalidates it: fall back to text
      engine: '',
    },
  };
}

// The shot list. The renderer reads assetPath, so the planner must write assetPath: the
// first shipped boundary bug was one side writing clipPath while the other read assetPath.
export const SHOT_SCHEMA = 'narrate/shots@1';

export function blankShot(id) {
  return {
    id,                              // S-001, the same id as audio/S-001.wav and segments/S-001.mp4
    sentence: '',
    assetPath: '',
    startSec: 0,
    endSec: 0,
    query: '',                       // the English visual query, stored so "why this clip" is checkable
    chosenBy: '',                    // duration | text | visual | user
    score: 0,
    fill: 'none',                    // none | slow | loop | report
    slowTo: 0,
    overflow: false,                 // past maxLines: keep all the text and flag it
  };
}

export function blankShots(work, aspect) {
  return { schema: SHOT_SCHEMA, work, aspect, shots: [] };
}

// The English visual queries Claude wrote, kept so a later reader can check a choice.
export const QUERY_SCHEMA = 'narrate/queries@1';

export function blankQueries(work) {
  return { schema: QUERY_SCHEMA, work, queries: [] };
}

// One script's answer on stdout. A script that prints nothing gets silently ignored by the
// agent, so every path prints a result or prints an error.
export const RESULT_SCHEMA = 'narrate/result@1';

export function resultOk(command, fields) {
  return { schema: RESULT_SCHEMA, command, ok: true, ...fields };
}

export function resultError(command, name, message, fields) {
  if (!isKnownError(name)) throw new Error(`unknown error name ${name}: add it to ERRORS or use E_SCAN_INTERNAL`);
  return { schema: RESULT_SCHEMA, command, ok: false, error: name, message, ...fields };
}
