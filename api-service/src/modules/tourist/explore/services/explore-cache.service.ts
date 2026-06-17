import { AppConfig } from '../../../../config/app.config';
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { supabase } from '../../../../config/supabase';
import { CategoryRow, TypeRow } from '../explore.types';

@Injectable()
export class ExploreCacheService {
  private readonly _cache = new Map<string, { ts: number; value: unknown }>();
  private readonly _categoryIdCache = new Map<string, string[]>();
  private readonly _typeIdCacheMap = new Map<string, string[]>();
  private _allCategoriesCache: CategoryRow[] | null = null;

  getCacheTtlMs(): number {
    const parsed = AppConfig.EXPLORE_CACHE_TTL_MS;
    if (!Number.isFinite(parsed) || parsed <= 0) return 300000;
    return Math.floor(parsed);
  }

  getFromCache<T>(key: string): T | null {
    const entry = this._cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.getCacheTtlMs()) {
      this._cache.delete(key);
      return null;
    }
    return entry.value as T;
  }

  setCache(key: string, value: unknown) {
    try {
      this._cache.set(key, { ts: Date.now(), value });
    } catch {
      // ignore
    }
  }

  async getAllCategories(): Promise<CategoryRow[]> {
    if (this._allCategoriesCache) return this._allCategoriesCache;
    const { data } = await supabase
      .schema('travel')
      .from('categories')
      .select('id, name')
      .returns<CategoryRow[]>();
    if (data && data.length > 0) this._allCategoriesCache = data;
    return data ?? [];
  }

  async getCategoryIdsByKeywords(keywords: string[]): Promise<string[]> {
    const cacheKey = keywords.join('|');
    const cached = this._categoryIdCache.get(cacheKey);
    if (cached && cached.length > 0) return cached;
    if (keywords.length === 0) return [];

    const allCategories = await this.getAllCategories();
    const lowerKeywords = keywords.map((k) => k.toLowerCase());
    const resolved = Array.from(
      new Set(
        allCategories
          .filter((c) =>
            lowerKeywords.some((kw) => c.name.toLowerCase().includes(kw)),
          )
          .map((c) => c.id),
      ),
    );

    try {
      if (resolved.length > 0) this._categoryIdCache.set(cacheKey, resolved);
    } catch {
      // ignore
    }

    return resolved;
  }

  async getTypeIdsByCategoryIds(categoryIds: string[]): Promise<string[]> {
    if (categoryIds.length === 0) return [];
    
    const typeCacheKey = categoryIds.join(',');
    const cachedTypeIds = this._typeIdCacheMap.get(typeCacheKey);
    if (cachedTypeIds) return cachedTypeIds;

    const { data: typeRows, error: typeError } = await supabase
      .schema('travel')
      .from('types')
      .select('id, category_id')
      .in('category_id', categoryIds)
      .limit(1000)
      .returns<TypeRow[]>();

    if (typeError) {
      throw new InternalServerErrorException(typeError.message);
    }

    const typeIds = Array.from(
      new Set(
        (typeRows ?? [])
          .map((item) => item.id)
          .filter((id) => id.trim().length > 0),
      ),
    );

    try {
      if (typeIds.length > 0) this._typeIdCacheMap.set(typeCacheKey, typeIds);
    } catch {
      // ignore
    }

    return typeIds;
  }
}
