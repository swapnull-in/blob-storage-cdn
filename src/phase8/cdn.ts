/**
 * Phase 8 — CDNs: THE DELIVERY LAYER (AND THE EGRESS BILL). Run: npm run phase8
 *
 * Phases 1-7 built the STORAGE side. But storage is not delivery: your bucket
 * lives in one region, and a user in Mumbai fetching from Virginia pays ~200ms
 * of RTT — and YOU pay ~$0.09/GB of internet egress, per download, forever.
 * For media, egress — not storage — is the line item that explodes.
 *
 * A CDN is a fleet of edge caches (PoPs) near users, origin-PULL by default:
 * first request at a PoP misses through to the origin (the bucket), everyone
 * after that is served from the edge. Origin traffic collapses from "every
 * read" to "one miss per PoP per object". Latency collapses from
 * cross-continent RTT to a ~15ms hop.
 *
 * The four things people get wrong:
 *
 *   INVALIDATION — purge-by-path is slow (seconds-minutes to reach every PoP,
 *     a global operation) and race-prone: readers get stale bytes until the
 *     purge lands. The grown-up move is VERSIONED URLs: the name carries the
 *     version (avatar_v2.jpg — or a content hash, which Phase 5's CAS gives
 *     you for free). Then every cached entry is immutable-forever
 *     (Cache-Control: immutable), a "deploy" is just flipping which URL the
 *     app references, and invalidation stops being an operation at all.
 *
 *   PRIVATE CONTENT — you don't route private blobs around the CDN; you give
 *     the PoP the means to check authorization itself: a SIGNED URL (HMAC over
 *     path + expiry, verified at the edge with a shared key). Tampered or
 *     expired requests die at the PoP without ever touching the origin.
 *
 *   THE BILL — CDN egress is cheaper than origin egress AND it shields the
 *     origin's meter. At a healthy hit ratio the total drops ~2x and origin
 *     egress drops 10x+; at a TERRIBLE hit ratio you pay BOTH meters and the
 *     CDN makes the bill worse. Hit ratio is a cost dial, not just a perf dial.
 *
 *   AND: the CDN is also the fix for Phase 7's hot OBJECT — 19,000 req/s for
 *     one viral video becomes one origin miss per PoP.
 *
 * TAKEAWAY: put a CDN in front of blobs, name things immutably (version/hash
 * in the URL) so invalidation becomes a non-event, sign at the edge for
 * private content — and watch egress, it's the bill that surprises.
 */

import { createHmac } from "node:crypto";
import { log, hash32, mulberry32 } from "../lib/log.ts";

// ─── Geography (modeled latencies, ms) ──────────────────────────────────────
const REGIONS = ["us-east", "eu-west", "ap-south"] as const;
type Region = (typeof REGIONS)[number];
const CLIENT_TO_EDGE_MS = 15; // everyone is near their local PoP
const REGION_TO_ORIGIN_MS: Record<Region, number> = { "us-east": 25, "eu-west": 105, "ap-south": 205 };

// ─── Origin: the object store from phases 1-7, with an egress meter ─────────
interface Origin { objects: Map<string, { sizeMB: number; body: string }>; egressGB: number; fetches: number }

function originGet(origin: Origin, url: string): { sizeMB: number; body: string } {
  const obj = origin.objects.get(url);
  if (!obj) throw new Error(`origin 404: ${url}`);
  origin.egressGB += obj.sizeMB / 1024;
  origin.fetches++;
  return obj;
}

// ─── Edge PoP: one cache per region ─────────────────────────────────────────
interface Pop { region: Region; cache: Map<string, { sizeMB: number; body: string }>; hits: number; misses: number; egressGB: number }

function makePops(): Map<Region, Pop> {
  return new Map(REGIONS.map((r) => [r, { region: r, cache: new Map(), hits: 0, misses: 0, egressGB: 0 }]));
}

/** Origin-pull: serve from edge, miss through to origin once. Returns [latencyMs, body]. */
function edgeGet(pop: Pop, origin: Origin, url: string): [number, string] {
  const cached = pop.cache.get(url);
  if (cached) { pop.hits++; pop.egressGB += cached.sizeMB / 1024; return [CLIENT_TO_EDGE_MS, cached.body]; }
  pop.misses++;
  const obj = originGet(origin, url); // fill from origin
  pop.cache.set(url, obj);            // Cache-Control: public → keep it
  pop.egressGB += obj.sizeMB / 1024;
  return [CLIENT_TO_EDGE_MS + REGION_TO_ORIGIN_MS[pop.region], obj.body];
}

