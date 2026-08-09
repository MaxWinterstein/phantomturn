#!/usr/bin/env python3
"""
repair_swim_fit.py -- repair Garmin pool swim FIT files (FR265).

This is the reference implementation. The golden files in
packages/fitfix/test/fixtures/*_fixed.fit came from this script, and
test/golden.test.mjs compares the JavaScript output against them byte for byte.
It is kept in the repository so the golden files stay reproducible -- without
it they are just opaque blobs nobody can regenerate.

It is not part of the npm package and is not run by CI.

NOTE ON SCOPE: this merges every active length in a lap into one, full stop.
That is equivalent to the JavaScript's `lengthsPerLap: 1`, and it is why
golden.test.mjs runs the JS in that mode rather than on its default. The
JavaScript has since grown `lengthsPerLap: 'auto'`, which resolves each lap
separately; on a file with mixed lapping the two therefore disagree, and that
disagreement is asserted rather than papered over.

Fixes three recurring faults:

 1. PHANTOM TURNS
    The watch detects a turn in the middle of a length and splits it in two,
    inflating the distance. Assumes one manual lap equals one length; all
    active lengths inside a swim lap are merged into one.

 2. STROKE MISCLASSIFICATION
    The classifier confuses breaststroke and freestyle, most often in exactly
    the laps that also have a phantom turn. Reassigned from the stroke count
    per length -- the distribution is bimodal and non-overlapping -- and
    cross-checked against the length duration.

 3. INFLATED ELAPSED TIME
    total_elapsed_time includes the gap between stopping the timer and saving.
    When the timer was never paused, elapsed is set equal to timer.

Everything else -- per-second heart rate, device info, HR zones, manufacturer
fields -- is preserved byte for byte. The CRC is recomputed.

Note on fixtures: the committed originals are scrubbed (see AGENTS.md). Running
this script on a scrubbed original reproduces the scrubbed golden, because
scrubbing only touches identity and timestamp fields, which this script never
writes.

Requires: pip install fitdecode
Usage:    python3 repair_swim_fit.py IN.fit [OUT.fit]
"""
import struct
import sys
from pathlib import Path

import fitdecode
from fitdecode.utils import compute_crc

# --- calibration (from the sessions on 30.07., 02.08. and 07.08.2026) -------
STROKE_SPLIT = 40      # strokes per length: below is freestyle, above is breaststroke
DURATION_SPLIT = 100   # seconds per length, cross-check only
# ---------------------------------------------------------------------------

STROKE_ENUM = {"freestyle": 0, "backstroke": 1, "breaststroke": 2,
               "butterfly": 3, "drill": 4, "mixed": 5, "im": 6}
FMT = {"enum": "B", "uint8": "B", "uint8z": "B", "sint8": "b",
       "uint16": "<H", "uint16z": "<H", "sint16": "<h",
       "uint32": "<I", "uint32z": "<I", "sint32": "<i"}
INVALID = {"enum": 0xFF, "uint8": 0xFF, "uint8z": 0, "sint8": 0x7F,
           "uint16": 0xFFFF, "uint16z": 0, "sint16": 0x7FFF,
           "uint32": 0xFFFFFFFF, "uint32z": 0, "sint32": 0x7FFFFFFF}


