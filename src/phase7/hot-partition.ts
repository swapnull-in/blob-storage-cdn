/**
 * Phase 7 — HOT PARTITIONS: YOUR KEY NAMING IS YOUR LOAD DISTRIBUTION. Run: npm run phase7
 *
 * Object stores look like one infinite bucket, but underneath the keyspace is
 * split into PARTITIONS by KEY PREFIX, and each partition has a real request
 * cap. S3's published numbers: ~3,500 writes/s and ~5,500 reads/s PER PREFIX.
 * Exceed the cap and you get 503 SlowDown — the bucket didn't fail, your
 * KEY NAMING did.
 *
 * The classic self-inflicted wound: timestamp-led keys.
 *
 *   logs/2026-08-17/12:00:01-a41f    ← every write today shares one prefix
 *   logs/2026-08-17/12:00:01-b7c2    ← same partition
 *   logs/2026-08-17/12:00:02-...     ← same partition. All of them.
 *
 * Sequential names sort together, and keys that sort together LIVE together —
 * on one partition. 12,000 writes/s into a 3,500/s partition = 8,500 503s/s,
 * while the other partitions sit idle. The fix costs two characters: put a
 * hash-derived shard in front (logs/a3/2026-08-17/...) and the SAME traffic
 * fans out across 16 (or 256) partitions with headroom to spare.
 *
 * Two traps look similar but are different animals:
 *   HOT PARTITION — many keys crowd one prefix. Fix: rename (spread the keys).
 *   HOT OBJECT    — the world wants ONE key (a viral video). Hashing can't
 *                   help: a single key lives on exactly one partition. Detect
 *                   it with per-key counters; fix by replicating the object
 *                   under several keys — or better, put a CDN in front so the
 *                   origin only ever sees one miss (that's Phase 8).
 *
 * "But S3 auto-splits hot partitions!" It does — ADAPTIVELY, over minutes.
 * The burst that made the partition hot eats 503s the whole time the split is
 * brewing. For workloads you KNOW will spike (launch day, log firehose), you
 * pre-spread keys so the capacity exists before the traffic does.
 *
 * TAKEAWAY: your key naming IS your load distribution. Never lead with a
 * timestamp or sequence, treat per-prefix throughput caps as real, and know
 * the difference between a hot partition (rename your keys) and a hot object
 * (replicate it, or front it with a CDN).
 */

import { log, hash32, mulberry32 } from "../lib/log.ts";

// ─── Published per-prefix caps (S3's real numbers) ──────────────────────────
const PUT_CAP_PER_PARTITION = 3_500; // writes/s per prefix
const GET_CAP_PER_PARTITION = 5_500; // reads/s per prefix

// ─── A tiny object store that partitions by key prefix ──────────────────────
// Partition id = first two path segments ("logs/2026-08-17", "logs/a3", ...).
// Real stores split by traffic-observed key ranges, but "keys that share a
// leading prefix share a partition" is exactly the behavior that bites you.

interface Partition { id: string; served: number; throttled: number; perKey: Map<string, number> }

interface ObjectStore { partitions: Map<string, Partition>; capPerPartition: number }

function makeStore(capPerPartition: number): ObjectStore {
  return { partitions: new Map(), capPerPartition };
}

function partitionOf(key: string): string {
  return key.split("/").slice(0, 2).join("/");
}

/** One simulated second of traffic: returns [served, throttled(503s)]. */
function tick(store: ObjectStore, keys: string[]): [number, number] {
  const perPartition = new Map<string, string[]>();
  for (const k of keys) {
    const pid = partitionOf(k);
    (perPartition.get(pid) ?? perPartition.set(pid, []).get(pid)!).push(k);
  }
  let served = 0, throttled = 0;
  for (const [pid, ks] of perPartition) {
    let p = store.partitions.get(pid);
    if (!p) { p = { id: pid, served: 0, throttled: 0, perKey: new Map() }; store.partitions.set(pid, p); }
    const ok = Math.min(ks.length, store.capPerPartition);
    const rejected = ks.length - ok;
    p.served += ok; p.throttled += rejected;
    served += ok; throttled += rejected;
    for (const k of ks) p.perKey.set(k, (p.perKey.get(k) ?? 0) + 1); // per-key counters (used in C)
  }
  return [served, throttled];
}

