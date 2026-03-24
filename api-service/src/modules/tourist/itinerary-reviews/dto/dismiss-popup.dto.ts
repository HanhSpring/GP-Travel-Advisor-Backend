import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class DismissItineraryReviewPopupDto {
  @ApiProperty({
    example: '2c2caf9e-1fc9-4065-a280-45d8508458c7',
    description: 'Tourist user id',
  })
  @IsUUID('4')
  tourist_id: string;

  @ApiProperty({
    example: '95e8ed23-4b8f-4ce4-b508-95fb4ce6e81f',
    description: 'Itinerary id',
  })
  @IsUUID('4')
  itinerary_id: string;
}
