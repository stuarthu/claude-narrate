// The three security tools CONSTRAINTS.md names as aspirations. They are not installed here,
// so this file says so out loud rather than letting a missing tool read as a pass.
//
// A check that never ran is not a pass. That is the same rule the layer check runs on: if
// dependency-cruiser is missing, scripts/check-layers.mjs exits non-zero. Here the tools are
// listed as aspirations, not as rules, so a missing one is a skip — but it must be a skip the
// reader can see, not silence.
import { run } from '../lib/run.mjs';

// Each command is an argv array, never a shell string (F-7).
const TOOLS = [
  { name: 'semgrep', argv: ['semgrep', '--config', 'auto', '--error', '.'],
    why: 'F-7 and F-8: a pattern scan over the source, the same rules the fast check runs.' },
  { name: 'gitleaks', argv: ['gitleaks', 'detect', '--no-report'],
    why: 'F-13: a secret left in a source file would be shipped with the plugin.' },
  { name: 'osv-scanner', argv: ['osv-scanner', '--scan=.'],
    why: 'the dependency floor: node-edge-tts and dependency-cruiser are both third party.' },
];

async function main() {
  let ran = 0;
  let skipped = 0;
  for (const t of TOOLS) {
    const where = await run(['which', t.name], { timeoutMs: 5000 });
    if (!where.ok || where.stdout.trim() === '') {
      console.log(`${t.name}: skipped, tool missing. ${t.why}`);
      skipped++;
      continue;
    }
    const got = await run(t.argv, { timeoutMs: 120000 });
    if (got.ok && got.code === 0) {
      console.log(`${t.name}: ran, nothing found.`);
    } else {
      console.log(`${t.name}: ran and said no. ${String(got.stderr).slice(0, 400)}`);
      process.exitCode = 1;
    }
    ran++;
  }
  console.log(`${ran} scanner(s) ran, ${skipped} skipped, tool missing. A skip is not a pass.`);
}

await main();
