# 🌊 phantomturn

Fixes phantom turn detection and stroke misclassification in Garmin pool swim
FIT files. Runs entirely in your browser — the file never leaves the page.

> [!IMPORTANT]
> ### 🧪 A living experiment, and 100% vibe coded
>
> **I have not read a single line of this code.** Not one. All of it was written by
> an AI while I described what I wanted and pushed back on the answers. I could
> probably follow it — given enough coffee and sleep — but I haven't, and that is
> rather the point. This repo is a proof of concept for how far you actually get
> building something real this way.
>
> It is also **not finished**. I keep swimming, so I keep feeding it new FIT files,
> and every one so far has taught it something. The heuristics are calibrated on a
> handful of sessions from one watch in one pool, and they will keep moving.
>
> What stands in for a human reading the code: an automated test suite, output
> compared byte for byte against an independent Python implementation, and CI on
> every push. That is not the same thing as review. **Keep your original file.**

## The problem

Swim slowly enough and a Forerunner will detect a turn in the middle of a
length. The length gets split in two, and you are credited with distance you
never swam. The same laps usually come back with the wrong stroke, because the
watch switches stroke at the turn it imagined. Two symptoms, one cause.

Three real sessions, all Forerunner 265 in a 50 m pool:

| Watch said        | Actually swum   | Phantom turns |
| ----------------- | --------------- | ------------- |
| 450 m / 9 lengths | 200 m / 4       | 4             |
| 1100 m / 22       | 900 m / 18      | 4             |
| 1100 m / 22       | 1000 m / 20     | 2             |

## Use it

**Browser:** open the page, drop in a `.fit` file, download the fixed one.
Nothing is uploaded anywhere.

The same page will also hand you an **anonymized copy** of whatever you drop
in. It keeps only the messages a swim analysis actually reads and drops
everything else — the per-second heart-rate stream, your user profile, sensor
identifiers, device settings and every undocumented Garmin message — then
clears serial numbers, zeroes every text field, and rebases the dates so the
real one cannot be worked back out. Durations, distances, stroke counts and
relative timing are exact, so the file still reproduces whatever went wrong.

It works even when the repair itself fails, which is usually the file worth
sharing. Files come out roughly a fifth of their original size, most of that
being the heart-rate stream going away.

**CLI:**

```sh
node packages/fitfix/src/cli.mjs swim.fit --dry-run           # report only
node packages/fitfix/src/cli.mjs swim.fit fixed.fit
node packages/fitfix/src/cli.mjs swim.fit --lengths-per-lap=4 # you lap per 200 m
node packages/fitfix/src/cli.mjs swim.fit --stroke-split=20   # 25 m pool
node packages/fitfix/src/cli.mjs --help                       # every assumption
```

Every assumption is a flag, and every flag has a browser equivalent under
**Assumptions** on the page. The defaults were calibrated on one swimmer, one
watch and one pool; if your numbers come out wrong, that is the first place to
look.

**Library:**

```js
import { analyze, repair } from 'fitfix';

const bytes = new Uint8Array(await file.arrayBuffer());

const { findings } = analyze(bytes); // reports, changes nothing
// [{ type: 'phantom-turn', lap: 6, detected: 2, assumed: 1, durS: 110.6, strokes: 52 }, ...]

const { bytes: fixed, summary } = repair(bytes);
```

`analyze()` is the honest half — it describes what looks wrong without deciding
anything. `repair()` applies its proposals without asking, which is fine for a
CLI and is why the browser front end shows you the findings first.

## Why it patches bytes instead of decoding

The obvious approach — decode with a profile library, change the objects,
re-encode — loses unknown messages and manufacturer fields. In practice things
like wrist heart rate and Body Battery go missing and Garmin Connect refuses
the import.

This project decodes only far enough to learn each field's byte offset, then
overwrites individual values in the raw buffer. Everything untouched survives
byte for byte. `roundtrip.test.mjs` proves it: read a file, write it back
unchanged, get identical bytes.

## Layout

| Path                          | What                                            |
| ----------------------------- | ----------------------------------------------- |
| `packages/fitfix/fit-patch.js`  | Generic FIT parser, patcher and CRC. No opinions. |
| `packages/fitfix/swim-repair.js` | Phantom turns, stroke, elapsed time. Calibrated. |
| `packages/fitfix/anonymize.js`  | Strips name, biometrics, serials and dates.       |
| `web/`                        | The static site. No build step, no bundler.       |
| `tools/`                      | Scrub, build and serve. All dependency-free.      |

`fitfix` is a local module rather than a published package for now, but it is
kept self-contained so it can move out to its own repository later.

## Development

```sh
task setup    # npm install (Biome is the only dev dependency)
task test     # node:test suites, including byte-exact golden files
task check    # everything CI runs
task web      # build and serve at http://localhost:8080
```

Read [AGENTS.md](AGENTS.md) before adding a test fixture — activity files carry
your name, your biometrics and your watch's serial number, and there is a
scrubbing step that is not optional.

## Known limits

- Defaults to **one lap button press per pool length**. If you lap per interval
  — or not at all, letting auto-pause and rest detection do the work — the
  default merges real lengths and loses distance. Raise `lengthsPerLap` (or the
  "Lengths per lap button press" setting) to match how you actually swim. Both
  front ends state the assumption on every result and raise a `lap-structure`
  warning when the file does not look like the configured habit, but the tool
  cannot decide for you: check the before/after numbers.
- The freestyle/breaststroke split is **40 strokes per length**, calibrated in a
  50 m pool. A 25 m pool would need roughly half that. It should be derived from
  the session instead of hard-coded.
- Freestyle and breaststroke only. No backstroke, butterfly, IM or drill.
- Multisport files are rejected. The guard is implemented but untested.
- Tested against a Forerunner 265, 50 m pool, three files.

## Licence

MIT. The FIT protocol itself belongs to Garmin and is covered by the Flexible
and Interoperable Data Transfer (FIT) Protocol License. This project vendors no
Garmin SDK. Not affiliated with or endorsed by Garmin.
