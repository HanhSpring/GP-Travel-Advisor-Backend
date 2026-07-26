import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { supabase } from '../../../config/supabase';
import { getRoomsByPlaceIds } from '../../itinerary/room-catalog';

interface ItineraryRow {
  id: string;
  creator_id: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  adult_count: number | null;
  children_count: number | null;
  status: string | null;
  tracking_active?: boolean | null;
  destination: string | null;
  created_at: string;
  is_public: boolean | null;
  trip_intent: string | null;
}

interface RankedCityRow {
  id: string;
  name: string;
  image_url: string | null;
  rating: number | null;
  review_count: number | null;
  quality_score: number | null;
  total_count: number | null;
}

interface ItineraryTimeRow {
  arrival_time: string | null;
  duration_minutes: number | null;
}

interface ItineraryWithDetailsRow extends ItineraryRow {
  itinerary_details: ItineraryTimeRow[] | null;
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
  open_hour_compressed?: string | null;
  average_rating: number | null;
  review_count: number | null;
  image_url?: unknown;
}

interface CategoryRow {
  id: string;
  name: string;
}

interface PlaceTypeRow {
  id: string;
  name: string | null;
  category_id: string | null;
  categories:
    | { id: string; name: string }
    | { id: string; name: string }[]
    | null;
}

interface TypeRow {
  id: string;
  category_id: string | null;
}

interface PlaceWithTypeRow extends PlaceRow {
  type_id?: string | null;
  types?: PlaceTypeRow | PlaceTypeRow[] | null;
}

interface CityRow {
  id: string;
  name: string;
  image_url?: string | null;
}

interface FavoritePlaceRow {
  place_id: string;
}

interface UserRow {
  id: string;
  full_name: string | null;
  avatar_url: string | null;
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

export interface ExplorePagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface ExplorePublicItineraryItem {
  id: string;
  title: string;
  location: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  days: number;
  participant_count: number;
  creator_id: string;
  creator_name: string;
  creator_avatar: string;
  image: string;
  image_gallery: string[];
  is_favorite?: boolean;
  favorite_count: number;
  average_rating: number;
  travel_type: string;
  trip_intent: string;
}

export interface ExplorePublicItinerariesResponse {
  data: ExplorePublicItineraryItem[];
  pagination: ExplorePagination;
}

export interface ExplorePlaceItem {
  id: string;
  name: string;
  image: string;
  rating: number;
  review_count: number;
  city: string | null;
  category: string | null;
  status?: string;
  is_favorite?: boolean;
}

export interface ExplorePlacesResponse {
  category: string | null;
  data: ExplorePlaceItem[];
  pagination: ExplorePagination;
}

@Injectable()
export class ExploreService implements OnModuleInit {
  private readonly defaultImageUrl =
    process.env.DEFAULT_PLACE_IMAGE_URL ||
    'https://placehold.co/1080x720?text=No+Image';

  private readonly featuredPlaceTypePriority = [
    'bãi biển/vịnh',
    'thiên nhiên',
    'khách sạn & resort',
    'công viên/quảng trường',
    'làng nghề',
    'công trình tôn giáo',
    'homestay & villa',
    'bảo tàng & không gian trưng bày',
    'bảo tàng nghệ thuật/3d',
    'nông trại',
    'công viên giải trí',
  ];

  // Simple in-memory cache to reduce repeated DB work for high-traffic explore queries
  private readonly _cache = new Map<string, { ts: number; value: unknown }>();
  // Permanent cache: category keyword -> resolved category ids
  private readonly _categoryIdCache = new Map<string, string[]>();
  // Permanent cache: resolved category id list (joined) -> type ids
  // Types rarely change, so this is safe to keep indefinitely per process.
  private readonly _typeIdCacheMap = new Map<string, string[]>();
  // All-categories cache — fetched once per process. The categories table is
  // small and rarely changes so a permanent cache is safe.
  private _allCategoriesCache: CategoryRow[] | null = null;

  onModuleInit(): void {
    // Pre-warm caches at startup so the first user request hits the cache
    // rather than the raw DB. Fire-and-forget; failures are harmless.
    // cspell:disable-next-line
    const restaurantKey = 'ẩm thực'; // ẩm thực
    // cspell:disable-next-line
    const hotelKey = 'lưu trú'; // lưu trú
    void Promise.allSettled([
      this.getAllCategories(),
      this.getPlacesByCategory(restaurantKey, 1, 10),
      this.getPlacesByCategory(hotelKey, 1, 10),
      this.getFeaturedCities(1, 10),
      // Pre-warm the shared itinerary cache (no touristId) so the first user
      // request only needs the lightweight favorites query, not the full fetch.
      this.getPublicItineraries(1, 10),
    ]);
  }

  private async getAllCategories(): Promise<CategoryRow[]> {
    if (this._allCategoriesCache) return this._allCategoriesCache;
    const { data } = await supabase
      .schema('travel')
      .from('categories')
      .select('id, name')
      .returns<CategoryRow[]>();
    if (data && data.length > 0) this._allCategoriesCache = data;
    return data ?? [];
  }

  private getCacheTtlMs(): number {
    // The ranked-city RPC is cheap, so keep Explore cache short enough for a
    // newly approved rating to become visible without a long stale window.
    const parsed = Number(process.env.EXPLORE_CACHE_TTL_MS ?? '60000');
    if (!Number.isFinite(parsed) || parsed <= 0) return 60000;
    return Math.floor(parsed);
  }

  private getPlaceOpenStatus(
    openTime?: string | null,
    closeTime?: string | null,
    openHourCompressed?: string | null,
  ): string {
    // Ưu tiên lịch theo từng thứ trong tuần (cột open_hour_compressed):
    // {"Monday":[["07:30:00","22:00:00"]], ...}
    const compressedStatus =
      this.getOpenStatusFromCompressed(openHourCompressed);
    if (compressedStatus !== null) return compressedStatus;

    const openMinutes = this.parseTimeToMinutes(openTime);
    const closeMinutes = this.parseTimeToMinutes(closeTime);
    if (openMinutes == null || closeMinutes == null) {
      return 'Chưa có giờ mở cửa';
    }

    const now = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const isOpen = this.isOpenAt(currentMinutes, openMinutes, closeMinutes);

    return isOpen ? 'Đang mở cửa' : 'Đã đóng cửa';
  }

  /** true nếu currentMinutes nằm trong [open, close); hỗ trợ khung giờ qua đêm. */
  private isOpenAt(
    currentMinutes: number,
    openMinutes: number,
    closeMinutes: number,
  ): boolean {
    return (
      openMinutes === closeMinutes ||
      (openMinutes < closeMinutes
        ? currentMinutes >= openMinutes && currentMinutes < closeMinutes
        : currentMinutes >= openMinutes || currentMinutes < closeMinutes)
    );
  }

