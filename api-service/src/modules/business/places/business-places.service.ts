import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { supabase } from '../../../config/supabase';

interface PlaceRow {
  id: string;
  image_url: string[] | string | null;
  name: string;
  address: string | null;
  is_approved: boolean | null;
  average_rating: number | null;
  review_count: number | null;
  registered_date: string | null;
  type_id: string | null;
  city_id: string | null;
  cities:
    | {
        name: string | null;
      }
    | {
        name: string | null;
      }[]
    | null;
}

interface BusinessRow {
  id: string;
}

interface TypeRow {
  id: string;
  name: string;
  categories: { name: string | null } | Array<{ name: string | null }> | null;
}

type PlaceStatus = 'all' | 'pending' | 'approved' | 'rejected';
type PlaceSort = 'default' | 'popular' | 'newest';
type PlaceFields = 'full' | 'basic';

const VENDOR_ID_CACHE_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class BusinessPlacesService {
  private readonly vendorIdCache = new Map<
    string,
    { resolvedId: string; expiresAt: number }
  >();

  private async resolveVendorId(vendorId: string): Promise<string> {
    const normalizedVendorId = vendorId?.trim();

    if (!normalizedVendorId) {
      throw new BadRequestException('vendor_id is required');
    }

    const cached = this.vendorIdCache.get(normalizedVendorId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.resolvedId;
    }

    // If caller already sends business id used by travel.places.vendor_id, keep it.
    const { data: existingPlaceRows, error: existingPlaceError } =
      await supabase
        .schema('travel')
        .from('places')
        .select('id')
        .eq('vendor_id', normalizedVendorId)
        .limit(1);

    if (existingPlaceError) {
      throw new InternalServerErrorException(existingPlaceError.message);
    }

    let resolvedId = normalizedVendorId;

    if ((existingPlaceRows ?? []).length === 0) {
      // Fallback: validate against public.businesses.id.
      const { data: businessRow, error: businessError } = await supabase
        .schema('public')
        .from('businesses')
        .select('id')
        .eq('id', normalizedVendorId)
        .maybeSingle<BusinessRow>();

      if (businessError) {
        throw new InternalServerErrorException(businessError.message);
      }

      resolvedId = businessRow?.id ?? normalizedVendorId;
    }

    this.vendorIdCache.set(normalizedVendorId, {
      resolvedId,
      expiresAt: Date.now() + VENDOR_ID_CACHE_TTL_MS,
    });

    return resolvedId;
  }

  private mapStatus(
    isApproved: boolean | null,
  ): 'pending' | 'approved' | 'rejected' {
    if (isApproved === true) {
      return 'approved';
    }

    if (isApproved === false) {
      return 'rejected';
    }

    return 'pending';
  }

  async getPlaces(
    vendorId: string,
    page: number = 1,
    limit: number = 10,
    status: PlaceStatus = 'all',
    search?: string,
    sort: PlaceSort = 'default',
    fields: PlaceFields = 'full',
  ) {
    const resolvedVendorId = await this.resolveVendorId(vendorId);

    if (!['all', 'pending', 'approved', 'rejected'].includes(status)) {
      throw new BadRequestException(
        'status must be one of: all, pending, approved, rejected',
      );
    }

    if (!['default', 'popular', 'newest'].includes(sort)) {
      throw new BadRequestException(
        'sort must be one of: default, popular, newest',
      );
    }

    const offset = (page - 1) * limit;

    let query = supabase
      .schema('travel')
      .from('places')
      .select(
        'id, name, address, image_url, is_approved, average_rating, review_count, registered_date, type_id, city_id, cities(name)',
        { count: 'exact' },
      )
      .eq('vendor_id', resolvedVendorId)
      .or('is_deleted.is.null,is_deleted.eq.false');

    if (status === 'pending') {
      query = query.is('is_approved', null);
    } else if (status === 'approved') {
      query = query.eq('is_approved', true);
    } else if (status === 'rejected') {
      query = query.eq('is_approved', false);
    }

    if (search) {
      query = query.ilike('name', `%${search}%`);
    }

    if (sort === 'popular') {
      query = query
        .order('average_rating', { ascending: false })
        .order('review_count', { ascending: false });
    } else {
      query = query.order('registered_date', { ascending: false });
    }

    const { data, error, count } = await query.range(
      offset,
      offset + limit - 1,
    );

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const placeRows = (data ?? []) as PlaceRow[];
    const typeIds = [
      ...new Set(
        placeRows
          .map((item) => item.type_id)
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    const placeIds = placeRows.map((item) => item.id);

    // 'basic' mode is for callers that only need id/name/city (e.g. building
    // a filter dropdown) — skip the category and live-rating enrichment
    // entirely instead of paying for two extra Supabase round-trips per page.
    const needsEnrichment = fields !== 'basic';

    // These two lookups are independent of each other, so fire them in
    // parallel instead of awaiting one after the other.
    const [typesData, reviewRows] = needsEnrichment
      ? await Promise.all([
          typeIds.length > 0
            ? supabase
                .schema('travel')
                .from('types')
                .select('id, name, categories(name)')
                .in('id', typeIds)
                .then(({ data: rows, error: typesError }) => {
                  if (typesError) {
                    throw new InternalServerErrorException(
                      typesError.message,
                    );
                  }
                  return rows;
                })
            : Promise.resolve(null),
          placeIds.length > 0
            ? supabase
                .schema('review_ai')
                .from('reviews')
                .select('place_id, rating')
                .in('place_id', placeIds)
                .then(({ data: rows }) => rows)
            : Promise.resolve(null),
        ])
      : [null, null];

    const categoryNameByTypeId = new Map<string, string>();
    for (const type of (typesData ?? []) as TypeRow[]) {
      const category = Array.isArray(type.categories)
        ? type.categories[0]
        : type.categories;
      categoryNameByTypeId.set(type.id, category?.name || type.name);
    }

    // Compute real-time ratings from review_ai.reviews (places.average_rating is not auto-updated)
    const liveRatingByPlaceId = new Map<
      string,
      { average: number; count: number }
    >();
    if (reviewRows && reviewRows.length > 0) {
      const groups: Record<string, number[]> = {};
      for (const row of reviewRows as {
        place_id: string;
        rating: number;
      }[]) {
        if (!groups[row.place_id]) groups[row.place_id] = [];
        groups[row.place_id].push(row.rating);
      }
      for (const [placeId, ratings] of Object.entries(groups)) {
        const count = ratings.length;
        const avg =
          count > 0
            ? Number((ratings.reduce((a, b) => a + b, 0) / count).toFixed(1))
            : 0;
        liveRatingByPlaceId.set(placeId, { average: avg, count });
      }
    }

    const places = placeRows.map((item) => {
      const city = Array.isArray(item.cities)
        ? item.cities[0]?.name
        : item.cities?.name;

      const liveRating = liveRatingByPlaceId.get(item.id);
      return {
        id: item.id,
        name: item.name,
        address: item.address ?? '',
        city: city ?? '',
        image_url: item.image_url ?? null,
        categories: item.type_id
          ? [categoryNameByTypeId.get(item.type_id) ?? 'Khác']
          : [],
        rating: liveRating?.average ?? Number(item.average_rating) ?? 0,
        review_count: liveRating?.count ?? item.review_count ?? 0,
        status: this.mapStatus(item.is_approved),
        registered_date: item.registered_date ?? '',
      };
    });

    return {
      data: places,
      pagination: {
        page,
        limit,
        total: count || 0,
        pages: Math.ceil((count || 0) / limit),
      },
    };
  }
}
