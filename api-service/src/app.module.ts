import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'

import { SearchModule } from './modules/search/search.module'
import { ItineraryModule } from './modules/itinerary/itinerary.module'
import { BusinessModule } from './modules/business/business.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    SearchModule,
    ItineraryModule,
    BusinessModule
  ],
})
export class AppModule {}