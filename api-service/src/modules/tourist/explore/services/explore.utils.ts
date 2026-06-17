import { AppConfig } from '../../../../config/app.config';
import { ItineraryRow, PlaceTypeRow } from '../explore.types';

export const defaultImageUrl = AppConfig.DEFAULT_PLACE_IMAGE_URL;

export const featuredPlaceTypePriority = [
    'bãi biển/vịnh',
    'thiên nhiên',
    'khách sạn & resort',
    'công viên/quảng trường',
    'làng nghề',
    'công trình tôn giáo',
    'homestay & villa',
    'bảo tàng & không gian trưng bày',
    'bảo tàng nghệ thuật/3d',
    'nông trại',
    'công viên giải trí',
];

  export function splitIntoChunks<T>(items: T[], chunkSize: number): T[][] {
    if (items.length === 0) {
      return [];
    }

    const size = chunkSize > 0 ? chunkSize : 500;
    const chunks: T[][] = [];

    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }

    return chunks;
  }

  export function toImageList(imageUrl?: unknown): string[] {
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

  export function normalizeText(value: string): string {
    return value
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/[&/]+/g, ' ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  export function resolveImage(imageUrl?: unknown): string {
    const images = this.toImageList(imageUrl);
    if (images.length > 0) {
      return images[0];
    }

    return this.defaultImageUrl;
  }

  export function toParticipantCount(itinerary: ItineraryRow): number {
    const adults = itinerary.adult_count ?? 0;
    const children = itinerary.children_count ?? 0;
    return adults + children;
  }

  export function extractCityName(
    cityData:
      | {
          id?: string | null;
          name: string | null;
        }
      | {
          id?: string | null;
          name: string | null;
        }[]
      | null,
  ): string | null {
    if (!cityData) {
      return null;
    }

    if (Array.isArray(cityData)) {
      return cityData[0]?.name ?? null;
    }

    return cityData.name ?? null;
  }

  export function extractCityId(
    cityData:
      | {
          id?: string | null;
          name: string | null;
        }
      | {
          id?: string | null;
          name: string | null;
        }[]
      | null,
  ): string | null {
    if (!cityData) {
      return null;
    }

    if (Array.isArray(cityData)) {
      return cityData[0]?.id ?? null;
    }

    return cityData.id ?? null;
  }

  export function extractCategoryNames(
    categories: PlaceTypeRow['categories'],
  ): string[] {
    if (!categories) {
      return [];
    }

    const categoryList = Array.isArray(categories) ? categories : [categories];
    return categoryList
      .map((item) => normalizeText(item.name))
      .filter((name) => name.length > 0);
  }

  export function extractTypeNames(
    typeData: PlaceTypeRow | PlaceTypeRow[] | null | undefined,
  ): string[] {
    if (!typeData) {
      return [];
    }

    const typeList = Array.isArray(typeData) ? typeData : [typeData];
    return typeList
      .map((item) => normalizeText(item.name ?? ''))
      .filter((name) => name.length > 0);
  }

  export function matchesAnyCategory(
    categoryNames: string[],
    targetCategories: string[],
  ): boolean {
    return categoryNames.some((name) =>
      targetCategories.some((target) => name.includes(target)),
    );
  }


  export function hasAnyCategoryId(
    categoryId: string | null | undefined,
    categoryIds: Set<string>,
  ): boolean {
    if (!categoryId) {
      return false;
    }

    return categoryIds.has(categoryId);
  }


  export function getTypePriorityIndex(typeNames: string[]): number | null {
    let bestIndex: number | null = null;

    for (const typeName of typeNames) {
      for (
        let index = 0;
        index < featuredPlaceTypePriority.length;
        index += 1
      ) {
        if (
          typeName.includes(
            normalizeText(featuredPlaceTypePriority[index]),
          )
        ) {
          if (bestIndex === null || index < bestIndex) {
            bestIndex = index;
          }
        }
      }
    }

    return bestIndex;
  }

  export function pickRandomItem<T>(items: T[]): T | null {
    if (items.length === 0) {
      return null;
    }

    const index = Math.floor(Math.random() * items.length);
    return items[index] ?? null;
  }

  export function mapActivityEntityCategory(categoryNames: string[]): string {
    const joinedCategoryNames = categoryNames.join(' ');

    if (joinedCategoryNames.includes('tham quan & khám phá')) {
      return 'attractions';
    }

    if (joinedCategoryNames.includes('văn hoá & di sản')) {
      return 'culturalHistory';
    }

    if (joinedCategoryNames.includes('giải trí & vui chơi')) {
      return 'entertainment';
    }

    if (joinedCategoryNames.includes('thư giãn & thể thao')) {
      return 'nature';
    }

    return 'attractions';
  }

  export function buildCategoryKeywords(categoryName: string): string[] {
    const normalized = categoryName.toLowerCase().trim();

    if (isRestaurantCategory(normalized)) {
      return ['ẩm thực', 'nhà hàng', 'ăn uống'];
    }

    if (isHotelCategory(normalized)) {
      return ['lưu trú', 'khách sạn', 'nghỉ dưỡng'];
    }

    if (isActivityCategory(normalized)) {
      return [
        'giải trí & vui chơi',
        'tham quan & khám phá',
        'thư giãn & thể thao',
        'văn hoá & di sản',
        'mua sắm & dịch vụ',
      ];
    }

    return [normalized];
  }

  export function isRestaurantCategory(name: string): boolean {
    return name.includes('ẩm thực') || name.includes('nhà hàng');
  }

  export function isHotelCategory(name: string): boolean {
    return name.includes('lưu trú') || name.includes('khách sạn');
  }

  export function isActivityCategory(name: string): boolean {
    return (
      name.includes('tham quan & khám phá') ||
      name.includes('văn hoá & di sản') ||
      name.includes('giải trí & vui chơi') ||
      name.includes('thư giãn & thể thao') ||
      name.includes('mua sắm & dịch vụ')
    );
  }

export function getDays(start?: string | null, end?: string | null): number {
    if (!start || !end) {
      return 0;
    }

    const s = new Date(start);
    const e = new Date(end);
    const diff = Math.ceil((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24));

    return diff > 0 ? diff : 1;
  }