  /**
   * Tính trạng thái mở cửa từ open_hour_compressed. Trả null khi không có
   * dữ liệu/không parse được (để fallback sang open_time/close_time).
   * Có lịch tuần nhưng hôm nay không có khung giờ nào → 'Đã đóng cửa'.
   */
  private getOpenStatusFromCompressed(
    openHourCompressed?: string | null,
  ): string | null {
    if (!openHourCompressed || !openHourCompressed.trim()) return null;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(openHourCompressed) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Object.keys(parsed).length === 0
    ) {
      return null;
    }

    const weekdays = [
      'Sunday',
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
    ];
    // Giờ Việt Nam (UTC+7)
    const now = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const todayRanges = parsed[weekdays[now.getUTCDay()]];

    if (!Array.isArray(todayRanges) || todayRanges.length === 0) {
      return 'Đã đóng cửa';
    }

    let hasValidRange = false;
    for (const range of todayRanges) {
      if (!Array.isArray(range) || range.length < 2) continue;
      const open = this.parseTimeToMinutes(String(range[0]));
      const close = this.parseTimeToMinutes(String(range[1]));
      if (open == null || close == null) continue;
      hasValidRange = true;
      if (this.isOpenAt(currentMinutes, open, close)) return 'Đang mở cửa';
    }

    // Không có khung giờ hợp lệ nào trong dữ liệu → coi như thiếu dữ liệu.
    return hasValidRange ? 'Đã đóng cửa' : null;
  }

  private parseTimeToMinutes(value?: string | null): number | null {
    if (!value) return null;
    const match = value.match(/^(\d{1,2}):(\d{2})/);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return hour * 60 + minute;
  }

