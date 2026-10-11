const LOC_TO_METERS = 10;

/** Upstream car_data sometimes freezes: the feed keeps emitting rows with
 *  advancing timestamps while speed, rpm and gear hold their last value and
 *  throttle / brake read 104 — the F1 feed's "no data" sentinel. The location
 *  feed is separate and keeps moving, so distance and timing stay honest; only
 *  the car channels are stale. Seen on 5 of 11 Suzuka 2026 qualifying laps,
 *  one of them frozen at 189 km/h for the final 1.9 km, through 130R and the
 *  chicane. A sample is frozen when it carries the sentinel, or sits in a run
 *  of identical speed + rpm that does: the first few rows of a freeze still
 *  show plausible throttle, while a car genuinely at terminal velocity holds
 *  its speed for a few samples but never with the sentinel. */
export function frozenCarDataMask(
  samples: { speed?: number; rpm?: number; throttle?: number; brake?: number }[],
): boolean[] {
  const n = samples.length;
  const mask = new Array<boolean>(n).fill(false);
  const sentinel = (s: { throttle?: number; brake?: number }) =>
    (s.throttle ?? 0) > 100 || (s.brake ?? 0) > 100;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && samples[j + 1].speed === samples[i].speed && samples[j + 1].rpm === samples[i].rpm) j++;
    let hit = false;
    for (let k = i; k <= j && !hit; k++) hit = sentinel(samples[k]);
    if (hit) for (let k = i; k <= j; k++) mask[k] = true;
    i = j + 1;
  }
  return mask;
}

/** Merge car_data with location data: attach cumulative track distance and
 *  an (x, y) position to every car_data sample. The (x, y) propagation lets
 *  downstream visualisations (track maps, dominance maps) skip a separate
 *  location fetch — every merged sample knows where on the circuit it was.
 *
 *  The distance axis is the car's own speed integral, calibrated to the
 *  location polyline, rather than the nearest fix by timestamp. The two feeds
 *  are not aligned: both run at ~3.7 Hz with 160–440 ms between rows, and the
 *  location rows' timestamps jitter by about ±0.1 s against the positions
 *  they carry — consecutive fixes on a 303 km/h straight imply 590 km/h and
 *  then 180. Snapping a sample to the nearest fix therefore put it up to
 *  ~10 m from where the car was at that instant, and anything timed between
 *  two track positions (lap segmentation, sector lines) inherited that as
 *  ±0.1 s per boundary. Measured against the official sector lines across
 *  four 2026 qualifying sessions, the snap put cars 8.9 m rms from a common
 *  crossing point; integrating speed and letting the fixes only correct the
 *  slow drift brings that to 5.6 m, and halves the noise on short sections.
 *  The fixes still set the scale: the polyline's cumulative length is what
 *  the integral is pulled onto, so the lap's distance stays comparable with
 *  the location-only maps. Where car_data is frozen (see frozenCarDataMask)
 *  the integral is bridged with the location fixes instead, since the speed
 *  channel is stale there. */
const CALIBRATION_WINDOW_S = 1.5;
/** Fewer live speed readings than this and the integral has nothing to work
 *  with; fall back to interpolating the fixes by time. */
const MIN_SPEED_SAMPLES = 10;

export function mergeDistance(cd: any[], loc: any[]): any[] {
  const track: { t: number; s: number; x: number; y: number }[] = [];
  let cum = 0;
  for (let i = 0; i < loc.length; i++) {
    if (i > 0) {
      const dx = loc[i].x - loc[i - 1].x, dy = loc[i].y - loc[i - 1].y;
      cum += Math.sqrt(dx * dx + dy * dy);
    }
    track.push({ t: new Date(loc[i].date).getTime(), s: cum / LOC_TO_METERS, x: loc[i].x, y: loc[i].y });
  }
  if (!track.length || !cd.length) return cd.map(c => ({ ...c, distance: 0, x: 0, y: 0 }));

  const bracket = <T,>(arr: T[], key: (v: T) => number, v: number): [number, number] => {
    let lo = 0, hi = arr.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (key(arr[mid]) <= v) lo = mid; else hi = mid;
    }
    return [lo, hi];
  };
  const lerp = (a: number, b: number, f: number) => a + f * (b - a);
  const fracBetween = (a: number, b: number, v: number) => (b > a ? Math.max(0, Math.min(1, (v - a) / (b - a))) : 0);

  // Distance along the fixes at a timestamp — the fallback, and the bridge
  // across frozen car_data.
  const locDistAt = (t: number) => {
    const [lo, hi] = bracket(track, p => p.t, t);
    return lerp(track[lo].s, track[hi].s, fracBetween(track[lo].t, track[hi].t, t));
  };
  // Position on the polyline at a distance.
  const xyAt = (s: number) => {
    const [lo, hi] = bracket(track, p => p.s, s);
    const f = fracBetween(track[lo].s, track[hi].s, s);
    return { x: lerp(track[lo].x, track[hi].x, f), y: lerp(track[lo].y, track[hi].y, f) };
  };

  const times = cd.map(c => new Date(c.date).getTime());
  const frozen = frozenCarDataMask(cd);
  const live = cd.reduce((n, c, i) => n + (!frozen[i] && Number.isFinite(c.speed) ? 1 : 0), 0);
  if (live < MIN_SPEED_SAMPLES) {
    return cd.map((c, i) => ({ ...c, distance: locDistAt(times[i]), ...xyAt(locDistAt(times[i])) }));
  }

  // Speed integral on the car_data clock, metres.
  const integral = new Array<number>(cd.length).fill(0);
  for (let j = 1; j < cd.length; j++) {
    const dt = (times[j] - times[j - 1]) / 1000;
    const stale = frozen[j] || frozen[j - 1] || !Number.isFinite(cd[j].speed) || !Number.isFinite(cd[j - 1].speed);
    integral[j] = integral[j - 1] + (stale || dt <= 0
      ? Math.max(0, locDistAt(times[j]) - locDistAt(times[j - 1]))
      : ((cd[j].speed + cd[j - 1].speed) / 2 / 3.6) * dt);
  }
  const integralAt = (t: number) => {
    if (t <= times[0]) return integral[0];
    if (t >= times[times.length - 1]) return integral[integral.length - 1];
    const [lo, hi] = bracket(times, v => v, t);
    return lerp(integral[lo], integral[hi], fracBetween(times[lo], times[hi], t));
  };

  // How far the fixes sit from the integral, smoothed by a running mean over
  // ±CALIBRATION_WINDOW_S. The fixes' timestamp jitter averages out; what is
  // left is the slow drift — the integral's scale error and the polyline's
  // chord-versus-arc shortfall through corners — which is what they are for.
  const residual = track.map(p => p.s - integralAt(p.t));
  const window = CALIBRATION_WINDOW_S * 1000;
  const smoothed = track.map((p, i) => {
    let sum = 0, n = 0;
    for (let k = i; k >= 0 && p.t - track[k].t <= window; k--) { sum += residual[k]; n++; }
    for (let k = i + 1; k < track.length && track[k].t - p.t <= window; k++) { sum += residual[k]; n++; }
    return sum / n;
  });
  const correctionAt = (t: number) => {
    const [lo, hi] = bracket(track, p => p.t, t);
    return lerp(smoothed[lo], smoothed[hi], fracBetween(track[lo].t, track[hi].t, t));
  };

  return cd.map((c, j) => {
    const distance = integral[j] + correctionAt(times[j]);
    return { ...c, distance, ...xyAt(distance) };
  });
}
