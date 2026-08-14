/**
 * swim-repair.js -- pool swim repair built on top of fit-patch.js.
 *
 * This layer is deliberately separate from fit-patch.js: the patcher is
 * generic and uncontroversial, the heuristics here are not.
 *
 * WARNING -- the defaults are calibrated on a single swimmer:
 *   * lengthsPerLap: 'auto' -- each lap is measured against the session's own
 *     length unit. A fixed number assumes one lapping habit for the whole
 *     swim, which silently deletes distance from anyone who lapped per length
 *     at first and then swam a continuous block. analyze() still returns
 *     proposals rather than applying them; the decision belongs in the UI.
 *   * strokeSplit: strokes per length above which breaststroke is assumed
 *     instead of freestyle. Depends on stroke length AND pool length.
 */
import { getField, patchFrame, readFit, writeFit } from './fit-patch.js';

const MSG = {
  record: 20,
  session: 18,
  lap: 19,
  length: 101,
  activity: 34,
  event: 21,
};

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
/**
 * stop, stop_all, stop_disable, stop_disable_all.
 *
 * The Python reference counts only the first two. A device that ends a session
 * with stop_disable_all would then leave a genuine mid-swim pause counted as
 * the closing stop, so `pauses` came out 0 and the real pause was erased from
 * total_elapsed_time. No fixture contains 8 or 9, so this is not a divergence
 * in practice -- but the narrow set was wrong in principle.
 */
const STOP_TYPES = new Set([1, 4, 8, 9]);

/**
 * Every assumption this layer makes, in one place. All are overridable per
 * call; the values are what one swimmer's Forerunner 265 needed in a 50 m pool.
 */
export const DEFAULTS = {
  /**
   * Lengths one press of the lap button covers, or `'auto'` to work it out per
   * lap from the file itself. A fixed number assumes you lapped the same way
   * for the whole swim; `'auto'` does not, which matters if you pressed the
   * button for the first few lengths and then swam a continuous block.
   */
  lengthsPerLap: 'auto',
  /**
   * Strokes per length at or above which breaststroke is assumed.
   *
   * 'auto' derives it from the pool: STROKES_PER_100M scaled to one length, so
   * the same setting works in a 50 m and an 18 m pool. A fixed number is a
   * per-length count and only means anything for one pool size -- 40 was
   * calibrated at 50 m, and in an 18 m pool nothing ever reaches it, so every
   * length read as freestyle including the breaststroke ones.
   */
  strokeSplit: 'auto',
  /** Seconds per length used to cross-check strokeSplit. When the two
   *  disagree the lap is reported as ambiguous and the watch's label kept.
   *  'auto' scales with the pool, same as strokeSplit. */
  durationSplit: 'auto',
  /**
   * Metres per length. `null` trusts the pool_length the watch recorded.
   *
   * Set it when the watch is wrong -- a mis-set pool size makes every distance
   * in the file wrong by a fixed ratio, and nothing in the data reveals it.
   * Overriding also rewrites session.pool_length in the output, so whatever
   * reads the file next recomputes from the right number.
   */
  poolLength: null,
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

/*
 * Calibration expressed per 100 m rather than per length, so that pool size
 * cancels out. Both figures reproduce the old per-50 m constants exactly --
 * 80 * 50/100 = 40 strokes, 200 * 50/100 = 100 s -- so nothing changes for the
 * pool they were fitted in, and an 18 m pool gets 14.4 strokes and 36 s
 * instead of thresholds it could never reach.
 */
const STROKES_PER_100M = 80;
const SECONDS_PER_100M = 200;

/** Resolves a threshold that may be 'auto', scaling it to one length. */
const perLength = (setting, poolM, per100) =>
  Number.isFinite(setting) ? setting : (per100 * poolM) / 100;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Coefficient of variation -- spread relative to size, so scales compare. */
function coefficientOfVariation(xs) {
  if (xs.length < 2) return Number.POSITIVE_INFINITY;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (!mean) return Number.POSITIVE_INFINITY;
  const variance = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance) / mean;
}

