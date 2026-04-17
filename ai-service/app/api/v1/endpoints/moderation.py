from fastapi import APIRouter
from pydantic import BaseModel
from app.services.moderation_service import moderation_service

router = APIRouter()

class ModerationRequest(BaseModel):
    text: str

class ModerationResponse(BaseModel):
    flagged: bool
    categories: dict

@router.post("/check", response_model=ModerationResponse)
async def check_moderation(request: ModerationRequest):
    """
    Endpoint kiểm duyệt nội dung văn bản.
    Sử dụng OpenAI Moderation API để phát hiện ngôn từ lăng mạ, tục tĩu, phản cảm.
    """
    is_flagged, categories = await moderation_service.check_content(request.text)
    
    return {
        "flagged": is_flagged,
        "categories": categories
    }
