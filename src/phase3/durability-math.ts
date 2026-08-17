/**
 * Phase 3 — DURABILITY MATH: how 11 nines is MANUFACTURED. Run: npm run phase3
 *
 * S3 advertises 99.999999999% durability — "eleven nines", ~1 object lost per
 * 100 BILLION object-years. Disks are terrible: a real disk has an ANNUAL
 * FAILURE RATE (AFR) of ~2%. So how does a pile of 2%-AFR disks become a
 * 10⁻¹¹ loss rate? Not by magic, and NOT just by "keeping 3 copies."
 *
 * Durability is a RACE. When a copy dies, a repair process re-replicates it
 * from the survivors. You lose data only if EVERY copy dies BEFORE the repair
 * of the first one completes. Three levers multiply together:
 *
 *   1. COPIES        — all R copies must die: AFR^R (needs lever 2 to multiply!)
 *   2. INDEPENDENCE  — AFR^R is only valid if failures are independent, i.e.
 *                      copies sit in separate failure domains (disk/rack/AZ).
 *                      Same rack ⇒ one power bus / switch / firmware bug kills
 *                      all copies at once and the exponent silently collapses.
 *   3. REPAIR SPEED  — the deaths must ALSO land inside one repair window.
 *                      For 3 copies with iid failure times, P(all 3 within a
 *                      window of length r·year) ≈ 3r². Shrink repair from
 *                      30 days to 3 hours and this factor drops ~57,000×.
 *
 * The model here: each copy independently dies this year with prob AFR, at a
 * uniformly random time. Loss ⇔ all copies die AND their death times span less
 * than the repair time (i.e. the last survivor died before the first repair
 * finished). Correlated placement adds a shared "rack" event that kills every
 * copy simultaneously — no window to race, no survivors to repair from.
 * (Simplifications: repaired copies can't re-fail within the year; a rack
 * death is instant. Both are second-order.)
 *
 * A Monte-Carlo confession that is itself the lesson: you CANNOT measure
 * 11 nines. You'd need ~100 billion object-years per observed loss. Real
 * vendors don't measure it either — they DERIVE it, exactly like part (D),
 * and then spend all their engineering defending the two assumptions the
 * derivation leans on: independence (placement across domains, scrubbing for
 * bit rot) and repair speed (parallel reconstruction across the whole fleet).
 * So we simulate at real AFR where events are visible, crank AFR to 40%
 * ("stress fleet") to make the repair-speed collapse visible, and derive the
 * real nines analytically.
 *
 * TAKEAWAY: 11 nines isn't "3 copies." It's copies × independent failure
 * domains × a repair process that races the second failure — and correlation
 * is the killer that deletes the exponent.
 */

import { log, hash32, mulberry32 } from "../lib/log.ts";

const YEAR_H = 8760;          // hours in a year
const TRIALS = 2_000_000;     // object-years simulated per scenario (fixed)
const AFR = 0.02;             // real-world disk annual failure rate (~2%)
const STRESS_AFR = 0.4;       // junk disks, to make rare events observable
const RACK_AFR = 0.01;        // annual failure rate of a whole rack (power/switch)

interface Scenario {
  name: string;
  copies: number;
  diskAfr: number;
  repairHours: number;        // time to re-replicate a dead copy from survivors
  rack?: "shared" | "independent"; // shared = all copies in ONE rack
}

interface Result { name: string; losses: number; measured: number; analytic: number }

/** P(the spread of `n` iid uniform failure times is < r years) — exact: n·r^(n-1) − (n−1)·r^n. */
function spanFactor(n: number, r: number): number {
  if (n === 1) return 1; // one copy: nothing to race, loss = death
  return n * Math.pow(r, n - 1) - (n - 1) * Math.pow(r, n);
}

