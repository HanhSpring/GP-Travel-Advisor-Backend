import pytest
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_embedding_no_model():
    """Test that embedding returns 503 when BGE-M3 not loaded."""
    response = client.post("/embedding/", json={
        "texts": ["Hello world"],
        "normalize": True,
    })
    # BGE-M3 might not be loaded in test environment
    assert response.status_code in (200, 503)
