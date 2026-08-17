/**
 * Phase 4 — ERASURE CODING vs 3× REPLICATION. Run: npm run phase4
 *
 * Phase 3 manufactured 11 nines with 3 full copies — 3.0× the storage. At
 * exabyte scale that overhead IS the bill. Erasure coding buys the same loss
 * tolerance for a fraction of the storage:
 *
 *   Split the blob into k DATA shards, compute m PARITY shards, store all
 *   k+m on different failure domains. ANY k of the k+m reconstruct the blob
 *   exactly. Overhead = (k+m)/k. With k=4, m=2: survive any 2 losses at
 *   1.5× storage — the same 2-loss tolerance 3× replication gives for 3.0×.
 *
 * The code below is REAL, not a sketch: RAID-6-style P+Q over GF(2⁸)
 * (arithmetic mod the polynomial 0x11D). Byte-wise:
 *
 *   P = d0 ⊕ d1 ⊕ d2 ⊕ d3                    (plain XOR parity — one equation)
 *   Q = 1·d0 ⊕ 2·d1 ⊕ 4·d2 ⊕ 8·d3            (second, INDEPENDENT equation,
 *                                              coefficients gⁱ in GF(2⁸))
 *
 * Two independent linear equations ⇒ any two unknowns are solvable: lose two
 * data shards dᵢ,dⱼ and P,Q give you two equations in two unknowns. This is
 * honestly a Reed-Solomon [6,4] code — but the SPECIAL CASE m=2. Production
 * systems (S3, Azure, HDFS-EC, Ceph) use general Reed-Solomon over GF(2⁸)
 * with Vandermonde/Cauchy matrices so m can be 3, 4, ... — same idea, m
 * independent parity equations, any k of k+m suffice.
 *
 * Why doesn't everything use EC, then? Because the savings are paid for in IO:
 *   • REPAIR: replication rebuilds a lost copy by reading 1 survivor. EC must
 *     read k shards to recompute one lost shard — k× read amplification, and
 *     on a hot cluster that repair traffic competes with serving traffic.
 *   • DEGRADED READS: with a replica down you just read another replica. With
 *     a shard down every GET does a k-shard read + decode until repair lands —
 *     latency = slowest of k nodes, plus CPU.
 * So: hot tier = replication (cheap reads/repair), cold tier = EC (cheap
 * bytes), and a lifecycle job re-encodes data as it cools.
 *
 * TAKEAWAY: erasure coding buys durability-per-dollar for cold data;
 * replication buys cheap reads and cheap repair for hot data. Tier between.
 */

import { log, hash32, mulberry32 } from "../lib/log.ts";

// ═══ GF(2⁸) arithmetic — the real math under Reed-Solomon ═══════════════════
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x; GF_LOG[x] = i;
    x <<= 1; if (x & 0x100) x ^= 0x11d; // multiply by g=2 mod x⁸+x⁴+x³+x²+1
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}
let decodeOps = 0; // byte-level XOR/GF operations — instrumented to price decode CPU
function gfMul(a: number, b: number): number {
  decodeOps++;
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}
function gfDiv(a: number, b: number): number {
  decodeOps++;
  if (b === 0) throw new Error("GF division by zero");
  return a === 0 ? 0 : GF_EXP[(GF_LOG[a] - GF_LOG[b] + 255) % 255];
}

// ═══ The code: k=4 data shards + m=2 parity shards ══════════════════════════
const K = 4, M = 2;
const COEFF = [1, 2, 4, 8]; // gⁱ for Q's equation — distinct, nonzero ⇒ solvable
let shardReads = 0;         // instrumented: how many shards each operation touches

