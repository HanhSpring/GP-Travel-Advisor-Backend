import { ApiProperty } from '@nestjs/swagger';

export class AutocompleteItemDto {
  @ApiProperty({ nullable: true })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ description: "'place' | 'city'" })
  type: string;

  @ApiProperty({ description: 'Ảnh đại diện (rỗng với city)' })
  image: string;

  @ApiProperty({ description: 'Tên thành phố của địa điểm' })
  city: string;

  @ApiProperty()
  rating: number;

  @ApiProperty()
  score: number;
}

export class SearchResultDto {
  @ApiProperty({ nullable: true })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  address: string;

  @ApiProperty()
  city: string;

  @ApiProperty()
  rating: number;

  @ApiProperty()
  type: string;

  @ApiProperty()
  score: number;
}
