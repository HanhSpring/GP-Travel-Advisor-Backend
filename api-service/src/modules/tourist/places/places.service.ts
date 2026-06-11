import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { supabase } from '../../../config/supabase';
import { RecommendationsService } from './recommendations.service';

interface PlaceRow {
  id: string;
  name: string;
  address: string | null;
  city_id: string | null;
  cities: { name: string | null } | { name: string | null }[] | null;
  average_rating: number;
  review_count: number;
  description: string | null;
  open_time: string | null;
  close_time: string | null;
  vendor_id: string | null;
  is_approved: boolean;
  is_active: boolean;
  image_url: unknown;
  vibes: string | string[] | null;
  type_id: string | null;
  types: {
    id: string;
    category_id: string | null;
    categories: { id: string; name: string } | { id: string; name: string }[] | null;
  } | {
    id: string;
    category_id: string | null;
    categories: { id: string; name: string } | { id: string; name: string }[] | null;
  }[] | null;
}

interface PlaceTypeRow {
  id: string;
  category_id: string | null;
  categories: { id: string; name: string } | { id: string; name: string }[] | null;
}

interface CategoryRow {
  id: string;
  name: string;
}

interface ReviewRow {
  id: string;
  tourist_id: string;
  rating: number;
  created_at: string;
}

interface RatingRow {
  rating: number;
}

interface UserRow {
  id: string;
  full_name: string | null;
  phone_number?: string | null;
}

interface ReviewContentRow {
  review_id: string;
  content: string | null;
}

@Injectable()
export class PlacesService {
  private readonly defaultPlaceImageUrl =
    process.env.DEFAULT_PLACE_IMAGE_URL ||
    'https://placehold.co/1080x720?text=No+Image';

  private readonly emptyUsers: Array<{ id: string; full_name: string | null }> =
    [];

  private readonly emptyContents: Array<{
    review_id: string;
    content: string | null;
  }> = [];

  constructor(private readonly recommendations: RecommendationsService) {}

  private extractCityName(
    cityData: { name: string | null } | { name: string | null }[] | null,
  ): string | null {
    if (!cityData) {
      return null;
    }

    if (Array.isArray(cityData)) {
      return cityData[0]?.name ?? null;
    }

    return cityData.name ?? null;
  }

  private extractVibes(vibes: string | string[] | null): string[] {
    if (!vibes) {
      return [];
    }

    if (Array.isArray(vibes)) {
      return vibes.filter((v) => typeof v === 'string' && v.trim().length > 0);
    }

    if (typeof vibes === 'string') {
      return vibes
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
    }

    return [];
  }

