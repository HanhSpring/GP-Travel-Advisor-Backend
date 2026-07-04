import { supabase } from '../../config/supabase';

export interface RoomCatalogRow {
  id: string;
  place_id: string;
  room_name: string;
  room_type: string | null;
  price: number;
  quantity: number;
}

interface HotelRoomDbRow {
  id: unknown;
  place_id: unknown;
  name: unknown;
  price: unknown;
  quantity: unknown;
}

function normalizeRoom(raw: HotelRoomDbRow): RoomCatalogRow | null {
  const id = String(raw.id ?? '').trim();
  const placeId = String(raw.place_id ?? '').trim();
  const roomName = String(raw.name ?? '').trim();
  const price = Number(raw.price);
  const quantity = Math.max(1, Math.trunc(Number(raw.quantity)));

  if (
    !id ||
    !placeId ||
    !roomName ||
    !Number.isFinite(price) ||
    price <= 0 ||
    !Number.isFinite(quantity)
  ) {
    return null;
  }

  return {
    id,
    place_id: placeId,
    room_name: roomName,
    room_type: null,
    price: Math.round(price),
    quantity,
  };
}

function normalizeRooms(rows: HotelRoomDbRow[]): RoomCatalogRow[] {
  return rows
    .map(normalizeRoom)
    .filter((room): room is RoomCatalogRow => room !== null)
    .sort((left, right) => left.price - right.price);
}

export async function getRoomsByPlaceId(
  placeId: string,
): Promise<RoomCatalogRow[]> {
  const { data, error } = await supabase
    .schema('order_sys')
    .from('hotel_rooms')
    .select('id, place_id, name, price, quantity')
    .eq('place_id', placeId);

  if (error) {
    throw new Error(`order_sys.hotel_rooms query failed: ${error.message}`);
  }
  return normalizeRooms((data ?? []) as HotelRoomDbRow[]);
}

export async function getRoomsByPlaceIds(
  placeIds: string[],
): Promise<Map<string, RoomCatalogRow[]>> {
  const uniquePlaceIds = [...new Set(placeIds.filter(Boolean))];
  const result = new Map(
    uniquePlaceIds.map((placeId) => [placeId, [] as RoomCatalogRow[]]),
  );
  if (!uniquePlaceIds.length) return result;

  const { data, error } = await supabase
    .schema('order_sys')
    .from('hotel_rooms')
    .select('id, place_id, name, price, quantity')
    .in('place_id', uniquePlaceIds);

  if (error) {
    throw new Error(`order_sys.hotel_rooms query failed: ${error.message}`);
  }

  for (const room of normalizeRooms((data ?? []) as HotelRoomDbRow[])) {
    result.get(room.place_id)?.push(room);
  }
  return result;
}