function analyticLoss(s: Scenario): number {
  const rackIndep = s.rack === "independent" ? RACK_AFR : 0;
  const perCopy = 1 - (1 - s.diskAfr) * (1 - rackIndep);
  const indep = Math.pow(perCopy, s.copies) * spanFactor(s.copies, s.repairHours / YEAR_H);
  return s.rack === "shared" ? RACK_AFR + (1 - RACK_AFR) * indep : indep;
}

function simulate(s: Scenario): Result {
  const rng = mulberry32(hash32(s.name));
  const rackIndep = s.rack === "independent" ? RACK_AFR : 0;
  const perCopyDeath = 1 - (1 - s.diskAfr) * (1 - rackIndep); // disk OR own rack dies
  let losses = 0;

  for (let t = 0; t < TRIALS; t++) {
    // Correlated placement: one rack event takes out every copy at once.
    if (s.rack === "shared" && rng() < RACK_AFR) { losses++; continue; }

    // Independent deaths: did each copy die this year, and when?
    let allDied = true;
    let tMin = Infinity, tMax = -Infinity;
    for (let c = 0; c < s.copies; c++) {
      if (rng() < perCopyDeath) {
        const time = rng() * YEAR_H;
        if (time < tMin) tMin = time;
        if (time > tMax) tMax = time;
      } else allDied = false;
    }
    if (!allDied) continue;
    // Loss ⇔ the last copy died before repair of the first completed.
    if (s.copies === 1 || tMax - tMin < s.repairHours) losses++;
  }
  return { name: s.name, losses, measured: losses / TRIALS, analytic: analyticLoss(s) };
}

const sci = (x: number) => x.toExponential(2);
const nines = (p: number) => (p > 0 ? (-Math.log10(p)).toFixed(1) : "∞");
const row = (r: Result) =>
  log(
    `   ${r.name.padEnd(38)} losses ${String(r.losses).padStart(6)}/${TRIALS.toLocaleString("en-US")}` +
    `  measured ${r.measured > 0 ? sci(r.measured) : "0       "}  analytic ${sci(r.analytic)}`
  );

