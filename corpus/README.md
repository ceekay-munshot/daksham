# corpus/

`docs.tar.xz` is a committed, compressed snapshot of the harvested document
corpus (`cache/docs/`) — the **durable fallback** on top of `actions/cache`.

- The cache (key prefix `docs-`) is the fast path, but it evicts after 7 days of
  no access (or 10 GB LRU). This archive lives in git, so the ~154 MB of
  extracted text (~40 MB xz'd) is always recoverable and stays versioned
  alongside `public/data/docs-manifest.json`.
- Produced by the **Document harvester** (automatically, after each successful
  harvest) and the **Archive corpus** workflow (on demand). The xz tar is
  reproducible (sorted, fixed mtime, single-threaded), so the blob only changes
  when the corpus actually changes — and xz keeps it clear of GitHub's 50 MB
  recommended file-size limit.
- Restore locally: `npm run archive:unpack` (→ `cache/docs/`). Read jobs call
  `node scrapers/corpus-archive.mjs ensure` to use the cache if present, else
  this archive.

Generated and committed by CI — do not edit `docs.tar.xz` by hand. (It appears
here after the first harvest or Archive-corpus run lands.)
