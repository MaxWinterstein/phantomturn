# AGENTS.md

Notes for anyone — human or agent — working in this repository.

## 🔴 Never commit an unscrubbed activity file

This is the one rule that matters more than the code.

A Garmin `.fit` export carries, in plain bytes:

- the owner's **name** (`user_profile.67`, and `friendly_name` in field 0)
- a **biometric profile** — weight, height, gender, resting heart rate
- the **watch serial number**, in `file_id` *and* in every `device_info` message
- **sensor hardware IDs**
- the **exact date and time** of the session

None of that belongs in a public repository. The fixtures in
`packages/fitfix/test/fixtures/` have all of it removed.

### The guardrails

1. **`.gitignore` ignores `*.[Ff][Ii][Tt]` everywhere**, and re-includes only
   `packages/fitfix/test/fixtures/`. The case folding is not decoration: the
   watch itself writes `GARMIN/ACTIVITY/*.FIT` in uppercase, and a plain
   `*.fit` misses it on every case-sensitive filesystem. macOS hides that
   locally because `core.ignorecase` defaults to true. Do not weaken this rule.
2. **`task fixtures:check`** runs `audit()` plus a text search for known
   personal strings, over every tracked `.fit` — not just the fixtures
   directory. CI runs it on every push, driven off `git ls-files`.
3. **The prek hook** runs the same check on any staged `.fit` before commit.

None of the three is sufficient alone, and none is a substitute for looking at
the file.

### Adding a new fixture

Scrub **outside** the tree first. `packages/fitfix/test/fixtures/` is the one
directory where `.gitignore` will not hide a raw export, so a file copied there
before scrubbing is one `git add .` away from being committed.

```sh
task fixtures:scrub -- ~/Downloads/12345_ACTIVITY.fit   # rewrites in place
mv ~/Downloads/12345_ACTIVITY.fit packages/fitfix/test/fixtures/swim-04.fit
task fixtures:check
```

Rename it. A Garmin export is called `<activityId>_ACTIVITY.fit`, and that id
resolves to a real activity on connect.garmin.com — the filename is personal
data too.

Then put whatever literal strings were in *your* file — your name, the watch
serial, sensor ids — into `tools/needles.local.json`, a gitignored JSON array.
`scrub-fixtures.mjs` uses them as a text cross-check independent of the
structural audit. They live in an untracked file because hardcoding them is
self-defeating: the first version of this list carried the serial number it
existed to protect, in a repository intended to go public.

The logic lives in `packages/fitfix/src/anonymize.js` — browser-safe, imports
nothing but `fit-patch.js` — because the same function powers the "Download
anonymized copy" button on the site. `tools/scrub-fixtures.mjs` is a thin CLI
over it that adds this project's known needle strings.

### What the anonymizer does: keep-list, not scrub-list

It keeps nine message types — `file_id`, `sport`, `session`, `lap`, `event`,
`device_info`, `activity`, `file_creator`, `length` — and **drops every other
data message**, including the whole per-second `record` stream and the heart
rate that rides along with it. Definition messages are always kept, because
local message types are reused and removing a definition would desynchronise
the data messages still referencing it.

On what remains: serial numbers and hardware identifiers are cleared, every
string field is zeroed, and dates are **rebased, not offset** — each file's
earliest timestamp moves to `ANONYMIZED_START` (2010-01-01Z) and everything
else shifts by the same delta. A published constant offset would be trivially
reversible. The delta here is derived from the file's own start and stored
nowhere, yet the transform stays deterministic, which the golden files need,
and idempotent.

**This is deliberately the opposite of how it started.** The first version
named the sensitive things and left everything else alone. An audit of its
output found the real session date in message 162, a BLE device address in
message 147, resting/max/threshold heart rate in message 216, and a sleep-wake
schedule in message 79 — and message 162 held the original `time_created`, so
the "unrecoverable" rebase could be undone by subtraction. `audit()` returned
clean for all of it, because it checked the same four fields the scrubber
wrote.

