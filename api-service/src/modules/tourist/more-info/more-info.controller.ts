import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { MoreInfoService } from './more-info.service';
import { TouristMoreInfoResponseDto } from './dto/tourist-more-info-response.dto';

@ApiTags('Tourist More Info')
@Controller('more-info')
export class MoreInfoController {
  constructor(private readonly service: MoreInfoService) {}

  @Get()
  @ApiOperation({ summary: 'Get data for tourist more-info side panel' })
  @ApiQuery({ name: 'tourist_id', required: true, type: String })
  @ApiOkResponse({ type: TouristMoreInfoResponseDto })
  getMoreInfo(@Query('tourist_id') touristId: string) {
    return this.service.getMoreInfo(touristId);
  }
}
