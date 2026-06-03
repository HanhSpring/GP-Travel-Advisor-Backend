"""
Travel Advisor AI Service
Main FastAPI application for AI-powered travel recommendations
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
import os
import logging
from dotenv import load_dotenv

from app.services.routing import optimize_route

# Load environment variables
load_dotenv()

# Cấu hình logging chuẩn cho toàn bộ service
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

# Initialize FastAPI app
app = FastAPI(
    title="Travel Advisor AI Service",
    description=(
        "AI-powered personalized travel recommendations\n\n"
        "## Tính năng\n"
        "- **Tối ưu lịch trình**: Greedy TSPTW — sắp xếp địa điểm theo thứ tự tối ưu nhất\n"
        "- **Kiểm tra xung đột**: Validate giờ ghim trước khi lưu DB\n"
    ),
    version="1.0.0",
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Cấu hình chặt hơn cho production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Import và đăng ký router v1 ─────────────────────────────────
from app.api.v1.api_router import api_router
app.include_router(api_router)


# Pydantic models
class HealthResponse(BaseModel):
    status: str
    service: str
    version: str


class RecommendationRequest(BaseModel):
    user_id: str
    preferences: Optional[dict] = None
    budget: Optional[float] = None
    destination: Optional[str] = None


class RecommendationResponse(BaseModel):
    recommendations: List[dict]
    confidence_score: float

class RouteRequest(BaseModel):
    locations: List[dict]

class RouteResponse(BaseModel):
    optimized_locations: List[dict]

# Routes
@app.get("/", response_model=HealthResponse)
async def root():
    """Root endpoint - health check"""
    return {
        "status": "healthy",
        "service": "Travel Advisor AI Service",
        "version": "1.0.0"
    }


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Detailed health check endpoint"""
    return {
        "status": "healthy",
        "service": "Travel Advisor AI Service",
        "version": "1.0.0"
    }


@app.post("/api/v1/recommendations", response_model=RecommendationResponse)
async def get_recommendations(_request: RecommendationRequest):
    """
    Get personalized travel recommendations based on user preferences
    
    This is a placeholder endpoint. Implement your AI/ML logic here.
    """
    # TODO: Implement AI recommendation logic
    # This is a mock response for initial setup
    mock_recommendations = [
        {
            "destination": "Paris, France",
            "description": "City of Light with rich culture and history",
            "estimated_cost": 2500.00,
            "best_season": "Spring",
            "activities": ["Eiffel Tower", "Louvre Museum", "Seine River Cruise"]
        },
        {
            "destination": "Tokyo, Japan",
            "description": "Modern metropolis blending tradition and innovation",
            "estimated_cost": 3000.00,
            "best_season": "Spring (Cherry Blossom)",
            "activities": ["Shibuya Crossing", "Senso-ji Temple", "Mount Fuji"]
        }
    ]
    
    return {
        "recommendations": mock_recommendations,
        "confidence_score": 0.85
    }

@app.post("/api/v1/optimize-route", response_model=RouteResponse)
async def api_optimize_route(request: RouteRequest):
    """
    Optimize the itinerary route using OR-Tools (TSP).
    """
    if not request.locations or len(request.locations) == 0:
        return {"optimized_locations": []}
    
    try:
        ordered = optimize_route(request.locations)
        return {"optimized_locations": ordered}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/v1/status")
async def service_status():
    """Get service status and configuration"""
    return {
        "service": "AI Service",
        "status": "online",
        "environment": os.getenv("ENVIRONMENT", "development"),
        "database_connected": False,  # TODO: Implement database connection check
    }


# Run the application
if __name__ == "__main__":
    import uvicorn
    
    port = int(os.getenv("AI_SERVICE_PORT", 8000))
    host = os.getenv("AI_SERVICE_HOST", "0.0.0.0")
    
    uvicorn.run(
        "main:app",
        host=host,
        port=port,
        reload=True,  # Enable auto-reload for development
        log_level="info"
    )
