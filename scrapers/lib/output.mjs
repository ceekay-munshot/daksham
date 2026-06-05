// Output writers for the universe scraper: JSON, CSV and metadata, plus a loader
// used to resume a previous run.

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { CANONICAL_KEYS } from './parse.mjs';

const BASE_FIELDS = ['name', 'path', 'slug'];

// Union of all keys across rows, in a stable order: identity fields, then the
// canonical ratio keys, then any extra (unrecognised) columns sorted alphabetically.
export function unionColumns(rows) {
  const seen = new Set([...BASE_FIELDS, ...CANONICAL_KEYS]);
  const extras = [];
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        extras.push(k);
      }
    }
  }
  extras.sort();
  return [...BASE_FIELDS, ...CANONICAL_KEYS, ...extras];
}

// The data columns (everything except the identity fields), for metadata.
export function dataColumns(rows) {
  return unionColumns(rows).filter((c) => !BASE_FIELDS.includes(c));
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  const cols = unionColumns(rows);
  const lines = [cols.map(csvEscape).join(',')];
  for (const r of rows) {
    lines.push(cols.map((c) => csvEscape(r[c] ?? '')).join(','));
  }
  return `${lines.join('\n')}\n`;
}

// Write the three output files. Called after every page so an interrupted run
// leaves valid, resumable files behind.
export function writeUniverse({ outDir, rows, source }) {
  mkdirSync(outDir, { recursive: true });

  const jsonPath = path.join(outDir, 'daksham-universe.json');
  const csvPath = path.join(outDir, 'daksham-universe.csv');
  const metaPath = path.join(outDir, 'universe-metadata.json');

  writeFileSync(jsonPath, `${JSON.stringify(rows, null, 2)}\n`);
  writeFileSync(csvPath, toCsv(rows));

  const metadata = {
    generated_at: new Date().toISOString(),
    source,
    company_count: rows.length,
    columns: dataColumns(rows),
  };
  writeFileSync(metaPath, `${JSON.stringify(metadata, null, 2)}\n`);

  return { jsonPath, csvPath, metaPath };
}

// Debug helper: dump a page's raw HTML to public/data/debug/page-N.html so the
// live DOM can be inspected. Never committed (see .gitignore); uploaded as a
// separate CI artifact instead.
export function dumpPageHtml(outDir, page, html) {
  const dir = path.join(outDir, 'debug');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `page-${page}.html`);
  writeFileSync(file, html);
  return file;
}

// Load a previously written universe so START_AT can resume without losing the
// pages already scraped. Returns [] if there is nothing usable on disk.
export function loadExistingUniverse(outDir) {
  const jsonPath = path.join(outDir, 'daksham-universe.json');
  if (!existsSync(jsonPath)) return [];
  try {
    const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
