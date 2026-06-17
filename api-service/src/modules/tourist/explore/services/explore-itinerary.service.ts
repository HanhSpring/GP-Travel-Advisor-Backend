import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { supabase } from '../../../../config/supabase';
import { ExploreCacheService } from './explore-cache.service';
import {
  ExplorePublicItinerariesResponse,
  ItineraryRow,
  ItineraryTimeRow,
  ItineraryDetailPlaceRow,
  UserRow,
} from '../explore.types';
import { defaultImageUrl, getDays, toParticipantCount, toImageList } from './explore.utils';

@Injectable()
/**
 * Service responsible for interacting with the AI model to generate and process itineraries.
 */
export class ExploreItineraryService {
  constructor(private readonly cacheService: ExploreCacheService) {}

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
        participant_count: toParticipantCount(ongoing),
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
        participant_count: toParticipantCount(upcoming),
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
      participant_count: toParticipantCount(recent),
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

  async getPublicItineraries(
    page = 1,
    limit = 5,
  ): Promise<ExplorePublicItinerariesResponse> {
    const cacheKey = `explore:public_itineraries:${page}:${limit}`;
    const cached =
      this.cacheService.getFromCache<ExplorePublicItinerariesResponse>(cacheKey);
    if (cached) return cached;
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
    const creatorIds = (data ?? []).map((item) => item.creator_id);

    const [creatorNameMap, itineraryImages] = await Promise.all([
      this.getCreatorNameMap(creatorIds),
      this.getItineraryImageMap(itineraryIds),
    ]);

    const mapped = (data ?? []).map((item) => {
      const gallery = itineraryImages.get(item.id) ?? [];
      const imageGallery =
        gallery.length > 0 ? gallery.slice(0, 3) : [defaultImageUrl];

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
        days: getDays(item.start_date, item.end_date),
        participant_count: toParticipantCount(item),
        creator_id: item.creator_id,
        creator_name: creatorNameMap.get(item.creator_id) ?? 'Traveler',
        image: imageGallery[0],
        image_gallery: imageGallery,
      };
    });

    const result = {
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

  async getItineraryImageMap(
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
      const images = toImageList(place?.image_url);
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

  async getCreatorNameMap(
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
}
