import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { SearchModule } from './modules/search/search.module';
import { ItineraryModule } from './modules/itinerary/itinerary.module';
import { BusinessModule } from './modules/business/business.module';
import { AuthModule } from './modules/auth/auth.module';
import { ProfileModule } from './modules/profile/profile.module';
import { AdminUserModule } from './modules/admin/admin-user.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    SearchModule,
    ItineraryModule,
    BusinessModule,
    AuthModule,
    ProfileModule,
    AdminUserModule,
  ],
})
export class AppModule {}
