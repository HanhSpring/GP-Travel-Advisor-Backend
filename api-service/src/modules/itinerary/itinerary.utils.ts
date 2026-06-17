export function calcRequestedDays(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  const diff = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  return Math.max(1, diff);
}

export function calcRetrievalTopK(numDays: number): number {
  return Math.min(200, Math.max(60, numDays * 20));
}

export function logPlanSummary(logger: any, plan: any): void {
  const days = Array.isArray(plan?.days) ? plan.days : [];
  logger.warn(
    `GA plan summary: hotel=${plan?.hotel_name ?? 'unknown'} ` +
      `(${plan?.hotel_id ?? 'unknown'}), days=${days.length}, ` +
      `visited=${plan?.total_visited ?? 0}`,
  );
  for (const day of days) {
    logger.warn(
      `GA day ${day.day}: fitness=${day.fitness}, ` +
        `visited=${day.visited_count}, travel=${day.total_travel_minutes}m, ` +
        `wait=${day.total_wait_minutes}m, visit=${day.total_visit_minutes}m, ` +
        `restaurant=${day.restaurant_count}, stopped=${day.stopped_reason}`,
    );
  }
}