function partitionTable(store: ObjectStore): void {
  const rows = [...store.partitions.values()].sort((a, b) => b.served + b.throttled - (a.served + a.throttled));
  for (const p of rows.slice(0, 6)) {
    const total = p.served + p.throttled;
    const bar = "█".repeat(Math.max(1, Math.round(total / 800)));
    log(`   ${p.id.padEnd(18)} ${String(total).padStart(6)} req  served ${String(p.served).padStart(6)}  503s ${String(p.throttled).padStart(5)}  ${bar}`);
  }
  if (rows.length > 6) log(`   ... and ${rows.length - 6} more partitions like the last one`);
}

const WRITES_PER_SEC = 12_000;

function main() {
  const rand = mulberry32(0xb10b);

  // ═════ A. Timestamp-led keys: one prefix, one partition, 503s ═════════════
  log("═══ A. Sequential key naming — logs/2026-08-17/<time>-<id> ═══");
  log(`${WRITES_PER_SEC} writes/s of log objects, keys led by today's date:`);
  {
    const store = makeStore(PUT_CAP_PER_PARTITION);
    const keys: string[] = [];
    for (let i = 0; i < WRITES_PER_SEC; i++) {
      keys.push(`logs/2026-08-17/12:00:${String(i % 60).padStart(2, "0")}-${hash32("evt" + i).toString(16)}`);
    }
    const [served, throttled] = tick(store, keys);
    partitionTable(store);
    log(`   → ${store.partitions.size} partition carries EVERYTHING: ${served} served, ${throttled} × 503 SlowDown (${(throttled / WRITES_PER_SEC * 100).toFixed(0)}% of traffic rejected)`);
    log(`   The bucket is nowhere near "full" — the KEYS all sort into one prefix.`);
  }

  // ═════ B. Hash-prefixed keys: same traffic, spread, zero 503s ═════════════
  log("");
  log("═══ B. Hash-prefixed keys — logs/<hash%16>/2026-08-17/... ═══");
  log(`The SAME ${WRITES_PER_SEC} writes/s, two extra characters in the key:`);
  {
    const store = makeStore(PUT_CAP_PER_PARTITION);
    const keys: string[] = [];
    for (let i = 0; i < WRITES_PER_SEC; i++) {
      const shard = (hash32("evt" + i) % 16).toString(16).padStart(2, "0"); // logs/00 .. logs/0f
      keys.push(`logs/${shard}/2026-08-17/12:00:${String(i % 60).padStart(2, "0")}-${hash32("evt" + i).toString(16)}`);
    }
    const [served, throttled] = tick(store, keys);
    partitionTable(store);
    log(`   → ${store.partitions.size} partitions × ~${Math.round(WRITES_PER_SEC / 16)} req each (cap ${PUT_CAP_PER_PARTITION}): ${served} served, ${throttled} × 503`);
    log(`   Need 50k GET/s? At ${GET_CAP_PER_PARTITION}/prefix that's ≥10 prefixes — design the key layout up front.`);
  }

  // ═════ C. The HOT OBJECT is a different beast ═════════════════════════════
  log("");
  log("═══ C. Hot object ≠ hot partition — one viral video ═══");
  log("20,000 GET/s: 19,000 want ONE key, 1,000 spread over the catalog:");
  {
    const store = makeStore(GET_CAP_PER_PARTITION);
    const viral = "videos/3f/dQw4w9WgXcQ.mp4"; // already hash-prefixed — doesn't matter!
    const keys: string[] = [];
    for (let i = 0; i < 19_000; i++) keys.push(viral);
    for (let i = 0; i < 1_000; i++) {
      const id = "vid" + Math.floor(rand() * 5000);
      keys.push(`videos/${(hash32(id) % 256).toString(16).padStart(2, "0")}/${id}.mp4`);
    }
    const [, throttled] = tick(store, keys);
    const hot = store.partitions.get(partitionOf(viral))!;
    const topShare = hot.perKey.get(viral)! / (hot.served + hot.throttled);
    log(`   videos/3f partition: ${hot.served + hot.throttled} req/s → ${hot.throttled} × 503 (total across store: ${throttled})`);
    log(`   DETECTION — per-key counters on the hot partition: top key = ${(topShare * 100).toFixed(1)}% of its traffic`);
    log(`   → ${viral} IS the partition. Re-hashing keys can't help: one key lives on one partition.`);

    // Fix 1: replicate the object under 4 keys, fan reads across the replicas.
    const store2 = makeStore(GET_CAP_PER_PARTITION);
    const keys2: string[] = [];
    for (let i = 0; i < 19_000; i++) {
      const r = i % 4; // client picks a replica: videos/<hash(id+r)>/...~r<r>
      keys2.push(`videos/${(hash32("dQw4w9WgXcQ~r" + r) % 256).toString(16).padStart(2, "0")}/dQw4w9WgXcQ.mp4~r${r}`);
    }
    for (let i = 0; i < 1_000; i++) {
      const id = "vid" + Math.floor(rand() * 5000);
      keys2.push(`videos/${(hash32(id) % 256).toString(16).padStart(2, "0")}/${id}.mp4`);
    }
    const [, throttled2] = tick(store2, keys2);
    log(`   FIX 1 — replicate: 4 copies under 4 hashed keys → ~4,750 req/s each (cap ${GET_CAP_PER_PARTITION}) → ${throttled2} × 503`);
    log(`   FIX 2 — the real one: CDN in front, origin sees ONE miss per edge, not 19,000/s → Phase 8.`);
  }

  // ═════ D. Auto-split saves you — eventually. The burst pays first. ════════
  log("");
  log("═══ D. \"The store auto-splits hot partitions\" — yes, in minutes ═══");
  log("Launch-day burst: 12,000 writes/s to a fresh prefix. Store splits the hot");
  log("partition 4-ways after 3 minutes of sustained throttling:");
  {
    const SPLIT_AFTER_MIN = 3, SPLIT_WAYS = 4;
    let lost = 0;
    for (let minute = 1; minute <= 5; minute++) {
      const partitions = minute > SPLIT_AFTER_MIN ? SPLIT_WAYS : 1; // split lands after minute 3
      const cap = partitions * PUT_CAP_PER_PARTITION;
      const throttledPerSec = Math.max(0, WRITES_PER_SEC - cap);
      lost += throttledPerSec * 60;
      const note = minute === SPLIT_AFTER_MIN + 1 ? "  ← split finally lands" : partitions === 1 ? "  (split still brewing)" : "";
      log(`   minute ${minute}: ${partitions} partition(s), cap ${cap}/s → ${throttledPerSec} × 503/s${note}`);
    }
    log(`   → ${lost.toLocaleString("en-US")} requests 503'd before the split caught up.`);
    log(`   Pre-spread keys (B) would have had 16 partitions at minute 0: 0 lost.`);
    log(`   Adaptive splitting is a safety net, not a capacity plan — for known-spiky`);
    log(`   workloads, the prefixes must exist BEFORE the burst does.`);
  }

  log("");
  log("TAKEAWAY: your key naming IS your load distribution. Timestamp-led keys");
  log("funnel every write into one partition's 3,500/s cap; a 2-char hash prefix");
  log("makes the same traffic free. Hot OBJECT ≠ hot partition — detect it with");
  log("per-key counters, replicate it or front it with a CDN (Phase 8). And auto-");
  log("splitting takes minutes the burst won't wait for: pre-spread spiky keys.");
  process.exit(0);
}

main();
