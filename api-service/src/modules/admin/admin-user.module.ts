import { Module } from '@nestjs/common';
import { AdminUserController } from './admin-user.controller';
import { AdminService } from './admin.service';

@Module({
  controllers: [AdminUserController],
  providers: [AdminService],
})
export class AdminUserModule {}
