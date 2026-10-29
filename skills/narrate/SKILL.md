---
name: narrate
description: Turn one idea typed in chat into one narrated, subtitled .mp4 built from the user's own clips, stopping four times and waiting for a clear yes at each stop. Use when the user asks for a narrated video, a voiceover, a subtitled cut, or a video made from clips in an assets folder.
---

# narrate — one idea, one narrated video

You write a spoken script, pick clips from the user's own `assets` folder, speak the script
with a swappable text-to-speech engine, burn the words onto the picture, and join one `.mp4`.

The point of this product is the **four stop points**. Other tools do the whole job in one
pass and show the result only after. This one stops first, and waits. Do not skip a stop
because the user seems eager. Do not merge two stops into one message.

## The four stops

| Stop | When | What you see | What you do |
| --- | --- | --- | --- |
| 1 | Before the script is written | At least three questions: how long, who is watching, what tone, the one line you want remembered | Answer. Answering *is* the yes — there is nothing else to approve. |
| 2 | Script finished | The full script, one numbered sentence per line | Approve it, or change it |
| 3 | Before any audio is made | The shot list, plus the list of sentences that have **no matching clip** | Add clips, edit the shot list, or say go ahead |
| 4 | Before rendering | An audio-only file: the narration with no picture | Listen to the pace, approve, or redo a few lines |

Nothing moves past a stop without a clear yes.

## The stop checklist — re-read this before every step

This checklist is the part that holds. Before you run the next step, print the current state
and ask. One message, one question, then stop and wait for the user's words.

- [ ] **Stop 1 — before the script.** Ask at least three questions: how long, who is
      watching, what tone, the one line you want remembered. Write no script file until they
      answer. Their answer is the yes; there is nothing else to approve at this stop.
- [ ] **Stop 2 — script finished.** Show the whole script, one numbered sentence per line.
      Ask: approve it, or change it. Do not build a shot list until they say yes.
- [ ] **Stop 3 — before any audio is made.** Show the shot list, and the list of sentences
      that have no matching clip. Ask: add clips, edit the shot list, or say go ahead.
- [ ] **Stop 4 — before rendering.** Make the audio-only file and tell the user where it is,
      so they can listen to the pace. Ask: approve, or redo a few lines.

If you cannot tell which stop you are at, say so and ask. Do not guess and carry on.

## The flow, with the exact commands

Pick one work name (a short folder name, for example `clouds`). Everything for one video
lives under `.narrate/<work>/`. Every script prints one JSON object on stdout and nothing
else; an error prints JSON too and exits non-zero. Read the JSON, not the exit code alone.

1. **Index the clips.**
   `node bin/index.mjs --assets <assets-dir>`
   This writes one JSON record beside each clip. A record that says it still needs
   understanding has no words yet — go to step 2 for those clips.
2. **Describe the clips that have no words.** For each clip:
   `node bin/describe.mjs --clip <clip> --every 5` pulls frames; then say what you see in
   those frames yourself, write those words to a file, and store them with
   `node bin/describe.mjs --clip <clip> --said <file>`.
   For the search words in each sentence, write English queries and store them with
   `node bin/describe.mjs --work <work> --queries <file>`. Translate any sentence that is
   not English into an English query first, and show the user the query you stored.
3. **Stop 1.** Ask the questions. Do not write `script.txt` yet.
4. **Write the script** only after they answer: one numbered sentence per line, into
   `.narrate/<work>/script.txt`.
5. **Stop 2.** Show the whole script. Wait for yes.
6. **Pick the clips.**
   `node bin/pick.mjs --work <work> --assets <assets-dir> --aspect landscape`
   This writes `shots.json`. It also reports the sentences that have no clip.
7. **Stop 3.** Show every shot row — sentence id, clip file, start second, end second,
   subtitle text — and show the sentences that have no clip. Say plainly that these are the
   user's own clips, and that you did not check whether they may be used. Wait for yes.
8. **Speak the sentences.**
   `node bin/voice.mjs --work <work>` — one audio file per sentence. The default engine needs
   no new API key. To change the voice, change `config/engines.json`; never change a script.
9. **Make the audio-only file** (this is stop 4's product, so it runs before the approval):
   `node bin/preview.mjs --work <work>` → `.narrate/<work>/preview.wav`.
10. **Stop 4.** Tell the user the file and how to listen: `ffplay <file>`. Ask them to check
    the pace, then approve or redo lines. To redo a few lines:
    `node bin/voice.mjs --work <work> --only S-002,S-003`, then preview again, then stop 4
    again.
11. **Render the parts** — only after their yes:
    `node bin/segment.mjs --work <work> --approved`
12. **Join one file** — only after their yes:
    `node bin/concat.mjs --work <work> --approved --out out/<work>.mp4`

Pass `--approved` only after the user said yes at that stop. A render run without it fails,
and that failure is the stop working. If you get `E_SEGMENT_NOT_APPROVED` or
`E_CONCAT_NOT_APPROVED`, you rendered too early: go back to the stop and ask.

## The stage-product check

Each stage writes a file before the next stage may read it: `script.txt`, `shots.json`,
`audio/S-xxx.wav`, `preview.wav`, `subs.ass`, `segments/S-xxx.mp4`, `out/<work>.mp4`.
There is no flow-state file. The files are the state.

A stage that reads the stage before it and finds no file stops and says so. It never invents
one, and it never reads "whatever is in the folder". If a script answers
`E_..._MISSING` or `E_..._SCRIPT_MISSING`, the stage before it never ran — go back and run it,
do not write the file yourself.

## Rules that hold

- Claude never types an ffmpeg flag. The skill calls the scripts through Bash. If you find
  yourself writing `ffmpeg`, stop and call a script instead.
- Model-written text never goes through a shell. Write it to a file, then pass the file path.
- Report what the JSON says, including the numbers. Do not claim a step ran when it exited
  non-zero.
- A step that cannot cover a sentence with a clip says so; it does not stretch a clip.
- If the visual layer is empty, the pick step falls back to the words and says so. That is a
  report, not an error.

## What this is not

These are **instructions, not a wall**. A skill cannot force the order on an agent. What
holds is the check in the scripts: the stage product on disk plus the required `--approved`
flag. Say this plainly to the user the first time you run the flow, so they know what the
stops do and do not do.