function encode(blob: Uint8Array): Uint8Array[] {
  const L = blob.length / K;
  const shards: Uint8Array[] = [];
  for (let i = 0; i < K; i++) shards.push(blob.slice(i * L, (i + 1) * L));
  const p = new Uint8Array(L), q = new Uint8Array(L);
  for (let j = 0; j < L; j++) {
    let pj = 0, qj = 0;
    for (let i = 0; i < K; i++) { pj ^= shards[i][j]; qj ^= gfMul(COEFF[i], shards[i][j]); }
    p[j] = pj; q[j] = qj;
  }
  return [...shards, p, q]; // indices 0..3 = data, 4 = P, 5 = Q
}

/** Rebuild all 6 shards from any ≥4 survivors (null = lost). Reads every survivor it needs. */
function reconstruct(shards: (Uint8Array | null)[]): Uint8Array[] {
  const missing = shards.flatMap((s, i) => (s === null ? [i] : []));
  if (missing.length > M) throw new Error(`lost ${missing.length} shards — only ${M} parity, unrecoverable`);
  const out = shards.map(s => (s ? s.slice() : null));
  const L = shards.find(s => s !== null)!.length;
  const read = (i: number): Uint8Array => { shardReads++; return out[i]!; };
  const lostData = missing.filter(i => i < K);

  if (lostData.length === 2) {
    // Two unknowns dᵢ,dⱼ; two equations P,Q. A = dᵢ⊕dⱼ, B = cᵢdᵢ⊕cⱼdⱼ.
    const [i, j] = lostData;
    const survivors = [0, 1, 2, 3].filter(x => x !== i && x !== j).map(read);
    const survCoeff = [0, 1, 2, 3].filter(x => x !== i && x !== j).map(x => COEFF[x]);
    const p = read(4), q = read(5);
    const di = new Uint8Array(L), dj = new Uint8Array(L);
    for (let b = 0; b < L; b++) {
      let A = p[b], B = q[b];
      for (let s = 0; s < survivors.length; s++) { A ^= survivors[s][b]; B ^= gfMul(survCoeff[s], survivors[s][b]); }
      di[b] = gfDiv(gfMul(COEFF[j], A) ^ B, COEFF[i] ^ COEFF[j]); // (cⱼA ⊕ B)/(cᵢ⊕cⱼ)
      dj[b] = A ^ di[b];
    }
    out[i] = di; out[j] = dj;
  } else if (lostData.length === 1) {
    const [i] = lostData;
    const survivors = [0, 1, 2, 3].filter(x => x !== i);
    const di = new Uint8Array(L);
    if (!missing.includes(4)) {
      const p = read(4), rest = survivors.map(read);
      for (let b = 0; b < L; b++) { let v = p[b]; for (const r of rest) { v ^= r[b]; decodeOps++; } di[b] = v; }
    } else {
      // P is also gone — solve dᵢ from the Q equation instead.
      const q = read(5), rest = survivors.map(read);
      for (let b = 0; b < L; b++) {
        let v = q[b];
        for (let s = 0; s < survivors.length; s++) v ^= gfMul(COEFF[survivors[s]], rest[s][b]);
        di[b] = gfDiv(v, COEFF[i]);
      }
    }
    out[i] = di;
  }
  // Any lost parity: recompute from (now complete) data.
  if (out[4] === null || out[5] === null) {
    const data = [0, 1, 2, 3].map(read);
    const p = new Uint8Array(L), q = new Uint8Array(L);
    for (let b = 0; b < L; b++) {
      let pj = 0, qj = 0;
      for (let i = 0; i < K; i++) { pj ^= data[i][b]; qj ^= gfMul(COEFF[i], data[i][b]); }
      p[b] = pj; q[b] = qj;
    }
    if (out[4] === null) out[4] = p;
    if (out[5] === null) out[5] = q;
  }
  return out as Uint8Array[];
}

const joinData = (shards: Uint8Array[]): Uint8Array => {
  const L = shards[0].length, blob = new Uint8Array(K * L);
  for (let i = 0; i < K; i++) blob.set(shards[i], i * L);
  return blob;
};
const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const fingerprint = (b: Uint8Array) => hash32(String.fromCharCode(...b.slice(0, 2048)) + b.length).toString(16);
const shardName = (i: number) => (i < K ? `d${i}` : i === K ? "P" : "Q");