The lesson generalises: against a format with a dozen undocumented proprietary
messages, a scrub-list can only ever remove what someone thought to name.
**Do not add message types to `KEEP` without reading their actual contents in
a real file first.**

### Why golden files are scrubbed rather than regenerated

`repair()` never writes a timestamp or an identity field, so scrubbing and
repairing commute:

```
scrub(repair(x)) == repair(scrub(x))
```

The golden files were produced by the Python reference implementation, and
scrubbing both sides with the same transform keeps them a genuine
cross-implementation check. Regenerating them with this codebase would turn
`golden.test.mjs` into "JS agrees with JS", which proves nothing. Do not
regenerate the goldens with the JS implementation.

`anonymize.test.mjs` asserts the commutation, so it cannot break silently.

The committed fixtures were regenerated from the raw exports with the
keep-list anonymizer, so the goldens are still Python's output — not this
codebase agreeing with itself.

### Regenerating a golden

The reference runs, and reproduces the committed goldens byte for byte from
the committed (already anonymized) inputs — which is the strongest available
demonstration that anonymizing and repairing really do commute:

```sh
pkgx +python.org -- python3 -m pip install --target=/tmp/pylibs fitdecode
PYTHONPATH=/tmp/pylibs pkgx +python.org -- python3 \
  reference/repair_swim_fit.py \
  packages/fitfix/test/fixtures/swim-04.fit \
  packages/fitfix/test/fixtures/swim-04_fixed.fit
```

**The reference hardcodes its assumptions, and the JS has since moved past
several of them.** `AS_REFERENCE` in `fixtures.mjs` pins them all back:
`lengthsPerLap: 1` (it merges every active length in a lap, full stop),
`strokeSplit: 40` and `durationSplit: 100` (per-length constants fitted at
50 m, where the JS's scaled defaults happen to land on exactly the same
numbers — which is why swim-05, an 18 m pool, was the first fixture to notice).

Every time the JS learns to do something the reference cannot, that constant
has to be added to `AS_REFERENCE`, or the comparison quietly becomes a
comparison of two different questions. Never "fix" a golden by regenerating it
with this codebase; that turns the whole suite into JS agreeing with JS.

On swim-04 the two implementations genuinely disagree — 550 m against auto's
1100 m — and `golden.test.mjs` asserts the disagreement so that it cannot
quietly vanish.

## The fixtures, and what each one is for

Every one is a different shape of the same problem. Adding a file that
duplicates an existing shape buys nothing; adding one that breaks a new
assumption is worth a lot.

| fixture | pool | what makes it useful | confirmed truth |
| ------- | ---- | -------------------- | --------------- |
| swim-01 | 50 m | every length split, so no intact one exists to learn a unit from; also micro laps from double-tapping | 4 lengths / 200 m |
| swim-02 | 50 m | occasional splits among clean lengths, mixed freestyle and breaststroke | 18 / 900 m |
| swim-03 | 50 m | the same, fewer splits | 20 / 1000 m |
| swim-04 | 50 m | **mixed lapping** — eight laps of one length, then blocks of 11 and 7. No single `lengthsPerLap` describes it | 22 / 1100 m |
| swim-05 | **18 m**, recorded as 20 m | short pool, **wrong pool size**, and the file that breaks the unit estimator | **still open — see below** |

### Open question: how long was swim-05?

`auto` reports 47 lengths. Total active time ÷ median length and total strokes
÷ median strokes both independently say **~64**, and the watch recorded 64.

The `max()` in `estimateLengthUnit()` is justified on the grounds that both
estimators err small. That holds for swim-01 to swim-04 and is **false in
general**: here the lap-total estimator errs large, because 64 lengths across 22
laps makes the median lap total one-and-a-half lengths. Using the smaller
estimator fixes swim-05 and breaks swim-01. Each rule is 4-for-5, failing on a
different file.

