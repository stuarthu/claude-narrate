// The rules about the source files themselves, not about what the code does.
//
// Three of them live in CONSTRAINTS.md because no test can see them: a rule about the bytes of
// a file, a rule about how a process is started, and a rule about a paragraph in the README.
// Each one is a check here, so a change that breaks it turns red before it ships.
//
//   F-8  A source file must be text. A literal NUL byte makes git treat the file as binary,
//        which kills every later diff, and with it code review.
//   F-7  Model-written text is data, never instructions. A script is model output, so it must
//        never reach a shell. The danger is a command and its arguments jammed into one string,
//        or the shell:true option: both put a string in front of a shell. Passing an argv array
//        to spawn does not, so spawn('ffmpeg', ['-y']) is fine and spawn('ffmpeg -y') is not.
//   F-15 The privacy table must ship, and must not be removed from the README.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Folders that are not source: someone else's code, our own output, and git's own files.
const SKIP_DIRS = new Set(['node_modules', '.git', '.narrate', 'tmp']);
// Only text files a reader or a reviewer would open. A clip or a wav is not source.
const SCAN_EXT = new Set(['.mjs', '.cjs', '.js', '.md', '.json', '.yml', '.yaml', '.txt']);

async function walk(dir, out) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(path, out);
    } else if (e.isFile()) {
      const dot = e.name.lastIndexOf('.');
      if (dot > 0 && SCAN_EXT.has(e.name.slice(dot))) out.push(path);
    }
  }
  return out;
}

// What may not appear in a source line, and why it matters. Each entry names the rule it
// holds, so a reader can find the rule in CONSTRAINTS.md from the line that broke.
const BANNED = [
  { re: /(^|[^.\w])exec\s*\(/, why: 'F-7: exec hands one string to a shell. Spawn with an argv array through lib/run.mjs.' },
  { re: /(^|[^.\w])execSync\s*\(/, why: 'F-7: execSync hands one string to a shell. Spawn with an argv array through lib/run.mjs.' },
  // The command and its arguments inside ONE string is the shape that only works through a
  // shell. An argv array is safe, so this looks for a space inside the first string.
  { re: /\bspawn(?:Sync)?\(\s*['"`][^'"`\n]* [^'"`\n]*['"`]/, why: 'F-7: a command string with its arguments inside it. Pass an argv array.' },
  { re: /shell:\s*true/, why: 'F-7: the shell:true option, which is what puts a string in front of a shell.' },
  { re: /\b(?:sh|bash|zsh)\s+-\w*c\b/, why: 'F-7: a shell asked for by name with a -c flag. No shell is ever started here.' },
  { re: /\/bin\/(?:sh|bash)\b/, why: 'F-7: a path to a shell. No shell is ever started here.' },
];

// Two kinds of line are skipped, and both are written out here rather than left to a reader:
//
//   A comment line. A comment NAMES a rule; it does not start a shell. The line above this
//   table says "spawn('ffmpeg -y') is not", and that is prose about the rule, not a call.
//   The rule table itself, between `const BANNED = [` and the `];` under it. Those lines hold
//   the patterns, so they name every danger this file is looking for. Skipping the table is
//   the only honest way to read it, and it is the one block this file owns.
async function isComment(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

const problems = [];

async function scanFiles(files) {
  for (const path of files) {
    const bytes = await readFile(path);
    const nul = bytes.indexOf(0);
    if (nul !== -1) {
      problems.push(`${path}: a literal NUL byte at byte ${nul} (F-8). Write \\u0000 in a test instead.`);
      continue;
    }
    if (!/\.(mjs|cjs|js)$/.test(path)) continue;
    const text = bytes.toString('utf8');
    const lines = text.split('\n');
    // The rule table's own lines, found by its markers rather than by a file name, so moving
    // this file or renaming it cannot turn the table back into code that is scanned.
    let tableFrom = -1;
    let tableTo = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (tableFrom === -1 && lines[i].includes('const BANNED = [')) tableFrom = i;
      if (tableFrom !== -1 && tableTo === -1 && i > tableFrom && lines[i].trim() === '];') tableTo = i;
    }
    for (let i = 0; i < lines.length; i += 1) {
      if (isComment(lines[i])) continue;
      if (tableFrom !== -1 && i >= tableFrom && i <= tableTo) continue;
      for (const rule of BANNED) {
        if (rule.re.test(lines[i])) {
          problems.push(`${path}:${i + 1}: ${lines[i].trim()} (${rule.why})`);
        }
      }
    }
  }
}

// The privacy table, checked for the parts that carry the promise. A README that keeps the
// heading but drops a row would tell a reader the wrong thing about where their data goes.
const PRIVACY = [
  '| What | Where your data goes | How to avoid it |',
  'node-edge-tts',
  'Never leave your machine',
  'Never uploaded anywhere',
  'not an official public Microsoft API',
];

async function checkReadme() {
  let text;
  try {
    text = await readFile('README.md', 'utf8');
  } catch {
    problems.push('README.md: the file is missing (F-15, README_MISSING).');
    return;
  }
  for (const part of PRIVACY) {
    if (!text.includes(part)) {
      problems.push(`README.md: the privacy table lost the part "${part}" (F-15). ` +
        `The table says where your data goes; without it a reader cannot tell.`);
    }
  }
  const words = text.split(/\s+/).filter((w) => w !== '');
  if (words.length < 40) {
    problems.push(`README.md: ${words.length} words, under the 40 a README needs (README_MISSING).`);
  }
}

async function main() {
  const files = await walk('.', []);
  await scanFiles(files);
  await checkReadme();
  for (const p of problems) process.stdout.write(`${p}\n`);
  if (problems.length) {
    process.stdout.write(`\n${problems.length} source rule broken.\n`);
    process.exit(1);
  }
  process.stdout.write(`\n${files.length} source files clean: no NUL byte, no shell, privacy table present.\n`);
}

await main();
