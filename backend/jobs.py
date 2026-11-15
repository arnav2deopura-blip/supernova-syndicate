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
from . import cache

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
    owner: str = "anonymous"
    created: float = field(default_factory=time.time)
    finished: Optional[float] = None
    result: Optional[dict] = None  # e.g. {"result_url": ...}

    def public(self) -> dict:
        d = asdict(self)
        d.pop("key")
        d.pop("owner")
        d["job_id"] = d.pop("id")
        return d


class QueueFull(RuntimeError):
    pass


class JobManager:
    def __init__(self, workers: int = 2, keep_seconds: float = 3600, capacity: int = 8):
        self._pool = ThreadPoolExecutor(workers, thread_name_prefix="job")
        self._jobs: dict[str, Job] = {}
        self._by_key: dict[str, str] = {}
        self._lock = threading.Lock()
        self._keep = keep_seconds
        self._capacity = capacity

    def submit(self, key: str, fn: Callable[[Callable[[str, int, int], None]], dict],
               classify: Callable[[Exception], tuple[str, str]], owner: str = "anonymous") -> Job:
        """Run fn(progress) in the background unless an unfinished job with this key exists."""
        with self._lock:
            self._expire()
            jid = self._by_key.get(key)
            if jid and self._jobs[jid].state in ("queued", "running"):
                return self._jobs[jid]
            if sum(j.state in ('queued','running') for j in self._jobs.values()) >= self._capacity:
                raise QueueFull('The processing queue is full. Please retry in 30 seconds.')
            if sum(j.owner == owner and j.state in ('queued','running') for j in self._jobs.values()) >= max(2,self._capacity//2):
                raise QueueFull('This connection already has several analyses queued. Wait for one to finish, then retry.')
            job = Job(id=uuid.uuid4().hex[:16], key=key, owner=owner)
            self._jobs[job.id] = job
            self._by_key[key] = job.id

        def progress(stage: str, done: int, total: int) -> None:
            job.stage, job.done, job.total = stage, done, total
            job.message = STAGE_TEXT.get(stage, stage)
            self._persist(job)

        def run():
            if time.time() - job.created > 300:
                job.state, job.error, job.message = 'error', 'busy', 'The queued job expired. Repeat the search.'
                job.finished = time.time(); self._persist(job); return
            job.state, job.message = "running", "Starting"
            try:
                job.result = fn(progress)
                job.state, job.message = "done", "Ready"
            except Exception as e:  # noqa: BLE001 - every failure must reach the client as a job state
                job.error, job.message = classify(e)
                job.state = "error"
            job.finished = time.time()
            self._persist(job)

        self._persist(job)
        self._pool.submit(run)
        return job

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            self._expire()
            job = self._jobs.get(job_id)
            if job is not None: return job
            saved=cache.get_json('job_'+job_id)
            if not saved: return None
            saved['id']=saved.pop('job_id')
            job=Job(key='',**saved)
            if time.time()-job.created > self._keep: return None
            if job.state in ('queued','running'):
                job.state='error';job.error='upstream_unavailable';job.message='The server restarted. Repeat the search to resume from cached downloads.'
            return job

    @staticmethod
    def _persist(job):
        cache.put_json('job_'+job.id,job.public())

    def _expire(self) -> None:
        now = time.time()
        for jid in [j.id for j in self._jobs.values() if j.finished and now - j.finished > self._keep]:
            job = self._jobs.pop(jid)
            if self._by_key.get(job.key) == jid:
                del self._by_key[job.key]
