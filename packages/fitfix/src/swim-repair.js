/**
 * swim-repair.js -- pool swim repair built on top of fit-patch.js.
 *
 * This layer is deliberately separate from fit-patch.js: the patcher is
 * generic and uncontroversial, the heuristics here are not.
 *
 * WARNING -- the defaults are calibrated on a single swimmer:
 *   * lengthsPerLap: 1  -- assumes the lap button was pressed once per 50 m
 *     length. Anyone who laps per interval (4x100) silently loses distance.
 *     That is why analyze() returns proposals instead of applying them -- the
 *     decision belongs in the UI.
 *   * strokeSplit: strokes per length above which breaststroke is assumed
 *     instead of freestyle. Depends on stroke length AND pool length.
 */
import { getField, patchFrame, readFit, writeFit } from './fit-patch.js';

const MSG = { record: 20, session: 18, lap: 19, length: 101, activity: 34, event: 21 };

// field numbers from the FIT profile (only the ones actually used)
// biome-ignore format: grouped by message, one line per logical group
const F = {
  length: { messageIndex: 254, startTime: 2, elapsed: 3, timer: 4, strokes: 5,
            avgSpeed: 6, swimStroke: 7, cadence: 9, lengthType: 12 },
  lap: { messageIndex: 254, startTime: 2, elapsed: 7, timer: 8, distance: 9,
         cycles: 10, calories: 11, avgCadence: 17, numLengths: 32,
         firstLengthIndex: 35, strokeDistance: 37, swimStroke: 38,
         numActiveLengths: 40, avgSpeed: 110, maxSpeed: 111 },
  session: { elapsed: 7, timer: 8, distance: 9, cycles: 10, avgCadence: 18,
             numLengths: 33, strokeDistance: 42, poolLength: 44,
             numActiveLengths: 47, avgSpeed: 124, maxSpeed: 125 },
  activity: { timer: 0 },
  event: { event: 0, eventType: 1 },
};
const LENGTH_TYPE = { idle: 0, active: 1 };
// biome-ignore format: mirrors the FIT swim_stroke enum order
const SWIM_STROKE = { freestyle: 0, backstroke: 1, breaststroke: 2, butterfly: 3,
                      drill: 4, mixed: 5, im: 6 };
const EVENT_TIMER = 0;
const STOP_TYPES = new Set([1, 4]); // stop, stop_all

/**
 * Every assumption this layer makes, in one place. All are overridable per
 * call; the values are what one swimmer's Forerunner 265 needed in a 50 m pool.
 */
export const DEFAULTS = {
  /** Lengths one press of the lap button covers. Anything beyond this in a lap
   *  is treated as phantom turns and merged away. */
  lengthsPerLap: 1,
  /** Strokes per length at or above which breaststroke is assumed. Depends on
   *  stroke length *and* pool length -- halve it for a 25 m pool. */
  strokeSplit: 40,
  /** Seconds per length used to cross-check strokeSplit. When the two
   *  disagree the lap is reported as ambiguous and the watch's label kept. */
  durationSplit: 100,
  /** Overwrite the watch's own stroke classification. */
  reclassifyStroke: true,
  /** Set elapsed time to timer time when the timer was never paused. */
  normalizeElapsed: true,
};

/**
 * Collapses a lap's active lengths down to `target` of them.
 *
 * Returns contiguous groups of the original indices; each group becomes one
 * length. Never splits: a lap already at or under the target comes back as
 * singletons.
 *
 * The groups are chosen to make the resulting lengths as even as possible, by
 * minimising the sum of the squared group durations -- for a fixed total, that
 * sum is smallest when the groups are equal. Real lengths in one lap take
 * roughly the same time, and a phantom turn splits one of them into two short
 * halves, so the most balanced partition is the one that puts the halves back
 * together.
 *
 * This replaced a greedy "merge the shortest adjacent pair" rule, which is
 * wrong on the very case it was written for. Two real lengths, both split:
 *
 *     [30, 25, 25, 30] target 2
 *       greedy   -> [[30,25,25],[30]]   the smallest pair straddles the
 *                                       true boundary, and every later
 *                                       merge inherits the mistake
 *       balanced -> [[30,25],[25,30]]
 *
 * @param {number[]} indices  active length indices, in time order
 * @param {number} target     how many lengths the lap should end up with
 * @param {(k: number) => number} durationOf
 * @returns {number[][]}
 */
