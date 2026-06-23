import { ApiProperty } from '@nestjs/swagger'

class ItineraryItemDto {

  @ApiProperty()
  id: string

  @ApiProperty()
  description: string

  @ApiProperty()
  destination: string

  @ApiProperty()
  start_date: string

  @ApiProperty()
  end_date: string

  @ApiProperty()
  status: string

  @ApiProperty()
  days: number

  @ApiProperty()
  progress: number

  @ApiProperty({ description: 'Tổng số địa điểm (trừ accommodation)' })
  total_locations: number

  @ApiProperty({ description: 'Số địa điểm đã ghé (geofence_visits.status = visited)' })
  visited_locations: number

  @ApiProperty({ type: [String], description: 'Ảnh địa điểm (tối đa 5, từ places.image_url[1])' })
  place_images: string[]

  @ApiProperty({ description: 'Điểm đánh giá tổng thể (null nếu chưa đánh giá)', nullable: true, required: false })
  rating: number | null
}

class StatsDto {

  @ApiProperty()
  total: number

  @ApiProperty()
  completed: number

  @ApiProperty()
  upcoming: number

  @ApiProperty()
  draft: number
}

export class ItineraryResponseDto {

  @ApiProperty({ type: StatsDto })
  stats: StatsDto

  @ApiProperty({ type: [ItineraryItemDto] })
  itineraries: ItineraryItemDto[]
}