/**
 * How long one real pool length takes this swimmer, in seconds.
 *
 * There are two things it could be measured from, and the question is which of
 * them is the repeating unit:
 *
 *   - the recorded lengths, taking the median of the LONGER half, since a
 *     phantom-turn fragment is always shorter than the length it came from;
 *   - the lap totals, which are exactly one length each whenever the swimmer
 *     pressed the button per length.
 *
 * Whichever set is more UNIFORM is the one made of single lengths. That is the
 * whole rule, and it needs no threshold: if he lapped per length, the lap
 * totals cluster and the fragments inside them scatter; if he swam continuous
 * blocks, the lengths cluster and the lap totals scatter wildly.
 *
 * This replaced `Math.max()` of the two, justified as "both estimators err
 * small". That held for four files and then failed on two consecutive short-
 * pool sessions, where most laps held several lengths and so the median lap
 * total came out at one-and-a-half lengths -- erring large, and merging away a
 * third of the swim. Uniformity picks the right set on all six.
 */
function estimateLengthUnit(lapGroups, durationOf) {
  const all = lapGroups.flat();
  if (!all.length) return { unit: 0, candidates: {} };

  const durations = all.map(durationOf).sort((a, b) => a - b);
  const fromLengths = median(durations.slice(Math.floor(durations.length / 2)));
  const lapTotals = lapGroups
    .filter((g) => g.length)
    .map((g) => g.reduce((a, k) => a + durationOf(k), 0));
  const fromLapTotals = median(lapTotals);

  const lapsAreUniform = coefficientOfVariation(lapTotals) < coefficientOfVariation(durations);
  return {
    unit: lapsAreUniform ? fromLapTotals : fromLengths,
    candidates: { fromLengths, fromLapTotals, lapsAreUniform },
  };
}

/** Total lengths a given unit implies across every lap. */
function impliedTotal(lapGroups, durationOf, unit) {
  if (!unit) return 0;
  return lapGroups.reduce((a, g) => {
    if (!g.length) return a;
    const total = g.reduce((x, k) => x + durationOf(k), 0);
    return a + Math.min(g.length, Math.max(1, Math.round(total / unit)));
  }, 0);
}

/**
 * How many real lengths each lap holds.
 *
 * With a numeric `lengthsPerLap` every lap gets the same answer. With 'auto'
 * each lap is measured against the session's own length unit, so a swim that
 * was lapped per length at the start and then swum as one continuous block
 * comes out right in both halves -- which a single number cannot do.
 *
 * Never exceeds the number of lengths actually recorded: this merges, it never
 * splits, so a missed turn is beyond it either way.
 */
