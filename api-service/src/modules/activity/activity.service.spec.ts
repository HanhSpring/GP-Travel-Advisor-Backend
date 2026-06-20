import { InternalServerErrorException } from '@nestjs/common';
import { supabase } from '../../config/supabase';
import { ActivityService } from './activity.service';

jest.mock('../../config/supabase', () => ({
  supabase: {
    schema: jest.fn(),
  },
}));

const schemaMock = supabase.schema as jest.Mock;

function findSearchResult(id: string | null) {
  const builder: any = {
    select: jest.fn(),
    eq: jest.fn(),
    is: jest.fn(),
    gte: jest.fn(),
    gt: jest.fn(),
    lte: jest.fn(),
    order: jest.fn(),
    limit: jest.fn(),
    maybeSingle: jest.fn().mockResolvedValue({
      data: id ? { id } : null,
      error: null,
    }),
  };
  Object.keys(builder)
    .filter((key) => key !== 'maybeSingle')
    .forEach((key) => builder[key].mockReturnValue(builder));
  return builder;
}

function updateResult(
  id: string | null = 'search-log-id',
  error: { message: string } | null = null,
) {
  const builder: any = {
    update: jest.fn(),
    eq: jest.fn(),
    is: jest.fn(),
    select: jest.fn(),
    maybeSingle: jest.fn().mockResolvedValue({
      data: id ? { id } : null,
      error,
    }),
  };
  Object.keys(builder)
    .filter((key) => key !== 'maybeSingle')
    .forEach((key) => builder[key].mockReturnValue(builder));
  return builder;
}

function insertResult(error: { message: string } | null = null) {
  return {
    insert: jest.fn().mockResolvedValue({ error }),
  };
}

describe('ActivityService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('attaches the first clicked place to the latest pending search', async () => {
    const latestClickBuilder = findSearchResult(null);
    const findBuilder = findSearchResult('search-log-id');
    const updateBuilder = updateResult();
    const insertBuilder = insertResult();
    schemaMock
      .mockReturnValueOnce({ from: () => latestClickBuilder })
      .mockReturnValueOnce({ from: () => findBuilder })
      .mockReturnValueOnce({ from: () => updateBuilder })
      .mockReturnValueOnce({ from: () => insertBuilder });

    await new ActivityService().log({
      tourist_id: 'tourist-id',
      action_type: 'click',
      place_id: 'place-id',
    });

    expect(updateBuilder.update).toHaveBeenCalledWith({ place_id: 'place-id' });
    expect(updateBuilder.eq).toHaveBeenCalledWith('id', 'search-log-id');
    expect(updateBuilder.is).toHaveBeenCalledWith('place_id', null);
    expect(updateBuilder.select).toHaveBeenCalledWith('id');
    expect(insertBuilder.insert).toHaveBeenCalled();
    expect(findBuilder.gt).toHaveBeenCalledWith(
      'created_at',
      '0001-01-01T00:00:00.000',
    );
    expect(updateBuilder.update.mock.invocationCallOrder[0]).toBeLessThan(
      insertBuilder.insert.mock.invocationCallOrder[0],
    );
  });

  it('only records the click when there is no recent pending search', async () => {
    const latestClickBuilder = findSearchResult(null);
    const findBuilder = findSearchResult(null);
    const insertBuilder = insertResult();
    schemaMock
      .mockReturnValueOnce({ from: () => latestClickBuilder })
      .mockReturnValueOnce({ from: () => findBuilder })
      .mockReturnValueOnce({ from: () => insertBuilder });

    await new ActivityService().log({
      tourist_id: 'tourist-id',
      action_type: 'click',
      place_id: 'place-id',
    });

    expect(insertBuilder.insert).toHaveBeenCalled();
    expect(schemaMock).toHaveBeenCalledTimes(3);
  });

  it('does not attach a later click to an older pending search', async () => {
    const latestClickBuilder = findSearchResult('previous-click-id');
    latestClickBuilder.maybeSingle.mockResolvedValue({
      data: { created_at: '2026-06-20T04:05:00.000' },
      error: null,
    });
    const findBuilder = findSearchResult(null);
    const insertBuilder = insertResult();
    schemaMock
      .mockReturnValueOnce({ from: () => latestClickBuilder })
      .mockReturnValueOnce({ from: () => findBuilder })
      .mockReturnValueOnce({ from: () => insertBuilder });

    await new ActivityService().log({
      tourist_id: 'tourist-id',
      action_type: 'click',
      place_id: 'second-place-id',
    });

    expect(findBuilder.gt).toHaveBeenCalledWith(
      'created_at',
      '2026-06-20T04:05:00.000',
    );
    expect(insertBuilder.insert).toHaveBeenCalled();
  });

  it('records view when a qualifying click exists for the same place', async () => {
    const clickBuilder = findSearchResult('click-log-id');
    const insertBuilder = insertResult();
    schemaMock
      .mockReturnValueOnce({ from: () => clickBuilder })
      .mockReturnValueOnce({ from: () => insertBuilder });

    await new ActivityService().log({
      tourist_id: 'tourist-id',
      action_type: 'view',
      place_id: 'place-id',
    });

    expect(clickBuilder.eq).toHaveBeenCalledWith('action_type', 'click');
    expect(clickBuilder.eq).toHaveBeenCalledWith('place_id', 'place-id');
    expect(clickBuilder.gte).toHaveBeenCalledWith(
      'created_at',
      expect.any(String),
    );
    expect(clickBuilder.lte).toHaveBeenCalledWith(
      'created_at',
      expect.any(String),
    );
    expect(insertBuilder.insert).toHaveBeenCalled();
  });

  it('ignores view when there is no qualifying click', async () => {
    const clickBuilder = findSearchResult(null);
    schemaMock.mockReturnValueOnce({ from: () => clickBuilder });

    await new ActivityService().log({
      tourist_id: 'tourist-id',
      action_type: 'view',
      place_id: 'place-id',
    });

    expect(schemaMock).toHaveBeenCalledTimes(1);
  });

  it('deduplicates pending searches received within five seconds', async () => {
    const recentSearchBuilder = findSearchResult('existing-search-id');
    schemaMock.mockReturnValueOnce({ from: () => recentSearchBuilder });

    await new ActivityService().log({
      tourist_id: 'tourist-id',
      action_type: 'search',
      place_id: null,
    });

    expect(schemaMock).toHaveBeenCalledTimes(1);
  });

  it('returns an error when inserting the activity fails', async () => {
    const insertBuilder = insertResult({ message: 'database unavailable' });
    schemaMock.mockReturnValueOnce({ from: () => insertBuilder });

    await expect(
      new ActivityService().log({
        tourist_id: 'tourist-id',
        action_type: 'save',
        place_id: 'place-id',
      }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
