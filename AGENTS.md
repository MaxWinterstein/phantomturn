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

- **`lengthsPerLap` is honoured by `repair()`, but only downwards.** A lap with
  more lengths than the target is merged down via `mergeToTarget()`, which
  picks the most even grouping. A lap with *fewer* is left
  alone — nothing is ever split. It used to be reporting-only while `repair()`
  always merged to one regardless; do not let it regress to that.
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
