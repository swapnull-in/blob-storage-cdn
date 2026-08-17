/** Drill data — mined from Core Course/08-storage.md + Deep Dives/18-pattern-large-blobs.md. */
window.DRILL = {
  module: "Module 08 — Storage & Large Blobs",
  source: "Core Course/08-storage.md + Deep Dives/18-pattern-large-blobs.md + apple-notes/06",
  cheats: [
    "<b>The default:</b> object storage + CDN, <em>key in the DB</em>. Never store blobs in the database; never explain what S3 is; never build a DFS when S3 suffices.",
    "<b>Three paradigms:</b> <em>block</em> = raw blocks, single attach, for DBs; <em>file</em> = shared POSIX (NFS/SMB), only with a named POSIX reason; <em>object</em> = immutable blobs by key over HTTP — the default.",
    "<b>Why object scales:</b> immutability + flat namespace = trivial horizontal scale — no locks, no rename, no in-place updates; the only strongly-consistent piece is a small metadata/index service.",
    "<b>The blob reflex:</b> metadata row <code>pending</code> → presigned URL → client uploads direct (multipart, parallel, resumable) → storage event flips <code>ready</code> → downloads via CDN/signed URLs. <em>Servers move pointers, never bytes.</em>",
    "<b>11 nines</b> = a race between <em>failure rate and repair rate</em>: erasure-coded fragments across ≥3 AZs + continuous scrubbing + fast parallel repair. Repair speed is the dominant lever, not copy count.",
    "<b>EC vs replication:</b> 3x replication tolerates 2 failures at 3.0x cost; <code>EC(6,3)</code> tolerates 3 at 1.5x — but repair reads <code>k</code> fragments and recomputes (<code>k</code>x read amplification).",
    "<b>Tier it:</b> replicate hot, erasure-code cold, lifecycle worker re-encodes as data cools. <em>LRC</em> (Azure) makes the common single-fragment repair cheap.",
    "<b>Per-prefix limits:</b> ~3,500 PUT / 5,500 GET per second <em>per prefix</em>. Key naming is load distribution — hash a shard id into the prefix (<code>media/a7/...</code>) to get parallelism up front.",
    "<b>Multipart numbers:</b> 5 GB single-PUT max; parts 5 MB–5 GB, up to 10k parts, 5 TB object cap. The retry unit is a part, not the file; a lifecycle rule reaps abandoned parts.",
    "<b>The commit point:</b> <code>CompleteMultipartUpload</code> → atomic metadata commit is the strong-consistency point — before it the object does not exist; after it, GET sees it (modern S3 strong read-after-write).",
    "<b>CAS/dedup:</b> address chunks by content hash — identical content stored once, integrity free; needs refcounted GC and content-defined chunking. Introduce <em>only</em> for naturally repetitive data.",
    "<b>DACL framework:</b> Durability vs Availability vs Cost vs Latency — pick the two that matter, degrade the rest deliberately. <em>Classify data first: not all of it deserves the same treatment.</em>",
    "<b>Egress is the bill:</b> internet egress ~$0.05–0.09/GB dwarfs storage (~$0.023/GB-mo). For media, a CDN with high hit ratio is non-negotiable — flag it unprompted.",
    "<b>Block question:</b> who owns durability — the storage layer (EBS + snapshots for single-writer DBs) or the data layer (local NVMe for quorum systems that already replicate)?"
  ],
  cards: [
    {
      topic: "blob pattern",
      q: "Where do user-uploaded files go in your design — and why never through your API tier or into the database?",
      a: "Bytes go to object storage; the DB row carries only the object key, owner, and status — 'the database owns that the file exists; the bucket holds its body.' Proxying uploads turns app servers into bandwidth proxies: buffered gigabytes, memory pressure, LB timeouts, fleet size scaling with bytes. Blobs in the DB bloat storage, blow the buffer pool, and drag replication and backups to a crawl. Presigned URLs delete the middleman in both directions — the API hands out capabilities, not bytes. Exception: files under ~1 MB (avatars) are fine inline; the pattern's ceremony is not earned."
    },
    {
      topic: "presigned",
      q: "The DB says a file exists but S3 has no bytes (or vice versa). How does upload-then-commit close the gap, and who cleans up orphans?",
      a: "Create the metadata row as status=pending — invisible to readers — then mint a time- and scope-limited presigned URL ('PUT this one key for 15 minutes'). Only a storage event notification, never client say-so, flips it to ready after optional validation or virus scan. A TTL reaper sweeps stale pending rows and orphaned multipart parts — the crash-between-steps cleanup. Two systems, one logical fact, reconciled by events plus a sweeper, not by hope."
    },
    {
      topic: "multipart",
      q: "A 50 GB upload over a flaky mobile network dies at 90%. Walk the multipart design that makes resume cheap.",
      a: "CreateMultipartUpload returns an uploadId; the client splits into parts (5 MB–5 GB, up to 10k parts, 5 TB cap) and uploads them in parallel via presigned URLs, each returning an ETag — the retry unit is a part, not the file. After a crash, ListParts tells the client what survived: resume from part 47, not byte zero. CompleteMultipartUpload sends the ordered part list + ETags and atomically commits metadata — the strong-consistency point; until then the object is invisible. A lifecycle rule reaps abandoned parts so orphans do not accrue cost."
    },
    {
      topic: "durability",
      q: "How does S3 achieve 11 nines of durability? Give the math intuition, not just the number.",
      a: "It is a race between failure rate and repair rate across independent failure domains. Each object is erasure-coded into k+m fragments across ≥3 AZs, so you must lose more than m fragments within one repair window. With 2%-AFR disks and EC(6,3), a fragment's chance of dying inside a ~1-hour repair window is ~2e-6; four coinciding is ~(2e-6)^4 — past 1e-11 annual loss even after combinatorics. The structure is the signal: independent domains + many fragments + a short repair window; repair speed dominates. The real-world threat is correlated failure that defeats independence — bad firmware, shared power — not steady-state disk AFR."
    },
    {
      topic: "dur vs avail",
      q: "Durability and availability for blobs: different numbers, different machinery — explain the distinction.",
      a: "Durability (11 nines) is the probability the bytes still exist — manufactured by erasure coding across failure domains, scrubbing, and fast repair; it is about annual loss, not uptime. Availability (99.9x%) is whether you can reach them right now — manufactured by redundant front-ends, multi-AZ request routing, and replicas online. An AZ outage can make objects unreachable for an hour without losing a byte: availability drops, durability is untouched. One Zone-IA shows the converse trade: same request plane, weaker durability to AZ loss. Different SLAs, different machinery — never quote one number for both."
    },
    {
      topic: "erasure",
      q: "Replication or erasure coding — how do you decide, and why does cold storage get EC while hot stays replicated?",
      a: "It is storage cost vs CPU-and-repair cost, and the answer is tiering, not a single choice. 3x replication tolerates 2 failures at 3x storage with trivial repair (copy one block); EC(6,3) tolerates 3 at 1.5x, but rebuilding one fragment reads k fragments and recomputes — k-times read/network amplification plus latency that hurts small hot objects. At exabyte scale, halving storage overhead dominates, so cold write-once data is virtually always EC; hot churny data stays replicated. Default: replicate hot, EC(6,3) cold, lifecycle worker re-encodes as data cools; add LRC to make single-failure repair cheap."
    },
    {
      topic: "CAS",
      q: "Design dedup for a backup/sync product. What does content-addressable storage buy, and what does it cost?",
      a: "Chunk each file with content-defined boundaries (Rabin fingerprinting) so a 1-byte edit shifts one chunk, hash each chunk (SHA-256), store each once under its hash; a file is a manifest of chunk hashes. Clients send hashes first and upload only chunks the server lacks — cross-user dedup plus delta sync, commonly reclaiming 30–70%, with integrity free since the address verifies the content. Costs: no in-place update ever, refcounted GC to reclaim space when references drop, and a conflict with per-user encryption (convergent encryption is the compromise). Only earn this complexity when data is naturally repetitive."
    },
    {
      topic: "GC",
      q: "A blob is 'deleted'. Walk the actual deletion path and explain why immediate physical delete is wrong.",
      a: "Delete writes a tombstone (or delete marker) — the key vanishes from reads immediately, bytes stay. A grace window protects against accidental deletion, versioned undelete, and in-flight readers. Async GC then drops fragments once references hit zero — with CAS a chunk may back many objects, so refcounts must reach zero first — and compaction rewrites storage extents to reclaim space in batches. Immediate delete is wrong because fragments are spread across EC groups and shared extents: synchronous scatter-delete is slow, races readers, and forfeits undelete. Lifecycle policies are the same machinery on a timer: expiry is just a scheduled tombstone."
    },
    {
      topic: "hot prefix",
      q: "One prefix (or one object) takes nearly all traffic. How do you detect it, and what are the two fixes?",
      a: "Detection: 503 SlowDown responses and per-prefix request metrics — S3 gives ~3,500 PUT / 5,500 GET per second per prefix, and adaptive splitting takes minutes to warm. Fix one: key naming — hash a shard id into the prefix (media/a7/id) to fan load across hundreds of partitions up front; key layout is load distribution. Fix two: for a single hot object, stop hitting the bucket at all — put a CDN in front so the origin sees only cache misses. Design the key layout before launch; waiting for auto-partitioning is a throttled launch day."
    },
    {
      topic: "CDN",
      q: "Millions download the same video. What do you cache at the edge, how do you invalidate, and how do private blobs work?",
      a: "Put the CDN in front of the bucket and cache immutable public media at the edge — the origin sees cache misses only. Invalidate with versioned URLs: put a content hash or version in the URL, set cache-forever headers, and never purge — a new version is a new URL, so 'invalidation' becomes a metadata pointer flip. Private content uses signed CDN URLs (or cookies): the API authorizes and mints a short-lived capability, the edge enforces it. This is also the cost story — the CDN absorbs egress, which otherwise dominates the media bill."
    },
    {
      topic: "ingestion",
      q: "100M photo uploads/day: sketch the full ingestion path with rough sizes for every component.",
      a: "100M/day ≈ 1,200 uploads/s average, plan ~5,000/s peak; at ~3 MB per photo that is ~300 TB/day of bytes that must never touch the API tier. Path: client → API (auth, create pending row, mint presigned URL — a few thousand cheap req/s on a small stateless fleet) → direct PUT to object storage with hashed key prefixes (5k PUT/s needs a couple of prefixes minimum; give it 256) → storage event → queue → thumbnail/transcode workers (sized to ~1,200/s, elastic) → flip row to ready. Metadata DB sharded by user/photo id at ~1,200 writes/s. Serve reads via CDN; lifecycle-tier originals as they cool."
    },
    {
      topic: "tiering",
      q: "Design storage tiering for a photo service to minimize cost without hurting UX.",
      a: "Classify by access recency, then let lifecycle automate: hot recent photos on Standard (replicated, CDN-fronted); after ~30 days of low access, originals to IA at ~half cost; after ~90 days to Glacier Instant Retrieval — still milliseconds, because users will not tolerate hours for their own photos. Deep Archive is for compliance backups only. Keep derived assets (thumbnails, transcodes) regenerable on cheaper single-AZ storage — never pay 11 nines for regenerable data. Dedup identical uploads, CDN in front for egress. Durability stays high everywhere; cost concentrates only where access justifies it."
    },
    {
      topic: "consistency",
      q: "Object storage now offers strong consistency — can you use it like a database?",
      a: "No. Strong read-after-write means an immediate GET reflects the last PUT to that key — it does not give mutability, multi-object transactions, efficient append, or partial writes; objects are still write-once-whole. Conditional writes (If-Match / If-None-Match) buy optimistic concurrency on a single key, nothing more. For transactional or queryable semantics you build a layer on top — a metadata DB, or table formats like Iceberg/Delta that provide ACID over immutable object files via a transaction log. Strong consistency removed a footgun; the primitive is still immutable blobs."
    },
    {
      topic: "egress",
      q: "EM layer: how do you control the storage bill across teams — and what is the surprise line item?",
      a: "The surprise is egress: internet transfer at $0.05–0.09/GB routinely dwarfs storage at $0.023/GB-mo — serving one viral image from the bucket can out-cost storing it by 10x, so CDN hit ratio is the first lever. Second lever is lifecycle policies: tier to IA/Glacier by age and expire regenerable data automatically — policy, not engineering effort. Then dedup and tiny-object aggregation (per-object minimums and request costs punish millions of small files). Showback: tag buckets and prefixes per team, use inventory and cost reports to attribute storage, requests, and egress — teams fix what they are billed for."
    }
  ]
};