**Do not retune this against a guess.** The swimmer has not confirmed swim-05's
count, and fitting a third rule to five points is how two confidently wrong
answers already got shipped in this project. Until it is confirmed, the
disagreement is reported as an `uncertain-lengths` finding with both readings,
and swim-05 is deliberately absent from the `TRUTH` table in
`auto-lengths.test.mjs`.

## Before this repository goes public

It is private today, and a few things are deliberately parked until it is not:

1. **Turn on the Pages deploy.** Uncomment the `workflow_run` trigger in
   `.github/workflows/pages.yml` and set Settings → Pages → Source to
   "GitHub Actions". Pages needs a public repo on free plans.
2. **Check `tools/needles.local.json` is still untracked.** It holds a name, a
   watch serial and sensor ids.

`web/legal.html` carries a name and an email and no postal address — a
deliberate call for a private, non-commercial page that collects nothing. If
the project ever takes money or ships advertising, that changes.

## Layout

```
packages/fitfix/     the library -- extractable to its own npm package one day
  src/fit-patch.js     generic FIT byte patcher, no opinions
  src/swim-repair.js   the calibrated swim heuristics
  src/anonymize.js     strips name, biometrics, serials, dates
  src/cli.mjs          Node CLI
  test/                node:test suites + scrubbed fixtures
web/                 the static site, no build step
tools/               scrub, build, serve -- all zero-dependency
reference/           the Python implementation the golden files came from
```

`fit-patch.js` is deliberately free of swimming logic. Keep it that way — it is
the part that could be published on its own.

## Commands

```sh
task setup     # npm install
task test      # node:test suites
task check     # what CI runs: lint + tests + fixture privacy check
task web       # build and serve at http://localhost:8080
task fix -- swim.fit
```

`http://localhost:8080/?demo=1` loads the sample file straight away — useful
for screenshots and for checking a deploy.

## Conventions

- **English only.** Code, comments, docs, commit messages, UI copy. The project
  started out in German and was converted; do not reintroduce it.
- **No runtime dependencies in `packages/fitfix`.** Ever. Biome is a dev
  dependency of the root workspace only.
- **No decode/encode roundtrip.** The whole point is patching bytes in place so
  unknown messages and manufacturer fields survive. `roundtrip.test.mjs` guards
  this; if it fails, stop and fix it rather than adjusting the test.
- **`roundHalfEven()` exists for a reason.** Python rounds half-to-even and
  `Math.round` rounds half-up. Removing it breaks byte-equality with the
  reference implementation.

## Known traps

- **`lengthsPerLap` defaults to `'auto'` and is resolved per lap.**
  `resolveLapTargets()` produces one target per lap; `analyze()` returns them
  as `lapTargets` and `repair()` uses those rather than recomputing. A fixed
  number still overrides. Merging is downwards only — a lap with fewer lengths
  than its target is untouched and nothing is ever split, so a *missed* turn is
  out of reach either way.
- **The unit estimate is `max()` of two estimators on purpose.** Both fail
  small, in opposite directions: the recorded-length estimator is useless when
  every length was split (swim-01 has no intact length anywhere), and the
  lap-total estimator is dragged down by long continuous blocks. Do not
  "simplify" it to one of them — `auto-lengths.test.mjs` pins the swimmer's
  confirmed count for each fixture.
- **The `lap-structure` finding is the guard against a wrong target.** It fires when more
  than half the laps hold multiple lengths, or any lap holds four or more —
  which means the swimmer did not lap once per length and the merge will delete
  real distance. It reports rather than refuses, because the data alone cannot
  distinguish "many phantom turns" from "a different lapping habit". Fixture 1
  trips it legitimately. Keep it loud in every front end.
- **Second vs millisecond resolution.** `length.start_time` is in whole
  seconds, `lap.total_elapsed_time` in milliseconds. Lap boundaries are derived
  from the *next* lap's `start_time` to stay in whole seconds throughout. A
  time-window comparison assigns lengths to the wrong lap — this was a real bug.
- **Timestamps are never written by the repair.** Garmin Connect exports put
  the activity start in every summary message, so this works. A device that
  writes segment ends there would need a timestamp update after a merge.
