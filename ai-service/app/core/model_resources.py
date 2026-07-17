"""Coordinate heavyweight ML workloads without serializing embeddings."""

from __future__ import annotations

import time
from contextlib import contextmanager
from threading import Condition
from typing import Iterator


class ModelResourceBusyError(RuntimeError):
    """Raised when an incompatible heavyweight workload owns the memory budget."""


class HeavyModelCoordinator:
    """A writer-preferring readers/writer gate.

    Embeddings are readers and may run concurrently.  The review pipeline is a
    writer because its transformer bundle cannot coexist with BGE-M3.
    """

    def __init__(self) -> None:
        self._condition = Condition()
        self._embedding_count = 0
        self._pipeline_active = False
        self._pipeline_waiters = 0

    def _wait_for(self, predicate, timeout: float, busy_message: str) -> None:
        deadline = time.monotonic() + max(0.0, timeout)
        while not predicate():
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not self._condition.wait(remaining):
                raise ModelResourceBusyError(busy_message)

    @contextmanager
    def embedding(self, timeout: float) -> Iterator[None]:
        with self._condition:
            self._wait_for(
                lambda: not self._pipeline_active and self._pipeline_waiters == 0,
                timeout,
                "AI service is busy running the review pipeline; retry embedding shortly.",
            )
            self._embedding_count += 1
        try:
            yield
        finally:
            with self._condition:
                self._embedding_count -= 1
                self._condition.notify_all()

    @contextmanager
    def pipeline(self, timeout: float) -> Iterator[None]:
        with self._condition:
            self._pipeline_waiters += 1
            try:
                self._wait_for(
                    lambda: not self._pipeline_active and self._embedding_count == 0,
                    timeout,
                    "Embedding traffic is busy; retry the review pipeline later.",
                )
                self._pipeline_active = True
            finally:
                self._pipeline_waiters -= 1
                self._condition.notify_all()
        try:
            yield
        finally:
            with self._condition:
                self._pipeline_active = False
                self._condition.notify_all()


heavy_model_coordinator = HeavyModelCoordinator()
