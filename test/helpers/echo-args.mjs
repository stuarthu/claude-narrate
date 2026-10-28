// Prints its own argv as JSON. Used to prove a dangerous string arrives as one literal
// argument, which is only true if no shell was ever involved.
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify(args));
