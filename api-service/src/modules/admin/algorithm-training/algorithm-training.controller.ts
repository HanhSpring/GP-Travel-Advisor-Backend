import { randomUUID } from 'crypto';
import { timingSafeEqual } from 'crypto';
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from 'src/common/enum/role.enum';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { AlgorithmTrainingService } from './algorithm-training.service';
import {
  PrepareDatasetRequestDto,
  RunFullTrainingRequestDto,
  TrainingCallbackDto,
  UpdateAlgorithmTrainingScheduleDto,
} from './dto/algorithm-training.dto';

@ApiTags('Admin - Algorithm Training')
@ApiBearerAuth('access-token')
@Controller('admin/algorithm-training')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AlgorithmTrainingController {
  constructor(private readonly service: AlgorithmTrainingService) {}

  @Post(':algorithm/prepare-dataset')
  @ApiOperation({
    summary: 'Export dữ liệu Supabase thật ra R2 (Phase 0)',
    description:
      'Tự động bỏ qua export nếu travel.mv_training_interactions không có gì mới (cùng số lượng ' +
      'và cùng mốc thời gian mới nhất) so với lần export "ready" gần nhất — trả về dataset cũ ' +
      'kèm skipped=true thay vì tốn thời gian export lại. Truyền force=true để luôn export lại.',
  })
  async prepareDataset(
    @Param('algorithm') algorithm: string,
    @Body() dto: PrepareDatasetRequestDto | undefined,
    @Request() req,
  ) {
    this.service.resolveAlgorithmSlug(algorithm);
    return this.service.prepareDataset(algorithm, req.user?.userId, dto?.force ?? false);
  }

  @Post(':algorithm/run-full-training')
  @ApiOperation({ summary: 'Spawn job GPU train thật trên Modal (dùng dataset đã chuẩn bị)' })
  async runFullTraining(
    @Param('algorithm') algorithm: string,
    @Body() dto: RunFullTrainingRequestDto,
    @Request() req,
  ) {
    this.service.resolveAlgorithmSlug(algorithm);
    return this.service.runFullTraining(algorithm, dto ?? {}, req.user?.userId);
  }

  @Get(':algorithm/runs')
  @ApiOperation({ summary: 'Lịch sử job (chuẩn bị dữ liệu / train / promote)' })
  async getRuns(@Param('algorithm') algorithm: string, @Query('limit') limit?: string) {
    this.service.resolveAlgorithmSlug(algorithm);
    return this.service.getRuns(algorithm, limit ? Number(limit) : undefined);
  }

  @Get(':algorithm/versions')
  @ApiOperation({ summary: 'Danh sách model_versions (metrics + trạng thái) để admin so sánh/kích hoạt' })
  async getVersions(@Param('algorithm') algorithm: string) {
    this.service.resolveAlgorithmSlug(algorithm);
    return this.service.getVersions(algorithm);
  }

  @Post(':algorithm/versions/:versionId/promote')
  @ApiOperation({ summary: 'Kích hoạt 1 model_version — hot-reload ai-service, không downtime' })
  async promoteVersion(
    @Param('algorithm') algorithm: string,
    @Param('versionId') versionId: string,
    @Request() req,
  ) {
    this.service.resolveAlgorithmSlug(algorithm);
    return this.service.promoteVersion(algorithm, versionId, req.user?.userId);
  }

  @Get(':algorithm/schedule')
  @ApiOperation({ summary: 'Lấy cấu hình lịch tự động "Chuẩn bị dữ liệu" (KHÔNG tự động train)' })
  async getSchedule(@Param('algorithm') algorithm: string) {
    this.service.resolveAlgorithmSlug(algorithm);
    return this.service.getSchedule(algorithm);
  }

  @Patch(':algorithm/schedule')
  @ApiOperation({ summary: 'Cập nhật lịch tự động "Chuẩn bị dữ liệu"' })
  async updateSchedule(
    @Param('algorithm') algorithm: string,
    @Body() dto: UpdateAlgorithmTrainingScheduleDto,
  ) {
    this.service.resolveAlgorithmSlug(algorithm);
    return this.service.updateSchedule(algorithm, dto);
  }
}

// Controller RIÊNG cho webhook — KHÔNG có @UseGuards (Modal không đăng nhập được), xác thực
// bằng header secret so sánh timingSafeEqual (tránh timing attack), không so sánh string thường.
@ApiTags('Admin - Algorithm Training (webhook)')
@Controller('admin/algorithm-training/webhook')
export class AlgorithmTrainingWebhookController {
  constructor(private readonly service: AlgorithmTrainingService) {}

  @Post('training-callback')
  @ApiOperation({ summary: 'Nội bộ — Modal gọi khi train xong (KHÔNG dùng JWT admin)' })
  async trainingCallback(
    @Body() payload: TrainingCallbackDto,
    @Headers('x-training-callback-secret') secretHeader?: string,
  ) {
    const expected = process.env.TRAINING_CALLBACK_SECRET || '';
    if (!expected || !secretHeader || !this.safeEqual(secretHeader, expected)) {
      throw new UnauthorizedException('Invalid or missing X-Training-Callback-Secret');
    }
    await this.service.handleTrainingCallback(payload);
    return { status: 'ok' };
  }

  /** So sánh 2 chuỗi thời gian không đổi (timing-safe) — độ dài khác nhau vẫn an toàn (đệm
   * bằng UUID ngẫu nhiên để timingSafeEqual không throw vì lệch length). */
  private safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
      // So sánh voi 1 buffer gia (cung do dai) de khong bi ro ri thong tin qua thoi gian phan
      // hoi khi length khac nhau -- van luon tra ve false vi noi dung chac chan khong khop.
      timingSafeEqual(bufA, Buffer.from(randomUUID().padEnd(bufA.length, '0').slice(0, bufA.length)));
      return false;
    }
    return timingSafeEqual(bufA, bufB);
  }
}
