export interface ItineraryRow {
  id: string;
  creator_id: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  adult_count: number | null;
  children_count: number | null;
  status: string | null;
  destination: string | null;
  created_at: string;
  is_public: boolean | null;
}

export interface ItineraryTimeRow {
  arrival_time: string | null;
  departure_time: string | null;
}

export interface ItineraryDetailPlaceRow {
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

export interface PlaceRow {
  id: string;
  name: string;
  city_id: string | null;
  cities:
    | {
        id?: string | null;
        name: string | null;
      }
    | {
        id?: string | null;
        name: string | null;
      }[]
    | null;
  address?: string | null;
  open_time?: string | null;
  close_time?: string | null;
  average_rating: number | null;
  review_count: number | null;
  image_url?: unknown;
}

export interface CategoryRow {
  id: string;
  name: string;
}

export interface PlaceTypeRow {
  id: string;
  name: string | null;
  category_id: string | null;
  categories:
    | { id: string; name: string }
    | { id: string; name: string }[]
    | null;
}

export interface TypeRow {
  id: string;
  category_id: string | null;
}

export interface PlaceWithTypeRow extends PlaceRow {
  type_id?: string | null;
  types?: PlaceTypeRow | PlaceTypeRow[] | null;
}

export interface CityRow {
  id: string;
  name: string;
}

export interface FavoritePlaceRow {
  place_id: string;
}

export interface UserRow {
  id: string;
  full_name: string | null;
}

export interface ItineraryDetailPlaceCityRow {
  itinerary_id: string;
  places:
    | {
        city_id?: string | null;
      }
    | {
        city_id?: string | null;
      }[]
    | null;
}

export interface ExplorePagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface ExplorePublicItineraryItem {
  id: string;
  title: string;
  location: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  days: number;
  participant_count: number;
  creator_id: string;
  creator_name: string;
  image: string;
  image_gallery: string[];
}

export interface ExplorePublicItinerariesResponse {
  data: ExplorePublicItineraryItem[];
  pagination: ExplorePagination;
}

export interface ExplorePlaceItem {
  id: string;
  name: string;
  image: string;
  rating: number;
  review_count: number;
  city: string | null;
  category: string | null;
}

export interface ExplorePlacesResponse {
  category: string | null;
  data: ExplorePlaceItem[];
  pagination: ExplorePagination;
}
