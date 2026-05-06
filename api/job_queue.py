import queue
import threading
import logging
import time
from typing import Callable, Any, Dict, List

log = logging.getLogger("chess_coach.job_queue")

class JobQueue:
    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super(JobQueue, cls).__new__(cls)
                    cls._instance._queue = queue.Queue()
                    cls._instance._worker_thread = None
                    cls._instance._stop_event = threading.Event()
                    cls._instance._running_job_lock = threading.Lock()
                    cls._instance._running_job_info: Dict[str, Any] = {}
                    log.info("JobQueue initialized.")
        return cls._instance

    def _worker(self):
        log.info("JobQueue worker started.")
        while not self._stop_event.is_set():
            try:
                job_func, job_args, job_kwargs, job_id = self._queue.get(timeout=1)
                log.info(f"Processing job {job_id}...")
                with self._running_job_lock:
                    self._running_job_info = {"id": job_id, "status": "running", "start_time": time.time()}
                
                try:
                    job_func(*job_args, **job_kwargs)
                    log.info(f"Job {job_id} completed successfully.")
                except Exception as e:
                    log.error(f"Job {job_id} failed with error: {e}", exc_info=True)
                finally:
                    with self._running_job_lock:
                        self._running_job_info = {} # Clear running job info
                    self._queue.task_done()

            except queue.Empty:
                continue
            except Exception as e:
                log.error(f"JobQueue worker encountered an unexpected error: {e}", exc_info=True)

        log.info("JobQueue worker stopped.")

    def start_worker(self):
        if self._worker_thread is None or not self._worker_thread.is_alive():
            self._stop_event.clear()
            self._worker_thread = threading.Thread(target=self._worker, daemon=True)
            self._worker_thread.start()
            log.info("JobQueue worker thread started.")
        else:
            log.warning("JobQueue worker thread is already running.")

    def stop_worker(self):
        if self._worker_thread and self._worker_thread.is_alive():
            log.info("Stopping JobQueue worker...")
            self._stop_event.set()
            self._worker_thread.join(timeout=5) # Wait for thread to finish
            if self._worker_thread.is_alive():
                log.warning("JobQueue worker thread did not terminate gracefully.")
            self._worker_thread = None
        else:
            log.warning("JobQueue worker thread is not running.")

    def enqueue_job(self, job_func: Callable, *args, job_id: str = None, **kwargs):
        if not job_id:
            job_id = f"{job_func.__name__}-{time.time()}"
        log.info(f"Enqueuing job {job_id}...")
        self._queue.put((job_func, args, kwargs, job_id))

    def get_current_job_status(self) -> Dict[str, Any]:
        with self._running_job_lock:
            if self._running_job_info:
                return self._running_job_info
            return {"status": "idle", "queue_size": self._queue.qsize()}

    def is_job_type_active(self, prefix: str) -> bool:
        with self._running_job_lock:
            if self._running_job_info and self._running_job_info.get("id", "").startswith(prefix):
                return True
        # Check jobs in queue
        for item in list(self._queue.queue): # Iterate over a copy to avoid issues if queue changes
            job_func, job_args, job_kwargs, job_id = item
            if job_id and job_id.startswith(prefix):
                return True
        return False

# Singleton instance
job_queue = JobQueue()
