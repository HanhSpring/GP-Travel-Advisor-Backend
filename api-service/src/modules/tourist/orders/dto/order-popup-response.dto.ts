import { ApiProperty } from '@nestjs/swagger';

class OrderPopupPlaceDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ nullable: true })
  address: string | null;

  @ApiProperty({ nullable: true })
  city: string | null;
}

class OrderPopupSuggestionDto {
  @ApiProperty()
  title: string;

  @ApiProperty()
  message: string;
}

class OrderPopupActionDto {
  @ApiProperty()
  label: string;

  @ApiProperty()
  target: string;
}

class OrderPopupActionsDto {
  @ApiProperty({ type: OrderPopupActionDto })
  primary: OrderPopupActionDto;

  @ApiProperty({ type: OrderPopupActionDto })
  secondary: OrderPopupActionDto;
}

class OrderPopupMetaDto {
  @ApiProperty()
  estimated_wait_minutes: number;

  @ApiProperty()
  rating: number;

  @ApiProperty()
  review_count: number;
}

export class OrderPopupResponseDto {
  @ApiProperty({ type: OrderPopupPlaceDto })
  place: OrderPopupPlaceDto;

  @ApiProperty({ type: OrderPopupSuggestionDto })
  suggestion: OrderPopupSuggestionDto;

  @ApiProperty({ type: OrderPopupActionsDto })
  actions: OrderPopupActionsDto;

  @ApiProperty({ type: OrderPopupMetaDto })
  meta: OrderPopupMetaDto;
}
