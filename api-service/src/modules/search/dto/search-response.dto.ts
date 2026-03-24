import { ApiProperty } from '@nestjs/swagger'

export class AutocompleteItemDto {

  @ApiProperty({ nullable: true })
  id: string

  @ApiProperty()
  name: string

  @ApiProperty()
  type: string

  @ApiProperty()
  score: number
}

export class SearchResultDto {

  @ApiProperty({ nullable: true })
  id: string

  @ApiProperty()
  name: string

  @ApiProperty()
  address: string

  @ApiProperty()
  city: string

  @ApiProperty()
  rating: number

  @ApiProperty()
  type: string

  @ApiProperty()
  score: number
}