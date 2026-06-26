import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { supabase } from 'src/config/supabase';

type SearchRow = Record<string, unknown>;

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

  private asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
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
      supabase.schema('travel').rpc('search_autocomplete', { p_query: q }).returns<SearchRow[]>(),
      new Promise<{ data: null; error: Error }>((resolve) =>
        setTimeout(() => resolve({ data: null, error: new Error('rpc_timeout') }), TIMEOUT_MS),
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
        setTimeout(() => resolve({ data: null, error: new Error('itin_timeout') }), TIMEOUT_MS),
      ),
    ]);

    const [rpcResult, itinResult] = await Promise.all([rpcPromise, itinPromise]);

    // Map places/cities (RPC or fallback)
    let placeItems: AutocompleteItem[];
    if (rpcResult.error || !rpcResult.data) {
      console.error('Autocomplete primary failed, falling back:', rpcResult.error?.message ?? rpcResult.error);
      placeItems = await this.autocompleteFallback(q);
    } else {
      const rows = Array.isArray(rpcResult.data) ? rpcResult.data : [];
      placeItems = rows.map((row) => {
        const type =
          this.asString(row['type']).trim().toLowerCase() === 'city' ? 'city' : 'place';
        const image = this.asString(row['image']).trim();
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
    }

    // Map itinerary results (append after places)
    const itinItems: AutocompleteItem[] = ((itinResult.data ?? []) as any[]).map((r) => ({
      id: String(r.id),
      name: (r.description && String(r.description).trim()) || String(r.destination ?? '') || 'Lịch trình',
      type: 'itinerary' as const,
      image: '',
      city: String(r.destination ?? ''),
      rating: 0,
      score: 0,
    }));

    return [...placeItems, ...itinItems];
  }

  private async autocompleteFallback(q: string): Promise<AutocompleteItem[]> {
    const { data } = await supabase
      .schema('travel')
      .from('places')
      .select('id, name, image_url, average_rating')
      .eq('is_approved', true)
      .eq('is_active', true)
      .ilike('name', `${q}%`)
      .order('average_rating', { ascending: false })
      .limit(15);

    return ((data ?? []) as any[]).map((p) => ({
      id: String(p.id ?? ''),
      name: String(p.name ?? ''),
      type: 'place' as const,
      image: this.resolveSearchImage(p.image_url),
      city: '',
      rating: Number(p.average_rating) || 0,
      score: 0,
    }));
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
    const cats = Array.isArray(typeData.categories) ? typeData.categories : [typeData.categories].filter(Boolean);
    const names: string[] = cats.map((c: any) => (c?.name ?? '').toLowerCase());
    if (names.some(n =>
      n.includes('lưu trú') || n.includes('khách sạn') || n.includes('homestay') || n.includes('resort') ||
      n.includes('nhà nghỉ') || n.includes('nhà trọ') || n.includes('biệt thự') ||
      n.includes('căn hộ') || n.includes('nghỉ dưỡng') || n.includes('bungalow')
    )) return 'hotel';
    if (names.some(n =>
      n.includes('ẩm thực') || n.includes('nhà hàng') || n.includes('quán ăn') ||
      n.includes('cà phê') || n.includes('cafe') || n.includes('quán cà phê') ||
      n.includes('trà sữa') || n.includes('giải khát') || n.includes('buffet')
    )) return 'restaurant';
    return 'activity';
  }

  private resolveSearchImage(imageUrl: unknown): string {
    if (Array.isArray(imageUrl)) {
      const first = (imageUrl as unknown[]).find(i => typeof i === 'string' && (i as string).trim());
      if (first) return first as string;
    }
    if (typeof imageUrl === 'string' && imageUrl.trim()) return imageUrl.trim();
    return this.defaultPlaceImageUrl;
  }

  private mapPlaceItem(place: any, cityMap: Map<string, string> = new Map()): Record<string, unknown> {
    const type = this.classifyPlaceType(place);
    const base = {
      id: String(place.id ?? ''),
      name: String(place.name ?? ''),
      imageUrl: this.resolveSearchImage(place.image_url),
      rating: Number(place.average_rating) || 0,
      reviewCount: Number(place.review_count) || 0,
      address: String(place.address ?? ''),
      city: cityMap.get(String(place.city_id ?? '')) ?? '',
      placeType: type,
    };
    if (type === 'hotel') {
      return { ...base, price: 'Liên hệ', starRating: 4, priceValue: 0, accommodationType: 'hotel', amenities: [] };
    }
    if (type === 'restaurant') {
      return { ...base, status: 'Đang mở cửa', cuisine: 'vietnamese', priceLevel: 'mid_range', amenities: [] };
    }
    const typeData = Array.isArray(place.types) ? place.types[0] : place.types;
    const cats = typeData?.categories ? (Array.isArray(typeData.categories) ? typeData.categories : [typeData.categories]) : [];
    const catName = (cats[0] as any)?.name ?? '';
    return { ...base, status: 'Đang mở cửa', category: catName, priceType: 'free', district: '' };
  }

  private async fetchCreatorNames(ids: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const deduped = [...new Set(ids.filter(Boolean))];
    if (!deduped.length) return map;
    const { data } = await supabase.from('users').select('id, full_name').in('id', deduped);
    for (const u of (data ?? []) as any[]) {
      if (u.full_name) map.set(u.id, u.full_name);
    }
    return map;
  }

  private async fetchItineraryImages(ids: string[]): Promise<Map<string, string>> {
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
      const img = this.resolveSearchImage((row.places as any)?.image_url);
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
      .select('id, creator_id, description, start_date, end_date, destination, created_at', { count: 'exact' })
      .eq('is_public', true)
      .eq('status', 'completed')
      .or(`description.ilike.%${q}%,destination.ilike.%${q}%`)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)
      .returns<any[]>();
    if (error) return { data: [], total: 0 };
    const rows = (data ?? []) as any[];
    const creatorIds = rows.map(r => r.creator_id).filter(Boolean);
    const itinIds = rows.map(r => r.id);
    const [creatorMap, imgMap] = await Promise.all([
      this.fetchCreatorNames(creatorIds),
      this.fetchItineraryImages(itinIds),
    ]);
    const mapped = rows.map(r => ({
      id: r.id,
      title: (r.description && String(r.description).trim()) || r.destination || 'Lịch trình',
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

  private readonly placesSelect =
    'id, name, address, average_rating, review_count, image_url, city_id, types(id, category_id, categories(id, name))';

  // Infix search — requires GIN trigram index for speed on large tables.
  private async queryPlaces(q: string, maxRows = 2000): Promise<any[]> {
    const { data, error } = await supabase
      .schema('travel')
      .from('places')
      .select(this.placesSelect)
      .eq('is_approved', true)
      .eq('is_active', true)
      .ilike('name', `%${q}%`)
      .order('average_rating', { ascending: false })
      .limit(maxRows);
    if (error) console.error('queryPlaces (infix) error:', error.message);
    return error ? [] : (data ?? []);
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
      .limit(maxRows);
    if (error) console.error('queryPlacesPrefix error:', error.message);
    return error ? [] : (data ?? []);
  }

  private async buildCityMap(rawPlaces: any[]): Promise<Map<string, string>> {
    const cityIds = [...new Set(rawPlaces.map((p: any) => String(p.city_id ?? '')).filter(Boolean))];
    if (!cityIds.length) return new Map();
    const { data } = await supabase
      .schema('travel')
      .from('cities')
      .select('id, name')
      .in('id', cityIds);
    const map = new Map<string, string>();
    for (const c of (data ?? []) as any[]) map.set(String(c.id), String(c.name ?? ''));
    return map;
  }

  async searchAll(query: string) {
    const q = (query ?? '').trim();
    if (!q) return { itineraries: { data: [], total: 0 }, activities: { data: [], total: 0 }, restaurants: { data: [], total: 0 }, hotels: { data: [], total: 0 } };
    let [itinResult, rawPlaces] = await Promise.all([
      this.queryItineraries(q, 1, 50),
      this.queryPlaces(q, 2000),
    ]);
    if (!rawPlaces.length) rawPlaces = await this.queryPlacesPrefix(q, 500);
    const cityMap = await this.buildCityMap(rawPlaces);
    const classified = rawPlaces.map(p => this.mapPlaceItem(p, cityMap));
    const activities = classified.filter(p => p['placeType'] === 'activity');
    const restaurants = classified.filter(p => p['placeType'] === 'restaurant');
    const hotels = classified.filter(p => p['placeType'] === 'hotel');
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
    if (type === 'itinerary') return this.queryItineraries(q, safePage, safeLimit);
    let raw = await this.queryPlaces(q, 2000);
    if (!raw.length) raw = await this.queryPlacesPrefix(q, 500);
    const cityMap = await this.buildCityMap(raw);
    const filtered = raw.map(p => this.mapPlaceItem(p, cityMap)).filter(p => p['placeType'] === type);
    const total = filtered.length;
    const offset = (safePage - 1) * safeLimit;
    return { data: filtered.slice(offset, offset + safeLimit), total, page: safePage, pages: Math.ceil(total / safeLimit) };
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
          ? this.getDistanceFromLatLonInKm(lat, lng, place.latitude, place.longitude)
          : Infinity;

      let category = 'Tham quan';
      const typeData = Array.isArray(place.types) ? place.types[0] : place.types;
      if (typeData && typeData.categories) {
        const catData = Array.isArray(typeData.categories) ? typeData.categories[0] : typeData.categories;
        if (catData && catData.name) category = catData.name;
      }

      let parsedImageUrl = 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=600&q=80';
      if (Array.isArray(place.image_url) && place.image_url.length > 0) {
        parsedImageUrl = place.image_url[0];
      } else if (typeof place.image_url === 'string' && place.image_url.trim().length > 0) {
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
          if (cat.includes('nhà hàng') || cat.includes('khách sạn') || cat.includes('quán ăn') || cat.includes('lưu trú') || cat.includes('ẩm thực') || cat.includes('quán cà phê') || cat.includes('cafe')) {
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

