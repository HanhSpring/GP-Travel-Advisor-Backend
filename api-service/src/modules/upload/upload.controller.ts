import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFile,
  UploadedFiles,
  Body,
  Req,
  UseGuards,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { UploadService } from './upload.service';
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
    file: any,
    @Req() req: any,
  ) {
    const userId = req.user.userId;
    return this.uploadService.uploadAvatar(file, userId);
  }

  // 2. LUỒNG UPLOAD ẢNH REVIEW (Khách du lịch)
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
    file: any,
    @Body('reviewId') reviewId: string,
  ) {
    return this.uploadService.uploadReviewImage(file, reviewId);
  }

  // 3. LUỒNG UPLOAD ẢNH ĐỊA ĐIỂM (Chủ cơ sở)
  @Post('place')
  @ApiOperation({ summary: 'Upload ảnh địa điểm (tối đa 5 ảnh, resize 640×400, lưu vào travel.places.image_url[])' })
  @ApiBearerAuth('access-token')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['files', 'placeId'],
      properties: {
        files: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          description: 'Ảnh địa điểm (png/jpeg/jpg/webp, tối đa 10MB/ảnh, tối đa 5 ảnh)',
        },
        placeId: {
          type: 'string',
          format: 'uuid',
          description: 'UUID của địa điểm cần gắn ảnh',
          example: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        },
      },
    },
  })
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FilesInterceptor('files', 5))
  async uploadPlace(
    @UploadedFiles(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 }),
          new FileTypeValidator({ fileType: '.(png|jpeg|jpg|webp)' }),
        ],
      }),
    )
    files: any[],
    @Body('placeId') placeId: string,
  ) {
    const urls: string[] = [];
    for (const file of files) {
      const result = await this.uploadService.uploadPlaceImage(file, placeId);
      urls.push(result.url);
    }
    return { urls };
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
    file: any,
    @Body('foodId') foodId: string,
  ) {
    return this.uploadService.uploadFoodImage(file, foodId);
  }
}
