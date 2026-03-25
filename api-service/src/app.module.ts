import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { SearchModule } from './modules/search/search.module';
import { ItineraryModule } from './modules/itinerary/itinerary.module';
import { BusinessModule } from './modules/business/business.module';

/*
Tourist modules
*/

import { ExploreModule } from './modules/tourist/explore/explore.module';
import { PlacesModule } from './modules/tourist/places/places.module';
import { ReviewsModule } from './modules/tourist/reviews/reviews.module';
import { CollectionsModule } from './modules/tourist/collections/collections.module';
import { OrdersModule } from './modules/tourist/orders/orders.module';
import { MoreInfoModule } from './modules/tourist/more-info/more-info.module';
import { ItineraryReviewsModule } from './modules/tourist/itinerary-reviews/itinerary-reviews.module';
import { NotificationsModule } from './modules/tourist/notifications/notifications.module';

/*
Admin modules
*/

import { AdminPlacesModule } from './modules/admin/places/admin-places.module';
import { AdminReviewsModule } from './modules/admin/reviews/admin-reviews.module';

/*
Business modules
*/

import { BusinessPlacesModule } from './modules/business/places/business-places.module';
import { BusinessReviewsModule } from './modules/business/reviews/business-reviews.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    SearchModule,
    ItineraryModule,
    BusinessModule,

    /*
    Tourist
    */

    ExploreModule,
    PlacesModule,
    ReviewsModule,
    CollectionsModule,
    OrdersModule,
    MoreInfoModule,
    ItineraryReviewsModule,
    NotificationsModule,

    /*
    Admin
    */

    AdminPlacesModule,
    AdminReviewsModule,

    /*
    Business
    */

    BusinessPlacesModule,
    BusinessReviewsModule,
  ],
})
export class AppModule {}
