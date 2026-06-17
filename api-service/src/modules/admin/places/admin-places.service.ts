import { AppConfig } from '../../../config/app.config';
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

interface TypeRow {
  id: string;
  name: string;
  categories: CategoryRow | CategoryRow[] | null;
}

interface PlaceListRow {
  id: string;
  image_url: string[] | string | null;
  name: string;
  address: string | null;
  is_approved: boolean | null;
  vendor_id: string | null;
  type_id: string | null;
  registered_date: string | null;
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
  types: TypeRow | TypeRow[] | null;
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

interface TypeFilterRow {
  id: string;
}

type PlaceStatus = 'all' | 'pending' | 'approved' | 'rejected';
type SupabaseCountAlgorithm = 'exact' | 'planned' | 'estimated';

@Injectable()
export class AdminPlacesService {
  private readonly metadataCacheTtlMs = Number(
    process.env.ADMIN_PLACES_METADATA_CACHE_TTL_MS ?? '300000',
  );

  private readonly categoryTypeIdsCache = new Map<
    string,
    { expiresAt: number; typeIds: string[] }
  >();

  private readonly typeRowsCache = new Map<
    string,
    { expiresAt: number; type: TypeRow }
  >();

  private getCurrentMonthRange(): { start: string; end: string } {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    return {
      start: start.toISOString(),
      end: end.toISOString(),
    };
  }

  private getSafeInFilterLimit(): number {
    const parsed = AppConfig.ADMIN_PLACES_MAX_IN_FILTER_IDS;
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 200;
    }

    return Math.floor(parsed);
  }

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

  private extractCategoryFromType(
    typeData: TypeRow | TypeRow[] | null,
  ): string {
    if (!typeData) {
      return '';
    }

    const type = Array.isArray(typeData) ? typeData[0] : typeData;
    if (!type?.categories) {
      return '';
    }

    const catData = type.categories;
    const cat = Array.isArray(catData) ? catData[0] : catData;
    return cat?.name ?? '';
  }

  private getCacheExpiry(): number {
    return Date.now() + this.metadataCacheTtlMs;
  }

  private getCachedCategoryTypeIds(categoryName: string): string[] | null {
    const cached = this.categoryTypeIdsCache.get(categoryName);
    if (!cached || cached.expiresAt <= Date.now()) {
      this.categoryTypeIdsCache.delete(categoryName);
      return null;
    }

    return cached.typeIds;
  }

  private setCachedCategoryTypeIds(
    categoryName: string,
    typeIds: string[],
  ): void {
    this.categoryTypeIdsCache.set(categoryName, {
      expiresAt: this.getCacheExpiry(),
      typeIds,
    });
  }

  private getCachedTypeRows(typeIds: string[]): Map<string, TypeRow> {
    const now = Date.now();
    const cachedTypes = new Map<string, TypeRow>();

    for (const typeId of typeIds) {
      const cached = this.typeRowsCache.get(typeId);
      if (!cached || cached.expiresAt <= now) {
        this.typeRowsCache.delete(typeId);
        continue;
      }

      cachedTypes.set(typeId, cached.type);
    }

    return cachedTypes;
  }

  private setCachedTypeRows(types: TypeRow[]): void {
    const expiresAt = this.getCacheExpiry();

    for (const type of types) {
      if (type.id) {
        this.typeRowsCache.set(type.id, { expiresAt, type });
      }
    }
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

  private async countPlaces(
    status: PlaceStatus = 'all',
    registeredFrom?: string,
    registeredTo?: string,
    countAlgorithm: SupabaseCountAlgorithm = 'estimated',
  ): Promise<number> {
    if (!['all', 'pending', 'approved', 'rejected'].includes(status)) {
      throw new BadRequestException(
        'status must be one of: all, pending, approved, rejected',
      );
    }

    let query = supabase
      .schema('travel')
      .from('places')
      .select('id', { count: countAlgorithm, head: true });

    if (status === 'pending') {
      query = query.is('is_approved', null);
    } else if (status === 'approved') {
      query = query.eq('is_approved', true);
    } else if (status === 'rejected') {
      query = query.eq('is_approved', false);
    }

    if (registeredFrom) {
      query = query.gte('registered_date', registeredFrom);
    }

    if (registeredTo) {
      query = query.lt('registered_date', registeredTo);
    }

    const { count, error } = await query;

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return count ?? 0;
  }

  async getPlaceStats() {
    const { start, end } = this.getCurrentMonthRange();

    const [totalLocations, pendingApproval, newThisMonth] = await Promise.all([
      this.countPlaces('all'),
      this.countPlaces('pending'),
      this.countPlaces('all', start, end),
    ]);

    return {
      totalLocations,
      pendingApproval,
      newThisMonth,
    };
  }

  private async getTypesById(typeIds: string[]): Promise<Map<string, TypeRow>> {
    if (typeIds.length === 0) {
      return new Map();
    }

    const cachedTypes = this.getCachedTypeRows(typeIds);
    const missingTypeIds = typeIds.filter((typeId) => !cachedTypes.has(typeId));

    if (missingTypeIds.length === 0) {
      return cachedTypes;
    }

    const { data, error } = await supabase
      .schema('travel')
      .from('types')
      .select('id, name, categories(id, name)')
      .in('id', missingTypeIds);

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const freshTypes = ((data ?? []) as TypeRow[]).filter((item) => item.id);
    this.setCachedTypeRows(freshTypes);

    for (const type of freshTypes) {
      cachedTypes.set(type.id, type);
    }

    return cachedTypes;
  }

  private async getTypeIdsByCategoryName(
    categoryName: string,
  ): Promise<string[]> {
    const normalizedCategoryName = categoryName.trim().toLowerCase();
    const cachedTypeIds = this.getCachedCategoryTypeIds(normalizedCategoryName);

    if (cachedTypeIds) {
      return cachedTypeIds;
    }

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
      this.setCachedCategoryTypeIds(normalizedCategoryName, []);
      return [];
    }

    const { data: types, error: typesError } = await supabase
      .schema('travel')
      .from('types')
      .select('id')
      .in('category_id', categoryIds);

    if (typesError) {
      throw new InternalServerErrorException(typesError.message);
    }

    const typeIds = Array.from(
      new Set(
        (types ?? []).map((item) => (item as TypeFilterRow).id).filter(Boolean),
      ),
    );

    this.setCachedCategoryTypeIds(normalizedCategoryName, typeIds);
    return typeIds;
  }