function main() {
  // A deterministic 4 KiB "object": readable header + seeded random payload.
  const HEADER = "blob-storage-cdn/phase4 :: this object must come back byte-identical. ";
  const blob = new Uint8Array(4096);
  const rng = mulberry32(hash32("phase4-blob"));
  for (let i = 0; i < blob.length; i++) blob[i] = Math.floor(rng() * 256);
  for (let i = 0; i < HEADER.length; i++) blob[i] = HEADER.charCodeAt(i);

  log(`Object: ${blob.length} bytes · fingerprint ${fingerprint(blob)} · "${HEADER.slice(0, 46)}..."`);
  const shards = encode(blob);
  log(`Encoded as EC(k=${K}, m=${M}): 4 data shards + 2 parity shards, ${shards[0].length} bytes each`);
  log(`  → stored bytes ${shards.length * shards[0].length} = ${(shards.length / K).toFixed(1)}× the object (vs 3.0× for 3 replicas)`);
  log("");

  // ── (A) Lose ANY 2 shards, reconstruct exactly ───────────────────────────
  log("═══ (A) LOSE ANY 2 OF 6 SHARDS → RECONSTRUCT EXACTLY ═══");
  const showcase: [number, number][] = [[1, 3], [2, 4], [4, 5]];
  for (const [x, y] of showcase) {
    const damaged = shards.map((s, i) => (i === x || i === y ? null : s));
    const rebuilt = reconstruct(damaged);
    const blob2 = joinData(rebuilt.slice(0, K));
    const ok = bytesEqual(blob, blob2);
    const txt = String.fromCharCode(...blob2.slice(0, 40));
    log(`   lost {${shardName(x)},${shardName(y)}} → rebuilt · bytes equal: ${ok ? "YES" : "NO"} · fingerprint ${fingerprint(blob2)} · "${txt}..."`);
  }
  let exact = 0, pairs = 0;
  for (let x = 0; x < 6; x++) for (let y = x + 1; y < 6; y++) {
    pairs++;
    const rebuilt = reconstruct(shards.map((s, i) => (i === x || i === y ? null : s)));
    if (bytesEqual(blob, joinData(rebuilt.slice(0, K))) &&
        bytesEqual(shards[4], rebuilt[4]) && bytesEqual(shards[5], rebuilt[5])) exact++;
  }
  log(`   brute force: all ${pairs} possible 2-shard losses → ${exact}/${pairs} reconstructed byte-identically`);
  try { reconstruct(shards.map((s, i) => (i < 3 ? null : s))); }
  catch (e) { log(`   lose 3 shards → ${(e as Error).message} (m=2 tolerates exactly 2)`); }
  log("");

  // ── (B) The economics ────────────────────────────────────────────────────
  log("═══ (B) ECONOMICS — same 2-loss tolerance, half the bytes ═══");
  const PRICE = 20; // $/TB-month raw
  const LOGICAL = 1000; // TB of user data
  log(`   storing ${LOGICAL} TB of user data at $${PRICE}/TB-month raw:`);
  log("   scheme           overhead   tolerates   raw stored     $/month");
  const schemes: [string, number, number][] = [
    ["3× replication", 3.0, 2], ["EC(4,2)", 6 / 4, 2], ["EC(6,3)", 9 / 6, 3], ["EC(12,4)", 16 / 12, 4],
  ];
  for (const [name, ov, tol] of schemes)
    log(`   ${name.padEnd(16)} ${ov.toFixed(2)}×      ${tol} losses    ${String(Math.round(LOGICAL * ov)).padStart(4)} TB      $${Math.round(LOGICAL * ov * PRICE).toLocaleString("en-US")}`);
  log(`   EC(4,2) vs 3×: identical 2-loss tolerance, ${(LOGICAL * 3 * PRICE - LOGICAL * 1.5 * PRICE).toLocaleString("en-US")} $/month saved — HALF the storage.`);
  log("   And EC(6,3) tolerates MORE failures (3) than 3× replication (2) at half the cost.");
  log("");

  // ── (C) The costs: repair + degraded reads ───────────────────────────────
  log("═══ (C) WHAT EC COSTS YOU — repair & degraded-read amplification ═══");
  shardReads = 0; decodeOps = 0;
  const oneLost = shards.map((s, i) => (i === 2 ? null : s));
  reconstruct(oneLost);
  log(`   REPAIR one lost ${shards[0].length}-byte shard (d2):`);
  log(`     EC(4,2):        read ${shardReads} shards (${shardReads * shards[0].length} bytes from ${shardReads} nodes) + ${decodeOps.toLocaleString("en-US")} byte-XOR/GF ops → rebuild ${shards[0].length} bytes`);
  log(`     3× replication: read 1 surviving copy — 1 node, 0 math. EC repair = k× read amplification.`);
  log(`     (Fleet-wide, that k× is why a disk failure in an EC pool triggers a read STORM.)`);
  shardReads = 0; decodeOps = 0;
  const degraded = reconstruct(oneLost);
  const served = joinData(degraded.slice(0, K));
  log(`   DEGRADED GET of the whole object while d2 is down (bytes equal: ${bytesEqual(served, blob) ? "YES" : "NO"}):`);
  log(`     EC(4,2):        must gather k=4 shards + decode (${decodeOps.toLocaleString("en-US")} byte ops) — latency = slowest of 4 nodes + CPU`);
  log(`     3× replication: read a different replica — 1 node, no reconstruction, no extra latency.`);
  log("   Every read of a degraded object pays this until repair finishes — which is why");
  log("   phase 3's repair-speed lever matters twice as much under EC.");
  log("");

  // ── (D) Placement: replicate hot, erasure-code cold ──────────────────────
  log("═══ (D) PLACEMENT — hot tier replicates, cold tier erasure-codes ═══");
  const HOT = 100, COLD = 900; // TB — the classic 10/90 hot/cold split
  const hotCost = HOT * 3.0 * PRICE, coldCost = COLD * 1.5 * PRICE;
  const allRepl = LOGICAL * 3.0 * PRICE;
  log("   tier            data      scheme    raw        $/month    repair IO    degraded GET");
  log(`   hot  (10%)      ${HOT} TB    3× repl   ${HOT * 3} TB     $${hotCost.toLocaleString("en-US")}     1× copy      any replica`);
  log(`   cold (90%)      ${COLD} TB    EC(4,2)   ${COLD * 1.5} TB    $${coldCost.toLocaleString("en-US")}    4× reads     k reads + decode`);
  log(`   blended: ${(HOT * 3 + COLD * 1.5).toLocaleString("en-US")} TB raw, $${(hotCost + coldCost).toLocaleString("en-US")}/mo vs $${allRepl.toLocaleString("en-US")}/mo all-replicated`);
  log(`   → $${(allRepl - hotCost - coldCost).toLocaleString("en-US")}/mo (${Math.round((1 - (hotCost + coldCost) / allRepl) * 100)}%) saved, every tier still tolerating any 2 simultaneous losses:`);
  log(`   $/durability: hot pays $${(3 * PRICE).toFixed(0)}/TB-mo for cheap reads+repair; cold pays $${(1.5 * PRICE).toFixed(0)}/TB-mo`);
  log("   for the same nines. A lifecycle job re-encodes 3×→EC as objects cool — exactly");
  log("   what HDFS-EC, Ceph and Colossus-style stores do.");
  log("");
  log("   TAKEAWAY: erasure coding buys durability-per-dollar for cold data; replication");
  log("   buys cheap reads and cheap repair for hot data. Don't pick one — tier: replicate");
  log("   hot, erasure-code cold, and let lifecycle policy move data between them.");
  process.exit(0);
}

main();
