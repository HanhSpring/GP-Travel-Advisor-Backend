/**
 * Suy ra intent_vibe từ thành phần nhóm du lịch.
 * Khớp với vocab intent_vibe của model two-tower v15.
 */
export function resolveIntentVibe(
  adultCount?: number,
  childCount?: number,
): string {
  const adults = Math.max(0, adultCount ?? 0);
  const children = Math.max(0, childCount ?? 0);

  if (children > 0) return 'Gia đình & Trẻ em';
  if (adults <= 1) return 'Khách solo';
  if (adults >= 4) return 'Nhóm đông người';
  return 'Cặp đôi';
}
