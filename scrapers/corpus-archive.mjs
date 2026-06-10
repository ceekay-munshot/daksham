#!/usr/bin/env node
// Corpus archive — a committed, compressed snapshot of the document corpus that
// serves as a DURABLE fallback on top of actions/cache. The cache evicts after
// 7 days of no-access (or 10 GB LRU); this tarball lives in git, so the ~49 MB
// of harvested text is always recoverable and stays versioned with the manifest.
//
//   node scrapers/corpus-archive.mjs pack     # cache/docs        -> corpus/docs.tar.gz
//   node scrapers/corpus-archive.mjs unpack   # corpus/docs.tar.gz -> cache/docs
//   node scrapers/corpus-archive.mjs ensure   # populate cache/docs if empty
//
// pack is REPRODUCIBLE (sorted names, fixed mtime/owner, gzip from a stream) so
// an unchanged corpus yields identical bytes — no spurious ~15 MB git commit.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DOCS = path.join(ROOT, 'cache', 'docs');
const DEFAULT_ARCHIVE = path.join(ROOT, 'corpus', 'docs.tar.gz');

// True if docsDir exists and holds at least one file in any subdirectory.
export function corpusPresent(docsDir = DEFAULT_DOCS) {
  if (!existsSync(docsDir)) return false;
  for (const name of readdirSync(docsDir)) {
    const p = path.join(docsDir, name);
    try {
      if (statSync(p).isDirectory() && readdirSync(p).length > 0) return true;
    } catch {
      /* unreadable entry — ignore */
    }
  }
  return false;
}

// Pack docsDir into a reproducible .tar.gz at `archive`.
export function packCorpus({ docsDir = DEFAULT_DOCS, archive = DEFAULT_ARCHIVE } = {}) {
  if (!corpusPresent(docsDir)) {
    throw new Error(`No documents under ${docsDir} — refusing to pack an empty corpus.`);
  }
  mkdirSync(path.dirname(archive), { recursive: true });
  // Reproducible: --sort=name + fixed mtime/owner + gnu format; tar streams to
  // its internal gzip (which writes no filename/mtime header for stdin), so an
  // identical corpus => identical bytes. LC_ALL=C keeps the name sort stable.
  execFileSync(
    'tar',
    [
      '--sort=name',
      '--format=gnu',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '-czf',
      archive,
      '-C',
      docsDir,
      '.',
    ],
    { stdio: 'inherit', env: { ...process.env, LC_ALL: 'C' } }
  );
  return archive;
}

// Unpack `archive` into destDir (created if missing).
export function unpackCorpus({ archive = DEFAULT_ARCHIVE, destDir = DEFAULT_DOCS } = {}) {
  if (!existsSync(archive)) throw new Error(`No archive at ${archive}.`);
  mkdirSync(destDir, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', destDir], { stdio: 'inherit' });
  return destDir;
}

// Guarantee cache/docs is populated: keep a cache hit as-is, else unpack the
// committed archive (the durable fallback). Read jobs (corpus-check, AI
// extraction) call this right after the actions/cache restore. Returns the
// source used: 'cache' or 'archive'.
export function ensureCorpus({ docsDir = DEFAULT_DOCS, archive = DEFAULT_ARCHIVE } = {}) {
  if (corpusPresent(docsDir)) return 'cache';
  if (!existsSync(archive)) {
    throw new Error(
      `cache/docs is empty and no committed archive at ${archive} — ` +
        'run the Document harvester (or the Archive corpus workflow) to create it.'
    );
  }
  unpackCorpus({ archive, destDir: docsDir });
  return 'archive';
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let i = -1;
  do {
    n /= 1024;
    i += 1;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(1)} ${units[i]}`;
}

function main() {
  const cmd = process.argv[2];
  if (cmd === 'pack') {
    const archive = packCorpus();
    console.log(
      `Packed ${path.relative(ROOT, DEFAULT_DOCS)} -> ${path.relative(ROOT, archive)} ` +
        `(${fmtBytes(statSync(archive).size)})`
    );
  } else if (cmd === 'unpack') {
    unpackCorpus();
    console.log(`Unpacked ${path.relative(ROOT, DEFAULT_ARCHIVE)} -> ${path.relative(ROOT, DEFAULT_DOCS)}`);
  } else if (cmd === 'ensure') {
    const src = ensureCorpus();
    console.log(
      src === 'cache'
        ? 'Corpus already present (actions/cache hit) — skipped unpack.'
        : 'Corpus restored from the committed archive (cache miss) — durable fallback used.'
    );
  } else {
    console.error('Usage: node scrapers/corpus-archive.mjs <pack|unpack|ensure>');
    process.exit(1);
  }
}

// Run only when invoked directly (lets read jobs import the functions).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
