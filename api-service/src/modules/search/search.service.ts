import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { supabase } from 'src/config/supabase';

type SearchRow = Record<string, unknown>;
type CityImageRow = {
  id?: string | null;
  name?: string | null;
  image_url?: string | null;
  url_image?: string | null;
};

export interface AutocompleteItem {
  id: string;
  name: string;
  type: 'place' | 'city' | 'itinerary';
  image: string;
  city: string;
  rating: number;
  score: number;
}

@Injectable()
export class SearchService {
  private readonly defaultPlaceImageUrl =
    process.env.DEFAULT_PLACE_IMAGE_URL ||
    'https://placehold.co/1080x720?text=No+Image';

  // ── Ranking (rating + số lượt đánh giá) ────────────────────────────────────
  // Bayesian weighted rating (kiểu IMDb): điểm kéo về mức trung bình PRIOR khi
  // ít review, tiến dần về rating thật khi review nhiều. Tránh 5.0★/1 review
  // xếp trên 4.7★/500 review.
  private static readonly RANK_MIN_REVIEWS = 10; // m: ngưỡng review để rating "đáng tin"
  private static readonly RANK_PRIOR_RATING = 3.0; // C: rating nền giả định

  private weightedRank(rating: number, reviewCount: number): number {
    const v = Math.max(0, Number(reviewCount) || 0);
    const r = Math.max(0, Number(rating) || 0);
    if (v === 0 && r === 0) return 0;
    const m = SearchService.RANK_MIN_REVIEWS;
    const c = SearchService.RANK_PRIOR_RATING;
    return (v / (v + m)) * r + (m / (v + m)) * c;
  }

  // Sort ổn định theo weightedRank desc; hòa thì rating desc → reviewCount desc
  // → giữ thứ tự gốc. Tính rank 1 lần/phần tử nên O(n log n) với n ≤ 2000.
  private sortByRank<T extends Record<string, unknown>>(items: T[]): T[] {
    return items
      .map((item, index) => ({
        item,
        index,
        rank: this.weightedRank(
          Number(item['rating']) || 0,
          Number(item['reviewCount']) || 0,
        ),
      }))
      .sort(
        (a, b) =>
          b.rank - a.rank ||
          (Number(b.item['rating']) || 0) - (Number(a.item['rating']) || 0) ||
          (Number(b.item['reviewCount']) || 0) -
            (Number(a.item['reviewCount']) || 0) ||
          a.index - b.index,
      )
      .map((entry) => entry.item);
  }

