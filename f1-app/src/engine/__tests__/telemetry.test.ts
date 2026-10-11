import { describe, it, expect } from "vitest";
import { mergeDistance } from "../telemetry/telemetry.ts";

// A lap on a circle, driven with a speed profile that brakes and accelerates
// the way a real lap does. car_data rows carry exact timestamps and integer
// speeds; location rows carry exact positions but timestamps jittered by up
// to ±0.12 s, which is what OpenF1's feed does (consecutive fixes on a
// 303 km/h straight imply 590 km/h and then 180).
const RADIUS_M = 800;
const T0 = Date.UTC(2026, 0, 1);

function speedAt(t: number): number {              // km/h
  return 200 + 100 * Math.sin(t / 4) - 60 * Math.max(0, Math.sin(t / 2.3));
}
function trueDistance(t: number): number {        // metres, integrated finely
  let d = 0;
  for (let u = 0; u < t; u += 0.005) d += speedAt(u) / 3.6 * 0.005;
  return d;
}
function posAt(d: number) {                        // decimetres, like the feed
  const a = d / RADIUS_M;
  return { x: Math.round(RADIUS_M * Math.cos(a) * 10), y: Math.round(RADIUS_M * Math.sin(a) * 10) };
}
/** Deterministic pseudo-random in [-1, 1). */
function noise(i: number): number {
  const v = Math.sin(i * 12.9898) * 43758.5453;
  return (v - Math.floor(v)) * 2 - 1;
}

function carData(lapS = 60, dt = 0.24) {
  const rows = [];
  for (let t = 0; t < lapS; t += dt) {
    rows.push({ date: new Date(T0 + t * 1000).toISOString(), speed: Math.round(speedAt(t)), throttle: 100, brake: 0, rpm: 11000 });
  }
  return rows;
}
function location(lapS = 60, dt = 0.27, jitterS = 0.12) {
  const rows = [];
  let i = 0;
  for (let t = 0; t < lapS; t += dt) {
    const p = posAt(trueDistance(t));
    rows.push({ date: new Date(T0 + (t + jitterS * noise(i++)) * 1000).toISOString(), ...p });
  }
  return rows;
}
function nearestFixDistance(cd: any[], loc: any[]): number[] {
  // the old merge, kept here as the yardstick
  let cum = 0;
  const track = loc.map((l, i) => {
    if (i) cum += Math.hypot(l.x - loc[i - 1].x, l.y - loc[i - 1].y) / 10;
    return { t: new Date(l.date).getTime(), s: cum };
  });
  return cd.map(c => {
    const t = new Date(c.date).getTime();
    let best = track[0];
    for (const p of track) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    return best.s;
  });
}
const rms = (xs: number[]) => Math.sqrt(xs.reduce((s, x) => s + x * x, 0) / xs.length);

describe("mergeDistance", () => {
  it("places samples where the car was, not at the nearest jittered fix", () => {
    const cd = carData(), loc = location();
    const merged = mergeDistance(cd, loc);
    // The polyline through 0.27 s fixes is a hair shorter than the arc; compare
    // on the fixes' own scale so the test reads position error, not scale.
    const scale = merged[merged.length - 1].distance / trueDistance(59.76);
    const errs = merged.map((m, i) => m.distance - trueDistance(i * 0.24) * scale).slice(5, -5);
    const naive = nearestFixDistance(cd, loc).map((d, i) => d - trueDistance(i * 0.24) * scale).slice(5, -5);
    expect(rms(errs)).toBeLessThan(1.5);
    expect(rms(naive)).toBeGreaterThan(5);
    expect(Math.max(...errs.map(Math.abs))).toBeLessThan(4);
    // (x, y) sit on the polyline at that distance, so they move with it.
    const far = merged[100];
    const p = posAt(far.distance / scale);
    expect(Math.hypot(far.x - p.x, far.y - p.y) / 10).toBeLessThan(4);
  });

  it("keeps the axis monotone, on the fixes' scale rather than the integral's", () => {
    const merged = mergeDistance(carData(), location());
    for (let i = 1; i < merged.length; i++) expect(merged[i].distance).toBeGreaterThanOrEqual(merged[i - 1].distance);
    // Fixes that read 3% short of the speed integral: the axis follows them.
    const short = location().map(l => ({ ...l, x: Math.round(l.x * 0.97), y: Math.round(l.y * 0.97) }));
    const onShort = mergeDistance(carData(), short);
    const ratio = onShort[onShort.length - 1].distance / merged[merged.length - 1].distance;
    expect(ratio).toBeGreaterThan(0.965);
    expect(ratio).toBeLessThan(0.975);
  });

  it("bridges a frozen car_data stretch with the fixes", () => {
    const cd = carData();
    for (let i = 120; i < 180; i++) cd[i] = { ...cd[i], speed: 189, rpm: 11535, throttle: 104, brake: 104 };
    const merged = mergeDistance(cd, location());
    const scale = merged[merged.length - 1].distance / trueDistance(59.76);
    const errs = merged.map((m, i) => m.distance - trueDistance(i * 0.24) * scale).slice(5, -5);
    expect(Math.max(...errs.map(Math.abs))).toBeLessThan(12);
  });

  it("falls back to the fixes by time when there is no speed channel, and to zeros with no fixes", () => {
    const cd = carData().map(c => ({ date: c.date }));
    const merged = mergeDistance(cd, location());
    expect(merged[merged.length - 1].distance).toBeGreaterThan(1000);
    const none = mergeDistance(carData(), []);
    expect(none.every(m => m.distance === 0 && m.x === 0 && m.y === 0)).toBe(true);
  });
});
