/**
 * Phase 5 — CONTENT-ADDRESSABLE STORAGE (CAS). Run: npm run phase5
 *
 * Ordinary storage addresses data by a NAME you choose: `photos/alice/img_001.jpg`.
 * CAS addresses data by the HASH OF ITS CONTENT: sha256(bytes) IS the key.
 *
 *   Same bytes → same hash → same address → stored ONCE, no matter how many
 *   users upload it. That single design choice buys three things at once:
 *
 *   1. DEDUP — a viral meme forwarded by 1,000 users is 1 blob + 1,000 cheap
 *      metadata pointers. Dropbox, Git, container registries (OCI layers),
 *      and backup tools (Borg/Restic) are all built on exactly this.
 *   2. INTEGRITY FOR FREE — the address *verifies* the content. Every read can
 *      re-hash the bytes and compare to the key; a single flipped bit (disk
 *      rot, bad RAM, truncated write) changes the hash and is caught.
 *   3. NATURAL IMMUTABILITY — you can't "edit byte 500" of a blob whose name
 *      is its hash: different bytes would be a *different address*. Editing
 *      means writing a NEW blob and moving your pointer.
 *
 * And one thing it costs you: DELETION gets harder. Since many names can
 * point at one blob, you can't delete bytes just because one user hit delete —
 * you need REFCOUNTS (or a mark-and-sweep GC, phase 6) and you only reclaim
 * space when the count hits zero. "CAS without GC" is a classic leak.
 *
 * Bonus: hash CHUNKS instead of whole files (Dropbox's ~4 MB blocks) and you
 * dedup ACROSS versions of a file too — edit one chunk, re-upload one chunk.
 *
 * TAKEAWAY: hashing the content buys dedup + integrity + natural immutability;
 * the price is refcounted GC and no in-place update.
 */

import { createHash } from "node:crypto";
import { log, mulberry32 } from "../lib/log.ts";

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const short = (h: string): string => h.slice(0, 12) + "…";
const mb = (n: number): string => (n / 1_048_576).toFixed(1) + " MB";

/** A content-addressed blob store: blobs live under their hash, with refcounts. */
class CasStore {
  blobs = new Map<string, Buffer>();     // hash → bytes (the data plane)
  refs = new Map<string, number>();      // hash → how many pointers reference it
  pointers = new Map<string, string>();  // user key → hash (the metadata plane)
  physicalWrites = 0;

  /** Upload: hash the content; store bytes only if this hash is new. */
  put(userKey: string, content: Buffer): { hash: string; deduped: boolean } {
    const hash = sha256(content);
    const deduped = this.blobs.has(hash);
    if (!deduped) { this.blobs.set(hash, content); this.physicalWrites++; }
    this.refs.set(hash, (this.refs.get(hash) ?? 0) + 1);
    const old = this.pointers.get(userKey);
    this.pointers.set(userKey, hash);
    if (old !== undefined && old !== hash) this.decref(old); // pointer moved off the old blob
    return { hash, deduped };
  }

  /** Read: fetch by pointer, then RE-HASH and compare to the address — self-verifying. */
  get(userKey: string): { content: Buffer; verified: boolean } {
    const hash = this.pointers.get(userKey);
    if (hash === undefined) throw new Error(`404: ${userKey}`);
    const content = this.blobs.get(hash)!;
    return { content, verified: sha256(content) === hash };
  }

  /** Delete a pointer; bytes are only reclaimed when the last reference drops. */
  delete(userKey: string): { refsLeft: number; bytesFreed: number } {
    const hash = this.pointers.get(userKey);
    if (hash === undefined) throw new Error(`404: ${userKey}`);
    this.pointers.delete(userKey);
    return this.decref(hash);
  }

  private decref(hash: string): { refsLeft: number; bytesFreed: number } {
    const left = this.refs.get(hash)! - 1;
    if (left > 0) { this.refs.set(hash, left); return { refsLeft: left, bytesFreed: 0 }; }
    const bytesFreed = this.blobs.get(hash)!.length;
    this.refs.delete(hash); this.blobs.delete(hash);
    return { refsLeft: 0, bytesFreed };
  }

  storedBytes(): number { let t = 0; for (const b of this.blobs.values()) t += b.length; return t; }
}

/** Deterministic pseudo-random file content (stands in for image/video bytes). */
function makeBlob(seed: number, size: number): Buffer {
  const rand = mulberry32(seed);
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) buf[i] = Math.floor(rand() * 256);
  return buf;
}

