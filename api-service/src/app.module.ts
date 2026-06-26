import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { ActivityModule } from './modules/activity/activity.module';
import { SearchModule } from './modules/search/search.module';
import { ItineraryModule } from './modules/itinerary/itinerary.module';
import { ItineraryTrackingModule } from './modules/itinerary-tracking/itinerary-tracking.module';
import { BusinessModule } from './modules/business/business.module';
import { AuthModule } from './modules/auth/auth.module';
import { ProfileModule } from './modules/profile/profile.module';
import { AdminUserModule } from './modules/admin/admin-user.module';

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
import { ModerationModule } from './modules/moderation/moderation.module';

/*
Admin modules
*/

import { AdminPlacesModule } from './modules/admin/places/admin-places.module';
import { AdminReviewsModule } from './modules/admin/reviews/admin-reviews.module';
import { AdminItineraryReviewsModule } from './modules/admin/itinerary-reviews/admin-itinerary-reviews.module';
import { AdminDashboardModule } from './modules/admin/dashboard/admin-dashboard.module';
import { AdminAlgorithmPipelineModule } from './modules/admin/algorithm-pipeline/admin-algorithm-pipeline.module';
import { AdminAlgorithmSettingsModule } from './modules/admin/algorithm-settings/admin-algorithm-settings.module';

/*
Business modules
*/

import { BusinessPlacesModule } from './modules/business/places/business-places.module';
import { BusinessReviewsModule } from './modules/business/reviews/business-reviews.module';

/*
Upload module
*/

import { UploadModule } from './modules/upload/upload.module';
import { AiTestModule } from './modules/ai-test/ai-test.module';

// City module
import { CitiesModule } from './modules/city/city.module';
import { PlaceTypesModule } from './modules/place-type/place-type.module';
import { RecommendationModule } from './modules/recommendation/recommendation.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot(),
    ActivityModule,
    SearchModule,
    ItineraryModule,
    ItineraryTrackingModule,
    RecommendationModule,
    BusinessModule,
    AuthModule,
    ProfileModule,
    AdminUserModule,

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
    ModerationModule,

    /*
    Admin
    */

    AdminPlacesModule,
    AdminReviewsModule,
    AdminItineraryReviewsModule,
    AdminDashboardModule,
    AdminAlgorithmPipelineModule,
    AdminAlgorithmSettingsModule,

    /*
    Business
    */

    BusinessPlacesModule,
    BusinessReviewsModule,

    /*
    Upload
    */

    UploadModule,
    AiTestModule,

    // City module
    CitiesModule,
    PlaceTypesModule,
  ],
})
export class AppModule {}
