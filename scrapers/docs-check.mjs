#!/usr/bin/env node
// Corpus check — verifies the harvested document text is present and readable
// from the manifest. Two jobs:
//   1. Proves the actions/cache corpus restored end-to-end (run it in a job that
//      restored cache/docs).
//   2. Documents the exact read pattern the AI-extraction layer will reuse:
//      resolve `${repo}/${entry.cached_path}` and read it as UTF-8 text.
//
//   node scrapers/docs-check.mjs

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'public', 'data', 'docs-manifest.json');

// The read pattern the AI layer uses: cached_path is repo-root-relative.
export function readDoc(entry) {
  const abs = path.join(ROOT, entry.cached_path);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, 'utf8');
}

function main() {
  if (!existsSync(MANIFEST)) {
    console.error(`No manifest at ${MANIFEST}. Run the document harvester first.`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const slugs = Object.keys(manifest);

  let docs = 0;
  let readable = 0;
  let missing = 0;
  let ocr = 0;
  let totalChars = 0;
  const missingSamples = [];

  for (const slug of slugs) {
    for (const entry of manifest[slug]) {
      docs += 1;
      if (entry.ocr_needed) ocr += 1;
      const text = readDoc(entry);
      if (text === null) {
        missing += 1;
        if (missingSamples.length < 8) missingSamples.push(entry.cached_path);
        continue;
      }
      totalChars += text.length;
      if (text.trim().length > 0) readable += 1;
    }
  }

  const pct = (n) => (docs ? `${((100 * n) / docs).toFixed(1)}%` : '0%');
  console.log('Corpus check');
  console.log(`  companies in manifest : ${slugs.length}`);
  console.log(`  documents in manifest : ${docs}`);
  console.log(`  readable (has text)   : ${readable} (${pct(readable)})`);
  console.log(`  ocr_needed (no text)  : ${ocr}`);
  console.log(`  MISSING from cache    : ${missing} (${pct(missing)})`);
  console.log(`  total characters      : ${totalChars.toLocaleString('en-US')}`);
  if (missing) {
    console.log('  sample missing paths:');
    for (const m of missingSamples) console.log(`    ${m}`);
  }

  if (!docs) {
    console.error('\nFAIL: manifest has no documents.');
    process.exit(1);
  }
  // If most docs are missing, the cache wasn't restored — fail loudly so the AI
  // layer never runs against an empty corpus.
  if (missing / docs > 0.2) {
    console.error(
      `\nFAIL: ${pct(missing)} of documents are missing from cache/docs — the corpus cache was not restored.`
    );
    process.exit(1);
  }
  console.log('\nOK — corpus is present and readable end-to-end.');
}

// Run only when invoked directly (lets the AI layer import readDoc).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
