import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
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

interface PlaceListRow {
  id: string;
  name: string;
  address: string | null;
  is_approved: boolean | null;
  vendor_id: string | null;
  registered_date: string | null;
  place_categories: PlaceCategoryJoinRow[] | null;
}

interface PlaceDetailRow {
  id: string;
  name: string;
  description: string | null;
  address: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  is_approved: boolean | null;
  vendor_id: string | null;
  registered_date: string | null;
  place_categories: PlaceCategoryJoinRow[] | null;
}

interface UserRow {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
}

interface UserFilterRow {
  id: string;
  full_name: string | null;
}

interface PlaceVendorRow {
  vendor_id: string | null;
}

interface CategoryFilterRow {
  id: string;
}

interface PlaceCategoryFilterRow {
  place_id: string;
}

interface VendorFilterByNameRow {
  id: string;
}

type PlaceStatus = 'all' | 'pending' | 'approved' | 'rejected';

@Injectable()
export class AdminPlacesService {
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
    status: PlaceStatus = 'all',
    page: number = 1,
    limit: number = 10,
    search?: string,
    categoryName?: string,
    vendorName?: string,
  ) {
    const offset = (page - 1) * limit;

    if (!['all', 'pending', 'approved', 'rejected'].includes(status)) {
      throw new BadRequestException(
        'status must be one of: all, pending, approved, rejected',
      );
    }

    let placeIdsByCategoryName: string[] | null = null;
    let vendorIdsByName: string[] | null = null;

    if (categoryName) {
      const { data: categories, error: categoriesError } = await supabase
        .schema('travel')
        .from('categories')
        .select('id')
        .ilike('name', `%${categoryName}%`);

      if (categoriesError) {
        throw new InternalServerErrorException(categoriesError.message);
      }

      const categoryIds = (categories ?? [])
        .map((item) => (item as CategoryFilterRow).id)
        .filter(Boolean);

      if (categoryIds.length === 0) {
        return {
          data: [],
          pagination: {
            page,
            limit,
            total: 0,
            pages: 0,
          },
        };
      }

      const { data: categoryLinks, error: categoryError } = await supabase
        .schema('travel')
        .from('place_categories')
        .select('place_id')
        .in('category_id', categoryIds);

      if (categoryError) {
        throw new InternalServerErrorException(categoryError.message);
      }

      placeIdsByCategoryName = (categoryLinks ?? [])
        .map((item) => (item as PlaceCategoryFilterRow).place_id)
        .filter(Boolean);

      if (placeIdsByCategoryName.length === 0) {
        return {
          data: [],
          pagination: {
            page,
            limit,
            total: 0,
            pages: 0,
          },
        };
      }
    }

    if (vendorName) {
      const { data: vendorRows, error: vendorRowsError } = await supabase
        .schema('core')
        .from('users')
        .select('id')
        .ilike('full_name', `%${vendorName}%`);

      if (vendorRowsError) {
        throw new InternalServerErrorException(vendorRowsError.message);
      }

      vendorIdsByName = (vendorRows ?? [])
        .map((item) => (item as VendorFilterByNameRow).id)
        .filter(Boolean);

      if (vendorIdsByName.length === 0) {
        return {
          data: [],
          pagination: {
            page,
            limit,
            total: 0,
            pages: 0,
          },
        };
      }
    }

    let query = supabase
      .schema('travel')
      .from('places')
      .select(
        'id, name, address, is_approved, vendor_id, registered_date, place_categories(category_id, categories(id, name))',
        { count: 'exact' },
      );

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

    if (vendorIdsByName) {
      query = query.in('vendor_id', vendorIdsByName);
    }

    if (placeIdsByCategoryName) {
      query = query.in('id', placeIdsByCategoryName);
    }

    const { data, error, count } = await query.range(
      offset,
      offset + limit - 1,
    );

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const placeRows = (data ?? []) as PlaceListRow[];

    const vendorIds = Array.from(
      new Set(
        placeRows
          .map((item) => item.vendor_id)
          .filter((id): id is string => Boolean(id)),
      ),
    );

    let vendors: UserRow[] = [];

    if (vendorIds.length > 0) {
      const { data: vendorData, error: vendorError } = await supabase
        .schema('core')
        .from('users')
        .select('id, full_name, email, phone')
        .in('id', vendorIds);

      if (!vendorError) {
        vendors = (vendorData ?? []) as UserRow[];
      }
    }

    const places = placeRows.map((place) => {
      const vendor = vendors.find((v) => v.id === place.vendor_id);
      const categoryNames = this.extractCategoryNames(place.place_categories);

      return {
        id: place.id,
        name: place.name,
        address: place.address ?? '',
        category: categoryNames.join(', '),
        vendor_name: vendor?.full_name ?? 'N/A',
        status: this.mapStatus(place.is_approved),
        registered_date: place.registered_date ?? '',
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

  async getPlaceDetail(id: string) {
    const { data: place, error: placeError } = await supabase
      .schema('travel')
      .from('places')
      .select(
        'id, name, description, address, city, latitude, longitude, is_approved, vendor_id, registered_date, place_categories(category_id, categories(id, name))',
      )
      .eq('id', id)
      .maybeSingle<PlaceDetailRow>();

    if (placeError || !place) {
      throw new NotFoundException(`Place with id ${id} not found`);
    }

    const vendor = place.vendor_id
      ? (
          await supabase
            .schema('core')
            .from('users')
            .select('id, full_name, email, phone')
            .eq('id', place.vendor_id)
            .maybeSingle<UserRow>()
        ).data
      : null;

    const vendorPlaceCount = place.vendor_id
      ? await supabase
          .schema('travel')
          .from('places')
          .select('id', { count: 'exact', head: true })
          .eq('vendor_id', place.vendor_id)
      : null;

    const categoryNames = this.extractCategoryNames(place.place_categories);

    return {
      id: place.id,
      name: place.name,
      description: place.description ?? '',
      address: place.address ?? '',
      city: place.city ?? '',
      latitude: place.latitude ?? 0,
      longitude: place.longitude ?? 0,
      category: categoryNames.join(', '),
      registered_date: place.registered_date ?? '',
      status: this.mapStatus(place.is_approved),
      contact_phone: vendor?.phone ?? '',
      contact_email: vendor?.email ?? '',
      vendor: vendor
        ? {
            id: vendor.id,
            name: vendor.full_name ?? '',
            email: vendor.email ?? '',
            phone: vendor.phone ?? '',
            total_places: vendorPlaceCount?.count ?? 0,
          }
        : null,
      images: [],
    };
  }

  async getPlaceFilters() {
    const [categoriesResult, placeVendorsResult] = await Promise.all([
      supabase
        .schema('travel')
        .from('categories')
        .select('id, name')
        .order('name', { ascending: true }),
      supabase.schema('travel').from('places').select('vendor_id'),
    ]);

    if (categoriesResult.error) {
      throw new InternalServerErrorException(categoriesResult.error.message);
    }

    if (placeVendorsResult.error) {
      throw new InternalServerErrorException(placeVendorsResult.error.message);
    }

    const vendorIds = Array.from(
      new Set(
        ((placeVendorsResult.data ?? []) as PlaceVendorRow[])
          .map((item) => item.vendor_id)
          .filter((id): id is string => Boolean(id)),
      ),
    );

    const vendorsResult = vendorIds.length
      ? await supabase
          .schema('core')
          .from('users')
          .select('id, full_name')
          .in('id', vendorIds)
          .order('full_name', { ascending: true })
      : { data: [], error: null };

    if (vendorsResult.error) {
      throw new InternalServerErrorException(vendorsResult.error.message);
    }

    return {
      statuses: [
        { value: 'all', label: 'Tất cả' },
        { value: 'pending', label: 'Chờ duyệt' },
        { value: 'approved', label: 'Đã duyệt' },
        { value: 'rejected', label: 'Từ chối' },
      ],
      categories: ((categoriesResult.data ?? []) as CategoryRow[]).map(
        (item) => ({
          value: item.name,
          label: item.name,
        }),
      ),
      submitters: ((vendorsResult.data ?? []) as UserFilterRow[]).map(
        (item) => ({
          value: item.full_name ?? 'N/A',
          label: item.full_name ?? 'N/A',
        }),
      ),
    };
  }

  async approvePlace(id: string) {
    const { data, error } = await supabase
      .schema('travel')
      .from('places')
      .update({ is_approved: true, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, name, is_approved')
      .single<{ id: string; name: string; is_approved: boolean }>();

    if (error || !data) {
      throw new InternalServerErrorException(
        `Failed to approve place: ${error?.message || 'Unknown error'}`,
      );
    }

    return {
      id: data.id,
      name: data.name,
      status: 'approved',
      message: 'Place approved successfully',
    };
  }

  async rejectPlace(id: string, note?: string) {
    const { data, error } = await supabase
      .schema('travel')
      .from('places')
      .update({ is_approved: false, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, name, is_approved')
      .single<{ id: string; name: string; is_approved: boolean }>();

    if (error || !data) {
      throw new InternalServerErrorException(
        `Failed to reject place: ${error?.message || 'Unknown error'}`,
      );
    }

    return {
      id: data.id,
      name: data.name,
      status: 'rejected',
      message: 'Place rejected successfully',
      note: note ?? null,
      note_saved: false,
    };
  }
}
