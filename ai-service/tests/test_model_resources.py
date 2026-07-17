import threading

import pytest

from app.core.model_resources import HeavyModelCoordinator, ModelResourceBusyError


def test_embeddings_can_enter_concurrently():
    coordinator = HeavyModelCoordinator()
    entered = threading.Event()

    def enter_embedding():
        with coordinator.embedding(timeout=0.1):
            entered.set()

    with coordinator.embedding(timeout=0.1):
        thread = threading.Thread(target=enter_embedding)
        thread.start()
        assert entered.wait(0.5)
        thread.join()


def test_embedding_fails_fast_while_pipeline_is_active():
    coordinator = HeavyModelCoordinator()

    with coordinator.pipeline(timeout=0.1):
        with pytest.raises(ModelResourceBusyError):
            with coordinator.embedding(timeout=0.01):
                pass
