# claude-narrate

One typed idea becomes one narrated, subtitled video, cut from **your own** clips.

[OpenCut-AI](https://github.com/Ekaanth/OpenCut-AI),
[OpenMontage](https://github.com/Open-Montage/OpenMontage),
[NarratoAI](https://github.com/linyqh/NarratoAI) and
[MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo) all do the whole job
today. None of them stop to ask you first. That is the one thing this project is for, so
keep the stop points at the centre of any change.

## Try it

```sh
claude plugin install narrate@claude-narrate
cd /tmp/scratch && claude "make me a video about how fast clouds move"
```

Put your clips in `./assets` first. A folder of `.mp4` files is enough; nothing else is
needed to start.

## The four stops

The skill stops four times and asks. Each stop prints what is on disk right now and waits
for a clear yes.

1. **The script.** The numbered narration, before anything is recorded.
2. **The shot list.** Which clip each sentence got, and which sentences got none.
3. **The audio.** One recording per sentence, before any picture is cut.
4. **The preview.** One audio-only file, so you can hear the whole thing before you pay
   for the render.

**These stops are instructions, not a wall.** The skill tells the agent to ask, and the
agent might not. What is hard is smaller: a render script refuses to run until you pass a
`--approved` flag, and a run without it fails. That is one check per render, not a lock on
the whole flow. See `docs/RULES.md` for what is checked and what is only asked.

## What it does

`index` → `describe` → `pick` → `voice` → `preview` → `segment` → `concat`

- One JSON file beside each clip, split into "yours" and "the machine's". Your writing is
  never rewritten by a scan.
- A clip's length is measured with `ffprobe` on every scan. No length is trusted from a
  metadata field.
- The picture is cut to the length of its own narration, never the other way around.
- Subtitles are burned in. The `.ass` file pins `PlayResX`/`PlayResY` to the output size,
  and the style values are ratios, because libass scales pixel values by frame height.
- Parts are joined only after every part's codec, size and frame rate are measured to match,
  and the result is checked by length **and** a full decode pass.
- Landscape and portrait, with subtitle rules that follow the ratio.

## Privacy — where your data goes

| What | Where your data goes | How to avoid it |
| --- | --- | --- |
| Bundled voice engine (default) | Your narration text is sent to Microsoft's Edge read-aloud service, through [`node-edge-tts`](https://www.npmjs.com/package/node-edge-tts). It needs no account and no API key. | Configure a local engine instead. |
| Your video clips | Never leave your machine. All cutting and encoding runs locally through `ffmpeg`. | Nothing to do. |
| Your finished video | Never uploaded anywhere. This plugin does not touch any platform account. | Nothing to do. |

The bundled engine is **not an official public Microsoft API**, so it can stop working at
any time. That is why the voice engine is a contract in `config/engines.json` and not code
in a file. To move off it, change config only:

```sh
node bin/voice.mjs --work demo --assets assets --config my-engines.json
```

A local engine is any command that takes a text file and writes one `.wav`. See
`docs/RULES.md` for the shape.

## Tests

```sh
npm test              # unit tests, written red-first
npm run qa            # the end-to-end runner, written from the acceptance checks
npm run check:full    # unit tests + qa + the source rules + the layer rules
```

The QA runner cuts real video and real audio, so `ffmpeg` and `ffprobe` must be on `PATH`,
and a font covering the language under test must be installed (`fonts-noto-cjk` for
Chinese). Network checks **skip out loud** and say why; a red run means our code is wrong,
never the network.

## Files

- `SPEC.md` — the spec.
- `CONSTRAINTS.md` — the quality bar, held by CI.
- `docs/DECISIONS.md` — what we chose not to build, and why, so nobody re-adds it.
- `docs/RULES.md` — every rule, each with the test that holds it.
- `tasks/plan.md` — the task list; `tasks/todo.md` is the same list, checked off.
