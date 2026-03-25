import { IsUUID } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class GetItinerariesDto {

  @ApiProperty({
    example: 'b3c8f5c1-1234-4c9a-9abc-123456789abc'
  })
  @IsUUID()
  userId: string
}