export function mergeToTarget(indices, target, durationOf) {
  // Anything non-numeric means "merge everything", which is the default
  // behaviour -- previously NaN made the loop condition false and silently
  // disabled merging altogether.
  const n = Number.isFinite(target) ? Math.max(1, Math.floor(target)) : 1;

  if (!indices.length) return [];
  if (n === 1) return [indices.slice()]; // fast path, and by far the common one
  if (n >= indices.length) return indices.map((k) => [k]);

  const size = indices.length;

  /*
   * The partition search is O(target x size^2). Real laps hold a handful of
   * lengths, but a crafted file can hold thousands, and this runs on the
   * browser's main thread. Past a sane bound, fall back to equal-sized chunks:
   * predictable, linear, and no worse than arbitrary for input that is not a
   * real swim anyway.
   */
  if (size > 256) {
    const chunk = Math.ceil(size / n);
    const groups = [];
    for (let i = 0; i < size; i += chunk) groups.push(indices.slice(i, i + chunk));
    return groups;
  }

  const prefix = [0];
  for (const k of indices) prefix.push(prefix[prefix.length - 1] + (durationOf(k) ?? 0));

  // cost[g][j]: best score for splitting the first j lengths into g groups.
  const cost = Array.from({ length: n + 1 }, () => new Float64Array(size + 1).fill(Infinity));
  const from = Array.from({ length: n + 1 }, () => new Int32Array(size + 1));
  cost[0][0] = 0;

  for (let g = 1; g <= n; g++) {
    for (let j = g; j <= size; j++) {
      for (let i = g - 1; i < j; i++) {
        if (cost[g - 1][i] === Infinity) continue;
        const span = prefix[j] - prefix[i];
        const score = cost[g - 1][i] + span * span;
        if (score < cost[g][j]) {
          cost[g][j] = score;
          from[g][j] = i;
        }
      }
    }
  }

  const groups = [];
  let end = size;
  for (let g = n; g > 0; g--) {
    const start = from[g][end];
    groups.unshift(indices.slice(start, end));
    end = start;
  }
  return groups;
}

/**
 * Reads the file and describes what stands out -- without changing anything.
 * This is the function a UI hangs off.
 */
