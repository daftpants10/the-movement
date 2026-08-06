"""SQLite cache for computed session analysis and AI narratives.

Analysis is only recomputed when a session file's content hash changes;
narratives are only regenerated when the underlying set of sessions
(and their hashes) they were built from changes, or on explicit refresh.
"""

import json
import sqlite3
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    file_name TEXT,
    file_hash TEXT,
    condition TEXT,
    participant_id TEXT,
    recorded_at TEXT,
    sample_count INTEGER,
    n_artifacts INTEGER,
    artifact_pct REAL,
    duration_s REAL,
    analyzable INTEGER,
    reason TEXT,
    mean_rr REAL,
    mean_hr REAL,
    sdnn REAL,
    rmssd REAL,
    pnn50 REAL,
    alpha1 REAL,
    alpha1_note TEXT,
    alpha1_windowed_json TEXT,
    analyzed_at TEXT
);

CREATE TABLE IF NOT EXISTS narratives (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    source_hash TEXT,
    narrative TEXT,
    model TEXT,
    generated_at TEXT,
    PRIMARY KEY (scope, key)
);
"""


def get_conn(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def upsert_session(conn, analysis: dict):
    windowed_json = json.dumps(analysis.get("alpha1_windowed", []))
    conn.execute(
        """
        INSERT INTO sessions (
            session_id, file_name, file_hash, condition, participant_id,
            recorded_at, sample_count, n_artifacts, artifact_pct, duration_s,
            analyzable, reason, mean_rr, mean_hr, sdnn, rmssd, pnn50,
            alpha1, alpha1_note, alpha1_windowed_json, analyzed_at
        ) VALUES (
            :session_id, :file_name, :file_hash, :condition, :participant_id,
            :recorded_at, :sample_count, :n_artifacts, :artifact_pct, :duration_s,
            :analyzable, :reason, :mean_rr, :mean_hr, :sdnn, :rmssd, :pnn50,
            :alpha1, :alpha1_note, :alpha1_windowed_json, :analyzed_at
        )
        ON CONFLICT(session_id) DO UPDATE SET
            file_name=excluded.file_name, file_hash=excluded.file_hash,
            condition=excluded.condition, participant_id=excluded.participant_id,
            recorded_at=excluded.recorded_at, sample_count=excluded.sample_count,
            n_artifacts=excluded.n_artifacts, artifact_pct=excluded.artifact_pct,
            duration_s=excluded.duration_s, analyzable=excluded.analyzable,
            reason=excluded.reason, mean_rr=excluded.mean_rr, mean_hr=excluded.mean_hr,
            sdnn=excluded.sdnn, rmssd=excluded.rmssd, pnn50=excluded.pnn50,
            alpha1=excluded.alpha1, alpha1_note=excluded.alpha1_note,
            alpha1_windowed_json=excluded.alpha1_windowed_json,
            analyzed_at=excluded.analyzed_at
        """,
        {
            "session_id": analysis["session_id"],
            "file_name": analysis["file_name"],
            "file_hash": analysis["file_hash"],
            "condition": analysis["condition"],
            "participant_id": analysis["participant_id"],
            "recorded_at": analysis.get("recorded_at"),
            "sample_count": analysis["sample_count"],
            "n_artifacts": analysis["n_artifacts"],
            "artifact_pct": analysis["artifact_pct"],
            "duration_s": analysis["duration_s"],
            "analyzable": 1 if analysis["analyzable"] else 0,
            "reason": analysis.get("reason"),
            "mean_rr": analysis.get("mean_rr"),
            "mean_hr": analysis.get("mean_hr"),
            "sdnn": analysis.get("sdnn"),
            "rmssd": analysis.get("rmssd"),
            "pnn50": analysis.get("pnn50"),
            "alpha1": analysis.get("alpha1"),
            "alpha1_note": analysis.get("alpha1_note"),
            "alpha1_windowed_json": windowed_json,
            "analyzed_at": datetime.now(timezone.utc).isoformat(),
        },
    )
    conn.commit()


def prune_sessions(conn, keep_file_names: set):
    rows = conn.execute("SELECT session_id, file_name FROM sessions").fetchall()
    stale = [r["session_id"] for r in rows if r["file_name"] not in keep_file_names]
    if stale:
        conn.executemany("DELETE FROM sessions WHERE session_id = ?", [(s,) for s in stale])
        conn.commit()
    return stale


def row_to_session(row) -> dict:
    d = dict(row)
    d["analyzable"] = bool(d["analyzable"])
    d["alpha1_windowed"] = json.loads(d.pop("alpha1_windowed_json") or "[]")
    return d


def get_session_by_hash(conn, session_id, file_hash):
    row = conn.execute(
        "SELECT * FROM sessions WHERE session_id = ? AND file_hash = ?",
        (session_id, file_hash),
    ).fetchone()
    return row_to_session(row) if row else None


def get_all_sessions(conn) -> list:
    rows = conn.execute("SELECT * FROM sessions ORDER BY recorded_at").fetchall()
    return [row_to_session(r) for r in rows]


def get_session(conn, session_id) -> dict:
    row = conn.execute("SELECT * FROM sessions WHERE session_id = ?", (session_id,)).fetchone()
    return row_to_session(row) if row else None


def get_narrative(conn, scope, key):
    row = conn.execute(
        "SELECT * FROM narratives WHERE scope = ? AND key = ?", (scope, key)
    ).fetchone()
    return dict(row) if row else None


def upsert_narrative(conn, scope, key, source_hash, narrative, model):
    conn.execute(
        """
        INSERT INTO narratives (scope, key, source_hash, narrative, model, generated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope, key) DO UPDATE SET
            source_hash=excluded.source_hash, narrative=excluded.narrative,
            model=excluded.model, generated_at=excluded.generated_at
        """,
        (scope, key, source_hash, narrative, model, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