function resolveLapTargets(lapGroups, durationOf, lengthsPerLap) {
  if (lengthsPerLap !== 'auto') {
    const n = Number.isFinite(lengthsPerLap) ? Math.max(1, Math.floor(lengthsPerLap)) : 1;
    return { targets: lapGroups.map(() => n), unit: null, alternative: null };
  }

  const { unit, candidates } = estimateLengthUnit(lapGroups, durationOf);
  if (!unit) return { targets: lapGroups.map(() => 1), unit: null, alternative: null };

  const targets = lapGroups.map((group) => {
    if (!group.length) return 1;
    const total = group.reduce((a, k) => a + durationOf(k), 0);
    return Math.min(group.length, Math.max(1, Math.round(total / unit)));
  });

  /*
   * The two estimators can imply materially different swims, and which one is
   * right is not decidable from the file. The smaller unit was correct on a
   * session lapped inconsistently in a short pool; the larger was correct on a
   * session where every single length had been split and no intact one
   * remained. Rather than pick silently, report the disagreement.
   */
  const other = candidates.lapsAreUniform ? candidates.fromLengths : candidates.fromLapTotals;
  const chosen = impliedTotal(lapGroups, durationOf, unit);
  const alternate = impliedTotal(lapGroups, durationOf, other);
  const alternative =
    other > 0 && Math.abs(alternate - chosen) > Math.max(1, chosen * 0.1)
      ? { unitS: other, lengths: alternate, chosenUnitS: unit, chosenLengths: chosen }
      : null;

  return { targets, unit, alternative };
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

  const recordedPoolM = getField(session, F.session.poolLength) / 100;
  if (!recordedPoolM) throw new Error('no pool_length -- not a pool swim file?');

  /*
   * A wrongly configured pool size is invisible in the data -- every duration
   * and stroke count is self-consistent, only the metres are wrong, by a fixed
   * ratio. So it can only come from the swimmer, and when it does it has to
   * feed the thresholds below as well as the distances.
   */
  const poolM = Number.isFinite(o.poolLength) && o.poolLength > 0 ? o.poolLength : recordedPoolM;
  const strokeSplit = perLength(o.strokeSplit, poolM, STROKES_PER_100M);
  const durationSplit = perLength(o.durationSplit, poolM, SECONDS_PER_100M);

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

  const durationOf = (k) => getField(lengths[k], F.length.elapsed) / 1000;
  const lapActive = lapLengths.map((ids) =>
    ids.filter((k) => getField(lengths[k], F.length.lengthType) === LENGTH_TYPE.active),
  );
  const {
    targets: lapTargets,
    unit,
    alternative,
  } = resolveLapTargets(lapActive, durationOf, o.lengthsPerLap);

  const findings = [];
  const swimLaps = [];
  lapActive.forEach((act, li) => {
    const target = lapTargets[li];
    if (!act.length) return;
    const durMs = act.reduce((a, k) => a + getField(lengths[k], F.length.elapsed), 0);
    const strokes = act.reduce((a, k) => a + (getField(lengths[k], F.length.strokes) ?? 0), 0);
    const stroke = strokes >= strokeSplit ? 'breaststroke' : 'freestyle';
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

    if (act.length > target)
      findings.push({
        type: 'phantom-turn',
        lap: li,
        detected: act.length,
        assumed: target,
        durS: durMs / 1000,
        strokes,
        note: `lap split into ${act.length} lengths`,
      });

    /*
     * Classify per merged group, exactly as repair() does.
     *
     * These used to be computed on the lap total while repair() worked group
     * by group, so with lengthsPerLap: 2 a lap of 23 + 38 strokes was reported
     * as "breaststroke, 61 strokes" and then written as freestyle for both
     * lengths. Reporting one thing and doing another is worse than either.
     */
    for (const group of mergeToTarget(act, target, (k) => getField(lengths[k], F.length.elapsed))) {
      const gDurMs = group.reduce((a, k) => a + getField(lengths[k], F.length.elapsed), 0);
      const gStrokes = group.reduce((a, k) => a + (getField(lengths[k], F.length.strokes) ?? 0), 0);
      const byStrokes = gStrokes >= strokeSplit;
      const byTime = gDurMs / 1000 >= durationSplit;
      const gStroke = byStrokes ? 'breaststroke' : 'freestyle';
      const gDevice = Object.keys(SWIM_STROKE).find(
        (k) => SWIM_STROKE[k] === getField(lengths[group[0]], F.length.swimStroke),
      );

      if (byStrokes !== byTime)
        findings.push({
          type: 'ambiguous-stroke',
          lap: li,
          strokes: gStrokes,
          durS: gDurMs / 1000,
          note: 'stroke count and length duration disagree',
        });
      else if (o.reclassifyStroke && gDevice && gStroke !== gDevice)
        findings.push({
          type: 'stroke-mismatch',
          lap: li,
          device: gDevice,
          proposed: gStroke,
          strokes: gStrokes,
          durS: gDurMs / 1000,
        });
    }
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
    const lengthsAfter = swimLaps.reduce((a, l) => a + Math.min(l.lengths, lapTargets[l.lap]), 0);
    const split = swimLaps.filter((l) => l.lengths > lapTargets[l.lap]);
    const maxPerLap = Math.max(...swimLaps.map((l) => l.lengths));
    const worstOverrun = Math.max(...swimLaps.map((l) => l.lengths / lapTargets[l.lap]));

    /*
     * Only a fixed target can be wrong about the swimmer's habit; 'auto'
     * measures each lap against the session's own length unit, so a lap
     * holding eleven lengths is a finding about that lap rather than evidence
     * the setting is wrong. Both tests are relative to the target -- an
     * absolute `maxPerLap >= 4` used to fire on files where nothing would be
     * merged at all.
     */
    const fixed = o.lengthsPerLap !== 'auto';
    if (fixed && split.length && (split.length / swimLaps.length > 0.5 || worstOverrun >= 4)) {
      const n = lapTargets[0];
      const word = (x) => (x === 1 ? 'length' : 'lengths');
      findings.push({
        type: 'lap-structure',
        laps: swimLaps.length,
        lengthsBefore,
        lengthsAfter,
        maxPerLap,
        note:
          `${split.length} of ${swimLaps.length} laps hold more than ${n} ${word(n)}. ` +
          `If a lap button press does not really cover ${n} ${word(n)} for you, merging ` +
          'will delete real distance — try lengths per lap set to auto.',
      });
    }
  }

  /*
   * Two readings of the same file, and the data does not settle which is
   * right. Loud, because the difference is real distance either way -- and
   * because a heuristic that quietly picks one is how this tool previously
   * deleted a third of a swim.
   */
  if (alternative) {
    findings.push({
      type: 'uncertain-lengths',
      chosenLengths: alternative.chosenLengths,
      chosenUnitS: alternative.chosenUnitS,
      alternateLengths: alternative.lengths,
      alternateUnitS: alternative.unitS,
      note:
        `One length could be ${alternative.chosenUnitS.toFixed(0)}s, giving ` +
        `${alternative.chosenLengths} lengths, or ${alternative.unitS.toFixed(0)}s, giving ` +
        `${alternative.lengths}. The file does not settle it — check which matches the swim ` +
        'you remember, and set lengths per lap yourself if neither does.',
    });
  }

  const elapsedMs = getField(session, F.session.elapsed);
  if (o.normalizeElapsed && pauses <= 0 && elapsedMs > timerMs)
    findings.push({
      type: 'inflated-elapsed',
      extraS: (elapsedMs - timerMs) / 1000,
    });

  return {
    poolM,
    /** What the watch recorded, so a caller can see it was overridden. */
    recordedPoolM,
    // Resolved once here and handed on, so repair() cannot scale them
    // differently from the analysis that reported on them.
    strokeSplit,
    durationSplit,
    timerMs,
    elapsedMs,
    pauses,
    laps: laps.length,
    lengths: lengths.length,
    swimLaps,
    findings,
    // Handed to repair() rather than recomputed there. The two copies of this
    // assignment drifting apart is exactly how analyze() ended up classifying
    // stroke on the lap total while repair() worked group by group.
    lapLengths,
    lapTargets,
    /** Seconds one real length takes, when it was inferred rather than given. */
    lengthUnitS: unit,
  };
}

/** Applies the repair and returns the new file. */
export function repair(u8, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const info = analyze(u8, o);
  const { poolM, recordedPoolM, strokeSplit, timerMs, pauses, lapLengths } = info;
  const { header, frames } = readFit(u8);
  const lengths = frames.filter((f) => f.kind === 'data' && f.globalNum === MSG.length);

  // lapLengths comes from analyze() rather than being recomputed. The frames
  // are re-read here, but the filter order is identical, so the indices line
  // up -- and analyze() has already refused anything where they would not.

  // --- new length list: a lap's active lengths get merged down to the
  //     configured number, and the leftovers dropped
  const newSpecs = new Map(); // old length index -> patch dict
  const newInfo = []; // { durMs, active, strokes }
  const lapNewLens = [];

  lapLengths.forEach((ids, li) => {
    const mine = [];
    const act = ids.filter((k) => getField(lengths[k], F.length.lengthType) === LENGTH_TYPE.active);
    const groups = mergeToTarget(act, info.lapTargets[li], (k) =>
      getField(lengths[k], F.length.elapsed),
    );
    // Each group collapses into its first length; the rest are not emitted.
    const byFirst = new Map(groups.map((g) => [g[0], g]));

    for (const k of ids) {
      const isActive = getField(lengths[k], F.length.lengthType) === LENGTH_TYPE.active;
      if (!isActive) {
        const idx = newInfo.length;
        newSpecs.set(k, { [F.length.messageIndex]: idx });
        newInfo.push({
          durMs: getField(lengths[k], F.length.elapsed),
          active: false,
          strokes: 0,
        });
        mine.push(idx);
      } else if (byFirst.has(k)) {
        const group = byFirst.get(k);
        const idx = newInfo.length;
        const durMs = group.reduce((a, j) => a + getField(lengths[j], F.length.elapsed), 0);
        const strokes = group.reduce(
          (a, j) => a + (getField(lengths[j], F.length.strokes) ?? 0),
          0,
        );
        /*
         * Written for every surviving length, not only merged ones.
         *
         * The Python reference writes them unconditionally, and skipping the
         * single-length case is invisible on these fixtures purely because the
         * watch's own stored values already equal the recomputation. It stops
         * being invisible the moment one does not: a length whose
         * total_strokes is invalid keeps that invalid marker while the lap
         * counts it as zero strokes, leaving the file self-contradictory.
         */
        const durS = durMs / 1000;
        const spec = {
          [F.length.messageIndex]: idx,
          [F.length.elapsed]: durMs,
          [F.length.timer]: durMs,
          [F.length.strokes]: strokes,
          [F.length.avgSpeed]: durS > 0 ? (poolM / durS) * 1000 : 0,
          [F.length.cadence]: durS > 0 ? (strokes * 60) / durS : 0,
        };
        if (o.reclassifyStroke)
          spec[F.length.swimStroke] =
            SWIM_STROKE[strokes >= strokeSplit ? 'breaststroke' : 'freestyle'];
        newSpecs.set(k, spec);
        newInfo.push({ durMs, active: true, strokes });
        mine.push(idx);
      }
    }
    lapNewLens.push(mine);
  });

  /*
   * Every one of these divides by something that can legitimately be zero -- a
   * kick set records no strokes, and a file whose lengths are all idle has no
   * active time at all. patchFrame coerces NaN and +/-Infinity to 0 through
   * DataView, so an unguarded division writes a confident "0 m/s, 0 m per
   * stroke" into the file rather than leaving the field invalid. Both the lap
   * and the session figures below go through it.
   */
  const ratio = (numerator, denominator) => (denominator > 0 ? numerator / denominator : 0);

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
      [F.lap.avgSpeed]: ratio(distCm / 100, swimMs / 1000) * 1000,
      [F.lap.maxSpeed]: act.length
        ? Math.max(...act.map((k) => ratio(poolM, newInfo[k].durMs / 1000) * 1000))
        : 0,
      [F.lap.strokeDistance]: ratio(distCm, strokes),
      [F.lap.avgCadence]: ratio(strokes * 60, swimMs / 1000),
    };
    if (act.length && o.reclassifyStroke) {
      const kinds = new Set(
        act.map((k) => (newInfo[k].strokes >= strokeSplit ? 'breaststroke' : 'freestyle')),
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

  /*
   * Write the corrected pool size back. Every distance above is already
   * computed from it, but leaving the field saying 20 m when the pool was 18
   * would let anything that recomputes -- Garmin Connect included -- undo the
   * correction and disagree with the totals in the same file.
   */
  if (poolM !== recordedPoolM) sessPatch[F.session.poolLength] = poolM * 100;
  // Same condition analyze() reports on. It used to write whenever the timer
  // was never paused, while analyze() only reported when there was actually
  // something to trim -- a no-op for Garmin files, where elapsed >= timer
  // always, but two conditions for one decision invites them to drift apart.
  if (o.normalizeElapsed && pauses <= 0 && info.elapsedMs > timerMs) {
    sessPatch[F.session.elapsed] = timerMs;
  }

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
