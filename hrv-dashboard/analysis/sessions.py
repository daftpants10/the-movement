"""Load RR-logger session exports and compute per-session analysis."""

import hashlib
import json
from pathlib import Path

from .artifacts import clean_rr_series
from .dfa import dfa_alpha, windowed_dfa_alpha
from .hrv_metrics import time_domain_metrics

DFA_WINDOW_BEATS = 120
DFA_STEP_BEATS = 30


class SessionError(Exception):
    pass


def file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _fallback_identity(session_id):
    # older exports may lack top-level condition/participant_id;
    # session_id is "{condition}_{participant}_{iso-timestamp}"
    parts = session_id.split("_")
    if len(parts) >= 3:
        return parts[0], parts[1]
    return "unknown", "unknown"


def load_session_file(path: Path) -> dict:
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise SessionError(f"could not read/parse {path.name}: {exc}") from exc

    samples = raw.get("samples")
    if not isinstance(samples, list) or len(samples) == 0:
        raise SessionError(f"{path.name}: no samples found")

    session_id = raw.get("session_id") or path.stem
    condition = raw.get("condition")
    participant_id = raw.get("participant_id")
    if not condition or not participant_id:
        fallback_condition, fallback_participant = _fallback_identity(session_id)
        condition = condition or fallback_condition
        participant_id = participant_id or fallback_participant

    try:
        rr_ms = [float(s["rr_ms"]) for s in samples]
        timestamps_ms = [float(s["timestamp_ms_unix"]) for s in samples]
    except (KeyError, TypeError, ValueError) as exc:
        raise SessionError(f"{path.name}: malformed sample rows: {exc}") from exc

    # samples should already be receipt-ordered, but don't assume the file wasn't hand-edited
    order = sorted(range(len(rr_ms)), key=lambda i: timestamps_ms[i])
    rr_ms = [rr_ms[i] for i in order]
    timestamps_ms = [timestamps_ms[i] for i in order]

    return {
        "session_id": session_id,
        "condition": condition,
        "participant_id": str(participant_id),
        "recorded_at": raw.get("recorded_at"),
        "rr_ms": rr_ms,
        "timestamps_ms": timestamps_ms,
    }


def analyze_session(parsed: dict) -> dict:
    rr_ms = parsed["rr_ms"]
    timestamps_ms = parsed["timestamps_ms"]
    n_samples = len(rr_ms)

    cleaned, valid_mask, n_artifacts = clean_rr_series(rr_ms)
    n_valid_for_interp = int(valid_mask.sum())

    duration_s = (timestamps_ms[-1] - timestamps_ms[0]) / 1000 if n_samples > 1 else 0.0

    result = {
        "session_id": parsed["session_id"],
        "condition": parsed["condition"],
        "participant_id": parsed["participant_id"],
        "recorded_at": parsed["recorded_at"],
        "sample_count": n_samples,
        "n_artifacts": n_artifacts,
        "artifact_pct": round(n_artifacts / n_samples * 100, 2) if n_samples else None,
        "duration_s": round(duration_s, 1),
    }

    if n_valid_for_interp < 2:
        result.update({
            "analyzable": False,
            "reason": "too few valid (non-artifact) rr intervals to analyze",
        })
        return result

    result.update(time_domain_metrics(cleaned))

    alpha1 = dfa_alpha(cleaned)
    windowed = windowed_dfa_alpha(cleaned, timestamps_ms,
                                   window_beats=DFA_WINDOW_BEATS,
                                   step_beats=DFA_STEP_BEATS)

    result["analyzable"] = True
    result["alpha1"] = round(alpha1, 4) if alpha1 is not None else None
    result["alpha1_note"] = None if alpha1 is not None else (
        f"session too short for a stable dfa alpha1 estimate "
        f"(need >= {16 * 4} beats after cleaning, have {n_valid_for_interp})"
    )
    result["alpha1_windowed"] = windowed
    return result


def scan_sessions(data_dir: Path) -> list:
    """Load + analyze every *.json in data_dir. Returns (results, errors)."""
    results = []
    errors = []
    for path in sorted(data_dir.glob("*.json")):
        try:
            parsed = load_session_file(path)
            analysis = analyze_session(parsed)
            analysis["file_name"] = path.name
            analysis["file_hash"] = file_hash(path)
            results.append(analysis)
        except SessionError as exc:
            errors.append({"file_name": path.name, "error": str(exc)})
    return results, errors
