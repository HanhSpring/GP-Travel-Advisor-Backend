import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class AiTestService {
  private readonly logger = new Logger(AiTestService.name);

  constructor(private readonly httpService: HttpService) {}

  async testConnection() {
    this.logger.log('Đang gọi thử sang AI Service (FastAPI)...');
    
    try {
      const healthResponse = await firstValueFrom(
        this.httpService.get('http://127.0.0.1:8000/health')
      );
      this.logger.log('✅ Gọi Health Check thành công');

      const recommendResponse = await firstValueFrom(
        this.httpService.post('http://127.0.0.1:8000/recommend/', {
          user_id: "test_user_nest",
          top_k: 5,
          strategy: "two_tower"
        })
      );
      this.logger.log('✅ Gọi Recommend thành công');

      return {
        message: 'Kết nối NestJS -> FastAPI thành công!',
        fastapi_health: healthResponse.data,
        fastapi_recommend: recommendResponse.data
      };
    } catch (error) {
      if (error.response) {
        this.logger.warn(`FastAPI trả về lỗi với HTTP Status: ${error.response.status}`);
        return {
          message: 'Kết nối thành công nhưng FastAPI báo lỗi logic (VD: chưa có model weights)',
          status: error.response.status,
          data: error.response.data
        };
      }
      
      this.logger.error(`Không thể kết nối đến FastAPI: ${error.message}`);
      return { 
        message: 'Không thể kết nối đến FastAPI. Hãy kiểm tra xem server uvicorn đã chạy chưa.', 
        error: error.message 
      };
    }
  }
}
