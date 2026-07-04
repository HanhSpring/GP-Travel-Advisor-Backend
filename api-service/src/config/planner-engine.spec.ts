import { resolvePlannerEngine } from './planner-engine';

describe('resolvePlannerEngine', () => {
  it.each([
    ['scheduler_v2', 'scheduler_v2'],
    ['or_tools', 'scheduler_v2'],
    ['ga_v1', 'ga_v1'],
    ['ga', 'ga_v1'],
    [' GA ', 'ga_v1'],
  ])('maps %s to %s', (input, expected) => {
    expect(resolvePlannerEngine(input)).toEqual({
      engine: expected,
      usedFallback: false,
    });
  });

  it.each([undefined, null, '', 'unknown'])(
    'falls back to scheduler_v2 for %s',
    (input) => {
      expect(resolvePlannerEngine(input)).toEqual({
        engine: 'scheduler_v2',
        usedFallback: true,
      });
    },
  );
});
