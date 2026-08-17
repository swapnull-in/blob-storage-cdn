# Learn Blob Storage & CDNs in TypeScript

A hands-on, runnable project for understanding object storage and content
delivery at a Staff/EM level — the presigned-URL pattern, multipart upload,
durability math, erasure coding, content-addressable storage, garbage
collection, hot partitions, and the CDN in front.

Every phase is a small script you can run and read. No build step: modern Node
runs the TypeScript directly. No external services.

> Built to match a Staff-level study path. The through-line: **big bytes never
> touch your servers** — metadata in a DB, bytes in object storage, presigned
> URLs both ways. The interesting design is **durability economics**: how eleven
> nines is *manufactured* (independent failure domains + repair speed, not
> copies), and what erasure coding buys over replication.

## Setup

```bash
npm install   # dev types only
```

## The lessons

| Command | What you learn |
|---|---|
| `npm run phase1` | **Presigned URLs** — pointers not bytes; HMAC capabilities; upload-then-commit + orphan GC |
| `npm run phase2` | **Multipart upload** — parts + ETags, resume after failure, the `Complete` commit point, abandoned-part cleanup |
| `npm run phase3` | **Durability math** — 11 nines derived: failure domains × repair speed; correlation is the killer |
| `npm run phase4` | **Erasure coding** — real k+m parity: lose any 2 of 6, reconstruct exactly; 1.5× vs 3× economics |
| `npm run phase5` | **Content-addressable storage** — `sha256(content)` keys: dedup, integrity, refcounted GC |
| `npm run phase6` | **Deletion & GC** — tombstone → grace → async GC → compaction; lifecycle policies as the cost lever |
| `npm run phase7` | **Hot partitions** — key naming IS load distribution; per-prefix limits and 503 SlowDown |
| `npm run phase8` | **CDN** — edge caching, versioned-URL invalidation, signed URLs at the edge, the egress bill |

## What each phase proves (the money quotes)

- **Phase 1** — 50 users uploading 2 GB videos push **~400 GB** through your
  fleet when proxied vs **0 bytes** presigned; a tampered or expired URL is
  **DENIED** by the store itself.
- **Phase 2** — a 5 GB single PUT that dies at 80% costs **9,216 MB**; multipart
  resume re-sends one part: **5,248 MB — 3,968 MB saved**.
- **Phase 3** — three copies with a 30-*day* repair window: 1.5e-7 annual loss;
  the same three copies with 3-*hour* repair: **2.8e-12 (11.6 nines)**. Repair
  speed did that, not more copies — and three copies in one rack collapse back
  to ~2 nines.
- **Phase 4** — all **15 possible 2-shard losses** of a k=4+m=2 object
  reconstruct byte-identically at **1.5× storage** vs replication's 3.0× —
  the same tolerance at half the bill.
- **Phase 5** — 1,000 uploads of the same meme = **1 physical write** (99.9%
  saved); a flipped bit on disk is caught because the address *is* the hash.
- **Phase 7** — timestamp-led keys: **8,500 of 12,000 writes/s rejected** (503);
  hash-prefixed keys: zero.
- **Phase 8** — a CDN takes ap-south from 205 ms to **16.5 ms** at a 99.5% hit
  ratio and collapses origin egress **293×**; versioned URLs make invalidation a
  non-event (0 stale reads, 0 purges).

## Interactive Blob Lab

Every phase is also a live instrument in the browser — flip a bit and watch the
hash catch it, lose two erasure shards and reconstruct, tombstone a blob and
run the GC, throttle a timestamp-keyed firehose, and price the egress bill.

```bash
npm run web        # serves web/index.html at http://localhost:8080 (no deps)
```

One self-contained static page (self-hosted fonts), grouped by tier and
deep-linkable. To host it on **Cloudflare Pages**: connect this repo in the
dashboard with build output `web` (auto-deploys on push), or run
`npx wrangler login` then `npm run deploy`.

## Project layout

```
src/
  lib/log.ts   (logger + hash + seeded PRNG)
  phase1/  presigned URLs + upload-then-commit + orphan GC
  phase2/  multipart upload + resume + abandoned-part cleanup
  phase3/  durability math (failure domains × repair speed)
  phase4/  erasure coding k+m vs 3× replication
  phase5/  content-addressable storage (dedup, integrity, refcounts)
  phase6/  deletion pipeline: tombstone → GC → compaction
  phase7/  hot partitions & key naming
  phase8/  CDN: edge caching, versioned URLs, signed URLs, egress
web/
  index.html  ·  serve.mjs   (the interactive Blob Lab — npm run web)
```

## Drill & study guide

The web lab has a **Drill** tab — the matching study module's interview questions
and cheat-sheet one-liners as click-to-reveal cards (active recall: answer out
loud before revealing). [`STUDY-GUIDE.md`](STUDY-GUIDE.md) maps every phase to
the exact module section it implements, with the staff-level insight quoted, and
points to the deep dives to read next.

## License

MIT — use it, fork it, learn from it.
