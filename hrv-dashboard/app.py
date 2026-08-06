"""Local HRV analysis dashboard: DFA alpha1 + HRV metrics + AI pattern narratives
over rr-logger session exports (see ../rr-logger).

Run:
    pip install -r requirements.txt
    export ANTHROPIC_API_KEY=...   # only needed for narrative generation
    python app.py

Drop exported session .json files into data/sessions/, then hit
"rescan" in the dashboard (or POST /api/rescan) to analyze them.
"""

from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

from analysis import db, narrative
from analysis.sessions import scan_sessions

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data" / "sessions"
DB_PATH = BASE_DIR / "data" / "cache.db"
STATIC_DIR = BASE_DIR / "static"

DATA_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, static_folder=None)


def get_db():
    return db.get_conn(DB_PATH)


@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/<path:filename>")
def static_files(filename):
    return send_from_directory(STATIC_DIR, filename)


@app.post("/api/rescan")
def rescan():
    conn = get_db()
    results, errors = scan_sessions(DATA_DIR)
    for analysis in results:
        db.upsert_session(conn, analysis)
    kept = {r["file_name"] for r in results}
    pruned = db.prune_sessions(conn, kept)
    return jsonify({
        "scanned": len(results),
        "errors": errors,
        "pruned": pruned,
    })


@app.post("/api/upload")
def upload():
    files = request.files.getlist("files")
    if not files:
        return jsonify({"error": "no files in request"}), 400

    saved, rejected = [], []
    for f in files:
        if not f.filename.lower().endswith(".json"):
            rejected.append({"file_name": f.filename, "error": "not a .json file"})
            continue
        dest = DATA_DIR / Path(f.filename).name
        f.save(dest)
        saved.append(dest.name)

    conn = get_db()
    results, errors = scan_sessions(DATA_DIR)
    for analysis in results:
        db.upsert_session(conn, analysis)
    kept = {r["file_name"] for r in results}
    db.prune_sessions(conn, kept)

    return jsonify({"saved": saved, "rejected": rejected, "scanned": len(results), "errors": errors})


@app.get("/api/sessions")
def list_sessions():
    conn = get_db()
    sessions = db.get_all_sessions(conn)
    return jsonify(sessions)


@app.get("/api/sessions/<session_id>")
def session_detail(session_id):
    conn = get_db()
    s = db.get_session(conn, session_id)
    if not s:
        return jsonify({"error": "not found"}), 404
    return jsonify(s)


@app.get("/api/overview")
def overview():
    conn = get_db()
    sessions = db.get_all_sessions(conn)
    conditions = sorted({s["condition"] for s in sessions})
    participants = sorted({s["participant_id"] for s in sessions})
    grid = {}
    for s in sessions:
        grid.setdefault(s["participant_id"], {})[s["condition"]] = {
            "session_id": s["session_id"],
            "alpha1": s["alpha1"],
            "analyzable": s["analyzable"],
        }
    return jsonify({"conditions": conditions, "participants": participants, "grid": grid})


def _narrative_response(conn, scope, key, sessions, prompt_builder, force):
    if not sessions:
        return jsonify({"error": f"no sessions found for {scope} '{key}'"}), 404

    analyzable = [s for s in sessions if s["analyzable"]]
    source_hash = narrative.compute_source_hash(sessions)
    cached = db.get_narrative(conn, scope, key)

    if cached and not force and cached["source_hash"] == source_hash:
        return jsonify({**cached, "cached": True})

    if not analyzable:
        return jsonify({
            "error": "no analyzable sessions (all too short/noisy) for a narrative",
        }), 422

    prompt = prompt_builder(key, sessions)
    try:
        text = narrative.generate_narrative(prompt)
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 503
    except Exception as exc:  # anthropic API errors, network errors, etc.
        return jsonify({"error": f"narrative generation failed: {exc}"}), 502

    db.upsert_narrative(conn, scope, key, source_hash, text, narrative.DEFAULT_MODEL)
    result = db.get_narrative(conn, scope, key)
    return jsonify({**result, "cached": False})


@app.get("/api/participants/<participant_id>/narrative")
def participant_narrative(participant_id):
    conn = get_db()
    sessions = [s for s in db.get_all_sessions(conn) if s["participant_id"] == participant_id]
    force = request.args.get("refresh") == "true"
    return _narrative_response(
        conn, "participant", participant_id, sessions,
        narrative.build_within_participant_prompt, force,
    )


@app.get("/api/conditions/<condition>/narrative")
def condition_narrative(condition):
    conn = get_db()
    sessions = [s for s in db.get_all_sessions(conn) if s["condition"] == condition]
    force = request.args.get("refresh") == "true"
    return _narrative_response(
        conn, "condition", condition, sessions,
        narrative.build_between_participant_prompt, force,
    )


if __name__ == "__main__":
    app.run(debug=True, port=5057)
