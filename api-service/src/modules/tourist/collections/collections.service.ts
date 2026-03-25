import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { supabase } from '../../../config/supabase';

interface ItineraryRow {
  id: string;
  destination: string;
  start_date: string;
  end_date: string;
  participant_count: number;
  status: string;
  description?: string;
}

interface PlaceRow {
  id: string;
  name: string;
  city: string;
  average_rating: number;
  review_count: number;
  image_url: string | null;
}

interface FavoriteItineraryItem {
  itineraries: ItineraryRow;
}

interface FavoritePlaceItem {
  places: PlaceRow;
}

@Injectable()
export class CollectionsService {
  private readonly defaultImageUrl =
    process.env.DEFAULT_PLACE_IMAGE_URL ||
    'https://placehold.co/1080x720?text=No+Image';

  async getCollectionsHome(touristId: string) {
    if (!touristId) {
      throw new BadRequestException('tourist_id is required');
    }

    // Get favorite itineraries (5 items)
    const { data: favoriteItineraries, error: itinerariesError } =
      await supabase
        .schema('travel')
        .from('favorite_itineraries')
        .select(
          `
          itineraries:itinerary_id(
            id, destination, start_date, end_date, 
            participant_count, status, description
          )
          `,
        )
        .eq('tourist_id', touristId)
        .order('added_at', { ascending: false })
        .limit(5);

    if (itinerariesError) {
      throw new InternalServerErrorException(itinerariesError.message);
    }

    // Get favorite places (5 items)
    const { data: favoritePlaces, error: placesError } = await supabase
      .schema('travel')
      .from('favorite_places')
      .select(
        `
        places:place_id(
          id, name, city, average_rating, review_count, image_url
        )
        `,
      )
      .eq('tourist_id', touristId)
      .order('added_at', { ascending: false })
      .limit(5);

    if (placesError) {
      throw new InternalServerErrorException(placesError.message);
    }

    const itinerariesData = (
      favoriteItineraries as unknown as FavoriteItineraryItem[]
    )
      .filter((item) => item.itineraries)
      .map((item) => {
        const it = item.itineraries;
        const startDate = new Date(it.start_date);
        const endDate = new Date(it.end_date);
        const days = Math.ceil(
          (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
        );

        return {
          id: it.id,
          title: it.destination ?? 'Lịch trình',
          location: it.destination ?? '',
          days: days || 1,
          participant_count: it.participant_count ?? 0,
          status: it.status,
        };
      })
      .slice(0, 5);

    const placesData = (favoritePlaces as unknown as FavoritePlaceItem[])
      .filter((item) => item.places)
      .map((item) => {
        const place = item.places;
        return {
          id: place.id,
          name: place.name,
          city: place.city,
          image: this.resolveImage(place.image_url),
          rating: place.average_rating ?? 0,
          review_count: place.review_count ?? 0,
        };
      })
      .slice(0, 5);

    return {
      favorite_itineraries: itinerariesData,
      favorite_places: placesData,
      view_all_targets: {
        favorite_itineraries: '/collections/itineraries?page=1&limit=50',
        favorite_places: '/collections/places?page=1&limit=50',
      },
    };
  }

  async getFavoriteItineraries(
    touristId: string,
    page: number = 1,
    limit: number = 5,
  ) {
    if (!touristId) {
      throw new BadRequestException('tourist_id is required');
    }

    if (page < 1 || limit < 1) {
      throw new BadRequestException('page and limit must be greater than 0');
    }

    const offset = (page - 1) * limit;

    // Get favorite itineraries with pagination
    const { data: favoriteItineraries, error: dataError } = await supabase
      .schema('travel')
      .from('favorite_itineraries')
      .select(
        `
        itineraries:itinerary_id(
          id, destination, start_date, end_date, 
          participant_count, status, description
        )
        `,
      )
      .eq('tourist_id', touristId)
      .order('added_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (dataError) {
      throw new InternalServerErrorException(dataError.message);
    }

    // Get total count
    const { count, error: countError } = await supabase
      .schema('travel')
      .from('favorite_itineraries')
      .select('*', { count: 'exact', head: true })
      .eq('tourist_id', touristId);

    if (countError) {
      throw new InternalServerErrorException(countError.message);
    }

    const itinerariesData = (
      favoriteItineraries as unknown as FavoriteItineraryItem[]
    )
      .filter((item) => item.itineraries)
      .map((item) => {
        const it = item.itineraries;
        const startDate = new Date(it.start_date);
        const endDate = new Date(it.end_date);
        const days = Math.ceil(
          (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
        );

        return {
          id: it.id,
          title: it.destination ?? 'Lịch trình',
          location: it.destination ?? '',
          days: days || 1,
          participant_count: it.participant_count ?? 0,
          status: it.status,
        };
      });

    const totalPages = Math.ceil((count || 0) / limit);

    return {
      data: itinerariesData,
      pagination: {
        page,
        limit,
        total: count || 0,
        pages: totalPages,
      },
    };
  }

  async getFavoritePlaces(
    touristId: string,
    page: number = 1,
    limit: number = 5,
  ) {
    if (!touristId) {
      throw new BadRequestException('tourist_id is required');
    }

    if (page < 1 || limit < 1) {
      throw new BadRequestException('page and limit must be greater than 0');
    }

    const offset = (page - 1) * limit;

    // Get favorite places with pagination
    const { data: favoritePlaces, error: dataError } = await supabase
      .schema('travel')
      .from('favorite_places')
      .select(
        `
        places:place_id(
          id, name, city, average_rating, review_count, image_url
        )
        `,
      )
      .eq('tourist_id', touristId)
      .order('added_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (dataError) {
      throw new InternalServerErrorException(dataError.message);
    }

    // Get total count
    const { count, error: countError } = await supabase
      .schema('travel')
      .from('favorite_places')
      .select('*', { count: 'exact', head: true })
      .eq('tourist_id', touristId);

    if (countError) {
      throw new InternalServerErrorException(countError.message);
    }

    const placesData = (favoritePlaces as unknown as FavoritePlaceItem[])
      .filter((item) => item.places)
      .map((item) => {
        const place = item.places;
        return {
          id: place.id,
          name: place.name,
          city: place.city,
          image: this.resolveImage(place.image_url),
          rating: place.average_rating ?? 0,
          review_count: place.review_count ?? 0,
        };
      });

    const totalPages = Math.ceil((count || 0) / limit);

    return {
      data: placesData,
      pagination: {
        page,
        limit,
        total: count || 0,
        pages: totalPages,
      },
    };
  }

  private resolveImage(imageUrl: string | null): string {
    if (imageUrl && imageUrl.trim()) {
      return imageUrl;
    }
    return this.defaultImageUrl;
  }
}
