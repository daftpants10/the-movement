"""Artifact detection/correction for RR interval series.

Chest strap RR data occasionally contains ectopic beats, missed beats,
or Bluetooth dropout artifacts. DFA in particular is sensitive to these,
so we clean the series before any downstream analysis:

1. drop physiologically implausible intervals (outside 300-2000 ms,
   i.e. HR outside ~30-200 bpm)
2. flag beat-to-beat jumps >20% of the previous accepted interval
   (the standard Malik-style percentage filter)
3. replace flagged points via linear interpolation so DFA gets a
   continuous series rather than gaps
"""

import numpy as np

MIN_RR_MS = 300
MAX_RR_MS = 2000
JUMP_FRACTION = 0.20


def clean_rr_series(rr_ms):
    """Return (cleaned_rr, valid_mask, n_removed).

    cleaned_rr has the same length as the input; implausible/ectopic
    points are replaced by linear interpolation between neighbouring
    valid points. valid_mask marks which original points were kept
    as-is (False = replaced).
    """
    rr = np.asarray(rr_ms, dtype=float)
    n = rr.size
    valid = (rr >= MIN_RR_MS) & (rr <= MAX_RR_MS)

    # percentage filter against the last accepted value
    last_good = None
    for i in range(n):
        if not valid[i]:
            continue
        if last_good is None:
            last_good = rr[i]
            continue
        if abs(rr[i] - last_good) / last_good > JUMP_FRACTION:
            valid[i] = False
        else:
            last_good = rr[i]

    n_removed = int(n - valid.sum())

    if n_removed == 0:
        return rr.copy(), valid, 0

    if valid.sum() < 2:
        # too little good data to interpolate from; caller should
        # treat this session as unanalyzable
        return rr.copy(), valid, n_removed

    idx = np.arange(n)
    cleaned = rr.copy()
    cleaned[~valid] = np.interp(idx[~valid], idx[valid], rr[valid])
    return cleaned, valid, n_removed
