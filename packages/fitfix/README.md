# fitfix

Repairs length and turn detection in Garmin pool swim FIT files. No
dependencies, runs in Node and in the browser.

This is the library behind [phantomturn](../../README.md). It lives here as a
local module so it can be lifted out into its own package later without
untangling anything.

## Two layers

| Module              | Contains                                | Opinionated? |
| ------------------- | --------------------------------------- | ------------ |
| `src/fit-patch.js`  | Parser, field offsets, patching, CRC-16 | No, generic  |
| `src/swim-repair.js`| Phantom turns, stroke, elapsed time     | Yes, calibrated |
| `src/anonymize.js`  | Removes name, biometrics, serials, dates | No, generic |

`fit-patch.js` is useful for any FIT file and has no idea swimming exists. Keep
it that way — it is the half that could stand on its own.

## Why not decode and re-encode

Decoding with a profile library, changing the objects and re-encoding loses
unknown messages and manufacturer fields. Wrist heart rate and Body Battery go
missing, and Garmin Connect rejects the result.

This package decodes only as far as the byte offsets require, then overwrites
individual field values in the raw buffer. Everything else is preserved
verbatim. `test/roundtrip.test.mjs` demonstrates it: reading and writing back
unchanged produces identical bytes.

## API

```js
import { analyze, repair, DEFAULTS } from 'fitfix';
import { readFit, patchFrame, writeFit } from 'fitfix/fit-patch';
import { anonymize, audit } from 'fitfix/anonymize';
```

`analyze(bytes, opts?)` returns findings and per-lap detail without modifying
anything:

```js
{ type: 'phantom-turn',     lap: 6,  detected: 2, assumed: 1, durS: 110.6, strokes: 52 }
{ type: 'stroke-mismatch',  lap: 12, device: 'freestyle', proposed: 'breaststroke', strokes: 60 }
{ type: 'ambiguous-stroke', lap: 16, strokes: 29, durS: 102.6 }
{ type: 'inflated-elapsed', extraS: 569.0 }
{ type: 'lap-structure',    laps: 1, lengthsBefore: 20, lengthsAfter: 1, maxPerLap: 20 }
```

`repair(bytes, opts?)` returns `{ bytes, info, summary }` with the proposals
applied.

`anonymize(bytes)` returns `{ bytes, removed }`, where `removed` is a
plain-language list of what was taken out. `audit(bytes)` returns a list of
identity fields that survived; empty means clean. Both are browser-safe.

**`lap-structure` is the one finding you must not ignore.** It means the file
does not look like one lap button press per length, so merging will delete real
distance rather than phantom turns. `repair()` still does what it is told —
this is a report, not a refusal.

## Options

| Option             | Default | Meaning                                             |
| ------------------ | ------- | --------------------------------------------------- |
| `lengthsPerLap`    | `1`     | Pool lengths one lap button press covers             |
| `strokeSplit`      | `40`    | Strokes per length at or above which breaststroke is assumed |
| `durationSplit`    | `100`   | Seconds per length, used only as a cross-check       |
| `reclassifyStroke` | `true`  | Overwrite the watch's stroke classification          |
| `normalizeElapsed` | `true`  | Set elapsed time to timer time when never paused     |

`lengthsPerLap` only ever merges *downwards*. A lap holding more lengths than
the target is collapsed by `mergeToTarget()`, which picks the most even
grouping — it minimises the sum of the squared group durations, and for a fixed
total that is smallest when the groups are equal. Real lengths in one lap take
roughly the same time, and a phantom turn splits one into two short halves, so
the most balanced partition is the one that puts the halves back together. A
lap holding fewer lengths than the target is left untouched; nothing is ever
split apart.

```js
repair(bytes);                        // 200 m over 4 lengths
repair(bytes, { lengthsPerLap: 8 });  // 450 m over 9 -- nothing merged
```

## Known limits

- Assumes one lap button press per length; lapping per interval loses distance.
- `strokeSplit: 40` depends on stroke length *and* pool length. Halve it for a
  25 m pool. It should be derived from the session's own stroke distribution.
- Freestyle and breaststroke only.
- Multisport files are rejected; the guard is untested for lack of a sample.
- `timestamp` is never written. Fine for Garmin Connect exports, where every
  summary message holds the activity start. A device writing segment ends there
  would need a timestamp update after a merge.
- Tested against a Forerunner 265, 50 m pool, three files.

## Tests

```sh
node --test "test/*.test.mjs"
```

Roundtrip fidelity, golden files against the Python reference, malformed input,
idempotency.
