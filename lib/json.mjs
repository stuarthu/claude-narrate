// Read and write JSON without losing bytes we did not write.
// A stock footage site ships its own json beside each clip. Our writing adds keys and
// must never drop or rewrite the keys it did not create, so a write is atomic: a
// half-finished write can never replace a good file.

import { rename, writeFile, readFile, copyFile, stat, mkdir } from 'node:fs/promises';
import { openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

export async function readJson(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    return { ok: false, message: `cannot read ${path}`, errno: e.code };
  }
  try {
    return { ok: true, value: JSON.parse(text), text };
  } catch (e) {
    return { ok: false, message: `not valid json: ${path}`, errno: 'E_PARSE' };
  }
}

// fsync a directory so a rename into it survives a crash. Linux allows opening a
// directory; Windows does not, so a failure there is reported as skipped, not hidden.
async function fsyncDir(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch (e) {
    return { ok: false, skipped: `platform will not fsync a directory (${e.code})` };
  }
  try {
    fsyncSync(fd);
    closeSync(fd);
    return { ok: true };
  } catch (e) {
    try { closeSync(fd); } catch {}
    return { ok: false, skipped: `fsync failed (${e.code})` };
  }
}

// Write to a temp name, fsync it, rename it into place, then fsync the directory.
// A failure returns a result; it does not leave a half-written file at the real name.
export async function writeJson(path, value) {
  let text;
  try {
    text = `${JSON.stringify(value, null, 2)}\n`;
  } catch (e) {
    return { ok: false, message: `cannot encode ${path}: ${e.message}` };
  }
  const tmp = `${path}.narrate-tmp`;
  try {
    await writeFile(tmp, text);
    const fd = openSync(tmp, 'a'); // 'a' so fsync does not truncate what writeFile just wrote
    fsyncSync(fd);
    closeSync(fd);
    await rename(tmp, path);
  } catch (e) {
    return { ok: false, message: `write failed for ${path}`, errno: e.code };
  }
  const dir = await fsyncDir(dirname(path) || '.');
  return { ok: true, bytes: Buffer.byteLength(text), dirFsync: dir.ok ? 'ok' : dir.skipped };
}

// The one-time backup, saved before the first touch of a foreign json. A second call
// must never overwrite it: the backup is the original, whatever the file becomes.
export async function copyOnce(src, dst) {
  try {
    await stat(dst);
    return { ok: true, copied: false, message: 'backup already exists and was kept' };
  } catch {}
  try {
    await copyFile(src, dst);
    const fd = openSync(dst, 'a'); // 'a' so fsync does not truncate the copy
    fsyncSync(fd);
    closeSync(fd);
  } catch (e) {
    return { ok: false, message: `cannot save backup ${dst}`, errno: e.code };
  }
  return { ok: true, copied: true };
}

// A scratch folder for tests and generated fixtures.
export async function ensureDir(path) {
  try {
    await mkdir(path, { recursive: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: `cannot make ${path}`, errno: e.code };
  }
}