function main() {
  const cas = new CasStore();

  log("═══ A. DEDUP — the same viral meme, uploaded by 1,000 users ═══");
  const meme = makeBlob(42, 2_500_000); // one 2.5 MB image
  let memeAddr = "";
  for (let u = 1; u <= 1000; u++) memeAddr = cas.put(`user-${u}/attachments/meme.jpg`, meme).hash;
  const naive = 1000 * meme.length;
  log(`   1,000 uploads → physical writes: ${cas.physicalWrites}, blobs stored: ${cas.blobs.size}, pointers: ${cas.pointers.size}`);
  log(`   blob ${short(memeAddr)} refcount = ${cas.refs.get(memeAddr)}`);
  log(`   key-per-upload storage: ${mb(naive)}   CAS storage: ${mb(cas.storedBytes())}   saved: ${mb(naive - cas.storedBytes())} (${(100 * (1 - cas.storedBytes() / naive)).toFixed(1)}%)`);
  log("");

  log("═══ B. INTEGRITY FOR FREE — every read self-verifies against its address ═══");
  const cleanRead = cas.get("user-1/attachments/meme.jpg");
  log(`   read meme.jpg → re-hash matches address? ${cleanRead.verified} ✓`);
  const stored = cas.blobs.get(memeAddr)!;
  stored[1_337_000] ^= 0x01; // bit rot: ONE bit flips on disk
  const dirtyRead = cas.get("user-1/attachments/meme.jpg");
  log(`   flip 1 bit of 20,000,000 at offset 1,337,000 (disk rot) …`);
  log(`   read meme.jpg → address ${short(memeAddr)}  actual ${short(sha256(dirtyRead.content))}  verified? ${dirtyRead.verified} → CORRUPTION DETECTED`);
  stored[1_337_000] ^= 0x01; // a real store now repairs from a replica/parity (phases 3–4)
  log(`   → treat the copy as failed, repair from a replica — no silent bad bytes to users`);
  log("");

  log("═══ C. THE COST — no in-place update, and deletes need refcounts ═══");
  const v1 = Buffer.from("Team offsite notes: pick a date.\n");
  const v2 = Buffer.from("Team offsite notes: pick a date.\nDecision: March 12.\n");
  const p1 = cas.put("docs/offsite.txt", v1);
  log(`   write  docs/offsite.txt v1 → blob ${short(p1.hash)}`);
  const p2 = cas.put("docs/offsite.txt", v2);
  log(`   "edit" docs/offsite.txt    → NEW blob ${short(p2.hash)}, pointer moved (v1 blob refcount hit 0 → reclaimed)`);
  log(`   an edit is never in place: new hash = new address = new blob + a pointer swing`);
  for (let u = 1; u <= 998; u++) cas.delete(`user-${u}/attachments/meme.jpg`);
  log(`   998 users delete the meme → refcount ${cas.refs.get(memeAddr)}, blob still on disk (others point at it)`);
  const d999 = cas.delete("user-999/attachments/meme.jpg");
  log(`   user-999 deletes → refcount ${d999.refsLeft}, bytes freed: ${d999.bytesFreed} (still referenced!)`);
  const d1000 = cas.delete("user-1000/attachments/meme.jpg");
  log(`   user-1000 deletes → refcount ${d1000.refsLeft} → NOW the blob is removed, ${mb(d1000.bytesFreed)} reclaimed`);
  log("");

  log("═══ D. CHUNK-LEVEL CAS — two versions of a file share all but one chunk ═══");
  const CHUNK = 4096; // Dropbox uses ~4 MB blocks; same idea, smaller numbers
  const fileV1 = makeBlob(7, 8 * CHUNK);                 // 8-chunk file (32 KB)
  const fileV2 = Buffer.from(fileV1); fileV2[5 * CHUNK + 100] ^= 0xff; // edit inside chunk 5
  const manifest = (f: Buffer): string[] => {
    const hashes: string[] = [];
    for (let o = 0; o < f.length; o += CHUNK) hashes.push(sha256(f.subarray(o, o + CHUNK)));
    return hashes;
  };
  const m1 = manifest(fileV1), m2 = manifest(fileV2);
  const chunkStore = new Set<string>(m1); // v1 already uploaded chunk-by-chunk
  const newChunks = m2.filter((h) => !chunkStore.has(h));
  log(`   file = manifest of chunk hashes: [${m1.slice(0, 3).map(short).join(", ")}, …] (${m1.length} chunks)`);
  log(`   v2 edits 1 byte inside chunk 5 → chunks differing from v1: ${m2.filter((h, i) => h !== m1[i]).length} of ${m2.length}`);
  log(`   uploading v2 stores only ${newChunks.length} new chunk (${newChunks.length * CHUNK} bytes), not ${fileV2.length} — dedup across versions AND users`);
  log(`   (content-defined chunking — Rabin — keeps this true even for INSERTS that shift bytes)`);
  log("");

  log("TAKEAWAY: key = hash(content) makes identical bytes land on the same address,");
  log("so dedup is automatic (1 blob + N pointers), every read self-verifies against");
  log("its own name, and blobs are naturally immutable. The bill for all that:");
  log("\"editing\" is a new-blob-plus-pointer-swing, and deletion becomes refcounted");
  log("GC — bytes are only reclaimed when the LAST reference drops (phase 6).");
  process.exit(0);
}

main();
