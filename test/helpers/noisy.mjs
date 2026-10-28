// Writes 10000 characters to stderr, then a short line to stdout.
process.stderr.write('e'.repeat(10000));
process.stdout.write('done');
