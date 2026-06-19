import { Injectable, InternalServerErrorException } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

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
  async uploadAvatar(file: any, userId: string) {
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
  async uploadReviewImage(file: any, reviewId: string) {
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
  async uploadPlaceImage(file: any, placeId: string) {
    try {
      const optimizedBuffer = await sharp(file.buffer)
        .resize(640, 400, { fit: 'cover' })
        .webp({ quality: 85 })
        .toBuffer();

      // Tạo key: places/{placeId}/{imageId}.webp
      // VD: places/place-uuid-abc123/img-uuid-001.webp
      const imageId = randomUUID();
      const key = `places/${placeId}/${imageId}.webp`;

      const url = await this.pushToR2(optimizedBuffer, key);

      // Lấy mảng image_url hiện tại của địa điểm
      const { data: place, error: fetchError } = await this.supabase
        .schema('travel')
        .from('places')
        .select('image_url')
        .eq('id', placeId)
        .single();

      if (fetchError) throw fetchError;

      const currentImages: string[] = (place as any)?.image_url ?? [];

      // Append URL mới vào mảng và cập nhật lại travel.places
      const { error: updateError } = await this.supabase
        .schema('travel')
        .from('places')
        .update({ image_url: [...currentImages, url] })
        .eq('id', placeId);

      if (updateError) throw updateError;

      return { url };
    } catch (error) {
      throw new InternalServerErrorException('Lỗi upload ảnh địa điểm');
    }
  }
  //  HÀM 4: UPLOAD ẢNH MÓN ĂN
  async uploadFoodImage(file: any, foodId: string) {
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
