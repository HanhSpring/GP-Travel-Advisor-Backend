import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { PlacesService } from './places.service';
import { PlaceDetailResponseDto } from './dto/place-detail-response.dto';

@ApiTags('Tourist Places')
@Controller('places')
export class PlacesController {
  constructor(private readonly service: PlacesService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get tourist place detail by place ID' })
  @ApiQuery({ name: 'tourist_id', required: false, type: String })
  @ApiOkResponse({ type: PlaceDetailResponseDto })
  getPlaceDetail(
    @Param('id') id: string,
    @Query('tourist_id') touristId?: string,
  ) {
    return this.service.getPlaceDetail(id, touristId);
  }
}
