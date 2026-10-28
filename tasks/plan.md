# PLAN — claude-narrate

Sliced vertically: each task is one complete path through the product, not a horizontal
layer. Order is the dependency direction in SPEC.md §2. Every task names the acceptance
check from section 10 that proves it, and the verification command that shows it.

Red-first rule (section 9 rule 9): for each task the failing run comes first, and it must
fail because behaviour is missing, not because the runner could not start. The red run is
kept in the commit note.

| Task | Path | Acceptance criteria | Verify with |
| --- | --- | --- | --- |
| T-01 | `lib/contract.mjs` — every error name from section 11, every crossing JSON shape in one place | all 13 scan names, 5 voice, 7 segment, 3 concat present; one export object | `node --test test/contract.test.mjs` |
| T-02 | `lib/json.mjs` + `lib/run.mjs` — read/write JSON that keeps bytes, fsync; spawn with an argv array, never a shell string | a model-written string with `'`, `{`, `}` and a newline cannot reach a shell; a write is fsynced | `node --test test/lib.test.mjs` |
| T-03 | `bin/index.mjs` — walk `assets`, follow symlinks with a loop guard, stem collision first, `.json.bak` once, seven sources with precedence, tags filtered, duration by `ffprobe` every scan, foreign JSON untouched | A-1 A-2 A-3 A-19 A-20 A-21 A-22 A-23 A-28 | `node --test test/index.test.mjs` |
| T-04 | `bin/describe.mjs` — pull frames at a stated interval, store Claude's words into `fromMachine`, never touch `fromYou` | A-1 A-26 (the English query is stored and echoed) | `node --test test/describe.test.mjs` |
| T-05 | `bin/pick.mjs` — three-layer funnel, rarity weighting, English query required for layer 2, available length `min(described end, duration - start)`, demote used clips only at ≥80% of best, no ping-pong, missing report splits "too short" from "not relevant" | A-6 A-7 A-24 A-25 A-27 | `node --test test/pick.test.mjs` |
| T-06 | `bin/voice.mjs` — engine contract from `config/engines.json`, text passed in a file, run → check file → trim silence → measure, timeout kills the process group, keep the text file on failure, never trust the exit code | A-8 A-13 A-14 | `node --test test/voice.test.mjs` |
| T-07 | `bin/preview.mjs` — join per-sentence audio to `preview.wav` | A-9 | `node --test test/preview.test.mjs` |
| T-08 | `bin/segment.mjs` — fill rules (`SLOW_LIMIT` 20%), fit order, `.ass` with pinned `PlayResX/Y`, ratio style values, escaping, `--approved` required | A-10 A-11 A-17 NEW-1 | `node --test test/segment.test.mjs` |
| T-09 | `bin/concat.mjs` — one fixed part shape, copy only when shapes match, verify by duration **and** full decode, `+faststart`, write to `.tmp.mp4` | A-12 A-16 | `node --test test/concat.test.mjs` |
| T-10 | `skills/narrate/SKILL.md` — the flow, the four stops, the stop checklist, the stage-product check, the copyright reminder at stop 3 | A-4 A-5 NEW-2 | a real session, plus the checklist present in the file |
| T-11 | `qa/qa.mjs` — written from section 10, not from the code; prints what it skipped and why | every check in section 10 has a line in the report | `node qa/qa.mjs` |
| T-12 | README (privacy table, "instructions not a wall", real-session command), `docs/DECISIONS.md`, `docs/RULES.md`, `CONSTRAINTS.md`, `.github/workflows/test.yml` | section 14 "done means", all five points | read the files; CI runs both test sets |

## Checkpoints

1. after T-03 — a folder of clips indexes, re-indexes clean, and keeps your writing
2. after T-06 — one sentence becomes one real `.wav` with no network
3. after T-09 — one sentence becomes one real subtitled `.mp4`, and 60 parts join
4. after T-10 — the plugin installs and the four stops happen in a real session
5. after T-12 — done means

## What is not a task

The "do not build" list in section 9. It becomes text in `docs/DECISIONS.md` with its
reason, and nothing else.
