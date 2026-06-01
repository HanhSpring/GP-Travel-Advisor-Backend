import pytest
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_recommend_invalid_strategy():
    """Test that invalid strategy returns 400."""
    response = client.post("/recommend/", json={
        "user_id": "u_001",
        "top_k": 5,
        "strategy": "invalid_strategy",
    })
    assert response.status_code == 400


def test_recommend_two_tower_not_implemented():
    """Test that two_tower returns 501 or 503 when weights not loaded."""
    response = client.post("/recommend/", json={
        "user_id": "u_001",
        "top_k": 5,
        "strategy": "two_tower",
    })
    assert response.status_code in (501, 503)
