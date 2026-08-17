/**
 * Phase 1 — PRESIGNED URLs: big bytes never touch your servers. Run: npm run phase1
 *
 * A client uploads a 4 GB video through `POST /upload` → your app server holds
 * the connection, buffers gigabytes, burns bandwidth and memory, hits LB
 * timeouts — and does it all again on download. Your API fleet scales with
 * BYTES MOVED, not requests served. Two wrong defaults (proxying uploads,
 * stuffing blobs in the DB), one pattern to fix both:
 *
 *   METADATA/BYTES SPLIT — the DB row (owner, name, size, status) is the source
 *   of truth for *existence and access*; the bucket holds only bytes keyed by
 *   an opaque id. Files > ~10 MB that don't need SQL queries belong in object
 *   storage (11 nines of durability, per-object pricing).
 *
 *   PRESIGNED URL — a time-limited, scope-limited capability: "PUT this one
 *   key, for the next 15 minutes." The app server (which holds the store
 *   credential) HMACs method+key+expiry and hands the client the URL. The
 *   client pushes bytes STRAIGHT to storage; the store re-computes the HMAC to
 *   verify. Tamper with the key, or show up late → rejected. Same trick in
 *   reverse for downloads. Your servers hand out POINTERS, never bytes.
 *
 *   UPLOAD-THEN-COMMIT — two systems must agree a file exists (bucket + DB),
 *   and you can crash between the two writes. Order matters: blob FIRST, then
 *   metadata row. A crash in the gap leaves an ORPHAN blob — invisible to
 *   users, costs pennies, and a periodic GC sweep (delete blobs no row points
 *   to, older than a grace period) cleans it up. The REVERSE order leaves a
 *   DANGLING POINTER — a row promising bytes that don't exist → user-visible
 *   404. Prefer the failure mode only a janitor can see.
 *
 * TAKEAWAY: metadata in the DB, bytes in object storage, presigned URLs both
 * directions — "my API hands out capabilities, not bytes." Write the blob
 * first, commit the row second, and let an orphan GC sweep mop up the crashes.
 */

import { createHmac } from "node:crypto";
import { log } from "../lib/log.ts";

const GB = 1024;              // we count sizes in MB
const APP_NIC_MBPS = 100;     // app server streaming throughput, MB/s
let clock = 0;                // virtual seconds — no Date.now() in logic

/** HMAC-SHA256 over the exact tuple the store will re-check. This IS the presigned URL. */
function sign(secret: string, method: string, key: string, expiresAt: number): string {
  return createHmac("sha256", secret).update(`${method}\n${key}\n${expiresAt}`).digest("hex");
}

interface PresignedUrl { method: "PUT" | "GET"; key: string; expiresAt: number; sig: string }
interface StoredBlob { sizeMB: number; uploadedAt: number }
interface FileRow { key: string; owner: string; sizeMB: number; status: "ready" }

/** The object store. Shares a signing secret with the app server; clients have NO credentials. */
class ObjectStore {
  secret: string;
  blobs = new Map<string, StoredBlob>();
  constructor(secret: string) { this.secret = secret; }

  private check(url: PresignedUrl): string {
    if (clock > url.expiresAt) return `DENIED — URL expired at t=${url.expiresAt}s, it is now t=${clock}s`;
    if (url.sig !== sign(this.secret, url.method, url.key, url.expiresAt))
      return "DENIED — signature does not match method+key+expiry (tampered or forged)";
    return "ok";
  }
  /** Client-side PUT with a presigned URL — the store, not the app server, verifies. */
  put(url: PresignedUrl, sizeMB: number): string {
    if (url.method !== "PUT") return "DENIED — URL not signed for PUT";
    const v = this.check(url); if (v !== "ok") return v;
    this.blobs.set(url.key, { sizeMB, uploadedAt: clock });
    return "ok";
  }
  /** Client-side GET with a presigned URL. */
  get(url: PresignedUrl): string {
    if (url.method !== "GET") return "DENIED — URL not signed for GET";
    const v = this.check(url); if (v !== "ok") return v;
    const b = this.blobs.get(url.key);
    return b ? `ok — ${b.sizeMB} MB served direct from store` : "404 — no such object";
  }
}

/** The app server: holds the store credential + the metadata DB. Never (ideally) the bytes. */
class AppServer {
  secret: string;
  db = new Map<string, FileRow>();    // fileId → metadata row (the DB)
  bytesProxiedMB = 0;                 // bytes that flowed THROUGH this server
  busySeconds = 0;                    // wall-clock a worker/connection was tied up
  constructor(secret: string) { this.secret = secret; }

  /** ANTI-PATTERN: client streams bytes to us, we stream them on to the store. */
  proxyUpload(store: ObjectStore, fileId: string, owner: string, sizeMB: number): void {
    this.bytesProxiedMB += sizeMB * 2;                 // in from client + out to store
    this.busySeconds += sizeMB / APP_NIC_MBPS;         // connection held the whole time
    store.blobs.set(`blobs/${fileId}`, { sizeMB, uploadedAt: clock });
    this.db.set(fileId, { key: `blobs/${fileId}`, owner, sizeMB, status: "ready" });
  }
  /** THE PATTERN: mint a capability. ~200 bytes of JSON, ~1 ms of server time. */
  presign(method: "PUT" | "GET", key: string, ttlSec: number): PresignedUrl {
    this.busySeconds += 0.001;
    return { method, key, expiresAt: clock + ttlSec, sig: sign(this.secret, method, key, clock + ttlSec) };
  }
  /** The metadata commit — a tiny DB write, AFTER the bytes are durable. */
  commit(fileId: string, key: string, owner: string, sizeMB: number): void {
    this.db.set(fileId, { key, owner, sizeMB, status: "ready" });
  }
  /** Orphan GC: delete blobs no metadata row references, older than a grace period. */
  gcSweep(store: ObjectStore, graceSec: number): number {
    const referenced = new Set([...this.db.values()].map((r) => r.key));
    let reclaimed = 0;
    for (const [key, b] of store.blobs) {
      if (referenced.has(key)) continue;
      if (clock - b.uploadedAt < graceSec) {
        log(`      GC: ${key} unreferenced but only ${clock - b.uploadedAt}s old → SKIP (upload may still commit)`);
        continue;
      }
      store.blobs.delete(key);
      reclaimed += b.sizeMB;
      log(`      GC: ${key} unreferenced for ${clock - b.uploadedAt}s → DELETE (+${b.sizeMB} MB reclaimed)`);
    }
    return reclaimed;
  }
}

