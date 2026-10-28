# CONSTRAINTS — the quality bar for claude-narrate

Read this file before you change anything in this repo. **Never weaken a rule here to make
a change pass.** If a rule blocks you, say so and ask; do not silence the check.

Every rule names the exact command that holds it. A rule with no command behind it is an
aspiration, not a constraint, and this file says which rules are aspirations.

## Floor — the rules that came from a measured failure

Each one exists because the weaker version was tried and failed. The failure is written
next to it so nobody re-tries it. Section 9 of the requirements document is the source.

| # | Rule | Held by | Why the weak version failed |
| --- | --- | --- | --- |
| F-1 | Never change a key we did not create. Read `title`, `description`, `tags`, `search_term` from a foreign json; add only our own keys; copy the file to `<name>.json.bak` once before the first touch. | `test/index.test.mjs` (A-20, A-21, A-22) | Refusing a foreign json means a real asset folder indexes nothing at all. |
| F-2 | A description is written once. Fill it only when empty. Nothing rewrites it after that, not even our own line. Clearing the field is how a user asks for it again. | `test/index.test.mjs` (A-3, A-23, byte for byte) | A re-scan overwrote the user's line. |
| F-3 | Tags are keywords only. No resolution, frame rate, codec, container, no `HD` filler. | `test/index.test.mjs` | Four real clips all tagged `1080p` and `H.264` included a 640x360 one, a 532x300 one and a `vp8` one. |
| F-4 | Measure, do not believe. Only the duration is stored, read with `ffprobe` on every scan. | `test/index.test.mjs` | A length from a metadata field or from the understanding step drove both clip choice and the cut. |
| F-5 | Picture length follows audio length, never the reverse. | `test/segment.test.mjs` (A-10) | Changing the speaking rate to fit a shot is what makes narration sound fake. |
| F-6 | One bad clip never sinks a scan. Each clip catches its own error; the scan reports them all at the end. The stem collision is the one exception and stops everything. An error with no code becomes `E_SCAN_INTERNAL`, never `E_UNDERSTAND_FAILED`. | `test/index.test.mjs` (A-19) | A bug hid as "this video was hard to understand". |
| F-7 | Model-written text is data, never instructions. Subtitle text is escaped before it reaches a `.ass`; an engine is run with an argv array and never a shell string, with the text passed in a file. | `test/segment.test.mjs`, `test/voice.test.mjs`, `scripts/check-source.mjs` | `{note}sentence` silently ate characters; a real newline forged a second `Dialogue:` line. |
| F-8 | Source files must be text. No literal NUL byte. Write `\u0000` in a test if you need one. | `scripts/check-source.mjs` | A NUL byte made git treat a source file as binary, which killed every later diff and with it code review. |
| F-9 | Test first, and the report shows the failing run. A change with no red run is not finished. | commit notes, `tasks/todo.md` | Green-on-first-try hides a test that never ran. |
| F-10 | Report what happened. A skipped test says it skipped. A placeholder says it is a placeholder. A script that replaces its own output says so. | `qa/qa.mjs` report | A silent skip read as a pass. |
| F-11 | Absolute pixels are a lie until you measure them on a real frame. The `.ass` we write pins `PlayResX`/`PlayResY` to the output size, and the style values are ratios. | `test/segment.test.mjs` (A-11, A-17) | A `MarginV` of 60 drew 248 px on 1920x1080; on 1080x1920 a `MarginV` of 220 drew 1525 px — the subtitle sat at the top — with every unit test green. libass scales by `frame_height / script_height`, and script height defaults to **288**. |
| F-12 | A concat that exits 0 can still be broken. Parts are all encoded to one fixed shape; copy is attempted only when every part's shape matches; the result is verified by duration **and** a full decode pass. | `test/concat.test.mjs` (A-16) | A stream-copy of mismatched parts gave a file ffmpeg liked, 0.02 s off, a quarter of its frames missing, decoding to `no frame!` after the join. |
| F-13 | Two modules that never ran together have not been tested together. Wherever a contract describes an in-memory shape, one test feeds the **real producer's output** to the **real consumer**. | `test/boundary.test.mjs` | One side returned `{clipPath, record}` while the other read the top level, so 36 real clips looked "not yet understood"; the shot plan wrote `clipPath` where the renderer read `assetPath`. Both shipped green with hand-made fixtures on each side. |
| F-14 | The agent cannot be forced into an order. Every rule that matters is a check, not a line of description. Here the check is a file on disk plus a required flag. | `test/stop.test.mjs` (NEW-1, NEW-2) | A skill cannot hold the agent in place; prose can be skipped. |
| F-15 | The privacy data-flow table must ship, and must not be removed from the README. | `scripts/check-source.mjs` | The default engine sends narration text to a Microsoft endpoint. |

