#!/usr/bin/env node
// OPTIONAL: generate photorealistic office backdrops once with your Replicate key
// and add them to the built-in Office list. No user photos are involved.
// Cost: about one image-generation call per backdrop (see docs/OPERATIONS.md).
//   npm run backgrounds:ai            → generates all presets
//   npm run backgrounds:ai ai-glass   → one preset
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { ReplicateClient } from '../server/replicate.js';
import { BACKGROUND_PRESETS } from '../server/ai-presets.js';

const cfg = loadConfig();
if (!cfg.aiEnabled) { console.error('Set REPLICATE_API_TOKEN in .env first.'); process.exit(1); }
const client = new ReplicateClient(cfg.replicate);
const dir = path.join(cfg.publicDir, 'backgrounds');
const manifestPath = path.join(dir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const wanted = process.argv.slice(2);
const ids = Object.keys(BACKGROUND_PRESETS).filter((id) => !wanted.length || wanted.includes(id));

for (const id of ids) {
  const preset = BACKGROUND_PRESETS[id];
  process.stdout.write(`Generating ${preset.label}… `);
  const { url } = await client.run(cfg.replicate.backgroundModel, { prompt: preset.prompt, aspect_ratio: '1:1', output_format: 'jpg', safety_tolerance: 2 });
  const { buffer } = await client.download(url);
  const file = `${id}.jpg`;
  fs.writeFileSync(path.join(dir, file), buffer);
  // The editor makes its own small preview; reuse the full image as the thumbnail.
  const entry = { id, label: preset.label, src: `/backgrounds/${file}`, thumb: `/backgrounds/${file}`, credit: `Generated with ${cfg.replicate.backgroundModel} via Replicate` };
  const i = manifest.findIndex((m) => m.id === id);
  if (i >= 0) manifest[i] = entry; else manifest.push(entry);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log('saved', file);
}
console.log('Done. Check the generator\'s licence terms for commercial use of outputs before publishing.');