function main() {
  const SECRET = "store-root-credential-never-leaves-the-server";
  const store = new ObjectStore(SECRET);
  const app = new AppServer(SECRET);

  log("═══ A) ANTI-PATTERN — uploading 4 GB THROUGH the app server ═══");
  app.proxyUpload(store, "f1-vacation.mp4", "alice", 4 * GB);
  log(`   bytes proxied through app server: ${app.bytesProxiedMB} MB (${4 * GB} in from client + ${4 * GB} out to store)`);
  log(`   worker/connection tied up: ${app.busySeconds.toFixed(1)} s at ${APP_NIC_MBPS} MB/s`);
  log(`   → 50 concurrent uploaders = ${(50 * 8 * GB / 1024).toFixed(0)} GB in flight through YOUR fleet. Your API is now a file proxy.`);
  const proxied = app.bytesProxiedMB;

  log("");
  log("═══ B) PRESIGNED UPLOAD — client PUTs straight to the store ═══");
  const upUrl = app.presign("PUT", "blobs/f2-demo.mov", 900); // 15-minute capability
  log(`   app server mints: PUT ${upUrl.key} expires=t+900s sig=${upUrl.sig.slice(0, 16)}…`);
  log(`   client → store PUT (2048 MB): ${store.put(upUrl, 2 * GB)}`);
  app.commit("f2-demo.mov", upUrl.key, "alice", 2 * GB);
  log(`   app server → DB: row {f2-demo.mov → ${upUrl.key}, status=ready}  (a POINTER, ~200 bytes)`);

  const tampered = { ...upUrl, key: "blobs/OTHER-USERS-file" };   // reuse sig on a different key
  log(`   attacker reuses sig for a different key: ${store.put(tampered, 1)}`);
  const shortUrl = app.presign("PUT", "blobs/f2b-late.mov", 60);
  clock += 61;                                                    // …dawdle past expiry
  log(`   client shows up 61 s after a 60 s URL: ${store.put(shortUrl, 1)}`);
  log(`   bytes proxied through app server this whole section: ${app.bytesProxiedMB - proxied} MB`);

  log("");
  log("═══ C) PRESIGNED DOWNLOAD — same trick in reverse ═══");
  const dlUrl = app.presign("GET", app.db.get("f2-demo.mov")!.key, 300);
  log(`   app server hands back: GET ${dlUrl.key} sig=${dlUrl.sig.slice(0, 16)}…`);
  log(`   client → store GET: ${store.get(dlUrl)}`);
  log("   (at scale: put a CDN in front and sign CDN URLs — origin sees only cache misses)");

  log("");
  log("═══ D) UPLOAD-THEN-COMMIT — the crash in the gap, and the orphan GC ═══");
  log("   Correct order — blob first, row second. Crash between them:");
  const u3 = app.presign("PUT", "blobs/f3-crashed.zip", 900);
  log(`   client → store PUT (512 MB): ${store.put(u3, 512)}`);
  log("   💥 app server crashes BEFORE the DB commit → blob exists, no row → ORPHAN (invisible to users, costs $)");

  log("   Reverse order — row first, bytes never arrive (why it's WORSE):");
  app.db.set("f4-phantom.pdf", { key: "blobs/f4-phantom.pdf", owner: "bob", sizeMB: 64, status: "ready" });
  log("   💥 crash before the client uploads → DB row promises blobs/f4-phantom.pdf");
  const dangling = app.presign("GET", "blobs/f4-phantom.pdf", 300);
  log(`   user clicks download: ${store.get(dangling)}  ← DANGLING POINTER, user-visible failure`);
  app.db.delete("f4-phantom.pdf");   // undo the bad-order demo before the sweep

  log("   Periodic GC sweep (grace period = 3600 s), plus one upload still in flight:");
  clock += 24 * 3600;                // a day later the sweeper runs…
  const inflight = app.presign("PUT", "blobs/f5-inflight.iso", 900);
  store.put(inflight, 256);          // …seconds after this upload landed (commit hasn't happened YET)
  const reclaimed = app.gcSweep(store, 3600);
  log(`   sweep reclaimed ${reclaimed} MB of orphans; young blobs left alone until the next pass`);

  log("");
  log(`Scoreboard — bytes through app server: proxy upload ${proxied} MB vs presigned ${app.bytesProxiedMB - proxied} MB.`);
  log("The app server authorized, recorded, and minted. It never touched a byte.");
  log("Metadata in the DB, bytes in object storage, presigned URLs both ways —");
  log("upload-then-commit, and a GC sweep for the orphans the crashes leave behind.");
  process.exit(0);
}

main();
