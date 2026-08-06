"""Standard time-domain HRV metrics, computed post-hoc from cleaned RR series."""

import numpy as np


def time_domain_metrics(rr_ms):
    rr = np.asarray(rr_ms, dtype=float)
    diffs = np.diff(rr)

    mean_rr = float(rr.mean())
    mean_hr = float(60000.0 / mean_rr) if mean_rr > 0 else None
    sdnn = float(rr.std(ddof=1)) if rr.size > 1 else None
    rmssd = float(np.sqrt(np.mean(diffs ** 2))) if diffs.size > 0 else None
    pnn50 = float(np.mean(np.abs(diffs) > 50) * 100) if diffs.size > 0 else None

    return {
        "mean_rr": round(mean_rr, 2),
        "mean_hr": round(mean_hr, 2) if mean_hr is not None else None,
        "sdnn": round(sdnn, 2) if sdnn is not None else None,
        "rmssd": round(rmssd, 2) if rmssd is not None else None,
        "pnn50": round(pnn50, 2) if pnn50 is not None else None,
    }
