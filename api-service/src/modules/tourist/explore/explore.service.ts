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
  participant_count: number | null;
  status: string | null;
  destination: string | null;
  created_at: string;
  is_public: boolean | null;
}

interface ItineraryTimeRow {
  arrival_time: string | null;
  departure_time: string | null;
}

interface PlaceRow {
  id: string;
  name: string;
  city: string | null;
  average_rating: number | null;
  review_count: number | null;
  image_url?: string | null;
}

interface CategoryRow {
  id: string;
  name: string;
}

interface PlaceCategoryRow {
  place_id: string;
}

@Injectable()
export class ExploreService {
  private readonly defaultImageUrl =
    process.env.DEFAULT_PLACE_IMAGE_URL ||
    'https://placehold.co/1080x720?text=No+Image';

  private resolveImage(imageUrl?: string | null): string {
    if (imageUrl && imageUrl.trim().length > 0) {
      return imageUrl;
    }

    return this.defaultImageUrl;
  }

  async getExploreHome(touristId: string) {
    if (!touristId) {
      throw new BadRequestException('tourist_id is required');
    }

    const currentItinerary = await this.getCurrentItinerary(touristId);
    const publicItinerariesResult = await this.getPublicItineraries(1, 5);
    const featuredPlacesResult = await this.getPlacesByCategory(
      undefined,
      1,
      5,
    );
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
        featured_places: '/explore/places?page=1&limit=50',
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
        'id, creator_id, description, start_date, end_date, participant_count, status, destination, created_at, is_public',
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
        title: ongoing.destination ?? 'Lịch trình của bạn',
        date_range: `${ongoing.start_date ?? ''} - ${ongoing.end_date ?? ''}`,
        time_range: await this.getTimeRange(ongoing.id),
        participant_count: ongoing.participant_count ?? 0,
        status: ongoing.status,
        can_start: false,
        start_target: null,
      };
    }

    const { data: upcoming, error: upcomingError } = await supabase
      .schema('travel')
      .from('itineraries')
      .select(
        'id, creator_id, description, start_date, end_date, participant_count, status, destination, created_at, is_public',
      )
      .eq('creator_id', touristId)
      .in('status',['ongoing', 'completed'])
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
        title: upcoming.destination ?? 'Lịch trình của bạn',
        date_range: `${upcoming.start_date ?? ''} - ${upcoming.end_date ?? ''}`,
        time_range: await this.getTimeRange(upcoming.id),
        participant_count: upcoming.participant_count ?? 0,
        status: upcoming.status,
        can_start: true,
        start_target: `/explore/itineraries/${upcoming.id}/start?tourist_id=${touristId}`,
      };
    }

    const { data: recent, error: recentError } = await supabase
      .schema('travel')
      .from('itineraries')
      .select(
        'id, creator_id, description, start_date, end_date, participant_count, status, destination, created_at, is_public',
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
      title: recent.destination ?? 'Lịch trình của bạn',
      date_range: `${recent.start_date ?? ''} - ${recent.end_date ?? ''}`,
      time_range: await this.getTimeRange(recent.id),
      participant_count: recent.participant_count ?? 0,
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
        'id, creator_id, description, start_date, end_date, participant_count, status, destination, created_at, is_public',
        { count: 'exact' },
      )
      .eq('is_public', true)
      .order('created_at', { ascending: false })
      .range(offset, offset + safeLimit - 1)
      .returns<ItineraryRow[]>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const mapped = (data ?? []).map((item) => ({
      id: item.id,
      title: item.destination ?? 'Lịch trình công khai',
      location: item.destination ?? 'Không xác định',
      description: item.description,
      start_date: item.start_date,
      end_date: item.end_date,
      days: this.getDays(item.start_date, item.end_date),
      participant_count: item.participant_count,
      image: this.defaultImageUrl,
    }));

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

  async getPlacesByCategory(category?: string, page = 1, limit = 5) {
    const safePage = page > 0 ? page : 1;
    const safeLimit = limit > 0 ? limit : 5;
    const offset = (safePage - 1) * safeLimit;

    let categoryName: string | null = null;
    let placeIdsByCategory: string[] | null = null;

    if (category && category.trim().length > 0) {
      categoryName = category.trim().toLowerCase();

      const { data: categories, error: categoryError } = await supabase
        .schema('travel')
        .from('categories')
        .select('id, name')
        .ilike('name', `%${categoryName}%`)
        .returns<CategoryRow[]>();

      if (categoryError) {
        throw new InternalServerErrorException(categoryError.message);
      }

      const categoryIds = (categories ?? []).map((item) => item.id);
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
      .select('id, name, city, average_rating, review_count, image_url', {
        count: 'exact',
      })
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
        city: item.city,
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
