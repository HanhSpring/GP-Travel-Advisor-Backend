import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CandidatePlaceDto {
  @ApiProperty({ example: 'uuid-place-1', description: 'Supabase place UUID' })
  place_id: string;

  @ApiProperty({ example: 'Hồ Hoàn Kiếm', description: 'Tên địa điểm' })
  place_name: string;

  @ApiPropertyOptional({ example: 'Đinh Tiên Hoàng, Hoàn Kiếm, Hà Nội' })
  address: string | null;

  @ApiPropertyOptional({ example: 'https://example.com/image.jpg' })
  image_url: string | null;

  @ApiProperty({ example: 'attraction', description: 'Nhóm loại địa điểm' })
  category: string;

  @ApiProperty({
    example: 0.923,
    description: 'Cosine similarity score từ pgvector (0→1, cao hơn = liên quan hơn)',
  })
  cosine_score: number;

  @ApiPropertyOptional({
    example: null,
    description: 'Điểm ranking từ model thứ 2 (null — sẽ được thành viên khác điền sau)',
    nullable: true,
  })
  predict_ranking: number | null;
}

export class TwoTowerRetrievalResponseDto {
  @ApiProperty({ example: 'Hà Nội', description: 'Tên thành phố điểm đến' })
  destination_name: string;

  @ApiProperty({ example: 'uuid-city-hanoi', description: 'UUID của thành phố điểm đến' })
  city_id: string;

  @ApiProperty({ example: 85, description: 'Tổng số candidates tìm được' })
  total_candidates: number;

  @ApiProperty({
    type: [CandidatePlaceDto],
    description:
      'Danh sách top-K địa điểm theo cosine score. ' +
      'predict_ranking = null cho đến khi ranking model được tích hợp.',
  })
  candidates: CandidatePlaceDto[];
}
