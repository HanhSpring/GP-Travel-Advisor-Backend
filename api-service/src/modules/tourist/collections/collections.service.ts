import { AppConfig } from '../../../config/app.config';
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
  adult_count: number | null;
  children_count: number | null;
  status: string;
  description?: string;
}

interface PlaceRow {
  id: string;
  name: string;
  city_id: string | null;
  cities:
    | {
        name: string | null;
      }
    | {
        name: string | null;
      }[]
    | null;
  average_rating: number;
  review_count: number;
  image_url: unknown;
}

interface FavoriteItineraryItem {
  itineraries: ItineraryRow;
}

interface FavoritePlaceItem {
  places: PlaceRow;
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

@Injectable()
export class CollectionsService {
  private readonly defaultImageUrl =
    AppConfig.DEFAULT_PLACE_IMAGE_URL;

  private toParticipantCount(itinerary: ItineraryRow): number {
    const adults = itinerary.adult_count ?? 0;
    const children = itinerary.children_count ?? 0;
    return adults + children;
  }

  private extractCityName(
    cityData:
      | {
          name: string | null;
        }
      | {
          name: string | null;
        }[]
      | null,
  ): string {
    if (!cityData) {
      return '';
    }

    if (Array.isArray(cityData)) {
      return cityData[0]?.name ?? '';
    }

    return cityData.name ?? '';
  }

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
            adult_count, children_count, status, description
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
          id, name, city_id, cities(name), average_rating, review_count, image_url
        )
        `,
      )
      .eq('tourist_id', touristId)
      .order('added_at', { ascending: false })
      .limit(5);

    if (placesError) {
      throw new InternalServerErrorException(placesError.message);
    }

    const itineraryRows = (
      favoriteItineraries as unknown as FavoriteItineraryItem[]
    )
      .filter((item) => item.itineraries)
      .map((item) => item.itineraries);

    const itineraryImages = await this.getItineraryImageMap(
      itineraryRows.map((item) => item.id),
    );

    const itinerariesData = itineraryRows
      .map((item) => {
        const it = item;
        const startDate = new Date(it.start_date);
        const endDate = new Date(it.end_date);
        const days = Math.ceil(
          (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
        );
        const imageGallery = itineraryImages.get(it.id) ?? [
          this.defaultImageUrl,
        ];

        return {
          id: it.id,
          title: it.description ?? 'Lịch trình',
          location: it.destination ?? '',
          days: days || 1,
          participant_count: this.toParticipantCount(it),
          status: it.status,
          image: imageGallery[0],
          image_gallery: imageGallery,
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
          city: this.extractCityName(place.cities),
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
          adult_count, children_count, status, description
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

    const itineraryRows = (
      favoriteItineraries as unknown as FavoriteItineraryItem[]
    )
      .filter((item) => item.itineraries)
      .map((item) => item.itineraries);

    const itineraryImages = await this.getItineraryImageMap(
      itineraryRows.map((item) => item.id),
    );

    const itinerariesData = itineraryRows.map((item) => {
      const it = item;
      const startDate = new Date(it.start_date);
      const endDate = new Date(it.end_date);
      const days = Math.ceil(
        (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
      );
      const imageGallery = itineraryImages.get(it.id) ?? [this.defaultImageUrl];

      return {
        id: it.id,
        title: it.description ?? 'Lịch trình',
        location: it.destination ?? '',
        days: days || 1,
        participant_count: this.toParticipantCount(it),
        status: it.status,
        image: imageGallery[0],
        image_gallery: imageGallery,
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
          id, name, city_id, cities(name), average_rating, review_count, image_url
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
          city: this.extractCityName(place.cities),
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

  private resolveImage(imageUrl: unknown): string {
    if (Array.isArray(imageUrl)) {
      const first = imageUrl.find(
        (item): item is string =>
          typeof item === 'string' && item.trim().length > 0,
      );
      if (first) {
        return first.trim();
      }
      return this.defaultImageUrl;
    }

    if (typeof imageUrl === 'string' && imageUrl.trim().length > 0) {
      return imageUrl.trim();
    }
    return this.defaultImageUrl;
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
}