export function analyze(u8, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { frames } = readFit(u8);
  const lengths = frames.filter((f) => f.kind === 'data' && f.globalNum === MSG.length);
  const laps = frames.filter((f) => f.kind === 'data' && f.globalNum === MSG.lap);
  const session = frames.find((f) => f.kind === 'data' && f.globalNum === MSG.session);
  if (!session) throw new Error('no session message -- not an activity file?');
  const sessions = frames.filter((f) => f.kind === 'data' && f.globalNum === MSG.session);
  if (sessions.length > 1)
    throw new Error(`${sessions.length} sessions (multisport) -- not supported`);

  const poolM = getField(session, F.session.poolLength) / 100;
  if (!poolM) throw new Error('no pool_length -- not a pool swim file?');
  const timerMs = getField(session, F.session.timer);

  const stops = frames.filter(
    (f) =>
      f.kind === 'data' &&
      f.globalNum === MSG.event &&
      getField(f, F.event.event) === EVENT_TIMER &&
      STOP_TYPES.has(getField(f, F.event.eventType)),
  ).length;
  const pauses = stops - 1;

  // Assign lengths to laps. length.start_time has second resolution,
  // lap.total_elapsed_time milliseconds -- so use lap boundaries in whole
  // seconds rather than a time window.
  const bounds = laps.map((lap, i) => {
    const s = getField(lap, F.lap.startTime);
    const e =
      i + 1 < laps.length
        ? getField(laps[i + 1], F.lap.startTime)
        : s + Math.trunc(getField(lap, F.lap.elapsed) / 1000) + 1;
    return [s, e];
  });
  const lapLengths = bounds.map(([s, e]) =>
    lengths
      .map((_, k) => k)
      .filter((k) => {
        const t = getField(lengths[k], F.length.startTime);
        return t !== null && t >= s && t < e;
      }),
  );

  /*
   * The lap windows have to partition the lengths, not merely filter them.
   *
   * repair() emits exactly the lengths that landed in some lap and drops the
   * rest, so a length matching no window disappears from the output -- and
   * with it, its distance. That failed silently in every direction: a single
   * length with an invalid start_time quietly turned 900 m into 850 m, and a
   * file with no lap messages at all came back as a valid, integrity-checked,
   * completely empty activity. Better to refuse than to hand someone a
   * plausible-looking file with lengths missing.
   */
  const assigned = lapLengths.flat();
  const unique = new Set(assigned);
  if (assigned.length !== unique.size) {
    throw new Error(
      'overlapping laps -- a length falls inside more than one lap, ' +
        'which means the lap start times are not in order',
    );
  }
  if (unique.size !== lengths.length) {
    const missing = lengths.length - unique.size;
    throw new Error(
      `${missing} of ${lengths.length} lengths belong to no lap; ` +
        'repairing would silently delete them',
    );
  }

  const findings = [];
  const swimLaps = [];
  lapLengths.forEach((ids, li) => {
    const act = ids.filter((k) => getField(lengths[k], F.length.lengthType) === LENGTH_TYPE.active);
    if (!act.length) return;
    const durMs = act.reduce((a, k) => a + getField(lengths[k], F.length.elapsed), 0);
    const strokes = act.reduce((a, k) => a + (getField(lengths[k], F.length.strokes) ?? 0), 0);
    const byStrokes = strokes >= o.strokeSplit;
    const byTime = durMs / 1000 >= o.durationSplit;
    const stroke = byStrokes ? 'breaststroke' : 'freestyle';
    const deviceStroke = Object.keys(SWIM_STROKE).find(
      (k) => SWIM_STROKE[k] === getField(lengths[act[0]], F.length.swimStroke),
    );
    swimLaps.push({
      lap: li,
      lengths: act.length,
      durS: durMs / 1000,
      strokes,
      stroke,
      deviceStroke,
    });

    if (act.length > o.lengthsPerLap)
      findings.push({
        type: 'phantom-turn',
        lap: li,
        detected: act.length,
        assumed: o.lengthsPerLap,
        durS: durMs / 1000,
        strokes,
        note: `lap split into ${act.length} lengths`,
      });
    if (byStrokes !== byTime)
      findings.push({
        type: 'ambiguous-stroke',
        lap: li,
        strokes,
        durS: durMs / 1000,
        note: 'stroke count and length duration disagree',
      });
    else if (o.reclassifyStroke && deviceStroke && stroke !== deviceStroke)
      findings.push({
        type: 'stroke-mismatch',
        lap: li,
        device: deviceStroke,
        proposed: stroke,
        strokes,
        durS: durMs / 1000,
      });
  });

  /*
   * Guard against the assumption being wrong altogether.
   *
   * repair() folds every active length in a lap into one, which is only right
   * if the lap button was pressed once per length. A swimmer who laps per
   * interval -- or not at all, letting auto-pause and rest detection do the
   * work -- gets whole lengths deleted instead of phantom turns removed.
   *
   * Phantom turns are occasional: a handful of laps out of dozens, two lengths
   * each. When most laps hold more than one length, or any lap holds four or
   * more, that is not a misdetected turn, that is a different lapping habit.
   * The data alone cannot tell the two apart, so this reports rather than
   * decides -- but it has to be impossible to miss.
   */
  if (swimLaps.length) {
    const lengthsBefore = swimLaps.reduce((a, l) => a + l.lengths, 0);
    const split = swimLaps.filter((l) => l.lengths > o.lengthsPerLap);
    const maxPerLap = Math.max(...swimLaps.map((l) => l.lengths));

    // Both tests are relative to the configured target. An absolute
    // `maxPerLap >= 4` fired on files where nothing would be merged at all --
    // with lengthsPerLap: 20, a lap of 10 lengths raised a red "22 lengths
    // would become 22" warning.
    const wayOver = maxPerLap >= 4 * o.lengthsPerLap;
    if (split.length && (split.length / swimLaps.length > 0.5 || wayOver)) {
      findings.push({
        type: 'lap-structure',
        laps: swimLaps.length,
        lengthsBefore,
        lengthsAfter: swimLaps.reduce((a, l) => a + Math.min(l.lengths, o.lengthsPerLap), 0),
        maxPerLap,
        note:
          `${split.length} of ${swimLaps.length} laps hold more than ` +
          `${o.lengthsPerLap} ${o.lengthsPerLap === 1 ? 'length' : 'lengths'}. ` +
          `If a lap button press does not really cover ${o.lengthsPerLap} ` +
          `${o.lengthsPerLap === 1 ? 'length' : 'lengths'} for you, merging will delete ` +
          'real distance.',
      });
    }
  }

  const elapsedMs = getField(session, F.session.elapsed);
  if (o.normalizeElapsed && pauses <= 0 && elapsedMs > timerMs)
    findings.push({ type: 'inflated-elapsed', extraS: (elapsedMs - timerMs) / 1000 });

  return {
    poolM,
    timerMs,
    elapsedMs,
    pauses,
    laps: laps.length,
    lengths: lengths.length,
    swimLaps,
    findings,
  };
}

