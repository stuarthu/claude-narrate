# SPEC — claude-narrate

This file is the spec. It was written before any code. The requirements document
(`~/claude-skill-requirements.md`) is the source of truth for every number and rule here.
When this file and the code disagree, this file and the requirements document win.

---

## 1. Objective

One user, one Claude Code session, one idea typed in chat. The plugin writes a spoken
script, picks clips from the user's own `assets` folder, speaks the script with a
swappable text-to-speech engine, burns the words onto the picture, and joins one `.mp4`.

The point of the product is the **four stop points**. Other tools do the whole job in one
pass and show the result only after. This one stops four times and waits for a clear yes.
Every later change must keep the stop points at the centre.

Target user: a person who already has clips on disk and wants a narrated cut without
learning ffmpeg, and who wants to say "no, wrong tone" before any money is spent on
rendering.

## 2. Capability map (modules, dependency direction, build order)

| Module id | Owns | Depends on | Build order |
| --- | --- | --- | --- |
| `contract` | the JSON shapes that cross module lines, and every error name | nothing | 1 |
| `index` | walk `assets`, read the seven sources, write one JSON beside each clip | `contract` | 2 |
| `describe` | pull frames for one clip, store what Claude said into `fromMachine` | `contract` | 3 |
| `pick` | the three-layer funnel, the missing-clip report, the reuse demotion | `contract`, `index` | 4 |
| `voice` | run the engine, check the file, trim silence, measure | `contract` | 5 |
| `preview` | join the per-sentence audio into `preview.wav` | `contract`, `voice` | 6 |
| `segment` | cut one sentence's picture, fit it, burn its subtitle | `contract`, `pick`, `voice` | 7 |
| `concat` | join the parts, verify the result | `contract`, `segment` | 8 |
| `skill` | `SKILL.md` — the flow, the four stops, the checklist | all of the above | 9 |
| `qa` | the end-to-end runner, written from the acceptance checks | all of the above | 10 |

Dependency direction is one way: `contract` → leaf scripts → `skill` → `qa`. No script
imports a script that comes later in the table.

## 3. Commands

The skill calls the scripts through Bash. Claude never types an ffmpeg flag.

```sh
node bin/index.mjs    --assets assets                     # walk, write per-clip JSON, report
node bin/describe.mjs --clip assets/bench.mp4 --every 4   # frames out; Claude reads them
node bin/pick.mjs     --work <name> --assets assets --aspect landscape   # shots.json + missing report
node bin/voice.mjs    --work <name> --engine edge         # audio/S-xxx.wav per sentence
node bin/preview.mjs  --work <name>                      # preview.wav for stop 4
node bin/segment.mjs  --work <name> --approved            # segments/S-xxx.mp4
node bin/concat.mjs   --work <name> --approved --out out/<name>.mp4
```

Every script prints one JSON object on stdout and nothing else. Errors go to stderr as
JSON too, and exit non-zero. A script that prints nothing gets silently ignored by the
agent, so every path prints a result or prints an error.

Plugin-level commands:

```sh
claude plugin install narrate@claude-narrate
```

## 4. Project structure

```
claude-narrate/
  README.md                 privacy table, the "instructions, not a wall" note, real-session command
  SPEC.md                   this file
  tasks/plan.md             the task list with acceptance criteria
  tasks/todo.md             the same list, checked off as it goes
  CONSTRAINTS.md            the quality bar, held by CI
  docs/DECISIONS.md         the "do not build these" list, with reasons, so nobody re-adds them
  docs/RULES.md             section 9's keep-list, each rule with the test that holds it
  LICENSE                   MIT
  .claude-plugin/
    plugin.json
    marketplace.json
  skills/narrate/
    SKILL.md                the flow, the four stops, the stop checklist
  bin/                      the seven work scripts (ESM .mjs)
    index.mjs describe.mjs pick.mjs voice.mjs segment.mjs concat.mjs preview.mjs
  lib/                      shared code
    contract.mjs            shapes + error names, one place
    json.mjs                read/write JSON that keeps bytes, fsync
    run.mjs                 spawn a process with an argv array, never a shell string
  test/                     unit tests, `node --test test/*.test.mjs`, written red-first
  qa/
    fixtures/               generated clips and audio (made by ffmpeg, checked in as a recipe)
    qa.mjs                  the end-to-end runner, written from section 10, not from the code
  config/
    engines.json            the voice engine contract, and the two bundled engines
  .github/workflows/test.yml  one job: install ffmpeg + a CJK font, run unit tests, run qa
```

Runtime files, written by the plugin, never committed:

```
assets/<clip>.mp4  assets/<clip>.json  assets/<clip>.json.bak
.narrate/<short name>/script.txt shots.json queries.json audio/ preview.wav subs.ass segments/ out/
```

## 5. Code style

- Plain ESM `.mjs`. No build step, no type annotations. Node 24.
- Plain English in every comment, doc and README string. Short sentences. A technical term
  gets explained the first time it appears.
- Every constant that came from a measurement is named and carries the measurement in a
  comment (`288` script height, `0.05` tolerance, `-50dB`).
- No shell strings. `run.mjs` takes an argv array. Model text never reaches a shell.
- Every error is one of the names in section 11. A bug is `E_SCAN_INTERNAL`, never
  `E_UNDERSTAND_FAILED`.
- Source files contain no NUL byte. Write `\u0000` in a test if you need one.
- A skipped thing says it skipped. A placeholder says it is a placeholder.

## 6. Testing strategy

Two separate sets, kept apart on purpose.

1. **Unit tests** — `node --test test/*.test.mjs`. Red-first: the failing run is kept and
   shown, and it must fail because behaviour is missing, not because the runner could not
   start.
2. **QA runner** — `qa/qa.mjs`, written from the acceptance checks in section 10 rather
   than from the code. It runs the real scripts on real generated video and real audio.
   It prints which checks it skipped and why.

Boundary rule: for every contract that describes an in-memory shape, one test feeds the
**real producer's output** to the **real consumer**. No hand-made fixtures on either side
of those lines.

Network tests skip out loud and are marked skipped, never failed. A red build means our
code is wrong.

Offline CI gets audio from a second bundled engine (`local`, ffmpeg-based) in
`config/engines.json`. The Edge default is its own check (A-13) and skips when there is no
network.

## 7. Boundaries

**Always:** the four stops; the stage-product-on-disk check; `--approved` required by the
render scripts (a run without it fails, it does not warn); the privacy table in the README;
the "these are instructions, not a wall" note; every rule in section 9's keep-list with a
test.

**Ask first:** nothing in this session — the requirements document settled the decisions,
and the open ones were settled with the owner.

**Never:** a flow-state file and a status tool; tool registration or JSON-schema
validation of tool output; a patch file beside a bundle; a required dependency that turns
clips into text; environment variables named after another host's paths; npm publish;
uploading anything; judging clip copyright; speech inside a clip; background music;
transitions; auto-downloading clips. Each one stays written down in `docs/DECISIONS.md`
with its reason, so a future reader does not re-add it.
