import { Module } from '@nestjs/common';
import { AdminUserController } from './admin-user.controller';
import { AdminService } from './admin.service';
import { UploadModule } from '../upload/upload.module';

@Module({
  imports: [UploadModule],
  controllers: [AdminUserController],
  providers: [AdminService],
})
export class AdminUserModule {}
