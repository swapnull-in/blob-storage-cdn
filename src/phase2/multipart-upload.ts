/**
 * Phase 2 — MULTIPART UPLOAD: big, flaky uploads without starting over. Run: npm run phase2
 *
 * A 5 GB file over a residential connection WILL drop mid-transfer — and a
 * single PUT has exactly one retry unit: the whole file. Fail at 80% and you
 * restart from byte zero. (S3 caps single PUTs at 5 GB anyway.) The fix:
 *
 *   MULTIPART — split the object into parts (S3: 5 MB–5 GB per part, up to
 *   10,000 parts, 5 TB object cap). The protocol is three verbs:
 *     Initiate → uploadId          (an open, uncommitted upload)
 *     UploadPart n → ETag          (each part durable + retryable INDEPENDENTLY)
 *     Complete(manifest of ETags)  (stitch the parts → the object EXISTS)
 *
 *   The Complete call → metadata commit is the STRONG-CONSISTENCY POINT of the
 *   whole system: until it, a GET sees nothing; after it, everyone sees the
 *   object. Everything before is immutable, write-once parts needing zero
 *   coordination — which is exactly why object storage scales.
 *
 *   What multipart buys you:
 *   • RETRY unit = one part, not the file — a dropped connection wastes MBs, not GBs.
 *   • RESUME — uploadId + ListParts tells a restarted client what survived;
 *     re-upload only the missing parts.
 *   • PARALLELISM — one TCP stream rarely fills a fat pipe; N parts in flight
 *     ≈ N× throughput.
 *
 *   The dark side: parts of never-completed uploads are INVISIBLE (no object
 *   in any listing) but BILLED. Abandoned mobile uploads quietly accrue cost
 *   forever — until a lifecycle rule (AbortIncompleteMultipartUpload after
 *   N days) sweeps them.
 *
 * TAKEAWAY: multipart = parallel bandwidth, per-part retry, and resumability;
 * "upload dies at 90%? — completed parts persist, ListParts, resume from part
 * 47, not byte zero." Complete is the one strongly-consistent commit — and a
 * lifecycle rule reaps the uploads that never get there.
 */

import { log, hash32 } from "../lib/log.ts";

const FILE_MB = 5120;              // one 5 GB file
const PART_MB = 128;               // 40 parts of 128 MB (S3 allows 5 MB–5 GB per part)
const N_PARTS = FILE_MB / PART_MB;
const CONN_MBPS = 25;              // one TCP stream's throughput, MB/s

interface Mpu { key: string; parts: Map<number, string>; initiatedDay: number; done: boolean }

/** The object store's multipart API: initiate / uploadPart / listParts / complete / abort. */
class ObjectStore {
  objects = new Map<string, number>();  // committed key → size MB (what listings/GETs see)
  mpus = new Map<string, Mpu>();        // open uploads — parts live here, INVISIBLY
  day = 0;                              // virtual days, for the lifecycle sweeper

  initiate(key: string): string {
    const id = `mpu-${hash32(key + this.mpus.size).toString(16)}`;
    this.mpus.set(id, { key, parts: new Map(), initiatedDay: this.day, done: false });
    return id;
  }
  uploadPart(id: string, n: number): string {
    const etag = hash32(`${id}:${n}`).toString(16).padStart(8, "0");
    this.mpus.get(id)!.parts.set(n, etag);
    return etag;
  }
  listParts(id: string): number[] { return [...this.mpus.get(id)!.parts.keys()].sort((a, b) => a - b); }
  complete(id: string, manifest: [number, string][]): string {
    const mpu = this.mpus.get(id)!;
    for (const [n, etag] of manifest) if (mpu.parts.get(n) !== etag) return `ERROR — part ${n} missing or ETag mismatch`;
    this.objects.set(mpu.key, manifest.length * PART_MB);
    mpu.done = true; this.mpus.delete(id);
    return "200 — object committed";
  }
  get(key: string): string { return this.objects.has(key) ? `200 — ${this.objects.get(key)} MB` : "404 — no such object"; }
  /** Storage billed to open multipart uploads — none of it visible in any listing. */
  invisibleMB(): number { return [...this.mpus.values()].reduce((s, m) => s + m.parts.size * PART_MB, 0); }
  /** Lifecycle rule: AbortIncompleteMultipartUpload after `days` days. */
  abortStale(days: number): number {
    let reclaimed = 0;
    for (const [id, m] of this.mpus) {
      if (this.day - m.initiatedDay < days) continue;
      reclaimed += m.parts.size * PART_MB;
      log(`      lifecycle: ${id} (${m.key}) idle ${this.day - m.initiatedDay}d, ${m.parts.size} parts → ABORT (+${m.parts.size * PART_MB} MB reclaimed)`);
      this.mpus.delete(id);
    }
    return reclaimed;
  }
}

