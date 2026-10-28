// T-01 — the contract module. Written red-first: this file exists before lib/contract.mjs.
import assert from 'node:assert';
import { test } from 'node:test';

await test('every error name from section 11 exists', async () => {
  const c = await import('../lib/contract.mjs');
  const want = {
    scan: ['E_STEM_COLLISION','E_FOREIGN_JSON','E_CLIP_JSON_UNREADABLE','E_CLIP_SCHEMA_UNKNOWN',
           'E_ASSET_UNREADABLE','E_ASSET_MISSING','E_UNDERSTAND_FAILED','E_ASSETS_ROOT_UNREADABLE',
           'E_UNKNOWN_MEDIA','E_BACKUP_FAILED','E_SCAN_INTERNAL','E_SOURCE_CONFLICT','E_SOURCE_UNREADABLE'],
    voice: ['E_ENGINE_NOT_CONFIGURED','E_ENGINE_TIMEOUT','E_ENGINE_FAILED','E_ENGINE_NO_OUTPUT','E_ENGINE_BAD_AUDIO'],
    segment: ['E_SENTENCE_UNPLANNED','E_AUDIO_MISSING','E_AUDIO_ZERO_DURATION','E_DURATION_MISMATCH',
              'E_ASSET_MISSING','E_ASSET_TOO_SHORT','E_RENDER_OUTPUT_UNREADABLE'],
    concat: ['E_NOTHING_TO_CONCAT','E_SEGMENT_MISSING','E_CONCAT_MISMATCH'],
  };
  for (const group of Object.keys(want)) {
    assert.deepEqual(c.ERRORS[group], want[group], `${group} names`);
  }
});

await test('subtitle presets are the measured two sets, not one set plus a parameter', async () => {
  const c = await import('../lib/contract.mjs');
  assert.deepEqual(c.SUBS.landscape, { maxWidth: 56, maxLines: 2, fontRatio: 0.0333, marginRatio: 0.074 }, 'landscape');
  assert.deepEqual(c.SUBS.portrait,  { maxWidth: 30, maxLines: 2, fontRatio: 0.070,  marginRatio: 0.208 }, 'portrait');
});

await test('font size follows width, vertical margin follows height', async () => {
  const c = await import('../lib/contract.mjs');
  const land = c.subStyle(1920, 1080, 'landscape');
  assert.equal(land.marginH, Math.max(8, Math.round(1920 * 0.025)), 'marginH');
  assert.equal(land.marginV, Math.max(8, Math.round(1080 * 0.074)), 'marginV follows height');
  const p = c.subStyle(1080, 1920, 'portrait');
  assert.equal(p.marginV, Math.max(8, Math.round(1920 * 0.208)), 'portrait marginV follows height');
  assert.equal(p.fontSize, Math.max(12, Math.min(Math.round(1080 * 0.070),
      Math.floor((1080 - 2 * p.marginH) / (30 / 2)))), 'fontSize follows width');
  assert.equal(p.outline, Math.max(2, Math.round(p.fontSize / 16)), 'outline');
});

await test('one fixed part shape, two target frames, the fill limits', async () => {
  const c = await import('../lib/contract.mjs');
  assert.deepEqual(c.PART_SHAPE, { fps: 30, sampleRate: 44100, channels: 2,
    videoCodec: 'h264', videoProfile: 'high', videoLevel: '4.0', audioCodec: 'aac', pixFmt: 'yuv420p' },
    'part shape: measured here — ffmpeg calls its own h264 encoder h264, so -c:v x264 exits 8');
  assert.deepEqual(c.FRAMES, { landscape: [1920, 1080], portrait: [1080, 1920] }, 'target frames');
  assert.equal(c.FILL.SLOW_LIMIT, 0.20, 'SLOW_LIMIT');
  assert.equal(c.FILL.ESTIMATE_CHARS_PER_SEC, 3, 'estimate errs long: Chinese reads 4-5');
  assert.equal(c.TOLERANCE_SEGMENT, 0.05, 'segment tolerance');
});