  private asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  private resolveOptionalImage(...values: unknown[]): string {
    for (const value of values) {
      if (Array.isArray(value)) {
        const first = value.find(
          (item) => typeof item === 'string' && item.trim(),
        );
        if (first) return (first as string).trim();
      }
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  }

  /**
   * Autocomplete: gọi RPC travel.search_autocomplete (đã nâng cấp ở migration
   * sql/2026_search_optimization.sql) — trả id, name, type, image, city, rating, score.
   * Map phòng thủ để vẫn chạy được kể cả khi DB còn function bản cũ (chưa có image/city/rating).
   */
  async autocomplete(query: string): Promise<AutocompleteItem[]> {
    const q = (query ?? '').trim();
    if (q.length === 0) return [];

    const TIMEOUT_MS = 5000;

    // Run RPC (with 5s timeout fallback) and itinerary query in parallel
    const rpcPromise = Promise.race([
      supabase
        .schema('travel')
        .rpc('search_autocomplete', { p_query: q })
        .returns<SearchRow[]>(),
      new Promise<{ data: null; error: Error }>((resolve) =>
        setTimeout(
          () => resolve({ data: null, error: new Error('rpc_timeout') }),
          TIMEOUT_MS,
        ),
      ),
    ]) as Promise<{ data: SearchRow[] | null; error: any }>;

    // Prefix-only (destination.ilike.q%) — dùng B-tree index, nhanh hơn nhiều so với %q%
    // description chỉ prefix để tránh full-table scan; destination là trường chính để match
    const itinQuery = supabase
      .schema('travel')
      .from('itineraries')
      .select('id, description, destination')
      .eq('is_public', true)
      .eq('status', 'completed')
      .or(`destination.ilike.${q}%,description.ilike.${q}%`)
      .order('created_at', { ascending: false })
      .limit(5);

    // Cũng giới hạn timeout cho itinerary query
    const itinPromise = Promise.race([
      itinQuery,
      new Promise<{ data: null; error: Error }>((resolve) =>
        setTimeout(
          () => resolve({ data: null, error: new Error('itin_timeout') }),
          TIMEOUT_MS,
        ),
      ),
    ]);

    const [rpcResult, itinResult] = await Promise.all([
      rpcPromise,
      itinPromise,
    ]);

    // Map places/cities (RPC or fallback)
    let placeItems: AutocompleteItem[];
    if (rpcResult.error || !rpcResult.data) {
      console.error(
        'Autocomplete primary failed, falling back:',
        rpcResult.error?.message ?? rpcResult.error,
      );
      placeItems = await this.autocompleteFallback(q);
    } else {
      const rows = Array.isArray(rpcResult.data) ? rpcResult.data : [];
      placeItems = rows.map((row) => {
        const type =
          this.asString(row['type']).trim().toLowerCase() === 'city'
            ? 'city'
            : 'place';
        const image = this.resolveOptionalImage(
          row['image'],
          row['image_url'],
          row['url_image'],
        );
        return {
          id: this.asString(row['id']),
          name: this.asString(row['name']),
          type,
          image: type === 'place' ? image || this.defaultPlaceImageUrl : image,
          city: this.asString(row['city']),
          rating: Number(row['rating']) || 0,
          score: Number(row['score']) || 0,
        };
      });
      // Re-sort phòng khi DB còn function bản cũ (chưa xếp theo review_count):
      // score desc → rating desc → giữ thứ tự RPC. City (score 100/50) vẫn trên cùng.
      placeItems = placeItems
        .map((item, index) => ({ item, index }))
        .sort(
          (a, b) =>
            b.item.score - a.item.score ||
            b.item.rating - a.item.rating ||
            a.index - b.index,
        )
        .map((entry) => entry.item);
      placeItems = await this.attachCityImages(placeItems);
    }

    // Map itinerary results (append after places)
    const itinItems: AutocompleteItem[] = (
      (itinResult.data ?? []) as any[]
    ).map((r) => ({
      id: String(r.id),
      name:
        (r.description && String(r.description).trim()) ||
        String(r.destination ?? '') ||
        'Lịch trình',
      type: 'itinerary' as const,
      image: '',
      city: String(r.destination ?? ''),
      rating: 0,
      score: 0,
    }));

    return [...placeItems, ...itinItems];
  }

  private async autocompleteFallback(q: string): Promise<AutocompleteItem[]> {
    const [cityItems, placeResult] = await Promise.all([
      this.queryCitySuggestions(q),
      supabase
        .schema('travel')
        .from('places')
        .select('id, name, image_url, average_rating, review_count')
        .eq('is_approved', true)
        .eq('is_active', true)
        .ilike('name', `${q}%`)
        .order('average_rating', { ascending: false })
        .order('review_count', { ascending: false })
        .limit(15),
    ]);

    // score = weighted rank (rating + review_count) để sort nhất quán với RPC.
    const placeItems = ((placeResult.data ?? []) as any[])
      .map((p) => ({
        id: String(p.id ?? ''),
        name: String(p.name ?? ''),
        type: 'place' as const,
        image: this.resolveSearchImage(p.image_url),
        city: '',
        rating: Number(p.average_rating) || 0,
        score: this.weightedRank(
          Number(p.average_rating) || 0,
          Number(p.review_count) || 0,
        ),
      }))
      .sort((a, b) => b.score - a.score || b.rating - a.rating);

    return [...cityItems, ...placeItems].slice(0, 15);
  }

  private mapCitySuggestion(city: CityImageRow, score = 0): AutocompleteItem {
    const image = this.resolveOptionalImage(city.image_url, city.url_image);
    return {
      id: String(city.id ?? ''),
      name: String(city.name ?? ''),
      type: 'city',
      image,
      city: String(city.name ?? ''),
      rating: 0,
      score,
    };
  }

  private isMissingImageColumnError(
    error: { message?: string } | null,
  ): boolean {
    const message = error?.message?.toLowerCase() ?? '';
    return (
      message.includes('image_url') ||
      message.includes('url_image') ||
      message.includes('schema cache')
    );
  }

  private async queryCityRowsByPrefix(
    q: string,
    limit = 5,
  ): Promise<CityImageRow[]> {
    const primary = await supabase
      .schema('travel')
      .from('cities')
      .select('id, name, image_url')
      .ilike('name', `${q}%`)
      .order('name', { ascending: true })
      .limit(limit)
      .returns<CityImageRow[]>();

    if (!primary.error) return primary.data ?? [];
    if (!this.isMissingImageColumnError(primary.error)) {
      console.error('queryCityRowsByPrefix error:', primary.error.message);
      return [];
    }

    const fallback = await supabase
      .schema('travel')
      .from('cities')
      .select('id, name, url_image')
      .ilike('name', `${q}%`)
      .order('name', { ascending: true })
      .limit(limit)
      .returns<CityImageRow[]>();

    if (fallback.error) {
      console.error(
        'queryCityRowsByPrefix fallback error:',
        fallback.error.message,
      );
      return [];
    }

    return fallback.data ?? [];
  }

  private async queryCityRowsByColumn(
    column: 'id' | 'name',
    values: string[],
  ): Promise<CityImageRow[]> {
    if (!values.length) return [];

    const primary = await supabase
      .schema('travel')
      .from('cities')
      .select('id, name, image_url')
      .in(column, values)
      .returns<CityImageRow[]>();

    if (!primary.error) return primary.data ?? [];
    if (!this.isMissingImageColumnError(primary.error)) {
      console.error(
        `queryCityRowsByColumn.${column} error:`,
        primary.error.message,
      );
      return [];
    }

    const fallback = await supabase
      .schema('travel')
      .from('cities')
      .select('id, name, url_image')
      .in(column, values)
      .returns<CityImageRow[]>();

    if (fallback.error) {
      console.error(
        `queryCityRowsByColumn.${column} fallback error:`,
        fallback.error.message,
      );
      return [];
    }

    return fallback.data ?? [];
  }

  private async queryCitySuggestions(q: string): Promise<AutocompleteItem[]> {
    const data = await this.queryCityRowsByPrefix(q, 5);
    return data.map((city) => this.mapCitySuggestion(city));
  }

  private async attachCityImages(
    items: AutocompleteItem[],
  ): Promise<AutocompleteItem[]> {
    const missingCityItems = items.filter(
      (item) => item.type === 'city' && !item.image,
    );
    if (!missingCityItems.length) return items;

    const ids = [
      ...new Set(missingCityItems.map((item) => item.id).filter(Boolean)),
    ];
    const names = [
      ...new Set(missingCityItems.map((item) => item.name).filter(Boolean)),
    ];

    const [byIdRows, byNameRows] = await Promise.all([
      this.queryCityRowsByColumn('id', ids),
      this.queryCityRowsByColumn('name', names),
    ]);

    const imageById = new Map<string, string>();
    const imageByName = new Map<string, string>();
    for (const city of [...byIdRows, ...byNameRows]) {
      const image = this.resolveOptionalImage(city.image_url, city.url_image);
      if (!image) continue;
      if (city.id) imageById.set(String(city.id), image);
      if (city.name) imageByName.set(String(city.name), image);
    }

    return items.map((item) => {
      if (item.type !== 'city' || item.image) return item;
      return {
        ...item,
        image: imageById.get(item.id) ?? imageByName.get(item.name) ?? '',
      };
    });
  }

  async searchAdvanced(query: string): Promise<SearchRow[]> {
    const result = (await supabase
      .schema('travel')
      .rpc('search_places_advanced', {
        p_query: query,
      })) as { data: unknown; error: { message: string } | null };

    const { data, error } = result;

    if (error) {
      console.error('Search error:', error);
      throw new InternalServerErrorException(error.message);
    }

    return Array.isArray(data) ? (data as SearchRow[]) : [];
  }

  async getPlacesByFilter(
    city: string,
    category: string,
  ): Promise<SearchRow[]> {
    const result = (await supabase
      .schema('travel')
      .rpc('get_places_by_filter', {
        p_city: city,
        p_category: category,
      })) as { data: unknown; error: { message: string } | null };

    const { data, error } = result;

    if (error) {
      console.error('Supabase RPC error:', error);
      throw new InternalServerErrorException(error.message);
    }

    return Array.isArray(data) ? (data as SearchRow[]) : [];
  }

  private deg2rad(deg: number): number {
    return deg * (Math.PI / 180);
  }

  private getDistanceFromLatLonInKm(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371; // Bán kính Trái Đất (km)
    const dLat = this.deg2rad(lat2 - lat1);
    const dLon = this.deg2rad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.deg2rad(lat1)) *
        Math.cos(this.deg2rad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  // ── Multi-type search ──────────────────────────────────────────────────────

  private classifyPlaceType(place: any): 'activity' | 'restaurant' | 'hotel' {
    const typeData = Array.isArray(place.types) ? place.types[0] : place.types;
    if (!typeData) return 'activity';
    const cats = Array.isArray(typeData.categories)
      ? typeData.categories
      : [typeData.categories].filter(Boolean);
    const names: string[] = cats.map((c: any) => (c?.name ?? '').toLowerCase());
    if (
      names.some(
        (n) =>
          n.includes('lưu trú') ||
          n.includes('khách sạn') ||
          n.includes('homestay') ||
          n.includes('resort') ||
          n.includes('nhà nghỉ') ||
          n.includes('nhà trọ') ||
          n.includes('biệt thự') ||
          n.includes('căn hộ') ||
          n.includes('nghỉ dưỡng') ||
          n.includes('bungalow'),
      )
    )
      return 'hotel';
    if (
      names.some(
        (n) =>
          n.includes('ẩm thực') ||
          n.includes('nhà hàng') ||
          n.includes('quán ăn') ||
          n.includes('cà phê') ||
          n.includes('cafe') ||
          n.includes('quán cà phê') ||
          n.includes('trà sữa') ||
          n.includes('giải khát') ||
          n.includes('buffet'),
      )
    )
      return 'restaurant';
    return 'activity';
  }

  private resolveSearchImage(imageUrl: unknown): string {
    if (Array.isArray(imageUrl)) {
      const first = (imageUrl as unknown[]).find(
        (i) => typeof i === 'string' && i.trim(),
      );
      if (first) return first as string;
    }
    if (typeof imageUrl === 'string' && imageUrl.trim()) return imageUrl.trim();
    return this.defaultPlaceImageUrl;
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
    if (!parsed || Object.keys(parsed).length === 0) return null;

    const weekdays = [
      'Sunday',
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
    ];
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

    return hasValidRange ? 'Đã đóng cửa' : null;
  }

  private getPlaceOpenStatus(place: any): string {
    const compressedStatus = this.getOpenStatusFromCompressed(
      typeof place.open_hour_compressed === 'string'
        ? place.open_hour_compressed
        : null,
    );
    if (compressedStatus !== null) return compressedStatus;

    const openMinutes = this.parseTimeToMinutes(
      typeof place.open_time === 'string' ? place.open_time : null,
    );
    const closeMinutes = this.parseTimeToMinutes(
      typeof place.close_time === 'string' ? place.close_time : null,
    );
    if (openMinutes == null || closeMinutes == null) {
      return 'Chưa có giờ mở cửa';
    }

    const now = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    return this.isOpenAt(currentMinutes, openMinutes, closeMinutes)
      ? 'Đang mở cửa'
      : 'Đã đóng cửa';
  }

  private mapPlaceItem(
    place: any,
    cityMap: Map<string, string> = new Map(),
  ): Record<string, unknown> {
    const type = this.classifyPlaceType(place);
    const cityName = cityMap.get(String(place.city_id ?? '')) ?? '';
    const status = this.getPlaceOpenStatus(place);
    const base = {
      id: String(place.id ?? ''),
      name: String(place.name ?? ''),
      imageUrl: this.resolveSearchImage(place.image_url),
      rating: Number(place.average_rating) || 0,
      reviewCount: Number(place.review_count) || 0,
      // Kết quả search chỉ hiển thị tỉnh/TP (không load địa chỉ đầy đủ) —
      // địa chỉ đầy đủ xem ở màn chi tiết địa điểm. Giữ key `address` để
      // tương thích với mobile đang render trường này.
      address: cityName,
      city: cityName,
      placeType: type,
      status,
    };
    if (type === 'hotel') {
      const priceValue = Number(place.price) || 0;
      return {
        ...base,
        price: priceValue > 0 ? `${priceValue}đ` : 'Liên hệ',
        starRating: 4,
        priceValue,
        accommodationType: 'hotel',
        amenities: [],
      };
    }
    if (type === 'restaurant') {
      return {
        ...base,
        cuisine: 'vietnamese',
        priceLevel: 'mid_range',
        amenities: [],
      };
    }
    const typeData = Array.isArray(place.types) ? place.types[0] : place.types;
    const cats = typeData?.categories
      ? Array.isArray(typeData.categories)
        ? typeData.categories
        : [typeData.categories]
      : [];
    const catName = cats[0]?.name ?? '';
    return {
      ...base,
      category: catName,
      priceType: 'free',
      district: '',
    };
  }

  private async fetchCreatorNames(ids: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const deduped = [...new Set(ids.filter(Boolean))];
    if (!deduped.length) return map;
    const { data } = await supabase
      .from('users')
      .select('id, full_name')
      .in('id', deduped);
    for (const u of (data ?? []) as any[]) {
      if (u.full_name) map.set(u.id, u.full_name);
    }
    return map;
  }

  private async fetchItineraryImages(
    ids: string[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!ids.length) return map;
    const { data } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('itinerary_id, places:place_id(image_url)')
      .in('itinerary_id', ids)
      .limit(ids.length * 2); // giảm từ *6 xuống *2: 1 ảnh/lịch trình là đủ
    for (const row of (data ?? []) as any[]) {
      if (map.has(row.itinerary_id)) continue;
      const img = this.resolveSearchImage(row.places?.image_url);
      if (img !== this.defaultPlaceImageUrl) map.set(row.itinerary_id, img);
    }
    return map;
  }

  private calcDays(start: string | null, end: string | null): number {
    if (!start || !end) return 1;
    const ms = new Date(end).getTime() - new Date(start).getTime();
    return Math.max(1, Math.round(ms / 86400000) + 1);
  }

  private async queryItineraries(q: string, page: number, limit: number) {
    const offset = (page - 1) * limit;
    const { data, error, count } = await supabase
      .schema('travel')
      .from('itineraries')
      .select(
        'id, creator_id, description, start_date, end_date, destination, created_at',
        { count: 'exact' },
      )
      .eq('is_public', true)
      .eq('status', 'completed')
      .or(`description.ilike.%${q}%,destination.ilike.%${q}%`)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)
      .returns<any[]>();
    if (error) return { data: [], total: 0 };
    const rows = data ?? [];
    const creatorIds = rows.map((r) => r.creator_id).filter(Boolean);
    const itinIds = rows.map((r) => r.id);
    const [creatorMap, imgMap] = await Promise.all([
      this.fetchCreatorNames(creatorIds),
      this.fetchItineraryImages(itinIds),
    ]);
    const mapped = rows.map((r) => ({
      id: r.id,
      title:
        (r.description && String(r.description).trim()) ||
        r.destination ||
        'Lịch trình',
      authorName: creatorMap.get(r.creator_id) ?? 'Traveler',
      authorAvatar: `https://i.pravatar.cc/150?u=${r.creator_id}`,
      imageUrl: imgMap.get(r.id) ?? this.defaultPlaceImageUrl,
      duration: `${this.calcDays(r.start_date, r.end_date)} NGÀY`,
      destination: String(r.destination ?? ''),
      views: '0',
      likes: '0',
    }));
    return { data: mapped, total: count ?? 0 };
  }

  // Không select `address`: kết quả search chỉ cần tỉnh/TP (map từ city_id),
  // bỏ cột text dài này giúp giảm payload từ DB và response API.
  private readonly placesSelect =
    'id, name, average_rating, review_count, image_url, city_id, open_time, close_time, open_hour_compressed, price, types(id, category_id, categories(id, name))';

  // RPC search_places_full chưa tồn tại trên DB (chưa chạy migration) → chỉ log 1 lần.
  private searchRpcUnavailable = false;

  /**
   * Đường nhanh: RPC travel.search_places_full (sql/2026_search_results_optimization.sql)
   * — dùng GIN trigram index trên immutable_unaccent(name) nên vừa nhanh vừa khớp
   * không dấu ("da nang" ra "Đà Nẵng"), lại join sẵn city + category.
   * Trả null khi RPC chưa có trên DB để caller fallback về PostgREST ilike.
   */
  private async queryPlacesViaRpc(
    q: string,
    maxRows: number,
  ): Promise<any[] | null> {
    if (this.searchRpcUnavailable) return null;
    const { data, error } = (await supabase
      .schema('travel')
      .rpc('search_places_full', { p_query: q, p_limit: maxRows })) as {
      data: any[] | null;
      error: { message: string } | null;
    };
    if (error) {
      if (!this.searchRpcUnavailable) {
        this.searchRpcUnavailable = true;
        console.error(
          'search_places_full RPC không khả dụng, fallback ilike (chạy sql/2026_search_results_optimization.sql để tăng tốc):',
          error.message,
        );
      }
      return null;
    }
    // Đưa row phẳng của RPC về shape mà mapPlaceItem/classifyPlaceType hiểu.
    return (data ?? []).map((r: any) => ({
      ...r,
      types: { categories: [{ name: r.category_name ?? '' }] },
    }));
  }

  // Infix search — requires GIN trigram index for speed on large tables.
  // Trả null khi lỗi (khác [] = không có kết quả) để caller quyết định fallback.
  private async queryPlaces(q: string, maxRows = 2000): Promise<any[] | null> {
    const { data, error } = await supabase
      .schema('travel')
      .from('places')
      .select(this.placesSelect)
      .eq('is_approved', true)
      .eq('is_active', true)
      .ilike('name', `%${q}%`)
      .order('average_rating', { ascending: false })
      .order('review_count', { ascending: false })
      .limit(maxRows);
    if (error) console.error('queryPlaces (infix) error:', error.message);
    return error ? null : (data ?? []);
  }

  // Prefix-only fallback — works with a standard B-tree index.
  private async queryPlacesPrefix(q: string, maxRows = 500): Promise<any[]> {
    const { data, error } = await supabase
      .schema('travel')
      .from('places')
      .select(this.placesSelect)
      .eq('is_approved', true)
      .eq('is_active', true)
      .ilike('name', `${q}%`)
      .order('average_rating', { ascending: false })
      .order('review_count', { ascending: false })
      .limit(maxRows);
    if (error) console.error('queryPlacesPrefix error:', error.message);
    return error ? [] : (data ?? []);
  }

  private async buildCityMap(rawPlaces: any[]): Promise<Map<string, string>> {
    const cityIds = [
      ...new Set(
        rawPlaces.map((p: any) => String(p.city_id ?? '')).filter(Boolean),
      ),
    ];
    if (!cityIds.length) return new Map();
    const { data } = await supabase
      .schema('travel')
      .from('cities')
      .select('id, name')
      .in('id', cityIds);
    const map = new Map<string, string>();
    for (const c of (data ?? []) as any[])
      map.set(String(c.id), String(c.name ?? ''));
    return map;
  }

  // Cache kết quả đã phân loại theo query — /search/all rồi /search/results
  // (đổi tab, phân trang) dùng chung 1 lần fetch thay vì quét DB lại mỗi request.
  private static readonly SEARCH_CACHE_TTL_MS = 60_000;
  private static readonly SEARCH_CACHE_MAX = 100;
  private readonly classifiedCache = new Map<
    string,
    { at: number; items: Record<string, unknown>[] }
  >();

  /**
   * Fetch + phân loại + sort weighted rank cho 1 query, có cache TTL.
   * Thứ tự ưu tiên nguồn dữ liệu:
   *   1) RPC search_places_full (trigram index, join sẵn city/category)
   *   2) PostgREST ilike infix (cách cũ)
   *   3) PostgREST ilike prefix — CHỈ khi infix lỗi (prefix ⊆ infix nên
   *      infix trả 0 kết quả thì prefix chắc chắn cũng 0, khỏi quét thêm lần nữa)
   */
  private async getClassifiedPlaces(
    q: string,
  ): Promise<Record<string, unknown>[]> {
    const key = q.toLowerCase();
    const hit = this.classifiedCache.get(key);
    if (hit && Date.now() - hit.at < SearchService.SEARCH_CACHE_TTL_MS) {
      return hit.items;
    }

    let raw = await this.queryPlacesViaRpc(q, 2000);
    let cityMap: Map<string, string>;
    if (raw !== null) {
      // RPC đã join sẵn tên thành phố — khỏi query bảng cities.
      cityMap = new Map(
        raw
          .filter((r) => r.city_id)
          .map((r) => [String(r.city_id), String(r.city_name ?? '')]),
      );
    } else {
      raw = await this.queryPlaces(q, 2000);
      if (raw === null) raw = await this.queryPlacesPrefix(q, 500);
      cityMap = await this.buildCityMap(raw);
    }

    // Sort mặc định: rating cao + nhiều review lên đầu (weighted rank).
    // Sort 1 lần trước khi tách loại — filter giữ nguyên thứ tự đã xếp.
    const items = this.sortByRank(
      raw.map((p) => this.mapPlaceItem(p, cityMap)),
    );

    this.classifiedCache.set(key, { at: Date.now(), items });
    if (this.classifiedCache.size > SearchService.SEARCH_CACHE_MAX) {
      const oldest = this.classifiedCache.keys().next().value;
      if (oldest !== undefined) this.classifiedCache.delete(oldest);
    }
    return items;
  }

  async searchAll(query: string) {
    const q = (query ?? '').trim();
    if (!q)
      return {
        itineraries: { data: [], total: 0 },
        activities: { data: [], total: 0 },
        restaurants: { data: [], total: 0 },
        hotels: { data: [], total: 0 },
      };
    const [itinResult, classified] = await Promise.all([
      this.queryItineraries(q, 1, 50),
      this.getClassifiedPlaces(q),
    ]);
    const activities = classified.filter((p) => p['placeType'] === 'activity');
    const restaurants = classified.filter(
      (p) => p['placeType'] === 'restaurant',
    );
    const hotels = classified.filter((p) => p['placeType'] === 'hotel');
    return {
      itineraries: itinResult,
      activities: { data: activities, total: activities.length },
      restaurants: { data: restaurants, total: restaurants.length },
      hotels: { data: hotels, total: hotels.length },
    };
  }

  async searchByType(query: string, type: string, page: number, limit: number) {
    const q = (query ?? '').trim();
    const safePage = Math.max(1, page);
    const safeLimit = Math.max(1, limit);
    if (type === 'itinerary')
      return this.queryItineraries(q, safePage, safeLimit);
    // q rỗng trước đây thành ilike '%%' → tải 2000 dòng kèm joins (~2s/request).
    // Màn kết quả tìm kiếm luôn có từ khóa nên trả rỗng như searchAll.
    if (!q) return { data: [], total: 0, page: safePage, pages: 0 };
    // Sort weighted rank TRƯỚC khi phân trang để thứ tự trang ổn định.
    const filtered = (await this.getClassifiedPlaces(q)).filter(
      (p) => p['placeType'] === type,
    );
    const total = filtered.length;
    const offset = (safePage - 1) * safeLimit;
    return {
      data: filtered.slice(offset, offset + safeLimit),
      total,
      page: safePage,
      pages: Math.ceil(total / safeLimit),
    };
  }

  // ── Nearby places ─────────────────────────────────────────────────────────

  async getNearbyPlaces(
    lat: number,
    lng: number,
    limit: number = 20,
    excludeIds: string[] = [],
    preferCategory: string = '',
    radius: number = 10,
    q?: string,
  ): Promise<any[]> {
    // Pre-filter with bounding box to avoid fetching the entire table.
    const latDelta = radius / 111.32;
    const lngDelta = radius / (111.32 * Math.cos((lat * Math.PI) / 180));

    let query = supabase
      .schema('travel')
      .from('places')
      .select(
        'id, name, address, average_rating, review_count, image_url, latitude, longitude, open_hour_compressed, types(id, category_id, categories(id, name))',
      )
      .eq('is_approved', true)
      .eq('is_active', true)
      .gte('latitude', lat - latDelta)
      .lte('latitude', lat + latDelta)
      .gte('longitude', lng - lngDelta)
      .lte('longitude', lng + lngDelta);

    if (excludeIds.length > 0) {
      query = query.not('id', 'in', `(${excludeIds.join(',')})`);
    }

    if (q && q.trim().length > 0) {
      query = query.ilike('name', `%${q.trim()}%`);
    }

    const { data, error } = await query;

    if (error) {
      console.error('getNearbyPlaces error:', error);
      throw new InternalServerErrorException(error.message);
    }

    const places = (data || []) as any[];
    const normalizedPrefer = preferCategory.trim().toLowerCase();

    const placesWithDistance = places.map((place) => {
      const distance =
        place.latitude && place.longitude
          ? this.getDistanceFromLatLonInKm(
              lat,
              lng,
              place.latitude,
              place.longitude,
            )
          : Infinity;

      let category = 'Tham quan';
      const typeData = Array.isArray(place.types)
        ? place.types[0]
        : place.types;
      if (typeData && typeData.categories) {
        const catData = Array.isArray(typeData.categories)
          ? typeData.categories[0]
          : typeData.categories;
        if (catData && catData.name) category = catData.name;
      }

      let parsedImageUrl =
        'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=600&q=80';
      if (Array.isArray(place.image_url) && place.image_url.length > 0) {
        parsedImageUrl = place.image_url[0];
      } else if (
        typeof place.image_url === 'string' &&
        place.image_url.trim().length > 0
      ) {
        parsedImageUrl = place.image_url;
      }

      const isSameCategory =
        normalizedPrefer.length > 0 &&
        category.trim().toLowerCase() === normalizedPrefer;

      return {
        id: place.id,
        name: place.name,
        address: place.address || '',
        category,
        rating: place.average_rating || 0,
        reviewCount: place.review_count || 0,
        imageUrl: parsedImageUrl,
        distanceKm: distance === Infinity ? null : Number(distance.toFixed(1)),
        latitude: place.latitude,
        longitude: place.longitude,
        isSameCategory,
        openHourCompressed: place.open_hour_compressed || null,
      };
    });

    // Bounding box over-approximates — do a precise Haversine filter as the final step.
    const inRadius = placesWithDistance
      .filter((p) => p.distanceKm !== null && p.distanceKm <= radius)
      .filter((p) => {
        if (normalizedPrefer === 'tham quan' || normalizedPrefer === '') {
          const cat = p.category.toLowerCase();
          if (
            cat.includes('nhà hàng') ||
            cat.includes('khách sạn') ||
            cat.includes('quán ăn') ||
            cat.includes('lưu trú') ||
            cat.includes('ẩm thực') ||
            cat.includes('quán cà phê') ||
            cat.includes('cafe')
          ) {
            return false;
          }
        }
        return true;
      })
      .sort((a, b) => (a.distanceKm as number) - (b.distanceKm as number));

    // Same-category places first (sorted by distance), then the rest.
    const sameCategory = inRadius.filter((p) => p.isSameCategory);
    const others = inRadius.filter((p) => !p.isSameCategory);

    return [...sameCategory, ...others].slice(0, limit);
  }
}
