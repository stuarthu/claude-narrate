// The layer map SPEC §2 names, run as a check rather than written as a sentence.
//
// F-14 says every rule that matters must be a check, not a line of description. "No script
// imports a script that comes later in the table" is a sentence in SPEC §2; this file is the
// check. The rules themselves live in `.dependency-cruiser.cjs`, which builds one rule per
// layer out of the layer list, so the list is the thing a reader checks and the rules are
// derived from it.
//
// It fails when a rule fires. It also fails when the tool it needs is missing: a layer check
// that passes because it never ran would be a weakened rule, and CONSTRAINTS.md says a rule
// may not be weakened to make a change pass.
import { run } from '../lib/run.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const CLI = join('node_modules', '.bin', 'dependency-cruiser');
const CONFIG = '.dependency-cruiser.cjs';

async function main() {
  const version = await run([CLI, '--version'], { timeoutMs: 30000 });
  if (!version.ok) {
    process.stdout.write(
      `check-layers: cannot hold the layer rule: dependency-cruiser is not installed here.\n` +
      `      install it with \`npm install dependency-cruiser\` (the repo lists it as a devDependency).\n` +
      `      A layer check that never ran is not a pass.\n`);
    process.exit(1);
  }
  process.stdout.write(`dependency-cruiser ${version.stdout.trim()}\n`);

  const got = await run([CLI, '-c', CONFIG, '-T', 'json', '-f', '-', '.'], { timeoutMs: 120000 });
  let parsed;
  try {
    parsed = JSON.parse(got.stdout);
  } catch {
    process.stdout.write(`check-layers: the tool did not answer with JSON.\n` +
      `      stdout: ${got.stdout.slice(0, 400)}\n      stderr: ${got.stderr.slice(0, 400)}\n`);
    process.exit(1);
  }

  const summary = parsed.summary;
  const violations = summary.violations;
  for (const v of violations) {
    process.stdout.write(`  ${v.type}: ${v.from} -> ${v.to}\n`);
  }
  if (violations.length) {
    process.stdout.write(`\n${violations.length} layer rule fired. A script reached something ` +
      `that is built later in the SPEC §2 table.\n`);
    process.exit(1);
  }
  if (got.code !== 0) {
    process.stdout.write(`\nthe tool exited ${got.code} with no violation to show: ` +
      `${got.stderr.slice(0, 400)}\n`);
    process.exit(1);
  }
  process.stdout.write(`\n0 violations over ${summary.totalCruised} files, ` +
    `${summary.totalDependenciesCruised} import edges. The layers go one way.\n`);
}

await main();
