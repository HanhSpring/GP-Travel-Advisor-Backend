import { AppConfig } from '../../../../config/app.config';
import { Injectable, InternalServerErrorException, NotFoundException, BadRequestException } from '@nestjs/common';
import { supabase } from '../../../../config/supabase';
import { ExploreCacheService } from './explore-cache.service';
import { ExploreItineraryService } from './explore-itinerary.service';
import {
  CityRow,
  FavoritePlaceRow,
  PlaceWithTypeRow,
  PlaceRow,
  ItineraryRow,
  ItineraryDetailPlaceCityRow,
  ExplorePlacesResponse,
  PlaceTypeRow
} from '../explore.types';
import {
  extractTypeNames,
  getTypePriorityIndex,
  toImageList,
  pickRandomItem,
  defaultImageUrl,
  extractCategoryNames,
  hasAnyCategoryId,
  matchesAnyCategory,
  mapActivityEntityCategory,
  extractCityName,
  resolveImage,
  getDays,
  toParticipantCount,
  buildCategoryKeywords,
  featuredPlaceTypePriority
} from './explore.utils';

@Injectable()
export class ExplorePlacesService {
  constructor(
    private readonly cacheService: ExploreCacheService,
    private readonly itineraryService: ExploreItineraryService
  ) {}

  private getSafeInFilterLimit(): number {
    const parsed = AppConfig.EXPLORE_MAX_IN_FILTER_IDS;
    if (!Number.isFinite(parsed) || parsed <= 0) return 500;
    return Math.floor(parsed);
  }

  async getFeaturedCities(page = 1, limit = 5): Promise<ExplorePlacesResponse> {
    const cacheKey = `explore:featured_places:${page}:${limit}`;
    const cached = this.cacheService.getFromCache<ExplorePlacesResponse>(cacheKey);
    if (cached) return cached;
    const safePage = page > 0 ? page : 1;
    const safeLimit = limit > 0 ? limit : 5;
    const offset = (safePage - 1) * safeLimit;

    const [citiesResult, placeCityResult, favoriteResult] = await Promise.all([
      supabase
        .schema('travel')
        .from('cities')
        .select('id, name', { count: 'exact' })
        .returns<CityRow[]>(),
      supabase
        .schema('travel')
        .from('places')
        .select('id, city_id')
        .eq('is_approved', true)
        .eq('is_active', true)
        .limit(3000)
        .returns<{ id: string; city_id: string | null }[]>(),
      supabase
        .schema('travel')
        .from('favorite_places')
        .select('place_id')
        .limit(3000)
        .returns<FavoritePlaceRow[]>(),
    ]);

    if (citiesResult.error) throw new InternalServerErrorException(citiesResult.error.message);
    if (placeCityResult.error) throw new InternalServerErrorException(placeCityResult.error.message);
    if (favoriteResult.error) throw new InternalServerErrorException(favoriteResult.error.message);

    const cities = citiesResult.data;
    const count = citiesResult.count;
    const placeCityRows = placeCityResult.data;
    const favoritePlaces = favoriteResult.data;

    const favoriteCountByPlace = new Map<string, number>();
    for (const item of favoritePlaces ?? []) {
      if (!item.place_id) continue;
      favoriteCountByPlace.set(item.place_id, (favoriteCountByPlace.get(item.place_id) ?? 0) + 1);
    }

    const favoriteCountByCity = new Map<string, number>();
    for (const item of placeCityRows ?? []) {
      if (!item.city_id) continue;
      const placeFavoriteCount = favoriteCountByPlace.get(item.id) ?? 0;
      favoriteCountByCity.set(item.city_id, (favoriteCountByCity.get(item.city_id) ?? 0) + placeFavoriteCount);
    }

    const sortedCities = (cities ?? []).slice().sort((left, right) => {
      const favoriteDiff = (favoriteCountByCity.get(right.id) ?? 0) - (favoriteCountByCity.get(left.id) ?? 0);
      if (favoriteDiff !== 0) return favoriteDiff;
      return left.name.localeCompare(right.name, 'vi', { sensitivity: 'base' });
    });

    const pagedCities = sortedCities.slice(offset, offset + safeLimit);
    const pagedCityIds = pagedCities.map((c) => c.id);
    const cityImageMap = new Map<string, string>();

    if (pagedCityIds.length > 0) {
      const { data: placesWithTypes, error: placesError } = await supabase
        .schema('travel')
        .from('places')
        .select('id, city_id, image_url, type_id, types(id, name, category_id, categories(id, name))')
        .in('city_id', pagedCityIds)
        .eq('is_approved', true)
        .eq('is_active', true)
        .returns<PlaceWithTypeRow[]>();

      if (placesError) throw new InternalServerErrorException(placesError.message);

      const placesByCity = new Map<string, PlaceWithTypeRow[]>();
      for (const item of placesWithTypes ?? []) {
        if (!item.city_id) continue;
        const existing = placesByCity.get(item.city_id) ?? [];
        existing.push(item);
        placesByCity.set(item.city_id, existing);
      }

      for (const city of pagedCities) {
        const candidates = placesByCity.get(city.id) ?? [];
        const prioritizedGroups = new Map<number, PlaceWithTypeRow[]>();

        for (const item of candidates) {
          const typeData = Array.isArray(item.types) ? item.types?.[0] : item.types;
          const typeNames = extractTypeNames(typeData);
          const priorityIndex = getTypePriorityIndex(typeNames);
          if (priorityIndex === null) continue;

          const group = prioritizedGroups.get(priorityIndex) ?? [];
          group.push(item);
          prioritizedGroups.set(priorityIndex, group);
        }

        for (let index = 0; index < featuredPlaceTypePriority.length; index += 1) {
          const group = prioritizedGroups.get(index) ?? [];
          if (group.length === 0) continue;

          const imageReadyGroup = group.filter((place) => toImageList(place.image_url).length > 0);
          if (imageReadyGroup.length === 0) continue;

          const picked = pickRandomItem(imageReadyGroup);
          const images = toImageList(picked?.image_url);
          cityImageMap.set(city.id, images[0]);
          break;
        }
      }
    }

    const mapped = pagedCities.map((item) => ({
      id: item.id,
      name: item.name,
      image: cityImageMap.get(item.id) ?? defaultImageUrl,
      rating: 0,
      review_count: 0,
      city: item.name,
      category: null,
    }));

    const result = {
      category: null,
      data: mapped,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total: count ?? 0,
        pages: Math.ceil((count ?? 0) / safeLimit),
      },
    };

