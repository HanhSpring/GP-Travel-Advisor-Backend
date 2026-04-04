import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFile,
  Body,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UploadService } from './upload.service';
import { ApiConsumes, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('Upload Resources')
@Controller('upload')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  // 1. LUỒNG UPLOAD AVATAR
  @Post('avatar')
  @ApiOperation({ summary: 'Upload user avatar' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
        userId: {
          type: 'string',
        },
      },
    },
  })
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
    @Body('userId') userId: string,
  ) {
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
