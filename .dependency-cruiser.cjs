// The layer map SPEC §2 names, written as rules instead of as a sentence.
//
// SPEC §2 says: "No script imports a script that comes later in the table." A sentence in a
// doc is not a check, and F-14 says every rule that matters must be a check. So the order
// lives here: a script may import a script that comes EARLIER in this list, never one that
// comes later. Writing the pairs out by hand would be 66 lines nobody can read, so the file
// builds one rule per layer from the list, and the list is the thing a reader checks.
//
// Run it with `node scripts/check-layers.mjs`, which runs dependency-cruiser (18.7.0)
// against this file and fails when a rule fires.

// Earliest first. A leaf may not reach anything below it.
const LAYERS = [
  'lib/contract.mjs', 'lib/json.mjs', 'lib/run.mjs',
  'bin/index.mjs', 'bin/describe.mjs', 'bin/pick.mjs', 'bin/voice.mjs',
  'bin/preview.mjs', 'bin/segment.mjs', 'bin/concat.mjs',
  'qa/fixtures/make.mjs', 'qa/qa.mjs',
];

// dependency-cruiser matches module paths as full regular expressions against the path it
// cruised (for example "bin/pick.mjs"), so each rule needs an anchored pattern. The names
// above contain dots, which mean "any character" in a pattern, so they are escaped first.
function re(list) {
  const one = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return '^(?:' + list.map(one).join('|') + ')$';
}

const forbidden = [];

for (let i = 0; i < LAYERS.length; i += 1) {
  const later = LAYERS.slice(i + 1);
  if (!later.length) continue;
  forbidden.push({
    name: `layer-${i + 1}-may-not-import-later`,
    comment: `A layer may not import a layer that comes later in the SPEC §2 table. ` +
      `${LAYERS[i]} sits at level ${i + 1}; importing any of these would make the flow ` +
      `depend on something that is built after it, and a cycle of imports is what breaks ` +
      `the "one direction only" rule.`,
    severity: 'error',
    from: { path: re([LAYERS[i]]) },
    to: { path: re(later) },
  });
}

forbidden.push({
  name: 'no-cycle',
  comment: 'Imports must not form a circle. A circle means no script can be read on its own, ' +
    'which is the reason the layer table exists.',
  severity: 'error',
  from: {},
  to: { circular: true },
});

forbidden.push({
  name: 'not-to-unresolvable',
  comment: 'Every import must name a file that is really there. A typo in an import path is ' +
    'a broken hand-off, not a rule about layers, and it must not read as a pass.',
  severity: 'error',
  from: {},
  to: { couldNotResolve: true },
});

module.exports = {
  forbidden,
  options: {
    // The product is plain ESM .mjs with no build step, so only the ES module system is
    // worth cruising. node_modules is a dependency, not a layer, so the runner stops there
    // rather than reading thousands of files of someone else's code.
    moduleSystems: ['es6'],
    doNotFollow: { path: ['node_modules'] },
  },
};
