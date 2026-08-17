/**
 * Phase 6 — DELETION, GC & LIFECYCLE: what "delete" actually means. Run: npm run phase6
 *
 * In a blob store, DELETE is not an operation — it's a STATE MACHINE. Naively
 * you'd think "user hits delete → overwrite the bytes." But at the moment of
 * deletion, the blob is *everywhere*: a reader may be mid-download, 3 replicas
 * hold fragments, CDN edges cache it, a backup snapshot references it, and
 * (after phase 5) other users' pointers may share the same content. A
 * synchronous fan-out delete to all of them is slow, and worse, PARTIAL —
 * one timeout and you're left half-deleted with no record of what remains.
 *
 * So every real object store splits deletion into cheap-now and thorough-later:
 *
 *   DELETE  → write a TOMBSTONE in metadata (one fast atomic row update;
 *             the user sees 404 immediately — that IS the delete, to them)
 *   GC      → an async pass physically removes tombstoned blobs once a GRACE
 *             window passes (which is also your undelete / trash window)
 *   COMPACT → blobs live inside big append-only container files; freeing a
 *             blob just leaves a dead hole, so compaction copies the live
 *             blobs into a fresh container and drops the old one
 *
 * Two sweeps guard the metadata↔bytes invariant from opposite directions:
 * GC removes bytes whose metadata says "dead"; the ORPHAN sweep removes bytes
 * that have NO metadata at all (crashed uploads, phase-18's "reaper").
 * Together: every stored byte is reachable, every live key has its bytes.
 *
 * The same async machinery is the COST lever: lifecycle policies tier blobs
 * by age (hot → infrequent-access → archive → expire), and that — not faster
 * disks — is how storage bills get controlled.
 *
 * TAKEAWAY: deletion is a state machine (tombstone → grace → GC → compaction),
 * not an operation; lifecycle policies are how storage bills get controlled.
 */

import { log } from "../lib/log.ts";

type State = "live" | "tombstoned";
interface Meta { key: string; size: number; state: State; tombstonedDay: number }
interface Rec { key: string | null; size: number; dead: boolean } // key=null → orphan bytes
interface Container { id: string; recs: Rec[] }

const GRACE_DAYS = 7;      // undelete window; also how long readers/caches may lag
const COMPACT_AT = 0.30;   // compact a container once ≥30% of its bytes are dead
const mb = (n: number): string => (n / 1_048_576).toFixed(1) + " MB";

class BlobStore {
  meta = new Map<string, Meta>();  // metadata plane: key → state
  containers: Container[] = [];    // data plane: append-only container files
  day = 0;                         // logical clock — no wall time, fully deterministic

  putMany(container: string, entries: Array<[string, number]>): void {
    const c: Container = { id: container, recs: [] };
    for (const [key, size] of entries) {
      c.recs.push({ key, size, dead: false });
      this.meta.set(key, { key, size, state: "live", tombstonedDay: -1 });
    }
    this.containers.push(c);
  }

  /** DELETE = tombstone. One atomic metadata write; not a byte is touched. */
  delete(key: string): void {
    const m = this.meta.get(key)!;
    m.state = "tombstoned"; m.tombstonedDay = this.day;
  }

  read(key: string): string {
    const m = this.meta.get(key);
    return m === undefined || m.state === "tombstoned" ? "404 Not Found" : "200 OK";
  }

  undelete(key: string): boolean { // only possible while GC hasn't run past grace
    const m = this.meta.get(key);
    if (m === undefined || m.state !== "tombstoned") return false;
    m.state = "live"; m.tombstonedDay = -1;
    return true;
  }

  /** Async GC pass: physically free tombstones older than the grace window. */
  gc(): { removed: number; bytes: number } {
    let removed = 0, bytes = 0;
    for (const m of [...this.meta.values()]) {
      if (m.state !== "tombstoned" || this.day - m.tombstonedDay < GRACE_DAYS) continue;
      for (const c of this.containers) for (const r of c.recs) if (r.key === m.key) { r.dead = true; bytes += r.size; }
      this.meta.delete(m.key); removed++;
    }
    return { removed, bytes };
  }

