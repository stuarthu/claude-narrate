// Spawns its own long-running child, then hangs. A group kill must stop both, or a
// runaway engine child would keep the whole run alive.
import { spawn } from 'node:child_process';
spawn('sleep', ['30']);
await new Promise(() => {});