  async getPlaceDetail(placeId: string, touristId?: string) {
    const { data: place, error: placeError } = await supabase
      .schema('travel')
      .from('places')
      .select('*, cities(name), type_id, types(id, category_id, categories(id, name))')
      .eq('id', placeId)
      .eq('is_approved', true)
      .eq('is_active', true)
      .maybeSingle<PlaceRow>();

    if (placeError) {
      throw new InternalServerErrorException(placeError.message);
    }

    if (!place) {
      throw new NotFoundException('Place not found');
    }

    // Extract category from type relationship
    let categoryList: string[] = [];
    const typeData = Array.isArray(place.types) ? place.types?.[0] : place.types;
    if (typeData) {
      const categoryData = Array.isArray(typeData.categories)
        ? typeData.categories?.[0]
        : typeData.categories;
      if (categoryData?.name) {
        categoryList = [categoryData.name];
      }
    }

    const { data: ratingRows, error: ratingRowsError } = await supabase
      .schema('review_ai')
      .from('reviews')
      .select('rating')
      .eq('place_id', placeId);

    if (ratingRowsError) {
      throw new InternalServerErrorException(ratingRowsError.message);
    }

    const { data: reviews, error: reviewsError } = await supabase
      .schema('review_ai')
      .from('reviews')
      .select('id, tourist_id, rating, created_at')
      .eq('place_id', placeId)
      .order('created_at', { ascending: false })
      .limit(10);

    if (reviewsError) {
      throw new InternalServerErrorException(reviewsError.message);
    }

    const typedReviews = reviews as ReviewRow[] | null;
    const userIds =
      typedReviews?.map((item) => item.tourist_id).filter(Boolean) ?? [];
    const reviewIds = typedReviews?.map((item) => item.id) ?? [];

    const usersPromise = userIds.length
      ? supabase
          .schema('public')
          .from('users')
          .select('id, full_name')
          .in('id', userIds)
      : Promise.resolve({ data: this.emptyUsers, error: null });

    const contentsPromise = reviewIds.length
      ? supabase
          .schema('review_ai')
          .from('review_contents')
          .select('review_id, content')
          .in('review_id', reviewIds)
      : Promise.resolve({ data: this.emptyContents, error: null });

    const [usersResult, contentsResult] = await Promise.all([
      usersPromise,
      contentsPromise,
    ]);

    if (usersResult.error) {
      throw new InternalServerErrorException(usersResult.error.message);
    }

    if (contentsResult.error) {
      throw new InternalServerErrorException(contentsResult.error.message);
    }

    const users = (usersResult.data ?? this.emptyUsers) as UserRow[];
    const contents = (contentsResult.data ??
      this.emptyContents) as ReviewContentRow[];

    const reviewList = (typedReviews ?? []).map((review) => {
      const user = users.find((item) => item.id === review.tourist_id);
      const content = contents.find((item) => item.review_id === review.id);

      return {
        id: review.id,
        user_name: user?.full_name ?? 'Ẩn danh',
        rating: review.rating,
        content: content?.content ?? '',
        created_at: review.created_at,
      };
    });

    const breakdown: Record<number, number> = {
      1: 0,
      2: 0,
      3: 0,
      4: 0,
      5: 0,
    };

    ((ratingRows as RatingRow[] | null) ?? []).forEach((item) => {
      if (item.rating >= 1 && item.rating <= 5) {
        breakdown[item.rating] += 1;
      }
    });

    const { data: vendor, error: vendorError } = place.vendor_id
      ? await supabase
          .schema('public')
          .from('users')
          .select('phone_number')
          .eq('id', place.vendor_id)
          .maybeSingle<UserRow>()
      : { data: null, error: null };

    if (vendorError) {
      throw new InternalServerErrorException(vendorError.message);
    }

    const relatedPlaces = await this.buildRelatedPlaces(
      placeId,
      place.city_id,
      touristId,
    );

    const cityName = this.extractCityName(place.cities);
    const vibes = this.extractVibes(place.vibes);

    const isFavorite = touristId
      ? await this.checkFavorite(touristId, placeId)
      : false;

    return {
      id: place.id,
      name: place.name,
      address: place.address,
      city: cityName ?? '',
      district: this.extractDistrict(place.address ?? null),
      rating: Number(place.average_rating) || 0,
      review_count: place.review_count || 0,
      is_favorite: isFavorite,
      image_url: this.resolvePlaceImage(place.image_url),
      categories: categoryList,
      vibes,
      images: this.buildGallery(place.image_url),
      description: place.description,
      open_time: place.open_time,
      close_time: place.close_time,
      is_open_now: this.isOpenNow(
        place.open_time ?? null,
        place.close_time ?? null,
      ),
      phone: vendor?.phone_number ?? null,
      reviews: {
        average: Number(place.average_rating) || 0,
        total: place.review_count || 0,
        breakdown,
        list: reviewList,
      },
      related_places: relatedPlaces,
    };
  }

  private mapRelatedRow(item: PlaceRow) {
    return {
      id: item.id,
      name: item.name,
      city: this.extractCityName(item.cities),
      rating: Number(item.average_rating) || 0,
      review_count: item.review_count || 0,
      image: this.resolvePlaceImage(item.image_url),
      vibes: this.extractVibes(item.vibes),
    };
  }

