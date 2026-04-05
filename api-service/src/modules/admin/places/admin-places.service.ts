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

interface CityRow {
  name: string | null;
}

interface PlaceCategoryJoinRow {
  category_id: string;
  categories: CategoryRow | CategoryRow[] | null;
}

interface PlaceListRow {
  id: string;
  image_url: string[] | string | null;
  name: string;
  address: string | null;
  is_approved: boolean | null;
  vendor_id: string | null;
  registered_date: string | null;
  place_categories: PlaceCategoryJoinRow[] | null;
}

interface PlaceDetailRow {
  id: string;
  image_url: string[] | string | null;
  name: string;
  description: string | null;
  address: string | null;
  city_id: string | null;
  cities: CityRow | CityRow[] | null;
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
  phone_number: string | null;
  created_at: string | null;
}

interface CategoryFilterRow {
  id: string;
}

interface PlaceCategoryFilterRow {
  place_id: string;
}

type PlaceStatus = 'all' | 'pending' | 'approved' | 'rejected';

@Injectable()
export class AdminPlacesService {
  private normalizeImageUrls(
    value: string[] | string | null | undefined,
  ): string[] {
    if (Array.isArray(value)) {
      return value.filter(
        (item): item is string =>
          typeof item === 'string' && item.trim().length > 0,
      );
    }

    if (typeof value === 'string' && value.trim().length > 0) {
      return [value];
    }

    return [];
  }

  private normalizeForSearch(value?: string | null): string {
    if (!value) {
      return '';
    }

    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .toLowerCase()
      .trim();
  }

  private extractCityName(cityData: CityRow | CityRow[] | null): string {
    if (!cityData) {
      return '';
    }

    if (Array.isArray(cityData)) {
      return cityData[0]?.name ?? '';
    }

    return cityData.name ?? '';
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
  ) {
    const offset = (page - 1) * limit;

    if (!['all', 'pending', 'approved', 'rejected'].includes(status)) {
      throw new BadRequestException(
        'status must be one of: all, pending, approved, rejected',
      );
    }

    let placeIdsByCategoryName: string[] | null = null;
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

    let query = supabase
      .schema('travel')
      .from('places')
      .select(
        'id, image_url, name, address, is_approved, vendor_id, registered_date, place_categories(category_id, categories(id, name))',
      );

    if (status === 'pending') {
      query = query.is('is_approved', null);
    } else if (status === 'approved') {
      query = query.eq('is_approved', true);
    } else if (status === 'rejected') {
      query = query.eq('is_approved', false);
    }

    if (placeIdsByCategoryName) {
      query = query.in('id', placeIdsByCategoryName);
    }

    query = query.order('registered_date', {
      ascending: false,
      nullsFirst: false,
    });

    const { data, error } = await query;

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
        .schema('public')
        .from('users')
        .select('id, full_name, email, phone_number')
        .in('id', vendorIds);

      if (!vendorError) {
        vendors = (vendorData ?? []) as UserRow[];
      }
    }

    let places = placeRows.map((place) => {
      const vendor = vendors.find((v) => v.id === place.vendor_id);
      const categoryNames = this.extractCategoryNames(place.place_categories);

      return {
        id: place.id,
        image_url: place.image_url,
        name: place.name,
        address: place.address ?? '',
        category: categoryNames.join(', '),
        vendor_name: vendor?.full_name ?? 'N/A',
        status: this.mapStatus(place.is_approved),
        registered_date: place.registered_date ?? '',
      };
    });

    const normalizedSearch = this.normalizeForSearch(search);

    if (normalizedSearch) {
      places = places.filter((place) => {
        const normalizedPlaceName = this.normalizeForSearch(place.name);
        const normalizedVendorName = this.normalizeForSearch(place.vendor_name);

        return (
          normalizedPlaceName.includes(normalizedSearch) ||
          normalizedVendorName.includes(normalizedSearch)
        );
      });
    }

    const total = places.length;
    const pagedPlaces = places.slice(offset, offset + limit);

    return {
      data: pagedPlaces,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getPlaceDetail(id: string) {
    const { data: place, error: placeError } = await supabase
      .schema('travel')
      .from('places')
      .select(
        'id, image_url, name, description, address, city_id, cities(name), latitude, longitude, is_approved, vendor_id, registered_date, place_categories(category_id, categories(id, name))',
      )
      .eq('id', id)
      .maybeSingle<PlaceDetailRow>();

    if (placeError || !place) {
      throw new NotFoundException(`Place with id ${id} not found`);
    }

    const vendor = place.vendor_id
      ? (
          await supabase
            .schema('public')
            .from('users')
            .select('id, full_name, email, phone_number, created_at')
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
    const cityName = this.extractCityName(place.cities);

    return {
      id: place.id,
      name: place.name,
      description: place.description ?? '',
      address: place.address ?? '',
      city: cityName,
      latitude: place.latitude ?? 0,
      longitude: place.longitude ?? 0,
      category: categoryNames.join(', '),
      registered_date: place.registered_date ?? '',
      status: this.mapStatus(place.is_approved),
      contact_phone: vendor?.phone_number ?? '',
      contact_email: vendor?.email ?? '',
      vendor: vendor
        ? {
            id: vendor.id,
            name: vendor.full_name ?? '',
            email: vendor.email ?? '',
            phone: vendor.phone_number ?? '',
            total_places: vendorPlaceCount?.count ?? 0,
            created_at: vendor.created_at,
          }
        : null,
      images: this.normalizeImageUrls(place.image_url),
    };
  }

  async getPlaceCategories() {
    const { data, error } = await supabase
      .schema('travel')
      .from('categories')
      .select('id, name')
      .order('name', { ascending: true });

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return {
      categories: ((data ?? []) as CategoryRow[]).map((item) => ({
        value: item.name,
        label: item.name,
      })),
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
