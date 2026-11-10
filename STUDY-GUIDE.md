# Blob Storage & CDN — Study Guide

**How to study.** Work one phase at a time: run the phase (`npm run phase1` … `phase8`), read the code until you can predict its output, then hit the Drill tab in the web UI and answer the matching cards cold before reading the module section below. Follow the apple-note's 3-session plan (`apple-notes/06-blob-storage-and-cdn.txt`): Session 1 = the pattern (phases 1–2 + Deep Dive 18), Session 2 = the blind "build S3" rep (phases 3–7 + Core Course 08), Session 3 = the 8-question certification, cold, two days later.

## Phase map

| Phase | What it builds | Module section | The staff insight |
|---|---|---|---|
| `phase1` presigned-urls | The pattern: pointers in the DB, bytes direct to the store, upload-then-commit + orphan GC | Deep Dives/18 — "The pattern" + "The consistency gap" | "My API hands out capabilities, not bytes." Status flips `pending` → `ready` via storage event, never client say-so; a TTL reaper sweeps orphans. |
| `phase2` multipart-upload | Parts, ETags, resume, abandoned-part cleanup | Deep Dives/18 — "Big files" · 08-storage §2.6, Q7 | "A dropped connection costs one part, not the file." The `Complete` metadata commit is the only strong-consistency point in the system. |
| `phase3` durability-math | 11 nines = independent failure domains + repair speed, not copy count | 08-storage §2.2 "Durability math" | "Durability is a race between *failure rate* and *repair rate*." Fast repair — not more copies — is the dominant lever; correlated failure is the real threat. |
| `phase4` erasure-coding | k+m vs 3x replication: overhead, repair cost, hot vs cold | 08-storage §6 | "EC trades CPU and repair-time read-amplification for storage cost." Replicate hot, erasure-code cold, tier between — one fragment repair reads all `k`. |
| `phase5` content-addressable | Hash-keyed dedup + integrity; refcounted GC, no in-place update | 08-storage §7 "Deduplication & CAS", Q6 | "Identical content → identical address → stored once." Content-defined chunking means a 1-byte edit re-uploads almost nothing — but you sign up for GC forever. |
| `phase6` deletion-gc | Tombstone → grace → GC → compaction; lifecycle policies | 08-storage §7 pitfalls + §2.4 lifecycle | "CAS without garbage collection … stores leak space when references drop; you need GC." Deletion is a metadata event now, a byte-reclaim batch job later. |
| `phase7` hot-partition | Key naming is load distribution; per-prefix limits | 08-storage §2.5 | "If all your keys share one prefix you'll throttle (503 SlowDown) until S3 adaptively splits." Design 256 hashed prefixes up front; don't wait minutes for auto-split. |
| `phase8` cdn | Edge caching, versioned-URL invalidation, signed URLs, the egress bill | 08-storage §2.7 + Deep Dives/18 download path | "Raw storage is rarely the dominant line item; **egress is**." Versioned URLs make invalidation a pointer flip; the origin should see cache misses only. |

## Go deeper

- **[Deep Dives/18-pattern-large-blobs.md](https://github.com/swapnull-in/system-design/blob/main/Deep%20Dives/18-pattern-large-blobs.md)** — the whole pattern on one page, with the probe-and-answer table to recite before interviews.
- **[Core Course/21-build-from-scratch.md](https://github.com/swapnull-in/system-design/blob/main/Core%20Course/21-build-from-scratch.md) §6 (blob store)** — the blind-rep target: rebuild S3 from a blank page, then diff yourself against it.
- **[Core Course/03-caching.md](https://github.com/swapnull-in/system-design/blob/main/Core%20Course/03-caching.md) — CDN section** — stampede protection, global invalidation, and egress economics in full depth (the apple-note says do this first).
- **DDIA — 04-storage-and-retrieval** — what happens below the object API: LSM-trees, compaction, and why append-only + GC keeps reappearing at every layer.
