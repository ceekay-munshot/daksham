#!/usr/bin/env node
// Normalise the committed qualitative file in place — re-applies the numeric sanity
// guards (₹-crore reconciliation + %-ceiling) to every param's structured `fields`,
// healing any figure that was extracted before a guard landed (a mis-scaled mn/lakh/
// bn/USD ₹-crore headline, or a % above its ceiling). Pure re-shaping over stored data:
// the model `value`/`note`/`verdict` are untouched, only the derived numbers change, and
// the pass is idempotent (running it twice is a no-op). Reuses lib/qualitative.mjs so it
// can never drift from what the extractor now produces.
//
//   node scrapers/normalize-qualitative.mjs          # write cleaned file, print a summary
//   node scrapers/normalize-qualitative.mjs --check   # report only, exit 1 if any change (CI)

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renormalizeFields } from './lib/qualitative.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(__dirname, '..', 'public', 'data', 'daksham-qualitative.json');

function main() {
  const checkOnly = process.argv.includes('--check');
  const doc = JSON.parse(readFileSync(FILE, 'utf8'));
  const companies = doc.companies || {};
  const changes = [];

  for (const [slug, entry] of Object.entries(companies)) {
    const params = entry.params || {};
    for (const p of Object.values(params)) {
      if (!p || !p.fields) continue;
      const before = p.fields;
      const after = renormalizeFields(p);
      for (const k of Object.keys(after)) {
        if (before[k] !== after[k]) {
          changes.push({ slug, name: entry.name, field: k, from: before[k], to: after[k] });
        }
      }
      p.fields = after;
    }
  }

  console.log(`normalize-qualitative: ${changes.length} field(s) ${checkOnly ? 'would change' : 'changed'} across ${Object.keys(companies).length} companies`);
  for (const c of changes.slice(0, 40)) {
    console.log(`  ${String(c.name || c.slug).slice(0, 22).padEnd(22)} ${c.field.padEnd(18)} ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);
  }
  if (changes.length > 40) console.log(`  … and ${changes.length - 40} more`);

  if (checkOnly) {
    if (changes.length) {
      console.error('\n✖ qualitative fields are not normalised — run: node scrapers/normalize-qualitative.mjs');
      process.exit(1);
    }
    console.log('✓ already normalised');
    return;
  }
  if (changes.length) {
    writeFileSync(FILE, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`\n✓ wrote ${path.relative(path.resolve(__dirname, '..'), FILE)}`);
  } else {
    console.log('✓ nothing to change');
  }
}

main();
