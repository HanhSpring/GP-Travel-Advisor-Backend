import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { supabase } from '../../../config/supabase';

interface CategoryRow {
  id: string;
  name: string;
}

interface PlaceCategoryJoinRow {
  category_id: string;
  categories: CategoryRow | CategoryRow[] | null;
}

interface PlaceRow {
  id: string;
  name: string;
  address: string | null;
  is_approved: boolean | null;
  average_rating: number | null;
  review_count: number | null;
  registered_date: string | null;
  place_categories: PlaceCategoryJoinRow[] | null;
}

interface BusinessRow {
  id: string;
}

type PlaceStatus = 'all' | 'pending' | 'approved' | 'rejected';
type PlaceSort = 'default' | 'popular' | 'newest';

@Injectable()
export class BusinessPlacesService {
  private async resolveVendorId(vendorId: string): Promise<string> {
    const normalizedVendorId = vendorId?.trim();

    if (!normalizedVendorId) {
      throw new BadRequestException('vendor_id is required');
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

    if ((existingPlaceRows ?? []).length > 0) {
      return normalizedVendorId;
    }

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

    return businessRow?.id ?? normalizedVendorId;
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

  private extractCategoryNames(
    placeCategories: PlaceCategoryJoinRow[] | null,
  ): string[] {
    if (!placeCategories || placeCategories.length === 0) {
      return [];
    }

    const names: string[] = [];

    for (const item of placeCategories) {
      const categoryData = item.categories;

      if (!categoryData) {
        continue;
      }

      if (Array.isArray(categoryData)) {
        for (const category of categoryData) {
          if (category?.name) {
            names.push(category.name);
          }
        }
      } else if (categoryData.name) {
        names.push(categoryData.name);
      }
    }

    return names;
  }

  async getPlaces(
    vendorId: string,
    page: number = 1,
    limit: number = 10,
    status: PlaceStatus = 'all',
    search?: string,
    sort: PlaceSort = 'default',
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
        'id, name, address, is_approved, average_rating, review_count, registered_date, place_categories(category_id, categories(id, name))',
        { count: 'exact' },
      )
      .eq('vendor_id', resolvedVendorId);

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

    const places = ((data ?? []) as PlaceRow[]).map((item) => ({
      id: item.id,
      name: item.name,
      address: item.address ?? '',
      categories: this.extractCategoryNames(item.place_categories),
      rating: Number(item.average_rating) || 0,
      review_count: item.review_count || 0,
      status: this.mapStatus(item.is_approved),
      registered_date: item.registered_date ?? '',
    }));

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
