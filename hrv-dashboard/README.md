# hrv dashboard

local analysis backend for [rr-logger](../rr-logger) session exports. computes
dfa alpha1 (short-term detrended fluctuation scaling exponent) and standard
time-domain hrv metrics (sdnn, rmssd, pnn50, mean hr) per session, then uses
the anthropic api to describe patterns:

- **within-participant**: how one participant's sessions differ across
  conditions (baseline vs condition1 vs condition2, ...)
- **between-participant**: how participants compare to each other within
  the same condition (condition1 across participant 01, 02, ...)

grouping comes from the `condition` and `participant_id` fields rr-logger
writes into each export — not from filenames.

## setup

```
cd hrv-dashboard
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...   # only needed for narratives
python app.py
```

open `http://localhost:5057`.

## use

1. drop rr-logger `.json` exports into `data/sessions/` (or drag them onto
   the dashboard, or use the file picker) — filenames don't matter, the
   file content does.
2. hit **rescan data folder** (uploading does this automatically).
3. **sessions** tab: per-session table + a participant × condition overview
   grid. click any row/cell for a detail view with the windowed alpha1
   trend for that session, and — if the export includes a `computed_stream`
   (e.g. from [somasync-capture](../somasync-capture), when the data source
   streams its own already-computed values like a live dfa alpha1) — a
   **source's own values** section comparing those against the dashboard's
   own independently-computed numbers. These are two separate calculations
   and won't necessarily agree; that's expected, not a bug.
4. **by participant** / **by condition** tabs: pick one, hit **get
   narrative**. cached until the underlying sessions change; **regenerate**
   forces a fresh call.

## notes

- artifact handling: rr intervals outside 300-2000ms, or jumping >20% from
  the previous accepted interval, are treated as artifacts and linearly
  interpolated before analysis (see `analysis/artifacts.py`). artifact
  count/percentage is shown per session — check it before trusting alpha1
  on a noisy session.
- dfa alpha1 uses box sizes 4-16 beats (short-term scale), non-overlapping
  windows, per Peng et al. 1995 / the convention used in HRV threshold
  literature (e.g. Rogers et al. 2021). needs at least ~64 clean beats to
  return a value; shorter sessions show `n/a` rather than a shaky number.
- a windowed alpha1 trend (120-beat sliding window, 30-beat step) is also
  computed per session and condensed (slope, start/end, min/max) before
  being handed to the model — the model gets facts, not raw series, and
  is told not to draw clinical conclusions.
- everything is cached in `data/cache.db` (sqlite) keyed by session content
  hash, so re-running the dashboard doesn't recompute or re-call the api
  unless a file actually changed.
- this is a local tool — no deployment, no auth. don't expose it to the
  network as-is.
