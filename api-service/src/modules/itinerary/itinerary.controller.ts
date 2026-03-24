import { Controller, Get, Query } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { ItineraryService } from './itinerary.service'
import { GetItinerariesDto } from './dto/get-itineraries.dto'
import { ItineraryResponseDto } from './dto/itinerary-response.dto'

@ApiTags('Itinerary')
@Controller('itinerary')
export class ItineraryController {

  constructor(private readonly service: ItineraryService) {}

  @Get('my-itineraries')
  @ApiOperation({ summary: 'Get my itineraries' })
  @ApiResponse({ type: ItineraryResponseDto })
  getMyItineraries(@Query() query: GetItinerariesDto) {
    return this.service.getMyItineraries(query.userId)
  }
}