// Sleeps 30 s, then writes a marker file. A run that times out must never see the marker,
// which is how the test knows the child was stopped and not left running.
import { writeFile, mkdir } from 'node:fs/promises';
await new Promise((r) => setTimeout(r, 30000));
await mkdir('/tmp/narrate-run', { recursive: true });
await writeFile('/tmp/narrate-run/marker.txt', 'ran past the timeout');
