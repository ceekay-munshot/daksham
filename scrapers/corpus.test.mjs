import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  utimesSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { packCorpus, unpackCorpus, ensureCorpus, corpusPresent } from './corpus-archive.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'daksham-corpus-'));

// Mirrors the harvester's layout: cache/docs/<slug>/<type>-<period>.txt
function seedDocs(dir) {
  mkdirSync(path.join(dir, 'ACME'), { recursive: true });
  mkdirSync(path.join(dir, 'ZED'), { recursive: true });
  writeFileSync(path.join(dir, 'ACME', 'transcript-2026-02.txt'), 'acme concall text');
  writeFileSync(path.join(dir, 'ACME', 'ppt-2026-01.txt'), 'acme deck text');
  writeFileSync(path.join(dir, 'ZED', 'transcript-2026-02.txt'), 'zed concall text');
}

test('corpusPresent: false when missing or only-empty-dirs, true once a file exists', () => {
  const root = tmp();
  const docs = path.join(root, 'docs');
  assert.equal(corpusPresent(docs), false); // missing
  mkdirSync(path.join(docs, 'ACME'), { recursive: true });
  assert.equal(corpusPresent(docs), false); // empty subdir doesn't count
  writeFileSync(path.join(docs, 'ACME', 'a.txt'), 'x');
  assert.equal(corpusPresent(docs), true);
  rmSync(root, { recursive: true, force: true });
});

test('packCorpus refuses an empty corpus', () => {
  const root = tmp();
  const docs = path.join(root, 'docs');
  mkdirSync(docs, { recursive: true });
  assert.throws(() => packCorpus({ docsDir: docs, archive: path.join(root, 'x.tar.xz') }), /empty corpus/);
  rmSync(root, { recursive: true, force: true });
});

test('pack -> unpack round-trips the corpus byte-for-byte', () => {
  const root = tmp();
  const docs = path.join(root, 'docs');
  const archive = path.join(root, 'corpus', 'docs.tar.xz');
  seedDocs(docs);

  packCorpus({ docsDir: docs, archive });
  assert.ok(existsSync(archive));

  const out = path.join(root, 'restored');
  unpackCorpus({ archive, destDir: out });
  assert.equal(readFileSync(path.join(out, 'ACME', 'transcript-2026-02.txt'), 'utf8'), 'acme concall text');
  assert.equal(readFileSync(path.join(out, 'ACME', 'ppt-2026-01.txt'), 'utf8'), 'acme deck text');
  assert.equal(readFileSync(path.join(out, 'ZED', 'transcript-2026-02.txt'), 'utf8'), 'zed concall text');
  rmSync(root, { recursive: true, force: true });
});

test('pack is reproducible — identical content yields identical bytes despite changed mtimes', () => {
  const root = tmp();
  const docs = path.join(root, 'docs');
  seedDocs(docs);

  const a1 = path.join(root, 'a1.tar.xz');
  const a2 = path.join(root, 'a2.tar.xz');
  packCorpus({ docsDir: docs, archive: a1 });

  // Bump every file's mtime an hour into the future; --mtime=@0 must normalize
  // it out so the second archive is byte-identical (no spurious git commit).
  const future = Date.now() / 1000 + 3600;
  for (const f of ['ACME/transcript-2026-02.txt', 'ACME/ppt-2026-01.txt', 'ZED/transcript-2026-02.txt']) {
    utimesSync(path.join(docs, f), future, future);
  }
  packCorpus({ docsDir: docs, archive: a2 });

  assert.deepEqual(readFileSync(a1), readFileSync(a2));
  rmSync(root, { recursive: true, force: true });
});

test('ensureCorpus: restores from the archive on a cache miss, keeps a cache hit', () => {
  const root = tmp();
  const docs = path.join(root, 'docs'); // starts empty -> cache miss
  const archive = path.join(root, 'corpus', 'docs.tar.xz');

  const seed = path.join(root, 'seed');
  seedDocs(seed);
  packCorpus({ docsDir: seed, archive });

  // Miss: empty docs dir -> unpacks the committed archive (durable fallback).
  assert.equal(ensureCorpus({ docsDir: docs, archive }), 'archive');
  assert.equal(corpusPresent(docs), true);
  assert.equal(readFileSync(path.join(docs, 'ZED', 'transcript-2026-02.txt'), 'utf8'), 'zed concall text');

  // Hit: docs now populated -> keeps it, doesn't touch the archive.
  assert.equal(ensureCorpus({ docsDir: docs, archive }), 'cache');
  rmSync(root, { recursive: true, force: true });
});

test('ensureCorpus: clear error when neither cache nor archive exists', () => {
  const root = tmp();
  const docs = path.join(root, 'docs');
  const archive = path.join(root, 'corpus', 'docs.tar.xz');
  assert.throws(() => ensureCorpus({ docsDir: docs, archive }), /no committed archive/);
  rmSync(root, { recursive: true, force: true });
});
