from google import genai
from google.genai import types
import os
import json
import logging

logger = logging.getLogger(__name__)

class ModerationService:
    def __init__(self):
        # Sử dụng SDK mới 'google-genai' thay thế cho 'google-generativeai' đã bị deprecated
        self.api_key = os.getenv("GOOGLE_API_KEY")
        if not self.api_key:
            logger.warning("GOOGLE_API_KEY chưa được cấu hình. Tính năng kiểm duyệt sẽ luôn trả về False.")
            self.client = None
        else:
            # Client mới từ SDK google-genai
            self.client = genai.Client(api_key=self.api_key)
            self.model_id = "gemini-flash-latest"

    async def check_content(self, text: str) -> tuple[bool, dict]:
        """
        Kiểm tra nội dung văn bản qua Google Gemini 1.5 Flash (Sử dụng SDK google-genai mới nhất API v1).
        """
        if not self.client:
            return False, {}

        if not text or len(text.strip()) < 2:
            return False, {}

        try:
            # Gộp System Instruction và Nội dung vào chung 1 prompt để tương thích API v1
            prompt = (
                "Bạn là một chuyên gia kiểm soát nội dung cho ứng dụng du lịch Việt Nam. "
                "Nhiệm vụ của bạn là phân tích bình luận sau để phát hiện nội dung vi phạm.\n"
                "Các loại vi phạm: lăng mạ, xúc phạm, chửi thề, tục tĩu (viết tắt đm, vcl, cc...), "
                "phân biệt vùng miền, bạo lực, phản cảm.\n\n"
                'TRẢ VỀ DUY NHẤT MỘT ĐỐI TƯỢNG JSON TỰ KHOÁ (không kèm giải thích), dạng:\n'
                '{"flagged": true/false, "reason": "lý do tiếng Việt (nếu flagged, ngược lại để trống)"}\n\n'
                f'Nội dung cần kiểm duyệt: "{text}"'
            )

            response = self.client.models.generate_content(
                model=self.model_id,
                contents=prompt
            )
            
            # Xóa các ký tự markdown (```json ... ```) nếu Gemini có trả về
            raw_text = response.text.strip()
            if raw_text.startswith("```json"):
                raw_text = raw_text[7:]
            if raw_text.startswith("```"):
                raw_text = raw_text[3:]
            if raw_text.endswith("```"):
                raw_text = raw_text[:-3]
            raw_text = raw_text.strip()

            # Giải mã kết quả JSON
            try:
                data = json.loads(raw_text)
                is_flagged = data.get("flagged", False)
                reason = data.get("reason", "")
                
                return is_flagged, {"reason": reason}
            except (json.JSONDecodeError, AttributeError):
                logger.error(f"[ModerationService] Gemini returned invalid output: {response.text}")
                return False, {}

        except Exception as e:
            logger.error(f"[ModerationService] Lỗi khi gọi Gemini API: {str(e)}")
            # Fail-safe: Mặc định cho qua nếu API gặp lỗi
            return False, {}

# Singleton instance
moderation_service = ModerationService()
