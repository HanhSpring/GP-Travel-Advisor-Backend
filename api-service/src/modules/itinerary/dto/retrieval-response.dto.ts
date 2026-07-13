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
    description:
      'Cosine similarity score từ pgvector (0→1, cao hơn = liên quan hơn)',
  })
  cosine_score: number;

  @ApiPropertyOptional({
    example: 0.612,
    description:
      'Điểm ranking cuối cùng từ SessionCfReranker (trộn cosine_score + historical_cf_score + ' +
      'session_score + popularity_score, hoặc 2 thành phần rút gọn nếu is_cold_start=true). ' +
      'null nếu SessionCfReranker chưa nạp artifact (ready=false).',
    nullable: true,
  })
  predict_ranking: number | null;

  @ApiPropertyOptional({
    example: false,
    description:
      'true nếu user hoàn toàn không có trong vocab CF (đã train) LẪN không có session gần ' +
      'đây (90 phút) — xem SessionCfReranker.rerank(). Dùng để demo/kiểm chứng cold-start.',
    nullable: true,
  })
  is_cold_start?: boolean | null;

  @ApiPropertyOptional({
    example: 0.734,
    description:
      'Điểm CF dài hạn — dot(P[user], Q[item]) + bias từ Funk-SVD đã train offline ' +
      '(0 nếu user không có trong vocab CF).',
    nullable: true,
  })
  historical_cf_score?: number | null;

  @ApiPropertyOptional({
    example: 0.0,
    description:
      'Điểm phiên tức thời — cosine similarity giữa vector phiên (từ activity_logs 90 phút ' +
      'gần nhất) và item factor của candidate (0 nếu không có hoạt động gần đây).',
    nullable: true,
  })
  session_score?: number | null;

  @ApiPropertyOptional({
    example: 0.42,
    description: 'Điểm độ phổ biến (rating + top-20 lượt ghé thăm theo category).',
    nullable: true,
  })
  popularity_score?: number | null;
}

export class TwoTowerRetrievalResponseDto {
  @ApiProperty({ example: 'Hà Nội', description: 'Tên thành phố điểm đến' })
  destination_name: string;

  @ApiProperty({
    example: 'uuid-city-hanoi',
    description: 'UUID của thành phố điểm đến',
  })
  city_id: string;

  @ApiProperty({ example: 85, description: 'Tổng số candidates tìm được' })
  total_candidates: number;

  @ApiProperty({
    type: [CandidatePlaceDto],
    description:
      'Danh sách top-K địa điểm đã qua SessionCfReranker (nếu artifact sẵn sàng) — sắp xếp ' +
      'theo predict_ranking giảm dần. predict_ranking = null nếu SessionCfReranker chưa nạp.',
  })
  candidates: CandidatePlaceDto[];
}
