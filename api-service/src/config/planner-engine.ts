export type PlannerEngine = 'scheduler_v2' | 'ga_v1';

export interface PlannerEngineResolution {
  engine: PlannerEngine;
  usedFallback: boolean;
}

export function resolvePlannerEngine(
  value: string | undefined | null,
): PlannerEngineResolution {
  const normalized = value?.trim().toLowerCase();

  if (normalized === 'scheduler_v2' || normalized === 'or_tools') {
    return { engine: 'scheduler_v2', usedFallback: false };
  }
  if (normalized === 'ga_v1' || normalized === 'ga') {
    return { engine: 'ga_v1', usedFallback: false };
  }

  return { engine: 'scheduler_v2', usedFallback: true };
}
