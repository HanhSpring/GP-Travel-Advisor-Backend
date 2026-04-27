import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { supabase } from '../../../config/supabase';

interface ItineraryRow {
  id: string;
  creator_id: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  adult_count: number | null;
  children_count: number | null;
  status: string | null;
  destination: string | null;
  created_at: string;
  is_public: boolean | null;
}

interface ItineraryTimeRow {
  arrival_time: string | null;
  departure_time: string | null;
}

interface ItineraryDetailPlaceRow {
  itinerary_id: string;
  places:
    | {
        image_url?: unknown;
      }
    | {
        image_url?: unknown;
      }[]
    | null;
}

interface PlaceRow {
  id: string;
  name: string;
  city_id: string | null;
  cities:
    | {
        id?: string | null;
        name: string | null;
      }
    | {
        id?: string | null;
        name: string | null;
      }[]
    | null;
  address?: string | null;
  open_time?: string | null;
  close_time?: string | null;
  average_rating: number | null;
  review_count: number | null;
  image_url?: unknown;
}

interface CategoryRow {
  id: string;
  name: string;
}

interface PlaceCategoryRow {
  category_id?: string;
  place_id: string;
}

interface CityRow {
  id: string;
  name: string;
}

interface UserRow {
  id: string;
  full_name: string | null;
}

interface ItineraryDetailPlaceCityRow {
  itinerary_id: string;
  places:
    | {
        city_id?: string | null;
      }
    | {
        city_id?: string | null;
      }[]
    | null;
}

@Injectable()
export class ExploreService {
  private readonly defaultImageUrl =
    process.env.DEFAULT_PLACE_IMAGE_URL ||
    'https://placehold.co/1080x720?text=No+Image';

  private getSafeInFilterLimit(): number {
    const parsed = Number(process.env.EXPLORE_MAX_IN_FILTER_IDS ?? '50');
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 50;
    }

