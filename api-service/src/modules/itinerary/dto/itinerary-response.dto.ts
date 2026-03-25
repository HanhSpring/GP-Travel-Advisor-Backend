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