import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
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
  email: string | null;
  phone: string | null;
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

interface ResolvedPlaceType {
  typeId: string | null;
  categoryNames: string[];
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
    const parsed = Number(process.env.ADMIN_PLACES_MAX_IN_FILTER_IDS ?? '200');
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

  private sanitizeSupabaseOrValue(value: string): string {
    return value.replace(/[(),]/g, ' ').trim();
  }

  private async getVendorIdsBySearch(search: string): Promise<string[]> {
    const keyword = this.sanitizeSupabaseOrValue(search);

    if (!keyword) {
      return [];
    }

    const { data, error } = await supabase
      .schema('public')
      .from('users')
      .select('id')
      .or(
        `full_name.ilike.%${keyword}%,email.ilike.%${keyword}%,phone_number.ilike.%${keyword}%`,
      )
      .limit(200);

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return Array.from(
      new Set(
        ((data ?? []) as Array<{ id: string | null }>)
          .map((item) => item.id)
          .filter((id): id is string => Boolean(id)),
      ),
    );
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

  private onlyVisiblePlaces<T>(query: T): T {
    return (query as any).or('is_active.is.null,is_active.eq.true') as T;
  }

  private normalizeFoodImageUrls(imageUrl?: string) {
    const trimmedUrl = imageUrl?.trim();
    return trimmedUrl ? [trimmedUrl] : [];
  }

  private async resolveCityIdForCreate(cityName: string): Promise<string> {
    const { data, error } = await supabase
      .schema('travel')
      .from('cities')
      .select('id, name')
      .ilike('name', cityName.trim())
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    if (!data?.id) {
      throw new BadRequestException(`Tinh/thanh khong hop le: ${cityName}`);
    }

    return data.id;
  }

  private async resolvePlaceTypeForCreate(input: {
    typeId?: string;
    typeName?: string;
    categories?: string[];
  }): Promise<ResolvedPlaceType> {
    const typeId = input.typeId?.trim();

    if (typeId) {
      const { data, error } = await supabase
        .schema('travel')
        .from('types')
        .select('id, name, categories(id, name)')
        .eq('id', typeId)
        .maybeSingle<TypeRow>();

      if (error) {
        throw new InternalServerErrorException(error.message);
      }

      if (data?.id) {
        return {
          typeId: data.id,
          categoryNames: this.extractCategoryFromType(data)
            ? [this.extractCategoryFromType(data)]
            : input.categories ?? [],
        };
      }
    }

    const typeName = input.typeName?.trim() || input.categories?.[0]?.trim();
    if (!typeName) {
      return { typeId: null, categoryNames: [] };
    }

    const { data, error } = await supabase
      .schema('travel')
      .from('types')
      .select('id, name, categories(id, name)')
      .ilike('name', typeName)
      .maybeSingle<TypeRow>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    if (!data?.id) {
      return { typeId: null, categoryNames: [] };
    }

    return {
      typeId: data.id,
      categoryNames: this.extractCategoryFromType(data)
        ? [this.extractCategoryFromType(data)]
        : input.categories ?? [],
    };
  }

  private async addPlaceServices(
    placeId: string,
    services: Array<{ name: string; description?: string }>,
  ) {
    for (const service of services) {
      const serviceName = service.name?.trim();
      if (!serviceName) continue;

      const { data: existingService, error: findError } = await supabase
        .schema('travel')
        .from('services')
        .select('id')
        .ilike('name', serviceName)
        .maybeSingle<{ id: string }>();

      if (findError) {
        throw new InternalServerErrorException(findError.message);
      }

      let serviceId = existingService?.id ?? null;

      if (!serviceId) {
        const { data: createdService, error: createServiceError } =
          await supabase
            .schema('travel')
            .from('services')
            .insert({ id: randomUUID(), name: serviceName, price: null })
            .select('id')
            .single<{ id: string }>();

        if (createServiceError) {
          throw new BadRequestException(createServiceError.message);
        }

        serviceId = createdService?.id ?? null;
      }

      if (!serviceId) continue;

      const { error: linkError } = await supabase
        .schema('travel')
        .from('place_services')
        .upsert(
          { place_id: placeId, service_id: serviceId },
          { onConflict: 'place_id,service_id' },
        );

      if (linkError) {
        throw new BadRequestException(linkError.message);
      }
    }
  }

  private async addMenuItems(
    placeId: string,
    menu: Array<{
      name: string;
      description?: string;
      price: number;
      image_url?: string;
      img?: string;
    }>,
  ) {
    const rows = menu
      .filter((item) => item.name?.trim())
      .map((item) => ({
        id: randomUUID(),
        place_id: placeId,
        name: item.name.trim(),
        description: item.description || null,
        price: Number(item.price),
        image_url: this.normalizeFoodImageUrls(item.image_url || item.img),
      }));

    if (rows.length === 0) return;

    const { error } = await supabase
      .schema('order_sys')
      .from('food_items')
      .insert(rows);

    if (error) {
      throw new BadRequestException(error.message);
    }
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

    query = this.onlyVisiblePlaces(query);

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

  async getBusinessVendors() {
    const { data, error } = await supabase
      .schema('public')
      .from('users')
      .select('id, full_name, email, phone_number')
      .eq('role', 'BUSINESS')
      .order('full_name', { ascending: true });

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return {
      data: ((data ?? []) as UserRow[]).map((user) => ({
        id: user.id,
        name: user.full_name || user.email || user.id,
        email: user.email || '',
        phone: user.phone_number || '',
      })),
    };
  }

  async createFullPlace(dto: any) {
    const sourceMode = dto.sourceMode || dto.source_mode || 'system';
    const name = dto.p_name || dto.name;
    const address = dto.p_address || dto.address;
    const city = dto.p_city || dto.city;
    const email = (dto.p_email || dto.email || '').trim();
    const phone = (dto.p_phone || dto.phone || '').trim();
    const vendorId = (dto.p_vendor_id || dto.vendorId || dto.vendor_id || '').trim();
    const categories = Array.isArray(dto.p_categories || dto.categories)
      ? dto.p_categories || dto.categories
      : [];
    const services = Array.isArray(dto.p_services || dto.services)
      ? dto.p_services || dto.services
      : [];
    const menu = Array.isArray(dto.p_menu || dto.menu) ? dto.p_menu || dto.menu : [];
    const images = Array.isArray(dto.p_images || dto.images)
      ? dto.p_images || dto.images
      : [];

    if (!['system', 'vendor'].includes(sourceMode)) {
      throw new BadRequestException('Loai nguon dia diem khong hop le');
    }

    if (!name) throw new BadRequestException('Thieu du lieu: Ten dia diem');
    if (!address) throw new BadRequestException('Thieu du lieu: Dia chi');
    if (!city) throw new BadRequestException('Thieu du lieu: Tinh/Thanh pho');
    if (!email) throw new BadRequestException('Thieu du lieu: Email lien he');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('Email lien he khong dung dinh dang');
    }
    if (phone && !/^0\d{9}$/.test(phone)) {
      throw new BadRequestException('SDT lien he phai gom dung 10 chu so va bat dau bang so 0');
    }
    if (sourceMode === 'vendor' && !vendorId) {
      throw new BadRequestException('Vui long chon doi tac quan ly dia diem');
    }

    if (menu.length > 0) {
      for (const item of menu) {
        if (!item.name) throw new BadRequestException('Thieu ten mon');
        if (!item.price || Number(item.price) <= 0) {
          throw new BadRequestException(`Gia sai: ${item.name}`);
        }
      }
    }

    const resolvedType = await this.resolvePlaceTypeForCreate({
      typeId: dto.p_type_id || dto.typeId,
      typeName: dto.p_type_name || dto.typeName,
      categories,
    });

    if (!resolvedType.typeId) {
      throw new BadRequestException('Loai hinh kinh doanh khong hop le');
    }

    const cityId = await this.resolveCityIdForCreate(city);
    const createdPlaceId = randomUUID();
    const now = new Date();

    const { data: createdPlace, error: createPlaceError } = await supabase
      .schema('travel')
      .from('places')
      .insert({
        id: createdPlaceId,
        name,
        address,
        email,
        phone: phone || null,
        city_id: cityId,
        latitude: Number(dto.p_lat ?? dto.latitude),
        longitude: Number(dto.p_lng ?? dto.longitude),
        vendor_id: sourceMode === 'vendor' ? vendorId : null,
        type_id: resolvedType.typeId,
        open_time: dto.p_open_time || dto.openTime || '08:00',
        close_time: dto.p_close_time || dto.closeTime || '22:00',
        description: dto.p_description || dto.description || '',
        image_url: images,
        is_approved: true,
        is_active: true,
        average_rating: 0,
        review_count: 0,
        registered_date: now.toISOString().slice(0, 10),
        source: sourceMode === 'vendor' ? 'admin_created_for_business' : 'admin',
      })
      .select('id')
      .single<{ id: string }>();

    if (createPlaceError) {
      throw new BadRequestException(createPlaceError.message || 'Loi khi tao dia diem');
    }

    await this.addPlaceServices(createdPlace.id, services);
    await this.addMenuItems(createdPlace.id, menu);

    return {
      message: 'Tao dia diem thanh cong',
      placeId: createdPlace.id,
      sourceMode,
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
    vendorId?: string,
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

    query = this.onlyVisiblePlaces(query);

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

    if (vendorId) {
      query = query.eq('vendor_id', vendorId);
    }

    const normalizedSearch = this.normalizeForSearch(search);

    if (normalizedSearch) {
      const simpleSearch = search?.trim() ?? '';
      if (simpleSearch) {
        const keyword = this.sanitizeSupabaseOrValue(simpleSearch);
        if (!keyword) {
          query = query.ilike('name', `%${simpleSearch}%`);
        } else {
        const matchingVendorIds = await this.getVendorIdsBySearch(keyword);

        if (matchingVendorIds.length > 0) {
          query = query.or(
            `name.ilike.%${keyword}%,vendor_id.in.(${matchingVendorIds.join(',')})`,
          );
        } else {
          query = query.ilike('name', `%${keyword}%`);
        }
        }
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
        'id, image_url, name, description, address, email, phone, city_id, cities(name), latitude, longitude, is_approved, vendor_id, registered_date, types(id, name, categories(id, name))',
      )
      .eq('id', id)
      .or('is_active.is.null,is_active.eq.true')
      .maybeSingle<PlaceDetailRow>();

    if (placeError || !place) {
      throw new NotFoundException(`Place with id ${id} not found`);
    }

    const [vendorResult, vendorPlaceCount] = await Promise.all([
      place.vendor_id
        ? supabase
            .schema('public')
            .from('users')
            .select('id, full_name, email, phone_number, created_at')
            .eq('id', place.vendor_id)
            .maybeSingle<UserRow>()
        : Promise.resolve({ data: null, error: null }),
      place.vendor_id
        ? supabase
            .schema('travel')
            .from('places')
            .select('id', { count: 'estimated', head: true })
            .eq('vendor_id', place.vendor_id)
            .or('is_active.is.null,is_active.eq.true')
        : Promise.resolve({ count: 0, error: null }),
    ]);

    if (vendorResult.error) {
      throw new InternalServerErrorException(vendorResult.error.message);
    }

    if (vendorPlaceCount.error) {
      throw new InternalServerErrorException(vendorPlaceCount.error.message);
    }

    const vendor = vendorResult.data;

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
      contact_phone: place.phone ?? vendor?.phone_number ?? '',
      contact_email: place.email ?? vendor?.email ?? '',
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

  async updatePlaceCoordinates(
    id: string,
    latitude: number,
    longitude: number,
  ) {
    const lat = Number(latitude);
    const lng = Number(longitude);

    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new BadRequestException('Latitude must be a number from -90 to 90');
    }

    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      throw new BadRequestException(
        'Longitude must be a number from -180 to 180',
      );
    }

    const { data, error } = await supabase
      .schema('travel')
      .from('places')
      .update({
        latitude: lat,
        longitude: lng,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .or('is_active.is.null,is_active.eq.true')
      .select('id, latitude, longitude')
      .maybeSingle<{ id: string; latitude: number; longitude: number }>();

    if (error) {
      throw new InternalServerErrorException(
        `Failed to update place coordinates: ${error.message}`,
      );
    }

    if (!data) {
      throw new NotFoundException(`Place with id ${id} not found`);
    }

    return {
      id: data.id,
      latitude: data.latitude,
      longitude: data.longitude,
      message: 'Place coordinates updated successfully',
    };
  }

  async deletePlace(id: string) {
    const { data, error } = await supabase
      .schema('travel')
      .from('places')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', id)
      .or('is_active.is.null,is_active.eq.true')
      .select('id')
      .maybeSingle<{ id: string }>();

    if (error) {
      throw new InternalServerErrorException(
        `Failed to delete place: ${error.message}`,
      );
    }

    if (!data) {
      throw new NotFoundException(`Place with id ${id} not found`);
    }

    return { id, message: 'Place deleted successfully' };
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
