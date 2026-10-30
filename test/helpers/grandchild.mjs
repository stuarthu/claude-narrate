// Spawns its own long-running children, then hangs. A group kill must stop the node
// process AND these children, or a runaway engine child would keep the whole run alive.
//
// The children's process ids are written to a file so the test can ask about the sleeps
// THIS helper started. Asking "is there any process named sleep on this machine" is a
// question about the machine, not about our code (section 12): a busy host has other
// sleeps running for other reasons, and the test then reads a stranger as a failure.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';

const DIR = '/tmp/narrate-grandchild';
await mkdir(DIR, { recursive: true });
const kids = [spawn('sleep', ['30']), spawn('sleep', ['30'])];
await writeFile(`${DIR}/pids.txt`, kids.map((k) => k.pid).join('\n'));
await new Promise(() => {});