/** Applies the repair and returns the new file. */
export function repair(u8, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const info = analyze(u8, o);
  const { poolM, timerMs, pauses } = info;
  const { header, frames } = readFit(u8);
  const lengths = frames.filter((f) => f.kind === 'data' && f.globalNum === MSG.length);
  const laps = frames.filter((f) => f.kind === 'data' && f.globalNum === MSG.lap);

  const bounds = laps.map((lap, i) => {
    const s = getField(lap, F.lap.startTime);
    const e =
      i + 1 < laps.length
        ? getField(laps[i + 1], F.lap.startTime)
        : s + Math.trunc(getField(lap, F.lap.elapsed) / 1000) + 1;
    return [s, e];
  });
  const lapLengths = bounds.map(([s, e]) =>
    lengths
      .map((_, k) => k)
      .filter((k) => {
        const t = getField(lengths[k], F.length.startTime);
        return t >= s && t < e;
      }),
  );

  // --- new length list: a lap's active lengths get merged down to the
  //     configured number, and the leftovers dropped
  const newSpecs = new Map(); // old length index -> patch dict
  const newInfo = []; // { durMs, active, strokes }
  const lapNewLens = [];

  lapLengths.forEach((ids) => {
    const mine = [];
    const act = ids.filter((k) => getField(lengths[k], F.length.lengthType) === LENGTH_TYPE.active);
    const groups = mergeToTarget(act, o.lengthsPerLap, (k) =>
      getField(lengths[k], F.length.elapsed),
    );
    // Each group collapses into its first length; the rest are not emitted.
    const byFirst = new Map(groups.map((g) => [g[0], g]));

    for (const k of ids) {
      const isActive = getField(lengths[k], F.length.lengthType) === LENGTH_TYPE.active;
      if (!isActive) {
        const idx = newInfo.length;
        newSpecs.set(k, { [F.length.messageIndex]: idx });
        newInfo.push({ durMs: getField(lengths[k], F.length.elapsed), active: false, strokes: 0 });
        mine.push(idx);
      } else if (byFirst.has(k)) {
        const group = byFirst.get(k);
        const idx = newInfo.length;
        const durMs = group.reduce((a, j) => a + getField(lengths[j], F.length.elapsed), 0);
        const strokes = group.reduce(
          (a, j) => a + (getField(lengths[j], F.length.strokes) ?? 0),
          0,
        );
        const spec = { [F.length.messageIndex]: idx };
        if (group.length > 1) {
          spec[F.length.elapsed] = durMs;
          spec[F.length.timer] = durMs;
          spec[F.length.strokes] = strokes;
          spec[F.length.avgSpeed] = (poolM / (durMs / 1000)) * 1000;
          spec[F.length.cadence] = (strokes * 60) / (durMs / 1000);
        }
        if (o.reclassifyStroke)
          spec[F.length.swimStroke] =
            SWIM_STROKE[strokes >= o.strokeSplit ? 'breaststroke' : 'freestyle'];
        newSpecs.set(k, spec);
        newInfo.push({ durMs, active: true, strokes });
        mine.push(idx);
      }
    }
    lapNewLens.push(mine);
  });

  // --- laps
  const lapPatches = lapNewLens.map((mine) => {
    const act = mine.filter((k) => newInfo[k].active);
    const strokes = act.reduce((a, k) => a + newInfo[k].strokes, 0);
    const swimMs = act.reduce((a, k) => a + newInfo[k].durMs, 0);
    const distCm = Math.trunc(act.length * poolM * 100);
    const p = {
      [F.lap.firstLengthIndex]: mine.length ? mine[0] : 0,
      [F.lap.numLengths]: act.length ? mine.length : 0,
      [F.lap.numActiveLengths]: act.length,
      [F.lap.distance]: distCm,
      [F.lap.cycles]: strokes,
      [F.lap.avgSpeed]: act.length ? (distCm / 100 / (swimMs / 1000)) * 1000 : 0,
      [F.lap.maxSpeed]: act.length
        ? Math.max(...act.map((k) => (poolM / (newInfo[k].durMs / 1000)) * 1000))
        : 0,
      [F.lap.strokeDistance]: strokes ? distCm / strokes : 0,
      [F.lap.avgCadence]: act.length ? (strokes * 60) / (swimMs / 1000) : 0,
    };
    if (act.length && o.reclassifyStroke) {
      const kinds = new Set(
        act.map((k) => (newInfo[k].strokes >= o.strokeSplit ? 'breaststroke' : 'freestyle')),
      );
      p[F.lap.swimStroke] = SWIM_STROKE[kinds.size === 1 ? [...kinds][0] : 'mixed'];
    }
    return p;
  });

  // --- session
  const active = newInfo.filter((n) => n.active);
  const distCm = Math.trunc(active.length * poolM * 100);
  const strokes = active.reduce((a, n) => a + n.strokes, 0);
  const activeMs = active.reduce((a, n) => a + n.durMs, 0);

  /*
   * Every one of these divides by something that can legitimately be zero -- a
   * kick set records no strokes, and a file whose lengths are all idle has no
   * active time at all. patchFrame coerces NaN and +/-Infinity to 0 through
   * DataView, so an unguarded division writes a confident "0 m/s, 0 m per
   * stroke" into the file rather than leaving the field invalid. The lap-level
   * equivalents below were already guarded; the session ones were not.
   */
  const ratio = (numerator, denominator) => (denominator > 0 ? numerator / denominator : 0);
  const sessPatch = {
    [F.session.distance]: distCm,
    [F.session.cycles]: strokes,
    [F.session.avgSpeed]: ratio(distCm / 100, activeMs / 1000) * 1000,
    [F.session.maxSpeed]: active.length
      ? Math.max(...active.map((n) => ratio(poolM, n.durMs / 1000) * 1000))
      : 0,
    [F.session.numLengths]: lapPatches.reduce((a, p) => a + p[F.lap.numLengths], 0),
    [F.session.numActiveLengths]: active.length,
    [F.session.strokeDistance]: ratio(distCm, strokes),
    [F.session.avgCadence]: ratio(strokes * 60, activeMs / 1000),
  };
  if (o.normalizeElapsed && pauses <= 0) sessPatch[F.session.elapsed] = timerMs;

  // --- write
  let li = 0,
    lai = 0;
  const out = [];
  for (const fr of frames) {
    if (fr.kind !== 'data') {
      out.push(fr.bytes);
      continue;
    }
    switch (fr.globalNum) {
      case MSG.length: {
        const spec = newSpecs.get(li++);
        if (spec) out.push(patchFrame(fr, spec));
        break;
      }
      case MSG.lap:
        out.push(patchFrame(fr, lapPatches[lai++]));
        break;
      case MSG.session:
        out.push(patchFrame(fr, sessPatch));
        break;
      case MSG.activity:
        out.push(patchFrame(fr, { [F.activity.timer]: timerMs }));
        break;
      default:
        out.push(fr.bytes);
    }
  }

  return {
    bytes: writeFit(header, out),
    info,
    summary: {
      distanceM: distCm / 100,
      lengths: active.length,
      strokes,
      swimS: activeMs / 1000,
      timerS: timerMs / 1000,
    },
  };
}