function main() {
  const rand = mulberry32(0xcd47);

  // Catalog: a few blobs of realistic sizes (bodies stand in for bytes).
  const origin: Origin = { objects: new Map(), egressGB: 0, fetches: 0 };
  const catalog = [
    { url: "/videos/3f/dQw4w9.mp4", sizeMB: 48 },   // the Phase 7 viral video
    { url: "/videos/a1/launch.mp4", sizeMB: 32 },
    { url: "/img/hero_v1.webp", sizeMB: 1.2 },
    { url: "/img/logo_v1.svg", sizeMB: 0.1 },
    { url: "/audio/pod_ep12.mp3", sizeMB: 22 },
  ];
  for (const b of catalog) origin.objects.set(b.url, { sizeMB: b.sizeMB, body: `bytes(${b.url})` });

  // A deterministic request trace: 3,000 reads, zipf-ish popularity, 3 regions.
  const trace: { region: Region; url: string }[] = [];
  for (let i = 0; i < 3_000; i++) {
    const region = REGIONS[rand() < 0.4 ? 0 : rand() < 0.6 ? 1 : 2];
    const blob = catalog[Math.floor(Math.pow(rand(), 2.2) * catalog.length)]; // hot head, long tail
    trace.push({ region, url: blob.url });
  }

  // ═════ A. No CDN vs CDN: origin egress + latency ══════════════════════════
  log("═══ A. Same 3,000-read trace, with and without a CDN ═══");
  {
    // Without: every client fetches the origin region directly.
    const bare: Origin = { objects: origin.objects, egressGB: 0, fetches: 0 };
    const latNo: Record<Region, number[]> = { "us-east": [], "eu-west": [], "ap-south": [] };
    for (const r of trace) { originGet(bare, r.url); latNo[r.region].push(REGION_TO_ORIGIN_MS[r.region]); }

    // With: each region reads through its PoP.
    const pops = makePops();
    const latCdn: Record<Region, number[]> = { "us-east": [], "eu-west": [], "ap-south": [] };
    for (const r of trace) { const [ms] = edgeGet(pops.get(r.region)!, origin, r.url); latCdn[r.region].push(ms); }

    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    let hits = 0, misses = 0;
    for (const p of pops.values()) { hits += p.hits; misses += p.misses; }
    log(`   ${"region".padEnd(10)} ${"reads".padStart(6)}   avg latency no-CDN → CDN`);
    for (const r of REGIONS) log(`   ${r.padEnd(10)} ${String(latNo[r].length).padStart(6)}   ${avg(latNo[r]).toFixed(0).padStart(5)}ms → ${avg(latCdn[r]).toFixed(1)}ms`);
    log(`   edge hit ratio: ${hits}/${hits + misses} = ${((hits / (hits + misses)) * 100).toFixed(1)}%  (misses = first read per PoP per object)`);
    log(`   origin egress:  no-CDN ${bare.egressGB.toFixed(1)} GB (${bare.fetches} fetches) → CDN ${origin.egressGB.toFixed(2)} GB (${origin.fetches} fills)`);
    log(`   → origin traffic collapsed ${(bare.egressGB / origin.egressGB).toFixed(0)}x: every read became "one miss per PoP".`);
  }

  // ═════ B. Invalidation: purge-by-path vs versioned URLs ═══════════════════
  log("");
  log("═══ B. Invalidation — purge-by-path vs versioned (immutable) URLs ═══");
  {
    // WRONG WAY — mutable URL /img/hero.webp, deploy mutates bytes in place,
    // then a global purge crawls the PoPs (propagation: 0.5s / 2s / 8s).
    const o1: Origin = { objects: new Map([["/img/hero.webp", { sizeMB: 1.2, body: "hero-OLD" }]]), egressGB: 0, fetches: 0 };
    const pops1 = makePops();
    const purgeArrivesAtMs: Record<Region, number> = { "us-east": 500, "eu-west": 2000, "ap-south": 8000 };
    for (const r of REGIONS) edgeGet(pops1.get(r)!, o1, "/img/hero.webp"); // warm all PoPs with OLD
    o1.objects.set("/img/hero.webp", { sizeMB: 1.2, body: "hero-NEW" });   // t=0: deploy overwrites in place + issues purge
    let stale1 = 0, reads1 = 0;
    for (let t = 100; t <= 9000; t += 700) {                               // readers keep reading during propagation
      const region = REGIONS[Math.floor(rand() * 3)];
      const pop = pops1.get(region)!;
      if (t >= purgeArrivesAtMs[region] && pop.cache.has("/img/hero.webp")) pop.cache.delete("/img/hero.webp"); // purge lands
      const [, body] = edgeGet(pop, o1, "/img/hero.webp");
      reads1++; if (body === "hero-OLD") { stale1++; log(`   purge-by-path  t=${String(t).padStart(4)}ms ${region}: served STALE hero-OLD (purge not here yet)`); }
    }
    log(`   purge-by-path: ${stale1}/${reads1} reads stale during the purge window, 1 global purge op issued`);

    // RIGHT WAY — the version lives in the NAME (content hash → Phase 5 CAS).
    // A cached entry can never be wrong, so: Cache-Control: immutable.
    const vOld = hash32("hero-OLD").toString(16), vNew = hash32("hero-NEW").toString(16);
    const o2: Origin = { objects: new Map([[`/img/hero_${vOld}.webp`, { sizeMB: 1.2, body: "hero-OLD" }]]), egressGB: 0, fetches: 0 };
    const pops2 = makePops();
    let ref = `/img/hero_${vOld}.webp`;                                    // what the app's HTML points at
    for (const r of REGIONS) edgeGet(pops2.get(r)!, o2, ref);              // warm all PoPs with v-old
    o2.objects.set(`/img/hero_${vNew}.webp`, { sizeMB: 1.2, body: "hero-NEW" }); // deploy = upload new name...
    ref = `/img/hero_${vNew}.webp`;                                        // ...and flip the reference. No purge.
    let stale2 = 0, reads2 = 0, missAfter = 0;
    for (let t = 100; t <= 9000; t += 700) {
      const pop = pops2.get(REGIONS[Math.floor(rand() * 3)])!;
      const before = pop.cache.has(ref);
      const [, body] = edgeGet(pop, o2, ref);
      reads2++; if (!before) missAfter++; if (body === "hero-OLD") stale2++;
    }
    log(`   versioned URL: deploy = upload hero_${vNew}.webp + flip the reference`);
    log(`   versioned URL: ${stale2}/${reads2} stale reads, 0 purges — just ${missAfter} first-miss-per-PoP fills; old version ages out untouched`);
    log(`   → name the bytes (hash from Phase 5's CAS ⇒ new bytes = new name), mark them`);
    log(`     'immutable', and cache invalidation stops being a thing that can race.`);
  }

  // ═════ C. Signed URLs: private blobs, verified AT the edge ════════════════
  log("");
  log("═══ C. Signed URLs — the PoP checks the HMAC, origin never wakes up ═══");
  {
    const SECRET = "edge-shared-key-2026";                    // provisioned to every PoP
    const sign = (path: string, expires: number) => createHmac("sha256", SECRET).update(`${path}|${expires}`).digest("hex").slice(0, 16);
    const verify = (path: string, expires: number, sig: string, now: number) =>
      now <= expires && sig === sign(path, expires) ? "OK" : now > expires ? "EXPIRED" : "BAD SIGNATURE";

    const o3: Origin = { objects: new Map([["/private/payroll-2026.pdf", { sizeMB: 2, body: "payroll" }], ["/private/board-deck.pdf", { sizeMB: 6, body: "deck" }]]), egressGB: 0, fetches: 0 };
    const pop = makePops().get("eu-west")!;
    const NOW = 1_755_400_000;                                // simulated unix seconds — no Date.now() in logic

    const path = "/private/payroll-2026.pdf", exp = NOW + 300;
    const sig = sign(path, exp);
    log(`   API mints:  GET ${path}?exp=${exp}&sig=${sig}  (valid 300s)`);

    const attempts: { label: string; path: string; exp: number; sig: string; now: number }[] = [
      { label: "valid, first read ", path, exp, sig, now: NOW + 10 },
      { label: "valid, second read", path, exp, sig, now: NOW + 20 },
      { label: "tampered path     ", path: "/private/board-deck.pdf", exp, sig, now: NOW + 30 }, // reuse sig on another blob
      { label: "expired           ", path, exp, sig, now: NOW + 301 },
    ];
    for (const a of attempts) {
      const verdict = verify(a.path, a.exp, a.sig, a.now);
      if (verdict === "OK") { const [ms] = edgeGet(pop, o3, a.path); log(`   ${a.label} → 200 from edge (${ms}ms, ${pop.hits} hit / ${pop.misses} miss)`); }
      else log(`   ${a.label} → 403 at the PoP: ${verdict} — origin fetches still ${o3.fetches}`);
    }
    log(`   → auth became math the edge can do alone: ${o3.fetches} origin fetch total, and the`);
    log(`     tampered/expired requests never crossed the ocean. Same idea as Phase 1's`);
    log(`     presigned URLs — a capability in the URL — enforced one hop from the user.`);
  }

  // ═════ D. The egress bill: 1 PB served per month ══════════════════════════
  log("");
  log("═══ D. The bill — 1 PB/month served (≈ one 48 MB video gone viral × 22M views) ═══");
  {
    const PB_GB = 1_048_576;                                  // 1 PB in GB
    const ORIGIN_RATE = 0.09, CDN_RATE = 0.04;                // $/GB internet egress
    const usd = (n: number) => "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
    const row = (label: string, hit: number | null) => {
      if (hit === null) {                                     // no CDN: origin serves everything
        log(`   ${label.padEnd(18)} ${String(PB_GB.toLocaleString("en-US")).padStart(12)} GB   ${usd(PB_GB * ORIGIN_RATE).padStart(9)}   ${"—".padStart(8)}   ${usd(PB_GB * ORIGIN_RATE).padStart(9)}`);
        return;
      }
      const originGB = PB_GB * (1 - hit);                     // misses fill from origin (billed at origin rate)
      const total = originGB * ORIGIN_RATE + PB_GB * CDN_RATE;// CDN bills every GB it delivers
      log(`   ${label.padEnd(18)} ${Math.round(originGB).toLocaleString("en-US").padStart(12)} GB   ${usd(originGB * ORIGIN_RATE).padStart(9)}   ${usd(PB_GB * CDN_RATE).padStart(8)}   ${usd(total).padStart(9)}`);
    };
    log(`   rates: origin egress $${ORIGIN_RATE.toFixed(2)}/GB · CDN egress $${CDN_RATE.toFixed(2)}/GB · CDN misses fill from origin`);
    log(`   ${"".padEnd(18)} ${"origin egress".padStart(15)}   ${"origin $".padStart(9)}   ${"CDN $".padStart(8)}   ${"TOTAL/mo".padStart(9)}`);
    row("no CDN", null);
    row("CDN, 0% edge-hit", 0.0);
    row("CDN, 90% edge-hit", 0.9);
    log(`   → 90% hit ratio: total bill roughly HALVES and origin egress drops 10x —`);
    log(`     and same-vendor fills (e.g. S3→CloudFront $0.00/GB) erase the origin column.`);
    log(`   → 0% hit ratio: you pay BOTH meters. A CDN with a cold cache (bad cache keys,`);
    log(`     query-string explosions, purge-happy deploys) is a cost AMPLIFIER.`);
    log(`   Storage for that 48 MB video: ~$0.001/month. Serving it: ${usd(PB_GB * ORIGIN_RATE)}/month`);
    log(`   from origin. Egress is the bill that surprises — storage never is.`);
  }

  log("");
  log("TAKEAWAY: put a CDN in front of blobs — reads collapse to one miss per PoP");
  log("and far-region latency drops ~10x. Name things immutably (version or content");
  log("hash in the URL, à la Phase 5) so a deploy is a reference flip and");
  log("invalidation is a non-event, not a global race. Sign URLs so the edge can");
  log("reject bad requests without waking the origin. And watch the egress line:");
  log("hit ratio is a COST dial — 90% halves the bill, 0% pays both meters.");
  process.exit(0);
}

main();