  /** Orphan sweep — the other direction: container bytes with NO metadata row. */
  orphanSweep(): { removed: number; bytes: number } {
    let removed = 0, bytes = 0;
    for (const c of this.containers) for (const r of c.recs) {
      const orphan = !r.dead && (r.key === null || !this.meta.has(r.key));
      if (orphan) { r.dead = true; removed++; bytes += r.size; }
    }
    return { removed, bytes };
  }

  /** Compaction: copy live records forward into a new container, drop the old file. */
  compact(): { reclaimed: number } {
    let reclaimed = 0;
    this.containers = this.containers.map((c) => {
      const deadBytes = c.recs.filter((r) => r.dead).reduce((s, r) => s + r.size, 0);
      const total = c.recs.reduce((s, r) => s + r.size, 0);
      if (total === 0 || deadBytes / total < COMPACT_AT) return c;
      reclaimed += deadBytes;
      const live = c.recs.filter((r) => !r.dead);
      log(`      compact ${c.id}: ${mb(total)} → ${mb(total - deadBytes)} (copied ${live.length} live blobs forward, dropped ${mb(deadBytes)} = ${((100 * deadBytes) / total).toFixed(0)}%)`);
      return { id: c.id + "'", recs: live };
    });
    return { reclaimed };
  }

  diskBytes(): number { // what we're actually paying for: container file sizes
    return this.containers.reduce((s, c) => s + c.recs.reduce((t, r) => t + r.size, 0), 0);
  }
}

