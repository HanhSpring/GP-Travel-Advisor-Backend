import {
  Controller,
  Logger,
  Post,
  UseInterceptors,
  UploadedFile,
  Body,
  Req,
  UseGuards,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UploadService } from './upload.service';
import { CreateReviewPresignedUrlsDto } from './dto/create-review-presigned-urls.dto';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('Upload Resources')
@Controller('upload')
export class UploadController {
  private readonly logger = new Logger(UploadController.name);

  constructor(private readonly uploadService: UploadService) {}

  // 1. LUỒNG UPLOAD AVATAR
  @Post('avatar')
  @ApiOperation({ summary: 'Upload user avatar' })
  @ApiBearerAuth('access-token')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file'))
  async uploadAvatar(
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 2 * 1024 * 1024 }),
          new FileTypeValidator({ fileType: '.(png|jpeg|jpg|webp)' }),
        ],
      }),
    )
    file: Express.Multer.File,
    @Req() req: any,
  ) {
    const userId = req.user.userId;
    return this.uploadService.uploadAvatar(file, userId);
  }

  // 2. LUỒNG UPLOAD ẢNH REVIEW (Khách du lịch)
  @Post('reviews/presigned-urls')
  @ApiOperation({ summary: 'Create presigned R2 upload URLs for review media' })
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard)
  async createReviewPresignedUrls(
    @Body() dto: CreateReviewPresignedUrlsDto,
    @Req() req: any,
  ) {
    try {
      return await this.uploadService.createReviewPresignedUrls(
        dto,
        req.user.userId,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;

      this.logger.error(
        `POST /upload/reviews/presigned-urls failed: ${message} | context=${JSON.stringify(
          {
            userId: req.user?.userId,
            scope: dto.scope,
            itineraryId: dto.itinerary_id,
            itineraryDetailId: dto.itinerary_detail_id,
            fileCount: dto.files?.length ?? 0,
            contentTypes: dto.files?.map((file) => file.content_type) ?? [],
            totalSize:
              dto.files?.reduce((sum, file) => sum + file.size, 0) ?? 0,
          },
        )}`,
        stack,
      );

      throw error;
    }
  }

  // 3. LUỒNG UPLOAD ẢNH REVIEW (Khách du lịch - multipart fallback)
  @Post('review')
  @UseInterceptors(FileInterceptor('file'))
  async uploadReview(
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 }),
          new FileTypeValidator({ fileType: '.(png|jpeg|jpg|webp)' }),
        ],
      }),
    )
    file: Express.Multer.File,
    @Body('reviewId') reviewId: string,
  ) {
    return this.uploadService.uploadReviewImage(file, reviewId);
  }

  // 3. LUỒNG UPLOAD ẢNH ĐỊA ĐIỂM (Chủ cơ sở)
  @Post('place')
  @UseInterceptors(FileInterceptor('file'))
  async uploadPlace(
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 }),
          new FileTypeValidator({ fileType: 'image/*' }),
        ],
      }),
    )
    file: Express.Multer.File,
    @Body('placeId') placeId: string,
  ) {
    return this.uploadService.uploadPlaceImage(file, placeId);
  }

  // 4. LUỒNG UPLOAD ẢNH MÓN ĂN
  @Post('food')
  @UseInterceptors(FileInterceptor('file'))
  async uploadFood(
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 }),
          new FileTypeValidator({ fileType: 'image/*' }),
        ],
      }),
    )
    file: Express.Multer.File,
    @Body('foodId') foodId: string,
  ) {
    return this.uploadService.uploadFoodImage(file, foodId);
  }
}