function main() {
  log(`Fleet model: AFR per disk ${AFR * 100}%/yr · ${TRIALS.toLocaleString("en-US")} object-years per scenario · seeded PRNG`);
  log("");

  // ── (A) One copy ─────────────────────────────────────────────────────────
  log("═══ (A) ONE copy — durability IS the disk ═══");
  const a = simulate({ name: "1 copy (no redundancy)", copies: 1, diskAfr: AFR, repairHours: 0 });
  row(a);
  log(`   One copy has no survivors to repair from: annual loss ≈ AFR ≈ ${(a.measured * 100).toFixed(2)}%.`);
  log(`   That is ${nines(a.measured)} nines. Losing 1 in ${Math.round(1 / a.measured)} objects per year is not a product.`);
  log("");

  // ── (B) Three replicas: repair speed is the lever ────────────────────────
  log("═══ (B) 3 REPLICAS — loss only if ALL die before repair completes ═══");
  const bSlow = simulate({ name: "3 copies, repair takes 30 days", copies: 3, diskAfr: AFR, repairHours: 720 });
  const bFast = simulate({ name: "3 copies, repair takes 3 hours", copies: 3, diskAfr: AFR, repairHours: 3 });
  row(bSlow); row(bFast);
  log("   Both measure ~0 — and that's the rare-event wall: at the true slow-repair rate");
  log(`   (${sci(bSlow.analytic)}) you'd need ~${Math.round(1 / bSlow.analytic / 1e6)}M object-years to see ONE loss, and ~100 billion`);
  log("   for eleven nines. Durability this high is DERIVED, not measured (see D).");
  log("");
  log(`   To SEE repair speed working, stress fleet with junk disks (AFR ${STRESS_AFR * 100}%):`);
  const sSlow = simulate({ name: `stress: 3 copies, repair 30 days`, copies: 3, diskAfr: STRESS_AFR, repairHours: 720 });
  const sMed  = simulate({ name: `stress: 3 copies, repair 3 days`, copies: 3, diskAfr: STRESS_AFR, repairHours: 72 });
  const sFast = simulate({ name: `stress: 3 copies, repair 3 hours`, copies: 3, diskAfr: STRESS_AFR, repairHours: 3 });
  row(sSlow); row(sMed); row(sFast);
  log("   Same disks, same copy count — only repair speed changed. Loss probability");
  log("   collapses ∝ (repair window)², because P(3 deaths within window r) ≈ 3r².");
  log(`   30 days → 3 hours shrinks that factor ~${Math.round(spanFactor(3, 720 / YEAR_H) / spanFactor(3, 3 / YEAR_H)).toLocaleString("en-US")}×. Repair RACES the second failure.`);
  log("");

  // ── (C) Correlated failures ──────────────────────────────────────────────
  log("═══ (C) CORRELATION — 3 copies in ONE rack (shared power/switch, rack AFR 1%) ═══");
  const cShared = simulate({ name: "3 copies, SAME rack, repair 3h", copies: 3, diskAfr: AFR, repairHours: 3, rack: "shared" });
  const cIndep  = simulate({ name: "3 copies, 3 racks, repair 3h", copies: 3, diskAfr: AFR, repairHours: 3, rack: "independent" });
  row(cShared); row(cIndep);
  log(`   Same 3 copies, same fast repair — but co-located, loss jumps to ~${(cShared.measured * 100).toFixed(2)}%/yr:`);
  log("   the rack event kills every copy AT ONCE, so there is no window to race and");
  log("   no survivor to repair from. AFR³ quietly became AFR¹ of the shared domain.");
  log("   3× the storage bought ~2 nines — barely better than ONE copy. Correlation");
  log("   (bad placement, one AZ, a fleet-wide firmware push) is what actually loses data.");
  log("");

  // ── (D) The derivation ───────────────────────────────────────────────────
  log("═══ (D) THE DERIVATION — copies × independence × repair-window → the nines ═══");
  const rSlow = 720 / YEAR_H, rFast = 3 / YEAR_H;
  log(`   Step 1  COPIES        P(one copy dies this year)          = AFR        = ${sci(AFR)}`);
  log(`   Step 2  INDEPENDENCE  P(all 3 die, separate domains)      = AFR³       = ${sci(AFR ** 3)}`);
  log(`   Step 3  REPAIR WINDOW deaths must land inside one window:  P(span<r) ≈ 3r²`);
  log(`             slow  r = 720h/8760h → ${sci(spanFactor(3, rSlow))}      fast  r = 3h/8760h → ${sci(spanFactor(3, rFast))}`);
  log(`   Step 4  ANNUAL LOSS   = AFR³ × P(span<r)`);
  log("");
  log("   scheme                                annual loss     durability (nines)");
  const derived: Array<[string, number]> = [
    ["1 copy", AFR],
    ["3 copies, same rack (correlated)", analyticLoss({ name: "", copies: 3, diskAfr: AFR, repairHours: 3, rack: "shared" })],
    ["3 copies, indep domains, 30-day repair", AFR ** 3 * spanFactor(3, rSlow)],
    ["3 copies, indep domains, 3-hour repair", AFR ** 3 * spanFactor(3, rFast)],
  ];
  for (const [name, p] of derived) log(`   ${name.padEnd(40)} ${sci(p).padEnd(12)}    ${nines(p)} nines`);
  log("");
  log("   Same 2%-AFR disks in every row. Copies alone: no. Copies + independence +");
  log("   fast repair: ELEVEN nines, manufactured. Real stores go further: erasure-coded");
  log("   fragments (phase 4) across ≥3 AZs need m+1 simultaneous independent deaths in");
  log("   one window, plus checksum scrubbing so silent corruption counts as a failure");
  log("   and gets repaired before a second one lands.");
  log("");
  log("   TAKEAWAY: durability = copies × independent failure domains × repair speed.");
  log("   11 nines isn't \"3 copies\" — it's a repair process racing the second failure");
  log("   across independent domains. Correlation deletes the exponent; it's the killer.");
  process.exit(0);
}

main();
