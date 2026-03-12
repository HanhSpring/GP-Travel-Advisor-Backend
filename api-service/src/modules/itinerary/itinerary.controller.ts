import { Controller, Post, Get, Body, Query } from '@nestjs/common'
import { ApiTags, ApiOperation } from '@nestjs/swagger'
import { ItineraryService } from './itinerary.service'

@ApiTags('Itinerary')
@Controller('itinerary')
export class ItineraryController {

  constructor(private readonly service: ItineraryService){}

  @Post()
  @ApiOperation({ summary: 'Create itinerary' })
  create(@Body() body:any){
    return this.service.createItinerary(body)
  }

  @Get()
  @ApiOperation({ summary: 'Get user itinerary' })
  getMy(@Query('userId') userId:string){
    return this.service.getMyItinerary(userId)
  }

}