function main() {
  log("═══ A. Why IMMEDIATE physical delete is wrong ═══");
  log("   At DELETE time the blob exists in: 3 replica nodes, 2 CDN edge caches,");
  log("   1 backup snapshot — and a reader is at byte 41,943,040 of a download.");
  const fanout = [["replica-1", 18], ["replica-2", 21], ["replica-3", 2500], ["cdn-fra", 95], ["cdn-sin", 210], ["backup", 45]] as const;
  let elapsed = 0;
  for (const [where, ms] of fanout) { elapsed += ms; log(`      sync delete → ${where.padEnd(9)} ${ms >= 2500 ? "TIMEOUT after " + ms + "ms" : "ok, " + ms + "ms"}`); }
  log(`   sequential fan-out: ${elapsed}ms, and replica-3 FAILED → blob half-deleted,`);
  log(`   nothing records what's left, the mid-download reader just got a torn file.`);
  log(`   vs: tombstone = ONE metadata row update (~2ms, atomic) — then clean up async.`);
  log("");

  const store = new BlobStore();
  store.putMany("container-A", [["photos/p1.jpg", 4_000_000], ["photos/p2.jpg", 6_000_000], ["photos/p3.jpg", 2_000_000], ["videos/v1.mp4", 30_000_000]]);
  store.putMany("container-B", [["docs/report.pdf", 8_000_000], ["docs/old-draft.pdf", 12_000_000], ["exports/dump.csv", 20_000_000]]);
  store.containers[1].recs.push({ key: null, size: 5_000_000, dead: false }); // crashed multipart upload: bytes, no metadata

  log("═══ B. The real pipeline: TOMBSTONE → grace → GC → COMPACTION ═══");
  log(`   day ${store.day}: bucket holds 7 blobs in 2 append-only containers, ${mb(store.diskBytes())} on disk`);
  store.delete("videos/v1.mp4"); store.delete("docs/old-draft.pdf"); store.delete("exports/dump.csv");
  log(`   day ${store.day}: DELETE v1.mp4, old-draft.pdf, dump.csv → 3 tombstones written`);
  log(`      user reads videos/v1.mp4 → ${store.read("videos/v1.mp4")} (delete is already REAL to users)`);
  log(`      disk usage unchanged: ${mb(store.diskBytes())} (not a byte touched yet)`);
  let g = store.gc();
  log(`      GC pass same day → removed ${g.removed} (all inside ${GRACE_DAYS}-day grace window)`);
  store.day = 3;
  log(`   day 3: user restores dump.csv from trash → undelete: ${store.undelete("exports/dump.csv")} → read: ${store.read("exports/dump.csv")}`);
  log(`      (the grace window IS the undelete feature — same mechanism, zero extra cost)`);
  store.day = 10;
  g = store.gc();
  log(`   day 10: GC pass → ${g.removed} tombstones past grace physically freed (${mb(g.bytes)} marked dead in containers)`);
  log(`      but containers are APPEND-ONLY — dead records are holes, disk still ${mb(store.diskBytes())}`);
  const beforeCompact = store.diskBytes();
  const comp = store.compact();
  log(`      compaction reclaimed ${mb(comp.reclaimed)} (${((100 * comp.reclaimed) / beforeCompact).toFixed(0)}% of the ${mb(beforeCompact)} bucket) → disk now ${mb(store.diskBytes())}`);
  log(`      (container-B's dead blob is only ${((100 * 12) / 45).toFixed(0)}% of its bytes — below the ${100 * COMPACT_AT}% threshold, the hole waits)`);
  log("");

  log("═══ C. The ORPHAN sweep — the same invariant, from the bytes' side ═══");
  log("   GC walks METADATA and asks \"which dead keys still have bytes?\" The orphan");
  log("   sweep walks CONTAINERS and asks \"which bytes have no metadata at all?\"");
  const o = store.orphanSweep();
  log(`   sweep found ${o.removed} orphan (${mb(o.bytes)}) — a crashed multipart upload's bytes with no key → marked dead`);
  store.compact();
  log(`   INVARIANT the two sweeps jointly maintain: metadata keys ⟷ stored bytes`);
  log(`      • every LIVE key has its bytes   (durability side — never GC a live blob)`);
  log(`      • every stored byte has a LIVE key (cost side — no leaked/zombie bytes)`);
  log("");

  log("═══ D. LIFECYCLE POLICIES — deletion machinery as the cost lever ═══");
  const PRICE = { standard: 0.023, ia: 0.0125, archive: 0.004 } as const; // $/GB-month
  const bucketGB = [["0–30d", 2000, "standard"], ["30–90d", 3000, "standard"], ["90–365d", 4000, "standard"], [">365d", 1000, "standard"]] as Array<[string, number, keyof typeof PRICE]>;
  const cost = (rows: typeof bucketGB) => rows.reduce((s, [, gb, tier]) => s + gb * PRICE[tier], 0);
  log(`   bucket: 10,000 GB, all in Standard → $${cost(bucketGB).toFixed(0)}/month`);
  log(`   policy: age>30d → IA ($${PRICE.ia}/GB), age>90d → Archive ($${PRICE.archive}/GB), age>365d → EXPIRE (tombstone → GC)`);
  const after: typeof bucketGB = [["0–30d", 2000, "standard"], ["30–90d", 3000, "ia"], ["90–365d", 4000, "archive"], [">365d", 0, "archive"]];
  for (let i = 0; i < after.length; i++) {
    const [age, gbBefore] = bucketGB[i]; const [, gbAfter, tier] = after[i];
    log(`      ${age.padEnd(8)} ${String(gbBefore).padStart(4)} GB standard → ${String(gbAfter).padStart(4)} GB ${gbAfter === 0 ? "expired" : tier}`);
  }
  log(`   after lifecycle run: $${cost(after).toFixed(2)}/month — ${(100 * (1 - cost(after) / cost(bucketGB))).toFixed(0)}% off the bill, zero application changes`);
  log("");

  log("TAKEAWAY: \"delete\" returns in milliseconds because it's only a tombstone;");
  log("the bytes die later — grace window (= undelete), async GC, then compaction");
  log("of append-only containers to get the disk back. An orphan sweep covers the");
  log("reverse direction, and the pair maintain metadata ⟷ bytes exactly. Point the");
  log("same machinery at AGE instead of deletes and you get lifecycle tiering —");
  log("the single biggest storage-cost lever there is.");
  process.exit(0);
}

main();
