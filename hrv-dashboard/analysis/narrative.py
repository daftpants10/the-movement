"""AI-generated descriptive narratives over computed HRV/DFA metrics.

Two scopes:
  - within-participant: how one participant's sessions differ across
    conditions (e.g. baseline vs condition1 vs condition2)
  - between-participant: how different participants compare to each
    other within the same condition

The model is only ever given computed numbers (alpha1, sdnn, rmssd,
mean hr, a condensed windowed-alpha1 trend) — never raw RR series —
and is asked to describe patterns, not to diagnose or draw clinical
conclusions. Trend arithmetic (slope, min/max) is computed in Python
and handed to the model as facts, since LLMs are unreliable at reading
numeric trends off a raw list.
"""

from __future__ import annotations

import hashlib
import os

import numpy as np

DEFAULT_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5")

SYSTEM_PROMPT = """you are assisting with exploratory analysis of heart rate \
variability (hrv) data collected with a polar h10 chest strap for thesis \
research. you are given precomputed summary statistics per recording \
session: dfa alpha1 (short-term detrended fluctuation scaling exponent), \
sdnn, rmssd, pnn50, mean hr, session duration, and a condensed windowed \
alpha1 trend (computed via linear regression over sliding windows, not \
by you).

describe the patterns you see in the numbers. be specific and refer to \
actual values. note direction and rough magnitude of differences, \
consistency vs variability, and anything that stands out (outliers, \
sessions too short/noisy to trust). do not offer clinical, diagnostic, \
or causal interpretation — this is exploratory pattern description for \
a research pipeline, not a medical assessment. if the data is too \
sparse or noisy to say anything meaningful, say so plainly instead of \
speculating. write in lowercase, plain sentences, no filler, no markdown \
headers, 150-300 words."""


def compute_source_hash(sessions: list) -> str:
    parts = sorted(f"{s['session_id']}:{s['file_hash']}" for s in sessions)
    return hashlib.sha256("|".join(parts).encode()).hexdigest()


def _windowed_trend(windowed: list) -> dict | None:
    if not windowed or len(windowed) < 2:
        return None
    mids = np.array([(w["t_start_s"] + w["t_end_s"]) / 2 for w in windowed])
    alphas = np.array([w["alpha1"] for w in windowed])
    slope_per_s, _ = np.polyfit(mids, alphas, 1)
    return {
        "n_windows": len(windowed),
        "start_alpha1": round(float(alphas[0]), 3),
        "end_alpha1": round(float(alphas[-1]), 3),
        "min_alpha1": round(float(alphas.min()), 3),
        "max_alpha1": round(float(alphas.max()), 3),
        "mean_alpha1": round(float(alphas.mean()), 3),
        "slope_per_min": round(float(slope_per_s * 60), 4),
    }


def _session_line(s: dict, include_participant=False, include_condition=False) -> str:
    label_bits = []
    if include_condition:
        label_bits.append(f"condition={s['condition']}")
    if include_participant:
        label_bits.append(f"participant={s['participant_id']}")
    label = ", ".join(label_bits)

    if not s.get("analyzable"):
        return f"- {label}: not analyzable ({s.get('reason', 'unknown reason')})"

    bits = [
        label,
        f"duration={s['duration_s']}s",
        f"n={s['sample_count']} (artifacts removed={s['n_artifacts']}, {s['artifact_pct']}%)",
        f"mean_hr={s['mean_hr']}bpm",
        f"sdnn={s['sdnn']}ms",
        f"rmssd={s['rmssd']}ms",
        f"pnn50={s['pnn50']}%",
    ]
    if s.get("alpha1") is not None:
        bits.append(f"alpha1={s['alpha1']}")
    else:
        bits.append(f"alpha1=n/a ({s.get('alpha1_note', 'insufficient data')})")

    trend = _windowed_trend(s.get("alpha1_windowed") or [])
    if trend:
        bits.append(
            "windowed_alpha1_trend="
            f"start {trend['start_alpha1']} -> end {trend['end_alpha1']} "
            f"(slope {trend['slope_per_min']}/min, range "
            f"{trend['min_alpha1']}-{trend['max_alpha1']} over {trend['n_windows']} windows)"
        )

    return "- " + ", ".join(bits)


def build_within_participant_prompt(participant_id: str, sessions: list) -> str:
    by_condition = sorted(sessions, key=lambda s: (s["condition"], s.get("recorded_at") or ""))
    lines = [_session_line(s, include_condition=True) for s in by_condition]
    return (
        f"participant {participant_id}, {len(sessions)} session(s) across "
        f"{len({s['condition'] for s in sessions})} condition(s).\n\n"
        "sessions:\n" + "\n".join(lines) + "\n\n"
        "describe how this participant's hrv/dfa alpha1 patterns differ "
        "across conditions."
    )


def build_between_participant_prompt(condition: str, sessions: list) -> str:
    by_participant = sorted(sessions, key=lambda s: (s["participant_id"], s.get("recorded_at") or ""))
    lines = [_session_line(s, include_participant=True) for s in by_participant]
    return (
        f"condition '{condition}', {len(sessions)} session(s) across "
        f"{len({s['participant_id'] for s in sessions})} participant(s).\n\n"
        "sessions:\n" + "\n".join(lines) + "\n\n"
        "describe how participants compare to each other within this condition: "
        "consistency vs. variability, common trend direction, and any outliers."
    )


def generate_narrative(prompt: str, model: str = DEFAULT_MODEL) -> str:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError(
            "ANTHROPIC_API_KEY is not set. export it before requesting a narrative."
        )

    import anthropic  # deferred import so the rest of the app works without the package

    client = anthropic.Anthropic(api_key=api_key)
    response = client.messages.create(
        model=model,
        max_tokens=1024,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": prompt}],
    )
    return "".join(block.text for block in response.content if block.type == "text").strip()
