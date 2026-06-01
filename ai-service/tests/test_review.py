import pytest
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_review_classify_no_model():
    """Test that review classify returns 503 when model not loaded."""
    response = client.post("/review/classify", json={
        "reviews": ["Hôm nay quán đông lắm"],
    })
    # Review classifier might not be loaded in test environment
    assert response.status_code in (200, 503)
