import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { ExploreCacheService } from './services/explore-cache.service';
import { ExploreItineraryService } from './services/explore-itinerary.service';
import { ExplorePlacesService } from './services/explore-places.service';
import {
  ExplorePlacesResponse,
  ExplorePublicItinerariesResponse,
} from './explore.types';
import { resolveImage } from './services/explore.utils';

@Injectable()
export class ExploreService implements OnModuleInit {
  constructor(
    private readonly cacheService: ExploreCacheService,
    private readonly itineraryService: ExploreItineraryService,
    private readonly placesService: ExplorePlacesService,
  ) {}

  onModuleInit(): void {
    const restaurantKey = 'ẩm thực';
    const hotelKey = 'lưu trú';
    void Promise.allSettled([
      this.cacheService.getAllCategories(),
      this.placesService.getPlacesByCategory(restaurantKey, 1, 10),
      this.placesService.getPlacesByCategory(hotelKey, 1, 10),
    ]);
  }

  async getExploreHome(touristId: string) {
    if (!touristId || !touristId.trim()) {
      throw new BadRequestException('tourist_id is required');
    }

    const PAGE_SIZE = 10;
    const publicKey = `explore:public_itineraries:1:${PAGE_SIZE}`;
    const featuredKey = `explore:featured_places:1:${PAGE_SIZE}`;

    const emptyItineraries: ExplorePublicItinerariesResponse = {
      data: [],
      pagination: { page: 1, limit: PAGE_SIZE, total: 0, pages: 0 },
    };
    const emptyPlaces = (category: string | null): ExplorePlacesResponse => ({
      category,
      data: [],
      pagination: { page: 1, limit: PAGE_SIZE, total: 0, pages: 0 },
    });

    const [
      publicItinerariesResult,
      featuredPlacesResult,
      restaurantsResult,
      hotelsResult,
      currentItineraryResult,
    ] = await Promise.all([
      Promise.resolve(
        this.cacheService.getFromCache<ExplorePublicItinerariesResponse>(publicKey) ??
          this.itineraryService.getPublicItineraries(1, PAGE_SIZE),
      ).catch(() => emptyItineraries),
      Promise.resolve(
        this.cacheService.getFromCache<ExplorePlacesResponse>(featuredKey) ??
          this.placesService.getFeaturedCities(1, PAGE_SIZE),
      ).catch(() => emptyPlaces(null)),
      this.placesService.getPlacesByCategory('ẩm thực', 1, PAGE_SIZE).catch(() => emptyPlaces('ẩm thực')),
      this.placesService.getPlacesByCategory('lưu trú', 1, PAGE_SIZE).catch(() => emptyPlaces('lưu trú')),
      this.itineraryService.getCurrentItinerary(touristId).catch(() => null),
    ]);

    let restaurants = restaurantsResult.data;
    let hotels = hotelsResult.data;

    if (restaurants.length === 0 || hotels.length === 0) {
      const fallbackCity = featuredPlacesResult.data[0];
      if (fallbackCity) {
        try {
          const cityOverview = await this.placesService.getCityOverview(fallbackCity.id);

          if (restaurants.length === 0) {
            const fallbackRestaurants = (cityOverview.restaurants ?? []).slice(0, 5);
            restaurants = fallbackRestaurants.map((item) => ({
              id: (item as { id?: string }).id ?? '',
              name: (item as { name?: string }).name ?? 'Nhà hàng',
              image: resolveImage((item as { imageUrl?: string }).imageUrl),
              rating: (item as { rating?: number }).rating ?? 0,
              review_count: (item as { reviewCount?: number }).reviewCount ?? 0,
              city: cityOverview.city.name,
              category: 'ẩm thực',
            }));
          }

          if (hotels.length === 0) {
            const fallbackHotels = (cityOverview.hotels ?? []).slice(0, 5);
            hotels = fallbackHotels.map((item) => ({
              id: (item as { id?: string }).id ?? '',
              name: (item as { name?: string }).name ?? 'Khách sạn',
              image: resolveImage((item as { imageUrl?: string }).imageUrl),
              rating: (item as { rating?: number }).rating ?? 0,
              review_count: (item as { reviewCount?: number }).reviewCount ?? 0,
              city: cityOverview.city.name,
              category: 'lưu trú',
            }));
          }
        } catch {
          // ignore
        }
      }
    }

    return {
      actions: {
        more_info_target: `/more-info?tourist_id=${touristId}`,
        notifications_target: `/notifications?tourist_id=${touristId}`,
      },
      current_location: 'Vị trí của bạn (Hồ Chí Minh)',
      current_itinerary: currentItineraryResult,
      current_itinerary_target: `/explore/current?tourist_id=${touristId}`,
      suggestion_itineraries: publicItinerariesResult.data,
      featured_places: featuredPlacesResult.data,
      restaurants,
      hotels,
      view_all_targets: {
        suggestion_itineraries: '/explore/itineraries/public?page=1&limit=50',
        featured_places: '/explore/cities?page=1&limit=50',
        restaurants: '/explore/places?category=ẩm thực&page=1&limit=50',
        hotels: '/explore/places?category=lưu trú&page=1&limit=50',
      },
    };
  }

  getCurrentItinerary(touristId: string) {
    return this.itineraryService.getCurrentItinerary(touristId);
  }

  startItinerary(touristId: string, itineraryId: string) {
    return this.itineraryService.startItinerary(touristId, itineraryId);
  }

  getPublicItineraries(page = 1, limit = 5) {
    return this.itineraryService.getPublicItineraries(page, limit);
  }

  getFeaturedCities(page = 1, limit = 5) {
    return this.placesService.getFeaturedCities(page, limit);
  }

  getCityOverview(cityId: string) {
    return this.placesService.getCityOverview(cityId);
  }

  getPlacesByCategory(category?: string, page = 1, limit = 5) {
    return this.placesService.getPlacesByCategory(category, page, limit);
  }
}
