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

**`lap-structure` is the one finding you must not ignore.** It fires only when
`lengthsPerLap` is a fixed number, and means the file does not look like that
number — so merging will delete real distance rather than phantom turns.
`repair()` still does what it is told; this is a report, not a refusal. With
`'auto'` it never fires, because there is no setting to be wrong about.

## Options

| Option             | Default | Meaning                                             |
| ------------------ | ------- | --------------------------------------------------- |
| `lengthsPerLap`    | `'auto'`| Pool lengths one lap button press covers, or `'auto'` to infer it per lap |
| `strokeSplit`      | `40`    | Strokes per length at or above which breaststroke is assumed |
| `durationSplit`    | `100`   | Seconds per length, used only as a cross-check       |
| `reclassifyStroke` | `true`  | Overwrite the watch's stroke classification          |
| `normalizeElapsed` | `true`  | Set elapsed time to timer time when never paused     |

### `lengthsPerLap: 'auto'`

The default. Each lap is measured against how long one length takes *in this
swim*, so a session lapped inconsistently still comes out right:

```
lap  0-15  one recorded length each   ->  1 each
lap  16    eleven recorded lengths    ->  9
lap  18    seven recorded lengths     ->  4
```

The unit is the larger of two estimates, because they fail in opposite
directions and both fail *small*:

- **the median of the longer half of the recorded lengths.** A phantom-turn
  fragment is always shorter than the length it came from, so throwing away the
  short half throws away the fragments. Useless when *every* length was split —
  there is then no intact length in the file to learn from.
- **the median lap total.** Right whenever the swimmer lapped once per length,
  including that all-split case. Reads low when some laps hold a long
  continuous block.

Taking the larger also absorbs mixed strokes: a ~140 s breaststroke length
against a 96–132 s unit still rounds to one.

A number forces it instead. Either way it only ever merges *downwards* — a lap
holding fewer lengths than the target is untouched, and nothing is ever split
apart, so a *missed* turn is beyond this either way.

```js
repair(bytes);                        // 200 m over 4 lengths, inferred
repair(bytes, { lengthsPerLap: 8 });  // 450 m over 9 -- nothing merged
```

The grouping within a lap comes from `mergeToTarget()`, which picks the most
even partition — it minimises the sum of the squared group durations, smallest
when the groups are equal. Real lengths in one lap take roughly the same time,
and a phantom turn splits one into two short halves, so the balanced partition
is the one that puts the halves back together.

## Known limits

- `lengthsPerLap: 'auto'` is a heuristic, tuned on four files. It is checked
  against the swimmer's confirmed counts, but it is still inference — read the
  before/after numbers, and pass a number when you disagree.
- **Merges only, never splits.** A turn the watch *invented* can be undone; one
  it *missed* — two real lengths recorded as one — cannot.
- `strokeSplit: 40` depends on stroke length *and* pool length. Halve it for a
  25 m pool. It should be derived from the session's own stroke distribution.
- Freestyle and breaststroke only. A backstroke length is reclassified as one of
  those two rather than recognised.
- Multisport files are rejected; the guard is untested for lack of a sample.
- `timestamp` is never written. Fine for Garmin Connect exports, where every
  summary message holds the activity start. A device writing segment ends there
  would need a timestamp update after a merge.
- Tested against a Forerunner 265, 50 m pool, four sessions from one swimmer.

## Tests

```sh
node --test "test/*.test.mjs"
```

Roundtrip fidelity, golden files against the Python reference, malformed input,
idempotency.