  async getPlaces(
    status: PlaceStatus = 'all',
    page: number = 1,
    limit: number = 10,
    search?: string,
    categoryName?: string,
  ) {
    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    const requestedLimit =
      Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10;
    const safeLimit = Math.min(requestedLimit, 200);
    const offset = (safePage - 1) * safeLimit;

    if (!['all', 'pending', 'approved', 'rejected'].includes(status)) {
      throw new BadRequestException(
        'status must be one of: all, pending, approved, rejected',
      );
    }

    let typeIdsByCategoryName: string[] | null = null;
    if (categoryName) {
      typeIdsByCategoryName = await this.getTypeIdsByCategoryName(categoryName);

      if (typeIdsByCategoryName.length === 0) {
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
        'id, image_url, name, address, is_approved, vendor_id, type_id, registered_date',
        { count: 'estimated' },
      );

    if (status === 'pending') {
      query = query.is('is_approved', null);
    } else if (status === 'approved') {
      query = query.eq('is_approved', true);
    } else if (status === 'rejected') {
      query = query.eq('is_approved', false);
    }

    if (typeIdsByCategoryName) {
      const inFilterLimit = this.getSafeInFilterLimit();
      if (typeIdsByCategoryName.length > inFilterLimit) {
        typeIdsByCategoryName = typeIdsByCategoryName.slice(0, inFilterLimit);
      }

      query = query.in('type_id', typeIdsByCategoryName);
    }

    const normalizedSearch = this.normalizeForSearch(search);

    if (normalizedSearch) {
      const simpleSearch = search?.trim() ?? '';
      if (simpleSearch) {
        query = query.ilike('name', `%${simpleSearch}%`);
      }
    }

    query = query
      .order('registered_date', {
        ascending: false,
        nullsFirst: false,
      })
      .order('id', { ascending: false });

    const { data, error, count } = await query.range(
      offset,
      offset + safeLimit - 1,
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
    const typeIds = Array.from(
      new Set(
        placeRows
          .map((item) => item.type_id)
          .filter((id): id is string => Boolean(id)),
      ),
    );

    let vendors: UserRow[] = [];
    let typesById = new Map<string, TypeRow>();

    const [vendorDataResult, typeDataResult] = await Promise.all([
      vendorIds.length > 0
        ? supabase
            .schema('public')
            .from('users')
            .select('id, full_name, email, phone_number')
            .in('id', vendorIds)
        : Promise.resolve({ data: [], error: null }),
      this.getTypesById(typeIds),
    ]);

    if (!vendorDataResult.error) {
      vendors = (vendorDataResult.data ?? []) as UserRow[];
    }
    typesById = typeDataResult;

    const places = placeRows.map((place) => {
      const vendor = vendors.find((v) => v.id === place.vendor_id);
      const category = this.extractCategoryFromType(
        place.type_id ? (typesById.get(place.type_id) ?? null) : null,
      );
      const primaryImage = this.normalizeImageUrls(place.image_url)[0] ?? '';

      return {
        id: place.id,
        image_url: primaryImage,
        name: place.name,
        address: place.address ?? '',
        category,
        vendor_name: vendor?.full_name ?? 'N/A',
        status: this.mapStatus(place.is_approved),
        registered_date: place.registered_date ?? '',
      };
    });

    const total = count ?? 0;

    return {
      data: places,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        pages: Math.ceil(total / safeLimit),
      },
    };
  }

  async getPlaceDetail(id: string) {
    const { data: place, error: placeError } = await supabase
      .schema('travel')
      .from('places')
      .select(
        'id, image_url, name, description, address, city_id, cities(name), latitude, longitude, is_approved, vendor_id, registered_date, types(id, name, categories(id, name))',
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

    const category = this.extractCategoryFromType(place.types);
    const cityName = this.extractCityName(place.cities);

    return {
      id: place.id,
      name: place.name,
      description: place.description ?? '',
      address: place.address ?? '',
      city: cityName,
      latitude: place.latitude ?? 0,
      longitude: place.longitude ?? 0,
      category,
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
