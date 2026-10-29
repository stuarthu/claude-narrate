// The edge engine adapter. bin/voice.mjs runs engines through an argv array, so an
// engine that is an npm package needs a tiny door: this file is that door. It reads the
// sentence from a file (never from a command line) and writes the audio to a file.
//
// It is not product logic. Nothing here decides names, ids or paths for the pipeline.
import { EdgeTTS } from 'node-edge-tts/dist/edge-tts.js';
import { readFile, stat } from 'node:fs/promises';

const [textPath, outPath, voice] = process.argv.slice(2);
if (!textPath || !outPath) {
  process.stderr.write('usage: node bin/voice-edge.mjs <text-file> <out-file> [voice]\n');
  process.exit(2);
}

let text;
try {
  text = await readFile(textPath, 'utf8');
} catch (e) {
  process.stderr.write(`cannot read the text file: ${e.code} ${textPath}\n`);
  process.exit(2);
}

// The package writes mp3 by default, which is what the engine config says (ext "mp3").
const tts = new EdgeTTS({ voice: voice || 'en-US-AriaNeural', lang: 'en-US', timeout: 30000 });
try {
  await tts.ttsPromise(text, outPath);
} catch (e) {
  process.stderr.write(`edge tts failed: ${e.message}\n`);
  process.exit(3);
}

// The package can leave a zero-byte file behind on a failed call, so check the bytes.
let size = -1;
try { size = (await stat(outPath)).size; } catch { void 0; }
if (size <= 0) {
  process.stderr.write(`edge tts wrote no audio to ${outPath}\n`);
  process.exit(4);
}
