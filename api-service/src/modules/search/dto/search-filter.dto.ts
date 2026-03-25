import { IsString } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class SearchFilterDto {

  @ApiProperty({ example: 'ho chi minh' })
  @IsString()
  city: string

  @ApiProperty({ example: 'Restaurant' })
  @IsString()
  category: string
}