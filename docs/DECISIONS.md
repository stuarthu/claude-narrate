# What we chose not to build, and why

These belong to a different kind of host. They are written down so a future reader does not
re-add them. Each one was tried, or was about to be, and the reason it stopped is here.

| Do not build | Why | What still applies |
| --- | --- | --- |
| A state file that holds the whole flow, plus a status tool | Claude holds the flow in the conversation. A state machine adds a second place that can disagree with the first. | Keep the half that still applies: the per-clip JSON has three sections with different owners, and a scan must never rewrite a section it does not own. The test that asserts a write survives a re-scan byte for byte is kept — `test/index.test.mjs` "A-3 + A-23". |
| Tool registration, JSON-schema validation of tool output, a required `output.render` shape | A Claude Code plugin registers no tools and validates nothing. Scripts print JSON on stdout. | Keep the shadow of it: a script that prints nothing gets silently ignored, so every script prints a result or prints an error. Held by the "SPEC 3: the command prints one JSON object" tests in `test/concat.test.mjs`, `test/preview.test.mjs`, `test/pick.test.mjs`, `test/describe.test.mjs`. |
| A patch file that must ship beside a bundle | That belongs to a host with a boot process. Claude Code has none. | Nothing. |
| A required dependency that turns clips into text | Claude reads the frames. Adding someone else's understanding layer brings a version floor and a breakage risk for no gain. | The honest cost: this machine has no image encoder to read a frame with, so the QA runner feeds the frame words in through `--said` and says so in the report. Everything that READS them is the real step. |
| Environment variables named after another host's paths | Use plain names if needed at all. | The config we do read is a file: `config/engines.json`. |

## Product scope we also left out, with the reasons

| Not doing | Why |
| --- | --- |
| Music video / BPM cut points | Music-driven cutting is a different engine, not a switch |
| Editing-app draft files | The format is undocumented, changes by version, and paths differ per OS |
| Background music | v1 does not do it; volume mixing would slow the main path |
| Transitions, covers, title cards | Leave that to the editor |
| Per-language tuning | The voice contract does not lock a language, so it does not tune each one either |

## Two decisions that came from measurement, not from a guess

- **The voice engine is a contract in a config file, not code in a file.** The default
  engine is not an official public Microsoft API, so it can stop working at any time. A
  swappable engine means "it stopped" is a config change, not a code change. Measured by
  `test/voice.test.mjs` "swapping the engine changes config only, and no product code (A-14)".
- **The stop points are a flag plus a file, not a sentence in the skill.** The agent cannot
  be forced into an order, so the only stop that is real is one a script can check. A run
  without `--approved` fails. Measured by `test/stop.test.mjs`.