    this.cacheService.setCache(cacheKey, result);
    return result;
  }

  async getCityOverview(cityId: string) {
    if (!cityId || !cityId.trim()) throw new BadRequestException('city_id is required');

    const { data: city, error: cityError } = await supabase
      .schema('travel')
      .from('cities')
      .select('id, name')
      .eq('id', cityId)
      .maybeSingle<CityRow>();

    if (cityError) throw new InternalServerErrorException(cityError.message);
    if (!city) throw new NotFoundException('City not found');

    const restaurantCategoryIds = new Set(await this.cacheService.getCategoryIdsByKeywords(['ẩm thực', 'nhà hàng']));
    const hotelCategoryIds = new Set(await this.cacheService.getCategoryIdsByKeywords(['lưu trú', 'khách sạn']));

    const { data: places, error: placesError } = await supabase
      .schema('travel')
      .from('places')
      .select('id, name, address, city_id, cities(id, name), average_rating, review_count, image_url, open_time, close_time, type_id, types(id, category_id, categories(id, name))')
      .eq('city_id', cityId)
      .eq('is_approved', true)
      .eq('is_active', true)
      .order('average_rating', { ascending: false })
      .order('review_count', { ascending: false })
      .returns<PlaceWithTypeRow[]>();

    if (placesError) throw new InternalServerErrorException(`getCityOverview.city_places: ${placesError.message}`);

    const placeCategoriesByPlace = new Map<string, string[]>();
    for (const place of places ?? []) {
      const typeData = Array.isArray(place.types) ? place.types?.[0] : place.types;
      if (!typeData) continue;
      const categoryNames = extractCategoryNames(typeData.categories);
      if (categoryNames.length > 0) placeCategoriesByPlace.set(place.id, categoryNames);
    }

    const { data: publicItineraries, error: itineraryError } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('id, creator_id, description, start_date, end_date, adult_count, children_count, status, destination, created_at, is_public')
      .eq('is_public', true)
      .order('created_at', { ascending: false })
      .limit(100)
      .returns<ItineraryRow[]>();

    if (itineraryError) throw new InternalServerErrorException(`getCityOverview.public_itineraries: ${itineraryError.message}`);

    const publicItineraryIds = (publicItineraries ?? []).map((item) => item.id);
    let itineraryDetailRows: ItineraryDetailPlaceCityRow[] = [];
    if (publicItineraryIds.length > 0) {
      const { data: rows, error: itineraryDetailError } = await supabase
        .schema('travel')
        .from('itinerary_details')
        .select('itinerary_id, places:place_id(city_id)')
        .in('itinerary_id', publicItineraryIds)
        .returns<ItineraryDetailPlaceCityRow[]>();
      if (itineraryDetailError) throw new InternalServerErrorException(`getCityOverview.itinerary_details: ${itineraryDetailError.message}`);
      itineraryDetailRows = rows ?? [];
    }

    const itineraryIdsInCity = new Set<string>();
    for (const row of itineraryDetailRows) {
      const place = Array.isArray(row.places) ? row.places[0] : row.places;
      if (place?.city_id === cityId) itineraryIdsInCity.add(row.itinerary_id);
    }

    const cityItineraries = (publicItineraries ?? [])
      .filter((item) => itineraryIdsInCity.has(item.id))
      .slice(0, 6);

    let cityItineraryImages = new Map<string, string[]>();
    let cityCreatorNameMap = new Map<string, string>();

    try {
      cityItineraryImages = await this.itineraryService.getItineraryImageMap(cityItineraries.map((item) => item.id));
      cityCreatorNameMap = await this.itineraryService.getCreatorNameMap(cityItineraries.map((item) => item.creator_id));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      throw new InternalServerErrorException(`getCityOverview.aggregates: ${message}`);
    }

    const itineraries = cityItineraries.map((item) => {
      const gallery = cityItineraryImages.get(item.id) ?? [];
      const imageGallery = gallery.length > 0 ? gallery.slice(0, 3) : [defaultImageUrl];
      return {
        id: item.id,
        title: (item.description && item.description.trim()) || item.destination || 'Lịch trình công khai',
        authorName: cityCreatorNameMap.get(item.creator_id) ?? 'Traveler',
        authorAvatar: `https://i.pravatar.cc/150?u=${item.creator_id}`,
        imageUrl: imageGallery[0],
        duration: `${getDays(item.start_date, item.end_date)} NGÀY`,
        views: String(toParticipantCount(item)),
        likes: String(toParticipantCount(item)),
      };
    });

    const activities: Array<Record<string, unknown>> = [];
    const restaurants: Array<Record<string, unknown>> = [];
    const hotels: Array<Record<string, unknown>> = [];
    const activityCategoryNames = [
      'giải trí & vui chơi',
      'tham quan & khám phá',
      'thư giãn & thể thao',
      'văn hoá & di sản',
      'mua sắm & dịch vụ',
    ];

    for (const item of places ?? []) {
      const categories = placeCategoriesByPlace.get(item.id) ?? [];
      const typeData = Array.isArray(item.types) ? item.types?.[0] : item.types;
      const isRestaurant = hasAnyCategoryId(typeData?.category_id, restaurantCategoryIds);
      const isHotel = hasAnyCategoryId(typeData?.category_id, hotelCategoryIds);
      const isActivity = matchesAnyCategory(categories, activityCategoryNames);

      if (isHotel) {
        hotels.push({
          id: item.id,
          name: item.name,
          imageUrl: resolveImage(item.image_url),
          rating: Number(item.average_rating) || 0,
          reviewCount: item.review_count || 0,
          price: '0đ',
          address: item.address ?? city.name,
          starRating: 4,
          priceValue: 0,
          accommodationType: 'hotel',
          amenities: [] as string[],
        });
        continue;
      }

      if (isRestaurant) {
        restaurants.push({
          id: item.id,
          name: item.name,
          imageUrl: resolveImage(item.image_url),
          rating: Number(item.average_rating) || 0,
          reviewCount: item.review_count || 0,
          address: item.address ?? city.name,
          status: 'Đang mở cửa',
          cuisine: 'vietnamese',
          priceLevel: 'mid_range',
          amenities: [] as string[],
        });
        continue;
      }

      if (isActivity) {
        activities.push({
          id: item.id,
          title: item.name,
          imageUrl: resolveImage(item.image_url),
          rating: Number(item.average_rating) || 0,
          reviewCount: item.review_count || 0,
          address: item.address ?? city.name,
          status: 'Đang mở cửa',
          category: mapActivityEntityCategory(categories),
          priceType: 'free',
          district: extractCityName(item.cities) ?? city.name,
        });
      }
    }

    return { city: { id: city.id, name: city.name }, itineraries, activities, restaurants, hotels };
  }

  async getPlacesByCategory(category?: string, page = 1, limit = 5): Promise<ExplorePlacesResponse> {
    const safePage = page > 0 ? page : 1;
    const safeLimit = limit > 0 ? limit : 5;
    const offset = (safePage - 1) * safeLimit;

    let categoryName: string | null = null;
    let categoryFilter: string[] | null = null;

    if (category && category.trim().length > 0) {
      categoryName = category.trim().toLowerCase();
      categoryFilter = buildCategoryKeywords(categoryName);
      if (!categoryFilter || categoryFilter.length === 0) {
        return { category: categoryName, data: [], pagination: { page: safePage, limit: safeLimit, total: 0, pages: 0 } };
      }
    }

    const resolvedCategoryIds = categoryFilter ? new Set(await this.cacheService.getCategoryIdsByKeywords(categoryFilter)) : new Set<string>();
    const cacheKey = `explore:places:${categoryName}:${safePage}:${safeLimit}:${Array.from(resolvedCategoryIds).join(',')}`;
    const cached = this.cacheService.getFromCache<ExplorePlacesResponse>(cacheKey);
    if (cached) return cached;

    if (categoryFilter) {
      const resolvedCategoryIdList = Array.from(resolvedCategoryIds);
      const safeInFilterLimit = this.getSafeInFilterLimit();

      if (resolvedCategoryIdList.length > 0) {
        const typeIds = await this.cacheService.getTypeIdsByCategoryIds(resolvedCategoryIdList);

        if (typeIds.length > 0 && typeIds.length <= safeInFilterLimit) {
          const { data, error } = await supabase
            .schema('travel')
            .from('places')
            .select('id, name, city_id, cities(name), average_rating, review_count, image_url')
            .eq('is_approved', true)
            .eq('is_active', true)
            .in('type_id', typeIds)
            .order('average_rating', { ascending: false })
            .order('review_count', { ascending: false })
            .range(offset, offset + safeLimit - 1)
            .returns<PlaceRow[]>();

          if (error) throw new InternalServerErrorException(error.message);

          const result: ExplorePlacesResponse = {
            category: categoryName,
            data: (data ?? []).map((item) => ({
              id: item.id,
              name: item.name,
              image: resolveImage(item.image_url),
              rating: Number(item.average_rating) || 0,
              review_count: item.review_count || 0,
              city: extractCityName(item.cities),
              category: categoryName,
            })),
            pagination: { page: safePage, limit: safeLimit, total: offset + (data ?? []).length, pages: (data ?? []).length >= safeLimit ? safePage + 1 : safePage },
          };
          this.cacheService.setCache(cacheKey, result);
          return result;
        }
      }

      type PlaceItem = ExplorePlacesResponse['data'][number];
      const fallbackAllKey = `explore:places_all:${categoryName}`;
      let allFallbackItems = this.cacheService.getFromCache<PlaceItem[]>(fallbackAllKey);

      if (!allFallbackItems) {
        const { data: allData, error: allError } = await supabase
          .schema('travel')
          .from('places')
          .select('id, name, city_id, cities(name), average_rating, review_count, image_url, type_id, types(id, category_id, categories(id, name))')
          .eq('is_approved', true)
          .eq('is_active', true)
          .order('average_rating', { ascending: false })
          .order('review_count', { ascending: false })
          .limit(500)
          .returns<Array<PlaceRow & { type_id?: string | null; types?: PlaceTypeRow | PlaceTypeRow[] | null; }>>();

        if (allError) throw new InternalServerErrorException(allError.message);

        const filtered = (allData ?? []).filter((item) => {
          const typeData = Array.isArray(item.types) ? item.types?.[0] : item.types;
          if (!typeData) return false;
          if (hasAnyCategoryId(typeData.category_id, resolvedCategoryIds)) return true;
          const categoryNames = extractCategoryNames(typeData.categories);
          if (categoryNames.length === 0) return false;
          return matchesAnyCategory(categoryNames, categoryFilter);
        });

        allFallbackItems = filtered.map((item) => ({
          id: item.id,
          name: item.name,
          image: resolveImage(item.image_url),
          rating: Number(item.average_rating) || 0,
          review_count: item.review_count || 0,
          city: extractCityName(item.cities),
          category: categoryName,
        }));
        this.cacheService.setCache(fallbackAllKey, allFallbackItems);
      }

      const paginated = allFallbackItems.slice(offset, offset + safeLimit);
      const result: ExplorePlacesResponse = {
        category: categoryName,
        data: paginated,
        pagination: { page: safePage, limit: safeLimit, total: allFallbackItems.length, pages: Math.ceil(allFallbackItems.length / safeLimit) || 1 },
      };
      this.cacheService.setCache(cacheKey, result);
      return result;
    }

    const { data, error, count } = await supabase
      .schema('travel')
      .from('places')
      .select('id, name, city_id, cities(name), average_rating, review_count, image_url, type_id, types(id, category_id, categories(id, name))', { count: 'exact' })
      .eq('is_approved', true)
      .eq('is_active', true)
      .order('average_rating', { ascending: false })
      .order('review_count', { ascending: false })
      .range(offset, offset + safeLimit - 1)
      .returns<Array<PlaceRow & { type_id?: string | null; types?: PlaceTypeRow | PlaceTypeRow[] | null; }>>();

    if (error) throw new InternalServerErrorException(error.message);

    const mapped = (data ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      image: resolveImage(item.image_url),
      rating: Number(item.average_rating) || 0,
      review_count: item.review_count || 0,
      city: extractCityName(item.cities),
      category: categoryName,
    }));

    const result: ExplorePlacesResponse = {
      category: categoryName,
      data: mapped,
      pagination: { page: safePage, limit: safeLimit, total: count ?? mapped.length, pages: Math.ceil((count ?? mapped.length) / safeLimit) },
    };
    this.cacheService.setCache(cacheKey, result);
    return result;
  }
}