  /**
   * Mục "Có thể bạn sẽ thích": ưu tiên gợi ý từ AI Service (Hybrid CB + CF + khoảng cách).
   * AI Service chỉ trả place id đã xếp hạng → ở đây enrich lại bằng Supabase để có
   * ảnh/rating đúng với app. Nếu AI Service không sẵn sàng/không có gợi ý → fallback
   * danh sách cùng thành phố xếp theo rating (hành vi cũ).
   */
  private async buildRelatedPlaces(
    placeId: string,
    cityId: string | null,
    touristId?: string,
  ) {
    const numericUserId =
      touristId && /^\d+$/.test(touristId) ? Number(touristId) : null;

    const recommended = await this.recommendations.getRecommendedPlaceIds(
      placeId,
      { userId: numericUserId, k: 10 },
    );

    const recommendedIds = recommended.map((item) => item.id);
    if (recommendedIds.length > 0) {
      const { data, error } = await supabase
        .schema('travel')
        .from('places')
        .select(
          'id, name, city_id, cities(name), average_rating, review_count, image_url, vibes, type_id, types(id, category_id, categories(id, name))',
        )
        .eq('is_approved', true)
        .eq('is_active', true)
        .in('id', recommendedIds)
        .returns<PlaceRow[]>();

      if (error) {
        throw new InternalServerErrorException(error.message);
      }

      const byId = new Map<string, PlaceRow>(
        ((data as PlaceRow[] | null) ?? []).map((row) => [row.id, row]),
      );

      // Giữ đúng thứ tự xếp hạng của model, bỏ id không còn approved/active.
      const ordered = recommendedIds
        .map((id) => byId.get(id))
        .filter((row): row is PlaceRow => Boolean(row))
        .slice(0, 10)
        .map((row) => this.mapRelatedRow(row));

      if (ordered.length > 0) {
        return ordered;
      }
    }

    return this.fetchSameCityPlaces(placeId, cityId);
  }

  /** Fallback: địa điểm cùng thành phố, xếp theo rating. */
  private async fetchSameCityPlaces(placeId: string, cityId: string | null) {
    const { data: related, error: relatedError } = await supabase
      .schema('travel')
      .from('places')
      .select(
        'id, name, city_id, cities(name), average_rating, review_count, image_url, vibes, type_id, types(id, category_id, categories(id, name))',
      )
      .eq('is_approved', true)
      .eq('is_active', true)
      .eq('city_id', cityId)
      .neq('id', placeId)
      .order('average_rating', { ascending: false })
      .limit(12)
      .returns<PlaceRow[]>();

    if (relatedError) {
      throw new InternalServerErrorException(relatedError.message);
    }

    return ((related as PlaceRow[] | null) ?? [])
      .slice(0, 10)
      .map((item) => this.mapRelatedRow(item));
  }

  private async checkFavorite(
    touristId: string,
    placeId: string,
  ): Promise<boolean> {
    const { data, error } = await supabase
      .schema('travel')
      .from('favorite_places')
      .select('tourist_id')
      .eq('tourist_id', touristId)
      .eq('place_id', placeId)
      .maybeSingle<{ tourist_id: string }>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return Boolean(data);
  }

  private extractDistrict(address?: string | null): string | null {
    if (!address) {
      return null;
    }

    const segments = address.split(',').map((item) => item.trim());
    if (segments.length >= 2) {
      return segments[1];
    }

    return null;
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

  private resolvePlaceImage(imageUrl?: unknown): string {
    const images = this.toImageList(imageUrl);
    if (images.length > 0) {
      return images[0];
    }

    return this.defaultPlaceImageUrl;
  }

  private buildGallery(imageUrl?: unknown): string[] {
    const images = this.toImageList(imageUrl);
    if (images.length > 0) {
      return images;
    }

    return [this.defaultPlaceImageUrl];
  }

  private isOpenNow(
    openTime?: string | null,
    closeTime?: string | null,
  ): boolean | null {
    if (!openTime || !closeTime) {
      return null;
    }

    const now = new Date();
    const [openHour, openMinute] = openTime.split(':').map(Number);
    const [closeHour, closeMinute] = closeTime.split(':').map(Number);

    const open = new Date(now);
    open.setHours(openHour, openMinute, 0, 0);

    const close = new Date(now);
    close.setHours(closeHour, closeMinute, 0, 0);

    if (close < open) {
      close.setDate(close.getDate() + 1);
      if (now < open) {
        now.setDate(now.getDate() + 1);
      }
    }

    return now >= open && now <= close;
  }
}
