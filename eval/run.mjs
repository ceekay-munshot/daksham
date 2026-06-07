#!/usr/bin/env node
// Batch evaluator: read public/data/daksham-companies.json, evaluate every
// company, write public/data/daksham-evaluated.json, and print a per-check
// summary (PASS / FAIL / NA-sector / NA-data).
//
//   node eval/run.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluate, CHECK_KEYS } from './evaluate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'public', 'data');
const IN_PATH = path.join(OUT_DIR, 'daksham-companies.json');
const OUT_PATH = path.join(OUT_DIR, 'daksham-evaluated.json');

function main() {
  const companies = JSON.parse(readFileSync(IN_PATH, 'utf8'));
  if (!Array.isArray(companies) || !companies.length) {
    throw new Error(`No companies in ${IN_PATH}. Run the per-company crawler first.`);
  }

  const evaluated = companies.map(evaluate);
  mkdirSync(OUT_DIR, { recursive: true });
  // Minified: this is a generated, dashboard-consumed file (~947 × 38 params,
  // incl. 18 deferred stubs) — keep the payload and git footprint down.
  writeFileSync(OUT_PATH, `${JSON.stringify(evaluated)}\n`);

  // Tally the pass/fail checks.
  const tally = {};
  for (const k of CHECK_KEYS) tally[k] = { PASS: 0, FAIL: 0, NA_sector: 0, NA_data: 0 };
  for (const e of evaluated) {
    for (const k of CHECK_KEYS) {
      const p = e.params[k];
      if (!p) continue;
      if (p.verdict === 'PASS') tally[k].PASS += 1;
      else if (p.verdict === 'FAIL') tally[k].FAIL += 1;
      else if (p.verdict === 'NA') {
        if (p.note.startsWith('Not applicable')) tally[k].NA_sector += 1;
        else tally[k].NA_data += 1;
      }
    }
  }

  console.log(`Evaluated ${evaluated.length} companies → ${OUT_PATH}\n`);
  const padR = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  console.log(
    `${padR('check', 24)}${padL('PASS', 6)}${padL('FAIL', 6)}${padL('NA(sector)', 12)}${padL('NA(data)', 10)}`
  );
  console.log('-'.repeat(58));
  for (const k of CHECK_KEYS) {
    const t = tally[k];
    console.log(`${padR(k, 24)}${padL(t.PASS, 6)}${padL(t.FAIL, 6)}${padL(t.NA_sector, 12)}${padL(t.NA_data, 10)}`);
  }
}

main();