    return Math.floor(parsed);
  }

  private splitIntoChunks<T>(items: T[], chunkSize: number): T[][] {
    if (items.length === 0) {
      return [];
    }

    const size = chunkSize > 0 ? chunkSize : 500;
    const chunks: T[][] = [];

    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }

    return chunks;
  }

  private toImageList(imageUrl?: unknown): string[] {
    if (Array.isArray(imageUrl)) {
      return imageUrl
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }

    if (typeof imageUrl === 'string') {
      const value = imageUrl.trim();
      if (!value) {
        return [];
      }
      return [value];
    }

    return [];
  }

  private resolveImage(imageUrl?: unknown): string {
    const images = this.toImageList(imageUrl);
    if (images.length > 0) {
      return images[0];
    }

    return this.defaultImageUrl;
  }

  private toParticipantCount(itinerary: ItineraryRow): number {
    const adults = itinerary.adult_count ?? 0;
    const children = itinerary.children_count ?? 0;
    return adults + children;
  }

  private extractCityName(
    cityData:
      | {
          id?: string | null;
          name: string | null;
        }
      | {
          id?: string | null;
          name: string | null;
        }[]
      | null,
  ): string | null {
    if (!cityData) {
      return null;
    }

    if (Array.isArray(cityData)) {
      return cityData[0]?.name ?? null;
    }

    return cityData.name ?? null;
  }

  private extractCityId(
    cityData:
      | {
          id?: string | null;
          name: string | null;
        }
      | {
          id?: string | null;
          name: string | null;
        }[]
      | null,
  ): string | null {
    if (!cityData) {
      return null;
    }

    if (Array.isArray(cityData)) {
      return cityData[0]?.id ?? null;
    }

    return cityData.id ?? null;
  }

  private async getCreatorNameMap(
    creatorIds: string[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();

    const dedupedCreatorIds = Array.from(
      new Set(creatorIds.filter((id) => id.trim().length > 0)),
    );

    if (dedupedCreatorIds.length === 0) {
      return map;
    }

    const { data: users, error } = await supabase
      .from('users')
      .select('id, full_name')
      .in('id', dedupedCreatorIds)
      .returns<UserRow[]>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    for (const user of users ?? []) {
      const fullName = (user.full_name ?? '').trim();
      if (!fullName) {
        continue;
      }

      map.set(user.id, fullName);
    }

    return map;
  }

  async getExploreHome(touristId: string) {
    if (!touristId || !touristId.trim()) {
      throw new BadRequestException('tourist_id is required');
    }

    const currentItinerary = await this.getCurrentItinerary(touristId);
    const publicItinerariesResult = await this.getPublicItineraries(1, 5);
    const featuredPlacesResult = await this.getFeaturedCities(1, 5);
    const hotelsResult = await this.getPlacesByCategory('hotel', 1, 5);

    return {
      actions: {
        more_info_target: `/more-info?tourist_id=${touristId}`,
        notifications_target: `/notifications?tourist_id=${touristId}`,
      },
      current_location: 'Vị trí của bạn (Hồ Chí Minh)',
      current_itinerary: currentItinerary,
      suggestion_itineraries: publicItinerariesResult.data,
      featured_places: featuredPlacesResult.data,
      hotels: hotelsResult.data,
      view_all_targets: {
        suggestion_itineraries: '/explore/itineraries/public?page=1&limit=50',
        featured_places: '/explore/cities?page=1&limit=50',
        hotels: '/explore/places?category=hotel&page=1&limit=50',
      },
    };
  }

  async getCurrentItinerary(touristId: string) {
    const today = new Date().toISOString().split('T')[0];

    const { data: ongoing, error: ongoingError } = await supabase
      .schema('travel')
      .from('itineraries')
      .select(
        'id, creator_id, description, start_date, end_date, adult_count, children_count, status, destination, created_at, is_public',
      )
      .eq('creator_id', touristId)
      .eq('status', 'ongoing')
      .lte('start_date', today)
      .gte('end_date', today)
      .order('start_date', { ascending: true })
      .limit(1)
      .maybeSingle<ItineraryRow>();

    if (ongoingError) {
      throw new InternalServerErrorException(ongoingError.message);
    }

    if (ongoing) {
      return {
        id: ongoing.id,
        title:
          (ongoing.description && ongoing.description.trim()) ||
          ongoing.destination ||
          'Lịch trình của bạn',
        date_range: `${ongoing.start_date ?? ''} - ${ongoing.end_date ?? ''}`,
        time_range: await this.getTimeRange(ongoing.id),
        participant_count: this.toParticipantCount(ongoing),
        status: ongoing.status,
        can_start: false,
        start_target: null,
      };
    }

    const { data: upcoming, error: upcomingError } = await supabase
      .schema('travel')
      .from('itineraries')
      .select(
        'id, creator_id, description, start_date, end_date, adult_count, children_count, status, destination, created_at, is_public',
      )
      .eq('creator_id', touristId)
      .in('status', ['pending', 'ongoing', 'uncompleted', 'completed'])
      .gte('start_date', today)
      .order('start_date', { ascending: true })
      .limit(1)
      .maybeSingle<ItineraryRow>();

    if (upcomingError) {
      throw new InternalServerErrorException(upcomingError.message);
    }

    if (upcoming) {
      return {
        id: upcoming.id,
        title:
          (upcoming.description && upcoming.description.trim()) ||
          upcoming.destination ||
          'Lịch trình của bạn',
        date_range: `${upcoming.start_date ?? ''} - ${upcoming.end_date ?? ''}`,
        time_range: await this.getTimeRange(upcoming.id),
        participant_count: this.toParticipantCount(upcoming),
        status: upcoming.status,
        can_start: true,
        start_target: `/explore/itineraries/${upcoming.id}/start?tourist_id=${touristId}`,
      };
    }

    const { data: recent, error: recentError } = await supabase
      .schema('travel')
      .from('itineraries')
      .select(
        'id, creator_id, description, start_date, end_date, adult_count, children_count, status, destination, created_at, is_public',
      )
      .eq('creator_id', touristId)
      .order('start_date', { ascending: false })
      .limit(1)
      .maybeSingle<ItineraryRow>();

    if (recentError) {
      throw new InternalServerErrorException(recentError.message);
    }

    if (!recent) {
      return null;
    }

    return {
      id: recent.id,
      title:
        (recent.description && recent.description.trim()) ||
        recent.destination ||
        'Lịch trình của bạn',
      date_range: `${recent.start_date ?? ''} - ${recent.end_date ?? ''}`,
      time_range: await this.getTimeRange(recent.id),
      participant_count: this.toParticipantCount(recent),
      status: recent.status,
      can_start: false,
      start_target: null,
    };
  }

  async startItinerary(touristId: string, itineraryId: string) {
    if (!touristId || !itineraryId) {
      throw new BadRequestException('tourist_id and itinerary_id are required');
    }

    const { data: itinerary, error: findError } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('id, creator_id, status')
      .eq('id', itineraryId)
      .eq('creator_id', touristId)
      .maybeSingle<{ id: string; creator_id: string; status: string | null }>();

    if (findError) {
      throw new InternalServerErrorException(findError.message);
    }

    if (!itinerary) {
      throw new NotFoundException('Itinerary not found for this tourist');
    }

    const currentStatus = (itinerary.status ?? '').toLowerCase();
    if (currentStatus === 'completed') {
      throw new BadRequestException('Completed itinerary cannot be started');
    }

    const { error: updateError } = await supabase
      .schema('travel')
      .from('itineraries')
      .update({ status: 'ongoing' })
      .eq('id', itineraryId)
      .eq('creator_id', touristId);

    if (updateError) {
      throw new InternalServerErrorException(updateError.message);
    }

    return {
      success: true,
      itinerary_id: itineraryId,
      status: 'ongoing',
      message: 'Itinerary started successfully',
    };
  }

  async getPublicItineraries(page = 1, limit = 5) {
    const safePage = page > 0 ? page : 1;
    const safeLimit = limit > 0 ? limit : 5;
    const offset = (safePage - 1) * safeLimit;

    const { data, error, count } = await supabase
      .schema('travel')
      .from('itineraries')
      .select(
        'id, creator_id, description, start_date, end_date, adult_count, children_count, status, destination, created_at, is_public',
        { count: 'exact' },
      )
      .eq('is_public', true)
      .order('created_at', { ascending: false })
      .range(offset, offset + safeLimit - 1)
      .returns<ItineraryRow[]>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const itineraryIds = (data ?? []).map((item) => item.id);
    const creatorNameMap = await this.getCreatorNameMap(
      (data ?? []).map((item) => item.creator_id),
    );
    const itineraryImages = await this.getItineraryImageMap(itineraryIds);

    const mapped = (data ?? []).map((item) => {
      const gallery = itineraryImages.get(item.id) ?? [];
      const imageGallery =
        gallery.length > 0 ? gallery.slice(0, 3) : [this.defaultImageUrl];

      return {
        id: item.id,
        title:
          (item.description && item.description.trim()) ||
          item.destination ||
          'Lịch trình công khai',
        location: item.destination ?? 'Không xác định',
        description: item.description,
        start_date: item.start_date,
        end_date: item.end_date,
        days: this.getDays(item.start_date, item.end_date),
        participant_count: this.toParticipantCount(item),
        creator_id: item.creator_id,
        creator_name: creatorNameMap.get(item.creator_id) ?? 'Traveler',
        image: imageGallery[0],
        image_gallery: imageGallery,
      };
    });

    return {
      data: mapped,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total: count ?? 0,
        pages: Math.ceil((count ?? 0) / safeLimit),
      },
    };
  }

  private buildCategoryKeywords(categoryName: string): string[] {
    const normalized = categoryName.toLowerCase().trim();

    if (this.isRestaurantCategory(normalized)) {
      return ['restaurant', 'nhà hàng', 'nha hang', 'cafe', 'cà phê', 'ca phe'];
    }

    if (this.isHotelCategory(normalized)) {
      return ['hotel', 'khách sạn', 'khach san'];
    }

    if (this.isActivityCategory(normalized)) {
      return ['activity'];
    }

    return [normalized];
  }

  private isRestaurantCategory(name: string): boolean {
    return (
      name.includes('restaurant') ||
      name.includes('nhà hàng') ||
      name.includes('nha hang') ||
      name.includes('cafe') ||
      name.includes('cà phê') ||
      name.includes('ca phe')
    );
  }

  private isHotelCategory(name: string): boolean {
    return (
      name.includes('hotel') ||
      name.includes('khách sạn') ||
      name.includes('khach san')
    );
  }

  private isActivityCategory(name: string): boolean {
    return name.includes('activity');
  }

  private async getCategoryIdsByKeywords(
    keywords: string[],
  ): Promise<string[]> {
    const ids = new Set<string>();

    for (const keyword of keywords) {
      const { data: categories, error } = await supabase
        .schema('travel')
        .from('categories')
        .select('id, name')
        .ilike('name', `%${keyword}%`)
        .returns<CategoryRow[]>();

      if (error) {
        throw new InternalServerErrorException(error.message);
      }

      for (const item of categories ?? []) {
        ids.add(item.id);
      }
    }

    return Array.from(ids);
  }

  async getFeaturedCities(page = 1, limit = 5) {
    const safePage = page > 0 ? page : 1;
    const safeLimit = limit > 0 ? limit : 5;
    const offset = (safePage - 1) * safeLimit;

    const {
      data: cities,
      error: cityError,
      count,
    } = await supabase
      .schema('travel')
      .from('cities')
      .select('id, name', { count: 'exact' })
      .order('name', { ascending: true })
      .range(offset, offset + safeLimit - 1)
      .returns<CityRow[]>();

    if (cityError) {
      throw new InternalServerErrorException(
        `getCityOverview.city_lookup: ${cityError.message}`,
      );
    }

    const cityIds = (cities ?? []).map((item) => item.id);
    const cityImageMap = new Map<string, string>();

    if (cityIds.length > 0) {
      // Keep this query lightweight: pick representative images from approved
      // active places inside requested cities, without expensive category joins.
      const { data: places, error: placesError } = await supabase
        .schema('travel')
        .from('places')
        .select('id, city_id, image_url, average_rating, review_count')
        .eq('is_approved', true)
        .eq('is_active', true)
        .in('city_id', cityIds)
        .order('review_count', { ascending: false })
        .returns<PlaceRow[]>();

      if (placesError) {
        throw new InternalServerErrorException(placesError.message);
      }

      for (const item of places ?? []) {
        if (!item.city_id || cityImageMap.has(item.city_id)) {
          continue;
        }

        const images = this.toImageList(item.image_url);
        if (images.length === 0) {
          continue;
        }

        cityImageMap.set(item.city_id, images[0]);
      }
    }

    const mapped = (cities ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      image: cityImageMap.get(item.id) ?? this.defaultImageUrl,
      rating: 0,
      review_count: 0,
      city: item.name,
      category: null,
    }));

    return {
      category: null,
      data: mapped,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total: count ?? 0,
        pages: Math.ceil((count ?? 0) / safeLimit),
      },
    };
  }

  async getCityOverview(cityId: string) {
    if (!cityId || !cityId.trim()) {
      throw new BadRequestException('city_id is required');
    }

    const { data: city, error: cityError } = await supabase
      .schema('travel')
      .from('cities')
      .select('id, name')
      .eq('id', cityId)
      .maybeSingle<CityRow>();

    if (cityError) {
      throw new InternalServerErrorException(cityError.message);
    }

    if (!city) {
      throw new NotFoundException('City not found');
    }

    const { data: places, error: placesError } = await supabase
      .schema('travel')
      .from('places')
      .select(
        'id, name, address, city_id, cities(id, name), average_rating, review_count, image_url, open_time, close_time',
      )
      .eq('city_id', cityId)
      .eq('is_approved', true)
      .eq('is_active', true)
      .order('review_count', { ascending: false })
      .returns<PlaceRow[]>();

    if (placesError) {
      throw new InternalServerErrorException(
        `getCityOverview.city_places: ${placesError.message}`,
      );
    }

    const placeIds = (places ?? []).map((item) => item.id);
    let placeCategoryRows: PlaceCategoryRow[] = [];

    if (placeIds.length > 0) {
      const chunkSize = this.getSafeInFilterLimit();
      const chunks = this.splitIntoChunks(placeIds, chunkSize);

      for (const chunk of chunks) {
        try {
          const { data: placeCategories, error: placeCategoryError } =
            await supabase
              .schema('travel')
              .from('place_categories')
              .select('place_id, category_id')
              .in('place_id', chunk)
              .returns<PlaceCategoryRow[]>();

          if (placeCategoryError) {
            // Degrade gracefully for city overview: categories are optional data.
            placeCategoryRows = [];
            break;
          }

          if (placeCategories?.length) {
            placeCategoryRows.push(...placeCategories);
          }
        } catch {
          placeCategoryRows = [];
          break;
        }
      }
    }

    const categoryIds = Array.from(
      new Set(
        placeCategoryRows
          .map((row) => row.category_id)
          .filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          ),
      ),
    );

    const categoryMap = new Map<string, string>();
    if (categoryIds.length > 0) {
      const chunkSize = this.getSafeInFilterLimit();
      const chunks = this.splitIntoChunks(categoryIds, chunkSize);

      for (const chunk of chunks) {
        try {
          const { data: categories, error: categoriesError } = await supabase
            .schema('travel')
            .from('categories')
            .select('id, name')
            .in('id', chunk)
            .returns<CategoryRow[]>();

          if (categoriesError) {
            categoryMap.clear();
            break;
          }

          for (const item of categories ?? []) {
            categoryMap.set(item.id, item.name.toLowerCase());
          }
        } catch {
          categoryMap.clear();
          break;
        }
      }
    }

    const placeCategoriesByPlace = new Map<string, string[]>();
    for (const row of placeCategoryRows) {
      if (!row.category_id) {
        continue;
      }

      const name = categoryMap.get(row.category_id);
      if (!name) {
        continue;
      }

      const list = placeCategoriesByPlace.get(row.place_id) ?? [];
      list.push(name);
      placeCategoriesByPlace.set(row.place_id, list);
    }

    const { data: publicItineraries, error: itineraryError } = await supabase
      .schema('travel')
      .from('itineraries')
      .select(
        'id, creator_id, description, start_date, end_date, adult_count, children_count, status, destination, created_at, is_public',
      )
      .eq('is_public', true)
      .order('created_at', { ascending: false })
      .returns<ItineraryRow[]>();

    if (itineraryError) {
      throw new InternalServerErrorException(
        `getCityOverview.public_itineraries: ${itineraryError.message}`,
      );
    }

    const publicItineraryIds = (publicItineraries ?? []).map((item) => item.id);

    let itineraryDetailRows: ItineraryDetailPlaceCityRow[] = [];
    if (publicItineraryIds.length > 0) {
      const { data: rows, error: itineraryDetailError } = await supabase
        .schema('travel')
        .from('itinerary_details')
        .select('itinerary_id, places:place_id(city_id)')
        .in('itinerary_id', publicItineraryIds)
        .returns<ItineraryDetailPlaceCityRow[]>();

      if (itineraryDetailError) {
        throw new InternalServerErrorException(
          `getCityOverview.itinerary_details: ${itineraryDetailError.message}`,
        );
      }

      itineraryDetailRows = rows ?? [];
    }

    const itineraryIdsInCity = new Set<string>();
    for (const row of itineraryDetailRows) {
      const place = Array.isArray(row.places) ? row.places[0] : row.places;
      if (place?.city_id === cityId) {
        itineraryIdsInCity.add(row.itinerary_id);
      }
    }

    const cityItineraries = (publicItineraries ?? [])
      .filter((item) => itineraryIdsInCity.has(item.id))
      .slice(0, 6);

    let cityItineraryImages = new Map<string, string[]>();
    let cityCreatorNameMap = new Map<string, string>();

    try {
      cityItineraryImages = await this.getItineraryImageMap(
        cityItineraries.map((item) => item.id),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'unknown itinerary image error';
      throw new InternalServerErrorException(
        `getCityOverview.itinerary_images: ${message}`,
      );
    }

    try {
      cityCreatorNameMap = await this.getCreatorNameMap(
        cityItineraries.map((item) => item.creator_id),
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'unknown creator name error';
      throw new InternalServerErrorException(
        `getCityOverview.creator_names: ${message}`,
      );
    }

    const itineraries = cityItineraries.map((item) => {
      const gallery = cityItineraryImages.get(item.id) ?? [];
      const imageGallery =
        gallery.length > 0 ? gallery.slice(0, 3) : [this.defaultImageUrl];

      return {
        id: item.id,
        title:
          (item.description && item.description.trim()) ||
          item.destination ||
          'Lịch trình công khai',
        authorName: cityCreatorNameMap.get(item.creator_id) ?? 'Traveler',
        authorAvatar: `https://i.pravatar.cc/150?u=${item.creator_id}`,
        imageUrl: imageGallery[0],
        duration: `${this.getDays(item.start_date, item.end_date)} NGÀY`,
        views: String(this.toParticipantCount(item)),
        likes: String(this.toParticipantCount(item)),
      };
    });

    const activities: Array<Record<string, unknown>> = [];
    const restaurants: Array<Record<string, unknown>> = [];
    const hotels: Array<Record<string, unknown>> = [];

    for (const item of places ?? []) {
      const categories = placeCategoriesByPlace.get(item.id) ?? [];
      const isRestaurant = categories.some((name) =>
        this.isRestaurantCategory(name),
      );
      const isHotel = categories.some((name) => this.isHotelCategory(name));

      if (isHotel) {
        hotels.push({
          id: item.id,
          name: item.name,
          imageUrl: this.resolveImage(item.image_url),
          rating: Number(item.average_rating) || 0,
          reviewCount: item.review_count || 0,
          price: 'Liên hệ',
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
          imageUrl: this.resolveImage(item.image_url),
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

      activities.push({
        id: item.id,
        title: item.name,
        imageUrl: this.resolveImage(item.image_url),
        rating: Number(item.average_rating) || 0,
        reviewCount: item.review_count || 0,
        address: item.address ?? city.name,
        status: 'Đang mở cửa',
        category: 'cultural_history',
        priceType: 'free',
        district: this.extractCityName(item.cities) ?? city.name,
      });
    }

    return {
      city: {
        id: city.id,
        name: city.name,
      },
      itineraries,
      activities,
      restaurants,
      hotels,
    };
  }

  async getPlacesByCategory(category?: string, page = 1, limit = 5) {
    const safePage = page > 0 ? page : 1;
    const safeLimit = limit > 0 ? limit : 5;
    const offset = (safePage - 1) * safeLimit;

    let categoryName: string | null = null;
    let placeIdsByCategory: string[] | null = null;

    if (category && category.trim().length > 0) {
      categoryName = category.trim().toLowerCase();

      const keywords = this.buildCategoryKeywords(categoryName);
      const categoryIds = await this.getCategoryIdsByKeywords(keywords);
      if (categoryIds.length === 0) {
        return {
          category: categoryName,
          data: [],
          pagination: {
            page: safePage,
            limit: safeLimit,
            total: 0,
            pages: 0,
          },
        };
      }

      const { data: placeCategoryRows, error: placeCategoryError } =
        await supabase
          .schema('travel')
          .from('place_categories')
          .select('place_id')
          .in('category_id', categoryIds)
          .returns<PlaceCategoryRow[]>();

      if (placeCategoryError) {
        throw new InternalServerErrorException(placeCategoryError.message);
      }

      placeIdsByCategory = (placeCategoryRows ?? []).map(
        (item) => item.place_id,
      );

      placeIdsByCategory = Array.from(
        new Set(placeIdsByCategory.filter((id) => id && id.trim().length > 0)),
      );

      const inFilterLimit = this.getSafeInFilterLimit();
      const pageStart = (safePage - 1) * inFilterLimit;
      const pageEnd = pageStart + inFilterLimit;
      if (placeIdsByCategory.length > inFilterLimit) {
        placeIdsByCategory = placeIdsByCategory.slice(pageStart, pageEnd);
      }

      if (placeIdsByCategory.length === 0) {
        return {
          category: categoryName,
          data: [],
          pagination: {
            page: safePage,
            limit: safeLimit,
            total: 0,
            pages: 0,
          },
        };
      }
    }

    let placesQuery = supabase
      .schema('travel')
      .from('places')
      .select(
        'id, name, city_id, cities(name), average_rating, review_count, image_url',
        {
          count: 'exact',
        },
      )
      .eq('is_approved', true)
      .eq('is_active', true)
      .order('average_rating', { ascending: false })
      .order('review_count', { ascending: false });

    if (placeIdsByCategory) {
      placesQuery = placesQuery.in('id', placeIdsByCategory);
    }

    const { data, error, count } = await placesQuery
      .range(offset, offset + safeLimit - 1)
      .returns<PlaceRow[]>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return {
      category: categoryName,
      data: (data ?? []).map((item) => ({
        id: item.id,
        name: item.name,
        image: this.resolveImage(item.image_url),
        rating: Number(item.average_rating) || 0,
        review_count: item.review_count || 0,
        city: this.extractCityName(item.cities),
        category: categoryName,
      })),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total: count ?? 0,
        pages: Math.ceil((count ?? 0) / safeLimit),
      },
    };
  }

  async getTimeRange(itineraryId: string): Promise<string> {
    const { data, error } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('arrival_time, departure_time')
      .eq('itinerary_id', itineraryId)
      .order('arrival_time', { ascending: true })
      .returns<ItineraryTimeRow[]>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    if (!data || data.length === 0) {
      return 'N/A';
    }

    const first = data[0];
    const last = data[data.length - 1];

    return `${first.arrival_time ?? '??'} - ${last.departure_time ?? '??'}`;
  }

  private async getItineraryImageMap(
    itineraryIds: string[],
  ): Promise<Map<string, string[]>> {
    const imageMap = new Map<string, string[]>();
    if (itineraryIds.length === 0) {
      return imageMap;
    }

    const { data, error } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('itinerary_id, places:place_id(image_url)')
      .in('itinerary_id', itineraryIds)
      .returns<ItineraryDetailPlaceRow[]>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    for (const row of data ?? []) {
      const place = Array.isArray(row.places) ? row.places[0] : row.places;
      const images = this.toImageList(place?.image_url);
      if (images.length === 0) {
        continue;
      }

      const existing = imageMap.get(row.itinerary_id) ?? [];
      existing.push(...images);
      imageMap.set(row.itinerary_id, existing);
    }

    for (const [itineraryId, images] of imageMap.entries()) {
      const deduped = Array.from(new Set(images));
      imageMap.set(itineraryId, deduped.slice(0, 3));
    }

    return imageMap;
  }

  getDays(start?: string | null, end?: string | null): number {
    if (!start || !end) {
      return 0;
    }

    const s = new Date(start);
    const e = new Date(end);
    const diff = Math.ceil((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24));

    return diff > 0 ? diff : 1;
  }
}