  private getFromCache<T>(key: string): T | null {
    const entry = this._cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.getCacheTtlMs()) {
      this._cache.delete(key);
      return null;
    }
    return entry.value as T;
  }

  private setCache(key: string, value: unknown) {
    try {
      this._cache.set(key, { ts: Date.now(), value });
    } catch {
      // ignore cache errors
    }
  }

  private getSafeInFilterLimit(): number {
    const parsed = Number(process.env.EXPLORE_MAX_IN_FILTER_IDS ?? '500');
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 500;
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

  private normalizeText(value: string): string {
    return value
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/[&/]+/g, ' ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
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

  private extractCategoryNames(
    categories: PlaceTypeRow['categories'],
  ): string[] {
    if (!categories) {
      return [];
    }

    const categoryList = Array.isArray(categories) ? categories : [categories];
    return categoryList
      .map((item) => this.normalizeText(item.name))
      .filter((name) => name.length > 0);
  }

  private extractTypeNames(
    typeData: PlaceTypeRow | PlaceTypeRow[] | null | undefined,
  ): string[] {
    if (!typeData) {
      return [];
    }

    const typeList = Array.isArray(typeData) ? typeData : [typeData];
    return typeList
      .map((item) => this.normalizeText(item.name ?? ''))
      .filter((name) => name.length > 0);
  }

  private matchesAnyCategory(
    categoryNames: string[],
    targetCategories: string[],
  ): boolean {
    return categoryNames.some((name) =>
      targetCategories.some((target) => name.includes(target)),
    );
  }

  private hasAnyCategoryId(
    categoryId: string | null | undefined,
    categoryIds: Set<string>,
  ): boolean {
    if (!categoryId) {
      return false;
    }

    return categoryIds.has(categoryId);
  }

  private getTypePriorityIndex(typeNames: string[]): number | null {
    let bestIndex: number | null = null;

    for (const typeName of typeNames) {
      for (
        let index = 0;
        index < this.featuredPlaceTypePriority.length;
        index += 1
      ) {
        if (
          typeName.includes(
            this.normalizeText(this.featuredPlaceTypePriority[index]),
          )
        ) {
          if (bestIndex === null || index < bestIndex) {
            bestIndex = index;
          }
        }
      }
    }

    return bestIndex;
  }

  private computeTimeRange(details: ItineraryTimeRow[] | null): string {
    if (!details || details.length === 0) return 'N/A';
    const sorted = [...details].sort((a, b) =>
      (a.arrival_time ?? '').localeCompare(b.arrival_time ?? ''),
    );
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    return `${first.arrival_time ?? '??'} - ${this.addMinutesToTime(
      last.arrival_time,
      last.duration_minutes ?? 0,
    )}`;
  }

  private pickRandomItem<T>(items: T[]): T | null {
    if (items.length === 0) {
      return null;
    }

    const index = Math.floor(Math.random() * items.length);
    return items[index] ?? null;
  }

  private mapActivityEntityCategory(categoryNames: string[]): string {
    // categoryNames are already normalizeText()-ed (no diacritics, & → space)
    const joinedCategoryNames = categoryNames.join(' ');

    if (joinedCategoryNames.includes('tham quan kham pha')) {
      return 'attractions';
    }

    if (joinedCategoryNames.includes('van hoa di san')) {
      return 'culturalHistory';
    }

    if (joinedCategoryNames.includes('giai tri vui choi')) {
      return 'entertainment';
    }

    if (joinedCategoryNames.includes('thu gian the thao')) {
      return 'nature';
    }

    return 'attractions';
  }

  private async getCreatorInfoMap(
    creatorIds: string[],
  ): Promise<Map<string, { name: string; avatar: string }>> {
    const map = new Map<string, { name: string; avatar: string }>();

    const dedupedCreatorIds = Array.from(
      new Set(creatorIds.filter((id) => id.trim().length > 0)),
    );

    if (dedupedCreatorIds.length === 0) {
      return map;
    }

    const { data: users, error } = await supabase
      .from('users')
      .select('id, full_name, avatar_url')
      .in('id', dedupedCreatorIds)
      .returns<UserRow[]>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    for (const user of users ?? []) {
      map.set(user.id, {
        name: (user.full_name ?? '').trim(),
        avatar: (user.avatar_url ?? '').trim(),
      });
    }

    return map;
  }

  /** @deprecated use getCreatorInfoMap */
  private async getCreatorNameMap(
    creatorIds: string[],
  ): Promise<Map<string, string>> {
    const infoMap = await this.getCreatorInfoMap(creatorIds);
    const nameMap = new Map<string, string>();
    for (const [id, info] of infoMap) {
      if (info.name) nameMap.set(id, info.name);
    }
    return nameMap;
  }

  async getExploreHome(touristId: string) {
    if (!touristId || !touristId.trim()) {
      throw new BadRequestException('tourist_id is required');
    }

    // Top-level cache — 60 s TTL so repeated home visits (tab switch, back nav)
    // return instantly. Pull-to-refresh bypasses this via forceRefresh.
    const homeCacheKey = `explore:home:v2:${touristId}`;

    const cachedHome = this.getFromCache<any>(homeCacheKey);
    if (cachedHome) return cachedHome;

    // Use limit=10 so the sub-method caches are warmed for the "Xem tất cả"
    // first page (which also requests page=1 limit=10). The frontend trims to 5
    // for the home carousel, but the cached result is reused instantly for
    // "Xem tất cả" without an extra DB round-trip.
    const PAGE_SIZE = 10;
    const publicKey = `explore:public_itineraries:v2:1:${PAGE_SIZE}`;
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

    // If featured cities are already cached, start getCityOverview in parallel
    // so the fallback branch has zero sequential wait when it runs.
    const cachedFeatured =
      this.getFromCache<ExplorePlacesResponse>(featuredKey);
    const speculativeCityId = cachedFeatured?.data[0]?.id ?? null;

    const cityOverviewPromise: Promise<any> = speculativeCityId
      ? this.getCityOverview(speculativeCityId).catch(() => null)
      : Promise.resolve(null);

    const [
      publicItinerariesResult,
      featuredPlacesResult,
      restaurantsResult,
      hotelsResult,
      currentItineraryResult,
    ] = await Promise.all([
      this.getPublicItineraries(1, PAGE_SIZE, touristId).catch(
        () => emptyItineraries,
      ),
      Promise.resolve(
        this.getFromCache<ExplorePlacesResponse>(featuredKey) ??
          this.getFeaturedCities(1, PAGE_SIZE),
      ).catch(() => emptyPlaces(null)),
      this.getPlacesByCategory('ẩm thực', 1, PAGE_SIZE, touristId).catch(() =>
        emptyPlaces('ẩm thực'),
      ),
      this.getPlacesByCategory('lưu trú', 1, PAGE_SIZE, touristId).catch(() =>
        emptyPlaces('lưu trú'),
      ),
      this.getCurrentItinerary(touristId).catch(() => null),
    ]);

    let restaurants = restaurantsResult.data;
    let hotels = hotelsResult.data;

    if (restaurants.length === 0 || hotels.length === 0) {
      const fallbackCity = featuredPlacesResult.data[0];
      if (fallbackCity) {
        try {
          // Reuse the speculative fetch if it targeted the same city
          const cityOverview =
            fallbackCity.id === speculativeCityId
              ? await cityOverviewPromise
              : await this.getCityOverview(fallbackCity.id);

          if (!cityOverview) throw new Error('no overview');

          if (restaurants.length === 0) {
            const fallbackRestaurants = (cityOverview.restaurants ?? []).slice(
              0,
              5,
            );
            restaurants = fallbackRestaurants.map((item) => ({
              id: (item as { id?: string }).id ?? '',
              name: (item as { name?: string }).name ?? 'Nhà hàng',
              image: this.resolveImage(
                (item as { imageUrl?: string }).imageUrl,
              ),
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
              image: this.resolveImage(
                (item as { imageUrl?: string }).imageUrl,
              ),
              rating: (item as { rating?: number }).rating ?? 0,
              review_count: (item as { reviewCount?: number }).reviewCount ?? 0,
              min_price: (item as { priceValue?: number }).priceValue ?? 0,
              city: cityOverview.city.name,
              category: 'lưu trú',
            }));
          }
        } catch {
          // getCityOverview failed — return home page with empty sections
          // rather than crashing the entire endpoint.
        }
      }
    }

    const homeResult = {
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

    // Cache without current_itinerary so the Flutter client always falls back
    // to the parallel /explore/current call for a fresh itinerary status.
    // The suggestions / places / restaurant sections are safe to cache (5 min).
    this.setCache(homeCacheKey, { ...homeResult, current_itinerary: null });
    return homeResult;
  }

  async getCurrentItinerary(touristId: string) {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const { data: ongoing, error } = await supabase
      .schema('travel')
      .from('itineraries')
      .select(
        'id, creator_id, description, start_date, end_date, adult_count, children_count, status, tracking_active, destination, created_at, is_public, itinerary_details(arrival_time, duration_minutes)',
      )
      .eq('creator_id', touristId)
      .eq('status', 'ongoing')
      .gte('end_date', today)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<ItineraryWithDetailsRow>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    if (!ongoing) return null;

    return {
      id: ongoing.id,
      title:
        (ongoing.description && ongoing.description.trim()) ||
        ongoing.destination ||
        'Lịch trình của bạn',
      date_range: `${ongoing.start_date ?? ''} - ${ongoing.end_date ?? ''}`,
      time_range: this.computeTimeRange(ongoing.itinerary_details),
      participant_count: this.toParticipantCount(ongoing),
      status: ongoing.status,
      tracking_active: ongoing.tracking_active === true,
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

    const { error: clearOtherError } = await supabase
      .schema('travel')
      .from('itineraries')
      .update({ status: 'uncompleted', tracking_active: false })
      .eq('creator_id', touristId)
      .eq('status', 'ongoing')
      .neq('id', itineraryId);

    if (clearOtherError) {
      throw new InternalServerErrorException(clearOtherError.message);
    }

    const { error: updateError } = await supabase
      .schema('travel')
      .from('itineraries')
      .update({ status: 'ongoing', tracking_active: true })
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

  async getPublicItineraries(
    page = 1,
    limit = 5,
    touristId?: string,
  ): Promise<ExplorePublicItinerariesResponse> {
    // Per-user cache (includes is_favorite) — instant on repeat visits.
    const userCacheKey = `explore:public_itineraries:v3:${page}:${limit}:${touristId ?? 'anon'}`;
    const userCached =
      this.getFromCache<ExplorePublicItinerariesResponse>(userCacheKey);
    if (userCached) return userCached;

    // Shared cache (no is_favorite) — reused across all users so the expensive
    // sub-queries (image join, ratings, creator names) only run once per page.
    const sharedCacheKey = `explore:public_itineraries_shared:v3:${page}:${limit}`;
    type SharedItem = Omit<ExplorePublicItineraryItem, 'is_favorite'>;
    type SharedResponse = { data: SharedItem[]; pagination: ExplorePagination };
    let sharedData = this.getFromCache<SharedResponse>(sharedCacheKey);

    if (!sharedData) {
      const safePage = page > 0 ? page : 1;
      const safeLimit = limit > 0 ? limit : 5;
      const offset = (safePage - 1) * safeLimit;

      const { data, error, count } = await supabase
        .schema('travel')
        .from('itineraries')
        .select(
          'id, creator_id, description, start_date, end_date, adult_count, children_count, status, destination, created_at, is_public, trip_intent',
          { count: 'exact' },
        )
        .eq('is_public', true)
        .eq('is_deleted', false)
        .order('created_at', { ascending: false })
        .limit(1000)
        .returns<ItineraryRow[]>();

      if (error) {
        throw new InternalServerErrorException(error.message);
      }

      const favoriteCountMap = await this.getFavoriteCountMap(
        (data ?? []).map((item) => item.id),
      );
      const rankedData = [...(data ?? [])].sort((left, right) => {
        const favoriteDifference =
          (favoriteCountMap.get(right.id) ?? 0) -
          (favoriteCountMap.get(left.id) ?? 0);
        if (favoriteDifference !== 0) return favoriteDifference;
        return right.created_at.localeCompare(left.created_at);
      });
      const pageData = rankedData.slice(offset, offset + safeLimit);
      const itineraryIds = pageData.map((item) => item.id);
      const creatorIds = pageData.map((item) => item.creator_id);

      // Run all non-user-specific sub-queries in parallel.
      const [creatorInfoMap, itineraryImages, ratingMap] = await Promise.all([
        this.getCreatorInfoMap(creatorIds),
        this.getItineraryImageMap(itineraryIds),
        this.getItineraryRatingMap(itineraryIds),
      ]);

      const mapped: SharedItem[] = pageData.map((item) => {
        const gallery = itineraryImages.get(item.id) ?? [];
        const imageGallery =
          gallery.length > 0 ? gallery.slice(0, 3) : [this.defaultImageUrl];
        const creatorInfo = creatorInfoMap.get(item.creator_id);

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
          creator_name: creatorInfo?.name || 'Traveler',
          creator_avatar: creatorInfo?.avatar || '',
          image: imageGallery[0],
          image_gallery: imageGallery,
          favorite_count: favoriteCountMap.get(item.id) ?? 0,
          average_rating: ratingMap.get(item.id) ?? 0,
          travel_type: this.deriveTravelType(item.destination),
          trip_intent: item.trip_intent ?? '',
        };
      });

      sharedData = {
        data: mapped,
        pagination: {
          page: safePage,
          limit: safeLimit,
          total: count ?? 0,
          pages: Math.ceil((count ?? 0) / safeLimit),
        },
      };
      this.setCache(sharedCacheKey, sharedData);
    }

    // Layer in user-specific favorites — a single lightweight query.
    const itineraryIds = sharedData.data.map((item) => item.id);
    const favoriteItineraryIds = await this.getFavoriteItinerarySet(
      touristId,
      itineraryIds,
    );

    const result: ExplorePublicItinerariesResponse = {
      ...sharedData,
      data: sharedData.data.map((item) => ({
        ...item,
        is_favorite: favoriteItineraryIds.has(item.id),
      })),
    };

    this.setCache(userCacheKey, result);
    return result;
  }

  private buildCategoryKeywords(categoryName: string): string[] {
    const normalized = categoryName.toLowerCase().trim();

    if (this.isRestaurantCategory(normalized)) {
      return ['ẩm thực', 'nhà hàng', 'ăn uống'];
    }

    if (this.isHotelCategory(normalized)) {
      return ['lưu trú', 'khách sạn', 'nghỉ dưỡng'];
    }

    if (this.isActivityCategory(normalized)) {
      return [
        'giải trí & vui chơi',
        'tham quan & khám phá',
        'thư giãn & thể thao',
        'văn hoá & di sản',
        'mua sắm & dịch vụ',
      ];
    }

    return [normalized];
  }

  private isRestaurantCategory(name: string): boolean {
    return name.includes('ẩm thực') || name.includes('nhà hàng');
  }

  private isHotelCategory(name: string): boolean {
    return name.includes('lưu trú') || name.includes('khách sạn');
  }

  /** Rank rating together with its statistical confidence. */
  private getPlaceQualityScore(place: PlaceRow): number {
    const rating = Math.max(0, Number(place.average_rating) || 0);
    const reviewCount = Math.max(0, Number(place.review_count) || 0);
    const priorMean = 4;
    const priorWeight = 50;

    return (
      (reviewCount * rating + priorWeight * priorMean) /
      (reviewCount + priorWeight)
    );
  }

  private sortPlacesByQuality<T extends PlaceRow>(places: T[]): T[] {
    return [...places].sort((left, right) => {
      const scoreDifference =
        this.getPlaceQualityScore(right) - this.getPlaceQualityScore(left);
      if (Math.abs(scoreDifference) > Number.EPSILON) return scoreDifference;

      const reviewDifference =
        (Number(right.review_count) || 0) - (Number(left.review_count) || 0);
      if (reviewDifference !== 0) return reviewDifference;

      return (
        (Number(right.average_rating) || 0) - (Number(left.average_rating) || 0)
      );
    });
  }

  private isActivityCategory(name: string): boolean {
    return (
      name.includes('tham quan & khám phá') ||
      name.includes('văn hoá & di sản') ||
      name.includes('giải trí & vui chơi') ||
      name.includes('thư giãn & thể thao') ||
      name.includes('mua sắm & dịch vụ')
    );
  }

  private async getCategoryIdsByKeywords(
    keywords: string[],
  ): Promise<string[]> {
    const cacheKey = keywords.join('|');
    const cached = this._categoryIdCache.get(cacheKey);
    if (cached && cached.length > 0) return cached;
    if (keywords.length === 0) return [];

    // Fetch all categories once and filter in JavaScript. This is more
    // reliable than PostgreSQL ILIKE for Vietnamese text — JS toLowerCase()
    // handles Unicode case-folding (e.g. 'Ẩm thực' → 'ẩm thực') correctly
    // even when the DB uses the C locale where ILIKE cannot.
    const allCategories = await this.getAllCategories();
    const lowerKeywords = keywords.map((k) => k.toLowerCase());
    const resolved = Array.from(
      new Set(
        allCategories
          .filter((c) =>
            lowerKeywords.some((kw) => c.name.toLowerCase().includes(kw)),
          )
          .map((c) => c.id),
      ),
    );

    try {
      if (resolved.length > 0) this._categoryIdCache.set(cacheKey, resolved);
    } catch {
      // ignore
    }

    return resolved;
  }

  async getFeaturedCities(page = 1, limit = 5): Promise<ExplorePlacesResponse> {
    const cacheKey = `explore:featured_places:${page}:${limit}`;
    const cached = this.getFromCache<ExplorePlacesResponse>(cacheKey);
    if (cached) return cached;
    const safePage = page > 0 ? page : 1;
    const safeLimit = limit > 0 ? limit : 5;
    const offset = (safePage - 1) * safeLimit;

    // Preferred path: PostgreSQL aggregates every active place before
    // pagination. This is both deterministic and much cheaper than sending
    // thousands of place rows to Node for aggregation.
    const { data: rankedCities, error: rankedCitiesError } = await supabase
      .schema('travel')
      .rpc('get_featured_cities_ranked', {
        p_offset: offset,
        p_limit: safeLimit,
      })
      .returns<RankedCityRow[]>();

    if (!rankedCitiesError) {
      const rankedRows = (rankedCities ?? []) as unknown as RankedCityRow[];
      const total = Number(rankedRows[0]?.total_count) || 0;
      const result: ExplorePlacesResponse = {
        category: null,
        data: rankedRows.map((item) => ({
          id: item.id,
          name: item.name,
          image_url: (item.image_url ?? '').trim() || this.defaultImageUrl,
          image: (item.image_url ?? '').trim() || this.defaultImageUrl,
          rating: Number(item.rating) || 0,
          review_count: Number(item.review_count) || 0,
          city: item.name,
          category: null,
        })),
        pagination: {
          page: safePage,
          limit: safeLimit,
          total,
          pages: Math.ceil(total / safeLimit),
        },
      };

      this.setCache(cacheKey, result);
      return result;
    }

    // Compatibility fallback while the SQL migration is not installed.
    const [citiesResult, placeCityResult] = await Promise.all([
      supabase
        .schema('travel')
        .from('cities')
        .select('id, name, image_url', { count: 'exact' })
        .returns<CityRow[]>(),
      supabase
        .schema('travel')
        .from('places')
        .select('id, city_id, average_rating, review_count')
        .eq('is_approved', true)
        .eq('is_active', true)
        .order('id', { ascending: true })
        .limit(10000)
        .returns<
          {
            id: string;
            city_id: string | null;
            average_rating: number | null;
            review_count: number | null;
          }[]
        >(),
    ]);

    if (citiesResult.error) {
      throw new InternalServerErrorException(
        `getCityOverview.city_lookup: ${citiesResult.error.message}`,
      );
    }
    if (placeCityResult.error) {
      throw new InternalServerErrorException(placeCityResult.error.message);
    }

    const cities = citiesResult.data;
    const count = citiesResult.count;
    const placeCityRows = placeCityResult.data;
    const ratingByCity = new Map<
      string,
      { weightedRatingSum: number; ratingWeight: number; sumReviews: number }
    >();

    for (const item of placeCityRows ?? []) {
      if (!item.city_id) {
        continue;
      }

      const entry = ratingByCity.get(item.city_id) ?? {
        weightedRatingSum: 0,
        ratingWeight: 0,
        sumReviews: 0,
      };
      const rating = Number(item.average_rating) || 0;
      const reviews = Number(item.review_count) || 0;
      if (rating > 0) {
        const weight = Math.max(reviews, 1);
        entry.weightedRatingSum += rating * weight;
        entry.ratingWeight += weight;
      }
      entry.sumReviews += reviews;
      ratingByCity.set(item.city_id, entry);
    }

    // Rank all cities before pagination. A Bayesian score prevents a city with
    // one perfect review from outranking a consistently well-reviewed city.
    const cityQuality = (cityId: string) => {
      const entry = ratingByCity.get(cityId);
      if (!entry || entry.ratingWeight === 0) return 0;
      const rating = entry.weightedRatingSum / entry.ratingWeight;
      const reviews = entry.sumReviews;
      const confidence = reviews / (reviews + 20);
      return confidence * rating + (1 - confidence) * 3.5;
    };

    const sortedCities = (cities ?? []).slice().sort((left, right) => {
      const qualityDiff = cityQuality(right.id) - cityQuality(left.id);
      if (qualityDiff !== 0) return qualityDiff;

      const reviewDiff =
        (ratingByCity.get(right.id)?.sumReviews ?? 0) -
        (ratingByCity.get(left.id)?.sumReviews ?? 0);
      if (reviewDiff !== 0) return reviewDiff;

      return left.name.localeCompare(right.name, 'vi', { sensitivity: 'base' });
    });

    const pagedCities = sortedCities.slice(offset, offset + safeLimit);

    const mapped = pagedCities.map((item) => {
      const ratingEntry = ratingByCity.get(item.id);
      const avgRating =
        ratingEntry && ratingEntry.ratingWeight > 0
          ? Math.round(
              (ratingEntry.weightedRatingSum / ratingEntry.ratingWeight) * 100,
            ) / 100
          : 0;
      const totalReviews = ratingEntry?.sumReviews ?? 0;
      const image = (item.image_url ?? '').trim() || this.defaultImageUrl;
      return {
        id: item.id,
        name: item.name,
        image_url: image,
        image,
        rating: avgRating,
        review_count: totalReviews,
        city: item.name,
        category: null,
      };
    });

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

    this.setCache(cacheKey, result);
    return result;
  }

  private async getAllCityPlaces(cityId: string): Promise<PlaceWithTypeRow[]> {
    const pageSize = 1000;
    const allPlaces: PlaceWithTypeRow[] = [];

    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await supabase
        .schema('travel')
        .from('places')
        .select(
          'id, name, address, city_id, cities(id, name), average_rating, review_count, image_url, open_time, close_time, open_hour_compressed, type_id, types(id, category_id, categories(id, name))',
        )
        .eq('city_id', cityId)
        .eq('is_approved', true)
        .eq('is_active', true)
        .order('average_rating', { ascending: false })
        .order('review_count', { ascending: false })
        .range(offset, offset + pageSize - 1)
        .returns<PlaceWithTypeRow[]>();

      if (error) {
        throw new InternalServerErrorException(
          `getCityOverview.city_places: ${error.message}`,
        );
      }

      const page = data ?? [];
      allPlaces.push(...page);
      if (page.length < pageSize) break;
    }

    return allPlaces;
  }

  async getCityOverview(cityId: string) {
    if (!cityId || !cityId.trim()) {
      throw new BadRequestException('city_id is required');
    }

    const ovCacheKey = `explore:city_overview:v3:${cityId}`;

    const cachedOverview = this.getFromCache<any>(ovCacheKey);
    if (cachedOverview) return cachedOverview;

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

    const restaurantCategoryIds = new Set(
      await this.getCategoryIdsByKeywords(['ẩm thực', 'nhà hàng']),
    );
    const hotelCategoryIds = new Set(
      await this.getCategoryIdsByKeywords(['lưu trú', 'khách sạn']),
    );

    const places = await this.getAllCityPlaces(cityId);

    const hotelRoomMap = await getRoomsByPlaceIds(
      (places ?? [])
        .filter((item) => {
          const typeData = Array.isArray(item.types)
            ? item.types?.[0]
            : item.types;
          return this.hasAnyCategoryId(typeData?.category_id, hotelCategoryIds);
        })
        .map((item) => item.id),
    );

    const placeCategoriesByPlace = new Map<string, string[]>();

    for (const place of places ?? []) {
      const typeData = Array.isArray(place.types)
        ? place.types?.[0]
        : place.types;
      if (!typeData) {
        continue;
      }

      const categoryNames = this.extractCategoryNames(typeData.categories);
      if (categoryNames.length > 0) {
        placeCategoriesByPlace.set(place.id, categoryNames);
      }
    }

    const { data: publicItineraries, error: itineraryError } = await supabase
      .schema('travel')
      .from('itineraries')
      .select(
        'id, creator_id, description, start_date, end_date, adult_count, children_count, status, destination, created_at, is_public',
      )
      .eq('is_public', true)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .limit(1000)
      .returns<ItineraryRow[]>();

    if (itineraryError) {
      throw new InternalServerErrorException(
        `getCityOverview.public_itineraries: ${itineraryError.message}`,
      );
    }

    const publicItineraryIds = (publicItineraries ?? []).map((item) => item.id);

    let itineraryDetailRows: ItineraryDetailPlaceCityRow[] = [];
    if (publicItineraryIds.length > 0) {
      const batchSize = 100;
      for (
        let index = 0;
        index < publicItineraryIds.length;
        index += batchSize
      ) {
        const { data: rows, error: itineraryDetailError } = await supabase
          .schema('travel')
          .from('itinerary_details')
          .select('itinerary_id, places:place_id(city_id)')
          .in(
            'itinerary_id',
            publicItineraryIds.slice(index, index + batchSize),
          )
          .returns<ItineraryDetailPlaceCityRow[]>();

        if (itineraryDetailError) {
          throw new InternalServerErrorException(
            `getCityOverview.itinerary_details: ${itineraryDetailError.message}`,
          );
        }
        itineraryDetailRows.push(...(rows ?? []));
      }
    }

    const itineraryIdsInCity = new Set<string>();
    for (const row of itineraryDetailRows) {
      const place = Array.isArray(row.places) ? row.places[0] : row.places;
      if (place?.city_id === cityId) {
        itineraryIdsInCity.add(row.itinerary_id);
      }
    }

    const cityFavoriteCountMap = await this.getFavoriteCountMap(
      Array.from(itineraryIdsInCity),
    );
    const cityItineraries = (publicItineraries ?? [])
      .filter((item) => itineraryIdsInCity.has(item.id))
      .sort((left, right) => {
        const favoriteDifference =
          (cityFavoriteCountMap.get(right.id) ?? 0) -
          (cityFavoriteCountMap.get(left.id) ?? 0);
        if (favoriteDifference !== 0) return favoriteDifference;
        return right.created_at.localeCompare(left.created_at);
      })
      .slice(0, 6);

    let cityItineraryImages = new Map<string, string[]>();

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

    let cityCreatorInfoMap = new Map<
      string,
      { name: string; avatar: string }
    >();
    try {
      cityCreatorInfoMap = await this.getCreatorInfoMap(
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
      const creatorInfo = cityCreatorInfoMap.get(item.creator_id);

      return {
        id: item.id,
        title:
          (item.description && item.description.trim()) ||
          item.destination ||
          'Lịch trình công khai',
        authorName: creatorInfo?.name || 'Traveler',
        authorAvatar: creatorInfo?.avatar || '',
        imageUrl: imageGallery[0],
        duration: `${this.getDays(item.start_date, item.end_date)} NGÀY`,
        views: String(this.toParticipantCount(item)),
        likes: String(cityFavoriteCountMap.get(item.id) ?? 0),
      };
    });

    const activities: Array<Record<string, unknown>> = [];
    const restaurants: Array<Record<string, unknown>> = [];
    const hotels: Array<Record<string, unknown>> = [];
    // Must match normalizeText() output: diacritics stripped, & → space
    const activityCategoryNames = [
      'giai tri vui choi',
      'tham quan kham pha',
      'thu gian the thao',
      'van hoa di san',
      'mua sam dich vu',
    ];

    // All three city sections use the same confidence-aware ranking so a 5.0
    // backed by very few reviews does not outrank a proven 4.8-rated place.
    const rankedPlaces = this.sortPlacesByQuality(places ?? []);
    for (const item of rankedPlaces) {
      const categories = placeCategoriesByPlace.get(item.id) ?? [];
      const typeData = Array.isArray(item.types) ? item.types?.[0] : item.types;
      const isRestaurant = this.hasAnyCategoryId(
        typeData?.category_id,
        restaurantCategoryIds,
      );
      const isHotel = this.hasAnyCategoryId(
        typeData?.category_id,
        hotelCategoryIds,
      );
      const isActivity = this.matchesAnyCategory(
        categories,
        activityCategoryNames,
      );

      if (isHotel) {
        const minimumRoomPrice = hotelRoomMap.get(item.id)?.[0]?.price ?? 0;
        hotels.push({
          id: item.id,
          name: item.name,
          imageUrl: this.resolveImage(item.image_url),
          rating: Number(item.average_rating) || 0,
          reviewCount: item.review_count || 0,
          min_price: minimumRoomPrice,
          price: minimumRoomPrice,
          address: item.address ?? city.name,
          status: this.getPlaceOpenStatus(
            item.open_time,
            item.close_time,
            item.open_hour_compressed,
          ),
          starRating: 4,
          priceValue: minimumRoomPrice,
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
          status: this.getPlaceOpenStatus(
            item.open_time,
            item.close_time,
            item.open_hour_compressed,
          ),
          cuisine: 'vietnamese',
          priceLevel: 'mid_range',
          amenities: [] as string[],
        });
        continue;
      }

      if (!isActivity) {
        continue;
      }

      activities.push({
        id: item.id,
        title: item.name,
        imageUrl: this.resolveImage(item.image_url),
        rating: Number(item.average_rating) || 0,
        reviewCount: item.review_count || 0,
        address: item.address ?? city.name,
        status: this.getPlaceOpenStatus(
          item.open_time,
          item.close_time,
          item.open_hour_compressed,
        ),
        category: this.mapActivityEntityCategory(categories),
        priceType: 'free',
        district: this.extractCityName(item.cities) ?? city.name,
      });
    }

    const ovResult = {
      city: {
        id: city.id,
        name: city.name,
      },
      itineraries,
      activities,
      restaurants,
      hotels,
    };

    this.setCache(ovCacheKey, ovResult);
    return ovResult;
  }

  private async attachMinimumHotelPrices(
    items: ExplorePlacesResponse['data'],
  ): Promise<ExplorePlacesResponse['data']> {
    if (items.length === 0) return items;

    const roomsByPlace = await getRoomsByPlaceIds(items.map((item) => item.id));
    return items.map((item) => {
      const minimumPrice = roomsByPlace.get(item.id)?.[0]?.price ?? 0;
      return {
        ...item,
        min_price: minimumPrice,
        price: minimumPrice,
        priceValue: minimumPrice,
      };
    });
  }

  async getPlacesByCategory(
    category?: string,
    page = 1,
    limit = 5,
    touristId?: string,
  ): Promise<ExplorePlacesResponse> {
    const safePage = page > 0 ? page : 1;
    const safeLimit = limit > 0 ? limit : 5;
    const offset = (safePage - 1) * safeLimit;

    let categoryName: string | null = null;
    let categoryFilter: string[] | null = null;

    if (category && category.trim().length > 0) {
      categoryName = category.trim().toLowerCase();
      categoryFilter = this.buildCategoryKeywords(categoryName);

      if (!categoryFilter || categoryFilter.length === 0) {
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

    const resolvedCategoryIds = categoryFilter
      ? new Set(await this.getCategoryIdsByKeywords(categoryFilter))
      : new Set<string>();

    const cacheKey = `explore:places:v2:${categoryName}:${safePage}:${safeLimit}:${Array.from(
      resolvedCategoryIds,
    ).join(',')}:${touristId ?? 'anon'}`;
    const cached = this.getFromCache<ExplorePlacesResponse>(cacheKey);
    if (cached) return cached;

    if (categoryFilter) {
      const resolvedCategoryIdList = Array.from(resolvedCategoryIds);
      const safeInFilterLimit = this.getSafeInFilterLimit();

      // Primary path: resolve category -> type_ids and paginate places by type_id.
      // This returns the complete dataset for a category instead of only a
      // limited candidate window.
      if (resolvedCategoryIdList.length > 0) {
        const typeCacheKey = resolvedCategoryIdList.join(',');
        const cachedTypeIds = this._typeIdCacheMap.get(typeCacheKey);
        let typeIds: string[];

        if (cachedTypeIds) {
          typeIds = cachedTypeIds;
        } else {
          const { data: typeRows, error: typeError } = await supabase
            .schema('travel')
            .from('types')
            .select('id, category_id')
            .in('category_id', resolvedCategoryIdList)
            .limit(1000)
            .returns<TypeRow[]>();

          if (typeError) {
            throw new InternalServerErrorException(typeError.message);
          }

          typeIds = Array.from(
            new Set(
              (typeRows ?? [])
                .map((item) => item.id)
                .filter((id) => id.trim().length > 0),
            ),
          );

          try {
            if (typeIds.length > 0)
              this._typeIdCacheMap.set(typeCacheKey, typeIds);
          } catch {
            // ignore
          }
        }

        if (typeIds.length > 0 && typeIds.length <= safeInFilterLimit) {
          const candidateLimit = Math.min(
            Math.max(offset + safeLimit * 20, 200),
            1000,
          );
          // Simplified SELECT — no types/categories join needed since the
          // category is already known (from the input parameter).
          const { data, error } = await supabase
            .schema('travel')
            .from('places')
            .select(
              'id, name, city_id, cities(name), average_rating, review_count, image_url, open_time, close_time, open_hour_compressed',
            )
            .eq('is_approved', true)
            .eq('is_active', true)
            .in('type_id', typeIds)
            .order('review_count', { ascending: false })
            .order('average_rating', { ascending: false })
            .range(0, candidateLimit - 1)
            .returns<PlaceRow[]>();

          if (error) {
            throw new InternalServerErrorException(error.message);
          }

          const rankedData = this.sortPlacesByQuality(data ?? []);
          const pagedData = rankedData.slice(offset, offset + safeLimit);
          const rowCount = pagedData.length;
          const favoritePlaceIds = await this.getFavoritePlaceSet(
            touristId,
            pagedData.map((item) => item.id),
          );

          let mappedItems: ExplorePlacesResponse['data'] = pagedData.map(
            (item) => ({
              id: item.id,
              name: item.name,
              image: this.resolveImage(item.image_url),
              rating: Number(item.average_rating) || 0,
              review_count: item.review_count || 0,
              city: this.extractCityName(item.cities),
              category: categoryName,
              status: this.getPlaceOpenStatus(
                item.open_time,
                item.close_time,
                item.open_hour_compressed,
              ),
              is_favorite: favoritePlaceIds.has(item.id),
            }),
          );

          if (categoryName && this.isHotelCategory(categoryName)) {
            mappedItems = await this.attachMinimumHotelPrices(mappedItems);
          }

          const result: ExplorePlacesResponse = {
            category: categoryName,
            data: mappedItems,
            pagination: {
              page: safePage,
              limit: safeLimit,
              total: offset + rowCount,
              pages: rowCount >= safeLimit ? safePage + 1 : safePage,
            },
          };

          this.setCache(cacheKey, result);
          return result;
        }
      }

      // Fallback: no category IDs resolved (or typeIds exceeds the safe IN-filter
      // limit). Scan the top 500 places by rating, filter by category via the
      // types/categories JOIN, and cache ALL matching items under a single key.
      // Every page is then sliced from that cached array — this fixes the previous
      // sliding-window bug where page 2+ could return empty results when fewer
      // than `offset` matches existed inside the candidate window.
      type PlaceItem = ExplorePlacesResponse['data'][number];
      const fallbackAllKey = `explore:places_all:v2:${categoryName}`;
      let allFallbackItems = this.getFromCache<PlaceItem[]>(fallbackAllKey);

      if (!allFallbackItems) {
        const { data: allData, error: allError } = await supabase
          .schema('travel')
          .from('places')
          .select(
            'id, name, city_id, cities(name), average_rating, review_count, image_url, open_time, close_time, open_hour_compressed, type_id, types(id, category_id, categories(id, name))',
          )
          .eq('is_approved', true)
          .eq('is_active', true)
          .order('review_count', { ascending: false })
          .order('average_rating', { ascending: false })
          .limit(500)
          .returns<
            Array<
              PlaceRow & {
                type_id?: string | null;
                types?: PlaceTypeRow | PlaceTypeRow[] | null;
              }
            >
          >();

        if (allError) {
          throw new InternalServerErrorException(allError.message);
        }

        const filtered = (allData ?? []).filter((item) => {
          const typeData = Array.isArray(item.types)
            ? item.types?.[0]
            : item.types;
          if (!typeData) return false;
          if (
            this.hasAnyCategoryId(typeData.category_id, resolvedCategoryIds)
          ) {
            return true;
          }
          const categoryNames = this.extractCategoryNames(typeData.categories);
          if (categoryNames.length === 0) return false;
          return this.matchesAnyCategory(categoryNames, categoryFilter);
        });

        allFallbackItems = this.sortPlacesByQuality(filtered).map((item) => ({
          id: item.id,
          name: item.name,
          image: this.resolveImage(item.image_url),
          rating: Number(item.average_rating) || 0,
          review_count: item.review_count || 0,
          city: this.extractCityName(item.cities),
          category: categoryName,
          status: this.getPlaceOpenStatus(
            item.open_time,
            item.close_time,
            item.open_hour_compressed,
          ),
        }));

        if (categoryName && this.isHotelCategory(categoryName)) {
          allFallbackItems =
            await this.attachMinimumHotelPrices(allFallbackItems);
        }

        this.setCache(fallbackAllKey, allFallbackItems);
      }

      const paginated = allFallbackItems.slice(offset, offset + safeLimit);
      const favoritePlaceIds = await this.getFavoritePlaceSet(
        touristId,
        paginated.map((item) => item.id),
      );
      const result: ExplorePlacesResponse = {
        category: categoryName,
        data: paginated.map((item) => ({
          ...item,
          is_favorite: favoritePlaceIds.has(item.id),
        })),
        pagination: {
          page: safePage,
          limit: safeLimit,
          total: allFallbackItems.length,
          pages: Math.ceil(allFallbackItems.length / safeLimit) || 1,
        },
      };

      this.setCache(cacheKey, result);
      return result;
    }

    const placesQuery = supabase
      .schema('travel')
      .from('places')
      .select(
        'id, name, city_id, cities(name), average_rating, review_count, image_url, open_time, close_time, open_hour_compressed, type_id, types(id, category_id, categories(id, name))',
        {
          count: 'exact',
        },
      )
      .eq('is_approved', true)
      .eq('is_active', true);

    const { data, error, count } = await placesQuery
      .order('average_rating', { ascending: false })
      .order('review_count', { ascending: false })
      .range(offset, offset + safeLimit - 1)
      .returns<
        Array<
          PlaceRow & {
            type_id?: string | null;
            types?: PlaceTypeRow | PlaceTypeRow[] | null;
          }
        >
      >();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const favoritePlaceIds = await this.getFavoritePlaceSet(
      touristId,
      (data ?? []).map((item) => item.id),
    );

    const mapped = (data ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      image: this.resolveImage(item.image_url),
      rating: Number(item.average_rating) || 0,
      review_count: item.review_count || 0,
      city: this.extractCityName(item.cities),
      category: categoryName,
      status: this.getPlaceOpenStatus(
        item.open_time,
        item.close_time,
        item.open_hour_compressed,
      ),
      is_favorite: favoritePlaceIds.has(item.id),
    }));

    const result: ExplorePlacesResponse = {
      category: categoryName,
      data: mapped,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total: count ?? mapped.length,
        pages: Math.ceil((count ?? mapped.length) / safeLimit),
      },
    };

    this.setCache(cacheKey, result);
    return result;
  }

  private async getFavoritePlaceSet(
    touristId: string | undefined,
    placeIds: string[],
  ): Promise<Set<string>> {
    if (!touristId || placeIds.length === 0) {
      return new Set<string>();
    }

    const { data, error } = await supabase
      .schema('travel')
      .from('favorite_places')
      .select('place_id')
      .eq('tourist_id', touristId)
      .in('place_id', Array.from(new Set(placeIds)))
      .returns<FavoritePlaceRow[]>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return new Set((data ?? []).map((item) => item.place_id));
  }

  private deriveTravelType(destination: string | null): string {
    if (!destination) return 'Khác';
    const d = destination.toLowerCase();
    const beach = [
      'đà nẵng',
      'nha trang',
      'phú quốc',
      'quy nhơn',
      'bình định',
      'vũng tàu',
      'bà rịa',
      'côn đảo',
      'cát bà',
      'mũi né',
      'bình thuận',
      'hội an',
      'quảng nam',
      'khánh hòa',
      'phan thiết',
      'phan rang',
    ];
    const mountain = [
      'sapa',
      'lào cai',
      'đà lạt',
      'lâm đồng',
      'hà giang',
      'mộc châu',
      'sơn la',
      'lai châu',
      'điện biên',
      'yên tử',
      'quảng ninh',
    ];
    const heritage = [
      'huế',
      'thừa thiên',
      'ninh bình',
      'tràng an',
      'hoa lư',
      'hội an',
    ];
    const mekong = [
      'cần thơ',
      'tiền giang',
      'đồng tháp',
      'an giang',
      'vĩnh long',
      'bến tre',
      'hậu giang',
      'sóc trăng',
    ];
    if (beach.some((k) => d.includes(k))) return 'Biển đảo';
    if (mountain.some((k) => d.includes(k))) return 'Núi rừng';
    if (heritage.some((k) => d.includes(k))) return 'Di tích văn hóa';
    if (mekong.some((k) => d.includes(k))) return 'Miền sông nước';
    return 'Thành thị';
  }

  private async getFavoriteCountMap(
    itineraryIds: string[],
  ): Promise<Map<string, number>> {
    if (itineraryIds.length === 0) return new Map();
    const countMap = new Map<string, number>();
    const uniqueIds = Array.from(new Set(itineraryIds));
    const batchSize = 100;

    for (let index = 0; index < uniqueIds.length; index += batchSize) {
      const { data, error } = await supabase
        .schema('travel')
        .from('favorite_itineraries')
        .select('itinerary_id')
        .in('itinerary_id', uniqueIds.slice(index, index + batchSize))
        .returns<Array<{ itinerary_id: string }>>();
      if (error) {
        throw new InternalServerErrorException(error.message);
      }
      for (const row of data ?? []) {
        countMap.set(
          row.itinerary_id,
          (countMap.get(row.itinerary_id) ?? 0) + 1,
        );
      }
    }
    return countMap;
  }

  private async getItineraryRatingMap(
    itineraryIds: string[],
  ): Promise<Map<string, number>> {
    if (itineraryIds.length === 0) return new Map();
    const { data, error } = await supabase
      .schema('review_ai')
      .from('itinerary_reviews')
      .select('itinerary_id, rating')
      .in('itinerary_id', itineraryIds)
      .returns<Array<{ itinerary_id: string; rating: number }>>();
    if (error) return new Map();
    const sumMap = new Map<string, number>();
    const cntMap = new Map<string, number>();
    for (const row of data ?? []) {
      sumMap.set(
        row.itinerary_id,
        (sumMap.get(row.itinerary_id) ?? 0) + row.rating,
      );
      cntMap.set(row.itinerary_id, (cntMap.get(row.itinerary_id) ?? 0) + 1);
    }
    const avgMap = new Map<string, number>();
    for (const [id, sum] of sumMap) {
      avgMap.set(id, Math.round((sum / (cntMap.get(id) ?? 1)) * 10) / 10);
    }
    return avgMap;
  }

  private async getFavoriteItinerarySet(
    touristId: string | undefined,
    itineraryIds: string[],
  ): Promise<Set<string>> {
    if (!touristId || itineraryIds.length === 0) {
      return new Set<string>();
    }

    const { data, error } = await supabase
      .schema('travel')
      .from('favorite_itineraries')
      .select('itinerary_id')
      .eq('tourist_id', touristId)
      .in('itinerary_id', Array.from(new Set(itineraryIds)))
      .returns<Array<{ itinerary_id: string }>>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return new Set((data ?? []).map((item) => item.itinerary_id));
  }

  async getTimeRange(itineraryId: string): Promise<string> {
    const { data, error } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('arrival_time, duration_minutes')
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

    return `${first.arrival_time ?? '??'} - ${this.addMinutesToTime(
      last.arrival_time,
      last.duration_minutes ?? 0,
    )}`;
  }

  private addMinutesToTime(time: string | null, minutes: number): string {
    if (!time) return '??';
    const [hours, minute] = time.split(':').map(Number);
    const total = hours * 60 + minute + Math.max(0, minutes);
    return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(
      total % 60,
    ).padStart(2, '0')}`;
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
