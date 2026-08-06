"""Detrended fluctuation analysis (DFA) short-term scaling exponent (alpha1).

Implements the classic Peng et al. (1995) DFA algorithm, windowed to the
short-term scale (box sizes n = 4..16 beats) used throughout the HRV /
DFA-alpha1 literature (e.g. Rogers et al. 2021) for characterising
beat-to-beat correlation structure in RR interval series.
"""

import numpy as np


def dfa_alpha(rr_ms, min_box=4, max_box=16):
    """Compute the short-term DFA scaling exponent for one RR series.

    rr_ms: 1D sequence of RR intervals in milliseconds (already artifact
    corrected — DFA is sensitive to ectopic beats and noise).

    Returns None if there isn't enough data for a stable fit (need at
    least a few non-overlapping windows at the largest box size).
    """
    rr = np.asarray(rr_ms, dtype=float)
    n_samples = rr.size
    if n_samples < max_box * 4:
        return None

    mean_rr = rr.mean()
    y = np.cumsum(rr - mean_rr)

    box_sizes = np.arange(min_box, max_box + 1)
    log_n = []
    log_f = []

    for n in box_sizes:
        n_boxes = n_samples // n
        if n_boxes < 1:
            continue
        trimmed = y[: n_boxes * n].reshape(n_boxes, n)
        x = np.arange(n)
        # fit a linear trend per box and compute the RMS residual
        rms_per_box = np.empty(n_boxes)
        for i in range(n_boxes):
            coeffs = np.polyfit(x, trimmed[i], 1)
            trend = np.polyval(coeffs, x)
            rms_per_box[i] = np.sqrt(np.mean((trimmed[i] - trend) ** 2))
        f_n = np.sqrt(np.mean(rms_per_box ** 2))
        if f_n > 0:
            log_n.append(np.log(n))
            log_f.append(np.log(f_n))

    if len(log_n) < 3:
        return None

    alpha, _intercept = np.polyfit(log_n, log_f, 1)
    return float(alpha)


def windowed_dfa_alpha(rr_ms, timestamps_ms, window_beats=120, step_beats=30,
                        min_box=4, max_box=16):
    """Sliding-window alpha1 over the course of a session.

    Returns a list of {t_start_s, t_end_s, alpha1} using elapsed seconds
    from the first sample. Windows shorter than window_beats are skipped.
    Used to describe how alpha1 trends over time within a session (e.g.
    a steady decline), not just a single summary number.
    """
    rr = np.asarray(rr_ms, dtype=float)
    ts = np.asarray(timestamps_ms, dtype=float)
    n = rr.size
    if n < window_beats:
        return []

    t0 = ts[0]
    out = []
    start = 0
    while start + window_beats <= n:
        end = start + window_beats
        a = dfa_alpha(rr[start:end], min_box=min_box, max_box=max_box)
        if a is not None:
            out.append({
                "t_start_s": round(float(ts[start] - t0) / 1000, 1),
                "t_end_s": round(float(ts[end - 1] - t0) / 1000, 1),
                "alpha1": round(a, 4),
            })
        start += step_beats
    return out