function main() {
  const store = new ObjectStore();

  log(`═══ A) Single PUT of ${FILE_MB} MB — connection drops at 80% ═══`);
  const firstTry = Math.floor(FILE_MB * 0.8);
  log(`   attempt 1: sent ${firstTry} MB… 💥 connection reset. Retry unit = WHOLE FILE → restart from byte 0`);
  log(`   attempt 2: sent ${FILE_MB} MB → done`);
  const singlePutSent = firstTry + FILE_MB;
  log(`   total bytes sent: ${singlePutSent} MB for a ${FILE_MB} MB file (${firstTry} MB wasted, ${(singlePutSent / FILE_MB).toFixed(1)}× the file)`);

  log("");
  log(`═══ B) MULTIPART — initiate → parts → complete (fail at part 33, RESUME) ═══`);
  const id = store.initiate("blobs/dataset.tar");
  log(`   Initiate("blobs/dataset.tar") → uploadId=${id}`);
  let sent = 0;
  for (let n = 1; n <= 32; n++) { store.uploadPart(id, n); sent += PART_MB; }
  log(`   parts 1–32 uploaded (each returns an ETag, e.g. part 1 → ${store.uploadPart(id, 1)}), ${sent} MB durable`);
  sent += PART_MB;                                   // part 33 was in flight when the laptop lid closed
  log(`   💥 crash while sending part 33 — only that in-flight part (${PART_MB} MB) is lost`);
  const survived = store.listParts(id);
  log(`   client restarts: ListParts(${id}) → ${survived.length} parts survived (1…${survived[survived.length - 1]})`);
  const missing: [number, string][] = [];
  for (let n = 33; n <= N_PARTS; n++) { missing.push([n, store.uploadPart(id, n)]); sent += PART_MB; }
  log(`   resume: re-upload only parts 33–${N_PARTS} (${missing.length * PART_MB} MB), not byte zero`);
  log(`   before Complete: GET blobs/dataset.tar → ${store.get("blobs/dataset.tar")}   (parts ≠ object)`);
  const manifest: [number, string][] = survived.filter((n) => n <= 32).map((n) => [n, store.mpus.get(id)!.parts.get(n)!] as [number, string]).concat(missing);
  log(`   Complete(manifest of ${manifest.length} ETags) → ${store.complete(id, manifest)}   ← THE strong-consistency point`);
  log(`   after Complete:  GET blobs/dataset.tar → ${store.get("blobs/dataset.tar")}`);
  log(`   total bytes sent: ${sent} MB vs single-PUT's ${singlePutSent} MB → ${singlePutSent - sent} MB saved by resuming`);

  log("");
  log(`═══ C) PARALLEL PARTS — throughput ═══`);
  const serialSec = FILE_MB / CONN_MBPS;
  const lanes = 8;
  const parallelSec = (Math.ceil(N_PARTS / lanes) * PART_MB) / CONN_MBPS;  // waves of 8 parts in flight
  log(`   one ${CONN_MBPS} MB/s stream, ${N_PARTS} parts serial:  ${serialSec.toFixed(1)} s`);
  log(`   ${lanes} parts in flight (${Math.ceil(N_PARTS / lanes)} waves of ${lanes}):        ${parallelSec.toFixed(1)} s  → ${(serialSec / parallelSec).toFixed(0)}× faster`);
  log(`   (single-stream TCP rarely fills the pipe — parallel parts do; each retries alone)`);

  log("");
  log(`═══ D) ABANDONED UPLOADS — the invisible storage bill ═══`);
  const stale1 = store.initiate("blobs/phone-backup-1.zip");   // day 0
  for (let n = 1; n <= 12; n++) store.uploadPart(stale1, n);
  store.day = 1;
  const stale2 = store.initiate("blobs/screen-recording.mov"); // day 1
  for (let n = 1; n <= 20; n++) store.uploadPart(stale2, n);
  store.day = 9;
  const fresh = store.initiate("blobs/in-progress.iso");       // day 9 — still being uploaded
  for (let n = 1; n <= 5; n++) store.uploadPart(fresh, n);
  store.day = 10;
  log(`   day 10: bucket listing shows ${store.objects.size} object(s) — but ${store.invisibleMB()} MB of orphan parts are BILLED, invisibly`);
  log(`   lifecycle rule: AbortIncompleteMultipartUpload after 7 days →`);
  const reclaimed = store.abortStale(7);
  log(`   reclaimed ${reclaimed} MB; ${store.invisibleMB()} MB kept (the day-9 upload may still Complete)`);

  log("");
  log("Multipart = parallel bandwidth, per-part retry, resumability. Upload dies at");
  log("90%? — completed parts persist; ListParts and resume from part 47, not byte");
  log("zero. Complete(manifest) is the ONE strongly-consistent commit in the whole");
  log("path — and a lifecycle rule reaps the uploads that never reach it.");
  process.exit(0);
}

main();
