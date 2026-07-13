"""Coordination primitives for mutually exclusive heavyweight ML runtimes."""

from threading import Lock


# Repeated calls within one workload keep their cache; switching between BGE
# and review filtering evicts the other heavyweight cache under this lock.
heavy_model_lock = Lock()
