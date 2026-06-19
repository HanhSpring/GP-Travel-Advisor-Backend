import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { CreateReviewPresignedUrlsDto } from './dto/create-review-presigned-urls.dto';

type ReviewMediaType = 'image' | 'video';

@Injectable()
export class UploadService {
  private s3Client: S3Client;
  private supabase: SupabaseClient;

  constructor(private configService: ConfigService) {
    // Khởi tạo R2 Client (dùng SDK của S3)
    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: this.configService.get('CLOUDFLARE_R2_ENDPOINT'),
      credentials: {
        accessKeyId:
          this.configService.get<string>('CLOUDFLARE_R2_ACCESS_KEY_ID') || '',
        secretAccessKey:
          this.configService.get<string>('CLOUDFLARE_R2_SECRET_ACCESS_KEY') ||
          '',
      },
    });
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL')?.trim();
    const supabaseKey = this.configService.get<string>('SUPABASE_KEY')?.trim();

    if (!supabaseUrl || !supabaseKey) {
      throw new Error(
        'Missing Supabase env in UploadService: SUPABASE_URL and SUPABASE_KEY',
      );
    }

    this.supabase = createClient(supabaseUrl, supabaseKey);
  }

  // --- HÀM 1: UPLOAD AVATAR (Cắt vuông, tập trung vào tâm) ---
  async createReviewPresignedUrls(
    dto: CreateReviewPresignedUrlsDto,
    touristId: string,
  ) {
    if (!touristId) {
      throw new BadRequestException('tourist_id is required');
    }

    if (!dto.files?.length) {
      throw new BadRequestException('At least one file is required');
    }

    if (dto.files.length > 6) {
      throw new BadRequestException(
        'Review media upload is limited to 6 files per request',
      );
    }

    await this.assertReviewMediaScopeAccess(dto, touristId);

    const bucketName = this.configService.get<string>(
      'CLOUDFLARE_R2_BUCKET_NAME',
    );
    const publicR2Url = this.configService
      .get<string>('CLOUDFLARE_R2_PUBLIC_URL')
      ?.replace(/\/+$/, '');

    if (!bucketName || !publicR2Url) {
      throw new InternalServerErrorException(
        'Missing Cloudflare R2 bucket or public URL configuration',
      );
    }

    const expiresInSeconds = 15 * 60;
    const items = await Promise.all(
      dto.files.map(async (file, index) => {
        const media = this.getReviewMediaUploadInfo(file.content_type);
        this.validateReviewMediaFile(file.size, media.mediaType);

        const objectKey = this.buildReviewMediaObjectKey({
          scope: dto.scope,
          itineraryId: dto.itinerary_id,
          itineraryDetailId: dto.itinerary_detail_id,
          mediaType: media.mediaType,
          extension: media.extension,
        });

        const command = new PutObjectCommand({
          Bucket: bucketName,
          Key: objectKey,
          ContentType: file.content_type,
          ContentLength: file.size,
        });

        return {
          upload_url: await getSignedUrl(this.s3Client, command, {
            expiresIn: expiresInSeconds,
          }),
          object_key: objectKey,
          public_url: `${publicR2Url}/${objectKey}`,
          media_type: media.mediaType,
          sort_order: file.sort_order ?? index,
          expires_in_seconds: expiresInSeconds,
        };
      }),
    );

    return { items };
  }

  private async assertReviewMediaScopeAccess(
    dto: CreateReviewPresignedUrlsDto,
    touristId: string,
  ) {
    const { data: itinerary, error: itineraryError } = await this.supabase
      .schema('travel')
      .from('itineraries')
      .select('id')
      .eq('id', dto.itinerary_id)
      .eq('creator_id', touristId)
      .maybeSingle<{ id: string }>();

    if (itineraryError) {
      throw new InternalServerErrorException(itineraryError.message);
    }

    if (!itinerary) {
      throw new NotFoundException('Itinerary not found for this tourist');
    }

    if (dto.scope !== 'place') {
      return;
    }

    if (!dto.itinerary_detail_id) {
      throw new BadRequestException(
        'itinerary_detail_id is required for place review media',
      );
    }

    const { data: detail, error: detailError } = await this.supabase
      .schema('travel')
      .from('itinerary_details')
      .select('id')
      .eq('id', dto.itinerary_detail_id)
      .eq('itinerary_id', dto.itinerary_id)
      .maybeSingle<{ id: string }>();

    if (detailError) {
      throw new InternalServerErrorException(detailError.message);
    }

    if (!detail) {
      throw new BadRequestException(
        'itinerary_detail_id does not belong to this itinerary',
      );
    }
  }

  private getReviewMediaUploadInfo(contentType: string): {
    mediaType: ReviewMediaType;
    extension: string;
  } {
    const normalizedContentType = contentType.toLowerCase().trim();
    const imageTypes: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
    };
    const videoTypes: Record<string, string> = {
      'video/mp4': 'mp4',
      'video/quicktime': 'mov',
    };

    if (imageTypes[normalizedContentType]) {
      return {
        mediaType: 'image',
        extension: imageTypes[normalizedContentType],
      };
    }

    if (videoTypes[normalizedContentType]) {
      return {
        mediaType: 'video',
        extension: videoTypes[normalizedContentType],
      };
    }

    throw new BadRequestException(
      `Unsupported review media content type: ${contentType}`,
    );
  }

  private validateReviewMediaFile(size: number, mediaType: ReviewMediaType) {
    const maxImageSizeBytes = 2 * 1024 * 1024;
    const maxVideoSizeBytes = 20 * 1024 * 1024;
    const maxSize =
      mediaType === 'image' ? maxImageSizeBytes : maxVideoSizeBytes;

    if (size > maxSize) {
      throw new BadRequestException(
        `${mediaType} exceeds max upload size of ${maxSize} bytes`,
      );
    }
  }

  private buildReviewMediaObjectKey(params: {
    scope: 'itinerary' | 'place';
    itineraryId: string;
    itineraryDetailId?: string;
    mediaType: ReviewMediaType;
    extension: string;
  }) {
    const folder = params.mediaType === 'image' ? 'images' : 'videos';
    const id = randomUUID();

    if (params.scope === 'place') {
      return [
        'reviews',
        'itinerary-details',
        params.itineraryDetailId,
        folder,
        `${id}.${params.extension}`,
      ].join('/');
    }

    return [
      'reviews',
      'itineraries',
      params.itineraryId,
      folder,
      `${id}.${params.extension}`,
    ].join('/');
  }

  async uploadAvatar(file: Express.Multer.File, userId: string) {
    try {
      const { data: user } = await this.supabase
        .from('users')
        .select('avatar_url')
        .eq('id', userId)
        .single();

      const optimizedBuffer = await sharp(file.buffer)
        .resize(400, 400, { fit: 'cover', position: 'entropy' })
        .webp({ quality: 80 })
        .toBuffer();

      const fileName = `avatars/${userId}-${Date.now()}.webp`;
      const url = await this.pushToR2(optimizedBuffer, fileName);

      await this.supabase.rpc('update_user_avatar', {
        p_user_id: userId,
        p_avatar_url: url,
      });
      if (user?.avatar_url) {
        await this.deleteFromR2(user.avatar_url);
      }

      return { url };
    } catch (error) {
      console.log('--- DEBUG R2 ERROR ---');
      console.log('Code:', error.code);
      console.log('Message:', error.message);
      console.log('-----------------------');
      throw new InternalServerErrorException(error.message);
    }
  }

  //  HÀM 2: UPLOAD REVIEW
  async uploadReviewImage(file: Express.Multer.File, reviewId: string) {
    try {
      const optimizedBuffer = await sharp(file.buffer)
        .resize(1200, null, { fit: 'inside' })
        .webp({ quality: 85 })
        .toBuffer();

      const fileName = `reviews/rev-${reviewId}-${Date.now()}.webp`;
      const url = await this.pushToR2(optimizedBuffer, fileName);

      await this.supabase.from('review_images').insert({
        review_id: reviewId,
        image_url: url,
      });

      return { url };
    } catch (error) {
      throw new InternalServerErrorException('Lỗi upload ảnh review');
    }
  }

  //  HÀM 3: UPLOAD ẢNH ĐỊA ĐIỂM
  async uploadPlaceImage(file: Express.Multer.File, placeId: string) {
    try {
      const optimizedBuffer = await sharp(file.buffer)
        .resize(1920, 1080, { fit: 'inside' })
        .webp({ quality: 90 })
        .toBuffer();

      const fileName = `places/place-${placeId}-${Date.now()}.webp`;
      const url = await this.pushToR2(optimizedBuffer, fileName);

      // Lưu URL vào bảng travel.place_images
      await this.supabase
        .schema('travel')
        .from('place_images')
        .insert({ place_id: placeId, image_url: url });

      return { url };
    } catch (error) {
      throw new InternalServerErrorException('Lỗi upload ảnh địa điểm');
    }
  }
  //  HÀM 4: UPLOAD ẢNH MÓN ĂN
  async uploadFoodImage(file: Express.Multer.File, foodId: string) {
    try {
      const optimizedBuffer = await sharp(file.buffer)
        .resize(800, 600, {
          fit: 'cover',
          position: 'centre',
        })
        .webp({ quality: 85 })
        .toBuffer();

      const fileName = `foods/food-${foodId}-${Date.now()}.webp`;
      const url = await this.pushToR2(optimizedBuffer, fileName);

      await this.supabase
        .from('food_items')
        .update({ image_url: url })
        .eq('id', foodId);

      return { success: true, url };
    } catch (error) {
      console.error('Food upload error:', error);
      throw new InternalServerErrorException('Lỗi upload ảnh món ăn');
    }
  }

  // Hàm bổ trợ để đẩy lên R2
  private async pushToR2(buffer: Buffer, key: string): Promise<string> {
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.configService.get('CLOUDFLARE_R2_BUCKET_NAME'),
        Key: key,
        Body: buffer,
        ContentType: 'image/webp',
      }),
    );
    return `${this.configService.get('CLOUDFLARE_R2_PUBLIC_URL')}/${key}`;
  }

  private getRelativeKey(url: string): string {
    const publicUrl = this.configService.get('CLOUDFLARE_R2_PUBLIC_URL');
    // Loại bỏ phần domain để lấy key
    return url.replace(`${publicUrl}/`, '');
  }

  private async deleteFromR2(fileUrl: string) {
    try {
      const key = this.getRelativeKey(fileUrl);
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.configService.get('CLOUDFLARE_R2_BUCKET_NAME'),
          Key: key,
        }),
      );
      console.log(`Deleted old file: ${key}`);
    } catch (error) {
      console.error('Failed to delete old file from R2:', error);
    }
  }
}
