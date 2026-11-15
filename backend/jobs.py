"""In-process background jobs with progress, for slow cold requests. Owner: A.

One process, a small thread pool, jobs kept in memory (lost on restart, which is fine: results
live in the disk cache). Identical requests share one job.
"""
from __future__ import annotations

import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from typing import Callable, Optional

STAGE_TEXT = {
    "scan_folders": "Searching the SPHEREx archive for exposures",
    "headers": "Reading exposure headers",
    "stamps": "Downloading image cutouts",
    "coadd": "Aligning and stacking each survey pass",
    "cube": "Stacking each spectral channel",
}


@dataclass
class Job:
    id: str
    key: str
    state: str = "queued"          # queued | running | done | error
    stage: str = ""
    message: str = "Waiting to start"
    done: int = 0
    total: int = 0
    error: Optional[str] = None    # API error code when state == "error"
    created: float = field(default_factory=time.time)
    finished: Optional[float] = None
    result: Optional[dict] = None  # e.g. {"result_url": ...}

    def public(self) -> dict:
        d = asdict(self)
        d.pop("key")
        d["job_id"] = d.pop("id")
        return d


class JobManager:
    def __init__(self, workers: int = 2, keep_seconds: float = 3600):
        self._pool = ThreadPoolExecutor(workers, thread_name_prefix="job")
        self._jobs: dict[str, Job] = {}
        self._by_key: dict[str, str] = {}
        self._lock = threading.Lock()
        self._keep = keep_seconds

    def submit(self, key: str, fn: Callable[[Callable[[str, int, int], None]], dict],
               classify: Callable[[Exception], tuple[str, str]]) -> Job:
        """Run fn(progress) in the background unless an unfinished job with this key exists."""
        with self._lock:
            self._expire()
            jid = self._by_key.get(key)
            if jid and self._jobs[jid].state in ("queued", "running"):
                return self._jobs[jid]
            job = Job(id=uuid.uuid4().hex[:16], key=key)
            self._jobs[job.id] = job
            self._by_key[key] = job.id

        def progress(stage: str, done: int, total: int) -> None:
            job.stage, job.done, job.total = stage, done, total
            job.message = STAGE_TEXT.get(stage, stage)

        def run():
            job.state, job.message = "running", "Starting"
            try:
                job.result = fn(progress)
                job.state, job.message = "done", "Ready"
            except Exception as e:  # noqa: BLE001 - every failure must reach the client as a job state
                job.error, job.message = classify(e)
                job.state = "error"
            job.finished = time.time()

        self._pool.submit(run)
        return job

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def _expire(self) -> None:
        now = time.time()
        for jid in [j.id for j in self._jobs.values() if j.finished and now - j.finished > self._keep]:
            job = self._jobs.pop(jid)
            if self._by_key.get(job.key) == jid:
                del self._by_key[job.key]