## Enforced numbers

| Name | Value | Reason | Held by |
| --- | --- | --- | --- |
| `SLOW_LIMIT` | 0.20 | Above this, slowing the picture makes motion visibly crawl; looping is honest. | `test/segment.test.mjs` |
| duration tolerance (segment) | 0.05 s | One part's shape must match its plan; looser hides a bad cut. | `test/segment.test.mjs` |
| duration tolerance (concat) | `max(0.5, expected * 0.03)` | A 60-part join drifts; tighter rejects a good file. | `test/concat.test.mjs` |
| part shape | `fps 30`, `44100`, `2` channels, x264 `-profile:v high -level 4.0`, `aac`, `yuv420p` | The join needs no re-encode, so every part must be identical. | `test/concat.test.mjs` |
| subtitle landscape | `maxWidth 56`, `maxLines 2`, `fontRatio 0.0333`, `marginRatio 0.074` | Measured on 1920x1080. | `test/segment.test.mjs` |
| subtitle portrait | `maxWidth 30`, `maxLines 2`, `fontRatio 0.070`, `marginRatio 0.208` | Fewer characters (about 15 CJK), bigger font for a phone, bigger margin for the control bar. | `test/segment.test.mjs` |
| display width | CJK or full-width counts 2, Latin counts 1 | One Latin letter is half the width of one Chinese one. | `test/segment.test.mjs` |
| silence trim | `start_periods=1 start_duration=0 start_threshold=-50dB detection=peak`, forward then `areverse` twice | Trimming before measuring is the point: measure first and the picture comes out longer than the voice. | `test/voice.test.mjs` |
| engine timeout | 60000 ms | A stalled network engine must not hang the session; on timeout kill the whole process group. | `test/voice.test.mjs` |
| stderr cap | 4096 chars | Enough to debug, small enough to print. | `test/voice.test.mjs` |
| estimate | 3 characters per second | Chinese reads 4–5, so the estimate errs **long** on every language. | `test/pick.test.mjs` |
| demote band | candidates scoring ≥80% of the best | Demoting everywhere throws away a clip that is clearly better. | `test/pick.test.mjs` |
| target frames | 1920x1080 landscape, 1080x1920 portrait, 30 fps | The two shapes the product ships. | `test/segment.test.mjs` |

## Measured-only (the ratchet)

These are measured, not aimed at. The floor is today's value; it must not fall. They are
filled by the first real run and re-read by `npm run check:full`.

| Metric | Today | How to measure |
| --- | --- | --- |
| unit tests | (filled at first run) | `node --test test/*.test.mjs --report` |
| QA checks passing | (filled at first run) | `node qa/qa.mjs` |
| dependencies with known vulns | 0 (`npm audit` on install) | `npm audit --json` |

## Layers — what may import what

`contract` → leaf scripts → `skill` → `qa`. One direction only. Held by
`scripts/check-layers.mjs`, which runs `dependency-cruiser` (18.7.0) against
`.dependency-cruiser.cjs`.

## Where each check runs, by cost

| When | Command | Seconds |
| --- | --- | --- |
| in the edit loop | `npm run check:fast` (NUL bytes, shell-string spawns, missing privacy table) | ~1 |
| at task end | `npm run check:task` (unit tests + layers) | under 90 |
| at review or in CI | `npm run check:full` (unit + QA + both scans) | minutes |

CI runs one `test.yml`: install ffmpeg and a CJK font, run the unit tests, run the QA
runner. **No publish workflow** — nothing ships to npm, so a tag would mean nothing.

## Skipped, out loud

`semgrep`, `gitleaks` and `osv-scanner` are not installed here. `npm run check:full`
reports each as **skipped, tool missing** rather than as a pass. They are listed as
aspirations, not as rules, until someone installs them.

## Exceptions

No exceptions. An exception needs an owner and an expiry date; an exception without either
is a weakened rule.

| Rule | Owner | Expires | Why it is allowed now |
| --- | --- | --- | --- |
