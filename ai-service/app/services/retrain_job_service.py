"""Local background worker for Admin-triggered recommender retraining.

This module intentionally invokes retrain_pipeline.py, not the Colab wrapper.
Colab paths and behavior therefore remain independent.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

from app.api.deps import reload_hybrid_recommender
from app.core.config import settings
from app.core.logger import get_logger

logger = get_logger(__name__)
AI_SERVICE_DIR = Path(__file__).resolve().parents[2]
RETRAIN_SCRIPT = AI_SERVICE_DIR / "retrain" / "retrain_pipeline.py"
MANIFEST_PATH = AI_SERVICE_DIR / "retrain" / "output" / "recommender_artifacts" / "serve_manifest.json"

_lock = threading.Lock()
_active_run_id: str | None = None


def _client():
    from supabase import create_client

    return create_client(settings.supabase_url, settings.supabase_key)


def _update_run(run_id: str, **updates) -> None:
    response = (
        _client().schema("ai_config").table("training_runs")
        .update(updates).eq("id", run_id).execute()
    )
    if not response.data:
        logger.warning("training_runs update returned no row for %s", run_id)


def _progress(run_id: str, value: int, step: str, log_tail: list[str]) -> None:
    _update_run(
        run_id,
        metrics={"progress": value, "current_step": step, "log_tail": log_tail[-30:]},
    )


def _insert_algorithm_log(run_id: str, status: str, details: dict) -> None:
    try:
        sb = _client()
        run = (
            sb.schema("ai_config").table("training_runs")
            .select("algorithm_id").eq("id", run_id).single().execute()
        )
        if run.data:
            sb.schema("ai_config").table("algorithm_logs").insert({
                "algorithm_id": run.data["algorithm_id"],
                "status": status,
                "action": "updated",
                "details": json.dumps(details, ensure_ascii=False),
            }).execute()
    except Exception as exc:
        logger.warning("Could not write algorithm log for %s: %s", run_id, exc)


def _step_from_line(line: str) -> tuple[int, str] | None:
    normalized = line.lower()
    if "bước export" in normalized or "[export]" in normalized:
        return 20, "exporting_data"
    if "embedding cache" in normalized or "encode embedding" in normalized:
        return 40, "building_embeddings"
    if "pre-compute cb lookup" in normalized:
        return 50, "building_cb_lookup"
    if "[train] r:" in normalized or "gridsearchcv" in normalized:
        return 60, "training_rating_cf"
    if "log cf:" in normalized:
        return 72, "training_log_cf"
    if "quality gate" in normalized:
        return 82, "quality_gate"
    if "bước deploy" in normalized or "upload r2" in normalized:
        return 90, "deploying_artifacts"
    return None


def _promote_model_version(run_id: str, manifest: dict) -> str | None:
    sb = _client()
    run_result = (
        sb.schema("ai_config").table("training_runs")
        .select("algorithm_id").eq("id", run_id).single().execute()
    )
    if not run_result.data:
        return None
    algorithm_id = run_result.data["algorithm_id"]
    version_tag = datetime.now(timezone.utc).strftime("admin-%Y%m%d-%H%M%S")
    inserted = (
        sb.schema("ai_config").table("model_versions").insert({
            "algorithm_id": algorithm_id,
            "version_tag": version_tag,
            "status": "candidate",
            "artifact_r2_prefix": "recommender_artifacts/",
            "metrics": manifest.get("metrics", {}),
            "trained_at": datetime.now(timezone.utc).isoformat(),
        }).execute()
    )
    if not inserted.data:
        return None
    model_id = inserted.data[0]["id"]
    (
        sb.schema("ai_config").table("model_versions")
        .update({"status": "archived"})
        .eq("algorithm_id", algorithm_id).eq("status", "active").execute()
    )
    (
        sb.schema("ai_config").table("model_versions")
        .update({
            "status": "active",
            "promoted_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", model_id).execute()
    )
    return model_id


def _run(run_id: str, force: bool) -> None:
    global _active_run_id
    started = datetime.now(timezone.utc)
    log_tail: list[str] = []
    try:
        _update_run(
            run_id, status="running", started_at=started.isoformat(),
            metrics={"progress": 5, "current_step": "starting"},
        )
        command = [sys.executable, str(RETRAIN_SCRIPT)]
        if force:
            command.append("--force")
        env = os.environ.copy()
        env["RETRAIN_RESTART_CMD"] = ""  # parent process hot-reloads safely
        process = subprocess.Popen(
            command,
            cwd=str(AI_SERVICE_DIR / "retrain"),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        last_progress = 5
        assert process.stdout is not None
        for raw_line in process.stdout:
            line = raw_line.rstrip()
            if line:
                logger.info("[retrain:%s] %s", run_id, line)
                log_tail.append(line)
            step = _step_from_line(line)
            if step and step[0] > last_progress:
                last_progress = step[0]
                _progress(run_id, step[0], step[1], log_tail)
        exit_code = process.wait()
        if exit_code != 0:
            raise RuntimeError(f"Retrain process exited with code {exit_code}")

        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        reloaded = reload_hybrid_recommender()
        if not reloaded:
            raise RuntimeError("Artifact trained but hot reload failed")
        model_version_id = _promote_model_version(run_id, manifest)
        completed = datetime.now(timezone.utc)
        metrics = {
            **manifest.get("metrics", {}),
            "progress": 100,
            "current_step": "completed",
            "log_tail": log_tail[-30:],
        }
        _update_run(
            run_id,
            status="completed",
            completed_at=completed.isoformat(),
            duration_seconds=int((completed - started).total_seconds()),
            metrics=metrics,
            model_version_id=model_version_id,
        )
        _insert_algorithm_log(run_id, "active", {
            "requestedAction": "recommender_retrain_completed",
            "run_id": run_id,
            "model_version_id": model_version_id,
            "metrics": manifest.get("metrics", {}),
        })
    except Exception as exc:
        logger.exception("Retrain run %s failed", run_id)
        completed = datetime.now(timezone.utc)
        _update_run(
            run_id,
            status="failed",
            completed_at=completed.isoformat(),
            duration_seconds=int((completed - started).total_seconds()),
            error_message=str(exc)[:4000],
            metrics={"progress": 100, "current_step": "failed", "log_tail": log_tail[-30:]},
        )
        _insert_algorithm_log(run_id, "failed", {
            "requestedAction": "recommender_retrain_failed",
            "run_id": run_id,
            "error": str(exc),
        })
    finally:
        with _lock:
            _active_run_id = None


def start_retrain(run_id: str, force: bool) -> bool:
    global _active_run_id
    pending = (
        _client().schema("ai_config").table("training_runs")
        .select("id,status").eq("id", run_id).eq("status", "pending")
        .maybe_single().execute()
    )
    if not pending.data:
        return False
    with _lock:
        if _active_run_id is not None:
            return False
        _active_run_id = run_id
    threading.Thread(target=_run, args=(run_id, force), daemon=True).start()
    return True