def patch(raw, def_mesg, values):
    buf = bytearray(raw)
    fmap, off = {}, 1
    for fd in def_mesg.field_defs:
        fmap[fd.name] = (off, fd.size, fd.base_type.name)
        off += fd.size
    for name, val in values.items():
        off, size, bt = fmap[name]
        fmt = FMT[bt]
        esize = struct.calcsize(fmt)
        vals = list(val) if isinstance(val, (list, tuple)) else [val]
        vals += [None] * (size // esize - len(vals))
        for i, v in enumerate(vals):
            struct.pack_into(fmt, buf, off + i * esize,
                             INVALID[bt] if v is None else int(round(v)))
    return bytes(buf)


gv = lambda fr, n: (fr.get_field(n).raw_value if fr.has_field(n) else None)
gval = lambda fr, n: (fr.get_value(n) if fr.has_field(n) else None)
is_msg = lambda fr, n: isinstance(fr, fitdecode.FitDataMessage) and fr.name == n


def repair(src, dst):
    frames, header = [], None
    with fitdecode.FitReader(src, keep_raw_chunks=True) as f:
        for fr in f:
            if fr.frame_type == fitdecode.FIT_FRAME_HEADER:
                header = bytes(fr.chunk.bytes)
            elif fr.frame_type != fitdecode.FIT_FRAME_CRC:
                frames.append((fr, bytes(fr.chunk.bytes)))

    old_len = [(fr, raw) for fr, raw in frames if is_msg(fr, "length")]
    old_lap = [(fr, raw) for fr, raw in frames if is_msg(fr, "lap")]
    sess = next(fr for fr, _ in frames if is_msg(fr, "session"))
    pool_m = gval(sess, "pool_length")
    timer_ms = gv(sess, "total_timer_time")

    pauses = sum(1 for fr, _ in frames if is_msg(fr, "event")
                 and gval(fr, "event") == "timer"
                 and gval(fr, "event_type") in ("stop", "stop_all")) - 1

    # -- assign lengths to laps (whole seconds, see length.start_time) -------
    bounds = []
    for i, (lfr, _) in enumerate(old_lap):
        s = gv(lfr, "start_time")
        e = (gv(old_lap[i + 1][0], "start_time") if i + 1 < len(old_lap)
             else s + int(gv(lfr, "total_elapsed_time") / 1000.0) + 1)
        bounds.append((s, e))

    lap_lengths = []
    for s, e in bounds:
        lap_lengths.append([k for k, (fr, _) in enumerate(old_len)
                            if s <= gv(fr, "start_time") < e])

    # ------------------- build the new length list (merge per lap) ----------
    new_specs, new_info, lap_newlens, merged = [], [], [], []
    for li, ids in enumerate(lap_lengths):
        mine = []
        act = [k for k in ids if gval(old_len[k][0], "length_type") == "active"]
        for k in ids:
            fr = old_len[k][0]
            if gval(fr, "length_type") != "active":
                idx = len(new_specs)
                new_specs.append((k, {"message_index": idx}))
                new_info.append((gv(fr, "start_time"),
                                 gv(fr, "total_elapsed_time"), False, 0))
                mine.append(idx)
            elif k == act[0]:
                idx = len(new_specs)
                dur = sum(gv(old_len[j][0], "total_elapsed_time") for j in act)
                strokes = sum(gv(old_len[j][0], "total_strokes") or 0 for j in act)
                stroke = ("breaststroke" if strokes >= STROKE_SPLIT else "freestyle")
                if (strokes >= STROKE_SPLIT) != (dur / 1000.0 >= DURATION_SPLIT):
                    print(f"  ! lap {li}: stroke count ({strokes}) and duration "
                          f"({dur/1000:.0f}s) disagree -> {stroke}")
                new_specs.append((k, {
                    "message_index": idx,
                    "total_elapsed_time": dur, "total_timer_time": dur,
                    "total_strokes": strokes,
                    "avg_speed": pool_m / (dur / 1000.0) * 1000,
                    "avg_swimming_cadence": strokes * 60.0 / (dur / 1000.0),
                    "swim_stroke": STROKE_ENUM[stroke]}))
                new_info.append((gv(fr, "start_time"), dur, True, strokes))
                mine.append(idx)
                if len(act) > 1:
                    merged.append((li, len(act), dur / 1000.0, strokes))
        lap_newlens.append(mine)

    # ------------------------------- patch the laps -------------------------
    lap_patches = {}
    for li, mine in enumerate(lap_newlens):
        act = [k for k in mine if new_info[k][2]]
        strokes = sum(new_info[k][3] for k in act)
        swim_ms = sum(new_info[k][1] for k in act)
        dist_cm = int(len(act) * pool_m * 100)
        p = {"first_length_index": mine[0] if mine else 0,
             "num_lengths": len(mine) if act else 0,
             "num_active_lengths": len(act),
             "total_distance": dist_cm,
             "total_cycles": strokes,
             "enhanced_avg_speed": (dist_cm / 100.0) / (swim_ms / 1000.0) * 1000 if act else 0,
             "enhanced_max_speed": max((pool_m / (new_info[k][1] / 1000.0) * 1000)
                                       for k in act) if act else 0,
             "avg_stroke_distance": (dist_cm / strokes) if strokes else 0,
             "avg_cadence": strokes * 60.0 / (swim_ms / 1000.0) if act else 0}
        if act:
            st = {("breaststroke" if new_info[k][3] >= STROKE_SPLIT else "freestyle")
                  for k in act}
            p["swim_stroke"] = STROKE_ENUM[st.pop()] if len(st) == 1 else STROKE_ENUM["mixed"]
        lap_patches[li] = p

    # ------------------------------- session --------------------------------
    n_act = sum(1 for _, _, a, _ in new_info if a)
    dist_cm = int(n_act * pool_m * 100)
    strokes = sum(st for _, _, a, st in new_info if a)
    active_ms = sum(d for _, d, a, _ in new_info if a)
    sess_patch = {
        "total_distance": dist_cm,
        "total_cycles": strokes,
        "enhanced_avg_speed": (dist_cm / 100.0) / (active_ms / 1000.0) * 1000,
        "enhanced_max_speed": max(pool_m / (d / 1000.0) * 1000
                                  for _, d, a, _ in new_info if a),
        "num_lengths": sum(p["num_lengths"] for p in lap_patches.values()),
        "num_active_lengths": n_act,
        "avg_stroke_distance": dist_cm / strokes,
        "avg_cadence": strokes * 60.0 / (active_ms / 1000.0)}
    if pauses <= 0:
        sess_patch["total_elapsed_time"] = timer_ms

    # ------------------------------- write ----------------------------------
    out = bytearray()
    keep = {k for k, _ in new_specs}
    li = lai = 0
    for fr, raw in frames:
        if not isinstance(fr, fitdecode.FitDataMessage):
            out += raw
        elif fr.name == "length":
            if li in keep:
                out += patch(raw, fr.def_mesg,
                             next(pv for k, pv in new_specs if k == li))
            li += 1
        elif fr.name == "lap":
            out += patch(raw, fr.def_mesg, lap_patches[lai]); lai += 1
        elif fr.name == "session":
            out += patch(raw, fr.def_mesg, sess_patch)
        elif fr.name == "activity":
            out += patch(raw, fr.def_mesg, {"total_timer_time": timer_ms})
        else:
            out += raw

    nh = bytearray(header)
    struct.pack_into("<I", nh, 4, len(out))
    struct.pack_into("<H", nh, 12, compute_crc(nh[:12]))
    blob = bytes(nh) + bytes(out)
    blob += struct.pack("<H", compute_crc(blob))
    Path(dst).parent.mkdir(parents=True, exist_ok=True)
    Path(dst).write_bytes(blob)

    # ------------------------------- report ---------------------------------
    print(f"\n{Path(dst).name}")
    print(f"  phantom turns corrected: {len(merged)}")
    for li_, n, d, s in merged:
        print(f"    lap {li_}: {n} lengths -> 1 ({d:.0f}s, {s} strokes)")
    br = [(d, s) for _, d, a, s in new_info if a and s >= STROKE_SPLIT]
    kr = [(d, s) for _, d, a, s in new_info if a and s < STROKE_SPLIT]
    print(f"  breaststroke: {len(br):2d} lengths = {len(br)*int(pool_m):4d} m  "
          f"avg {sum(d for d,_ in br)/len(br)/1000:5.1f} s/length" if br else "")
    print(f"  freestyle:    {len(kr):2d} lengths = {len(kr)*int(pool_m):4d} m  "
          f"avg {sum(d for d,_ in kr)/len(kr)/1000:5.1f} s/length" if kr else "")
    print(f"  total: {dist_cm/100:.0f} m | {n_act} lengths | {strokes} strokes | "
          f"swim time {active_ms/60000:.1f} min | timer {timer_ms/60000:.1f} min")
    return blob


if __name__ == "__main__":
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2]) if len(sys.argv) > 2 else src.with_name(
        src.name.replace(".fit", "_fixed.fit"))
    repair(src, dst)
