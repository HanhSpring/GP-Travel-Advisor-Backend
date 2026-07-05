jest.mock('../../config/supabase', () => ({
  supabase: { schema: jest.fn() },
}));

import { ConfigService } from '@nestjs/config';
import { ItineraryController } from './itinerary.controller';
import { RecommendationService } from '../recommendation/recommendation.service';
import { TwoTowerConfigService } from '../recommendation/two-tower-config.service';
import { ItineraryService } from './itinerary.service';
import { CreateItineraryDto } from './dto/create-itinerary.dto';
import {
  DEFAULT_TWO_TOWER_RUNTIME_CONFIG,
  TwoTowerRuntimeConfig,
} from '../recommendation/two-tower-config.types';

// Config "đã bị admin chỉnh" qua AlgorithmSettings — dùng để chứng minh giá trị này
// (không phải DEFAULT_TWO_TOWER_RUNTIME_CONFIG) là thứ thực sự được truyền xuống
// RecommendationService, chứ không phải rơi về default hardcode như trước khi vá.
const adminEditedConfig: TwoTowerRuntimeConfig = {
  ...DEFAULT_TWO_TOWER_RUNTIME_CONFIG,
  intentQuota: {
    ...DEFAULT_TWO_TOWER_RUNTIME_CONFIG.intentQuota,
    'Ẩm thực & Bản địa': {
      ...DEFAULT_TWO_TOWER_RUNTIME_CONFIG.intentQuota['Ẩm thực & Bản địa'],
      restaurant: 7,
    },
  },
};

const dto = {
  userId: 'user-1',
  tripType: 'ROUND_TRIP',
  departureLocationId: 'city-a',
  destinationLocationId: 'city-b',
  transportMode: 'CAR',
  startDate: '2026-07-10',
  endDate: '2026-07-12',
  dailyStartTime: '08:00',
  dailyEndTime: '21:00',
  tripIntent: 'Ẩm thực & Bản địa',
  adultCount: 2,
  childCount: 0,
  budget: 5000000,
  foodPreferences: [],
} as unknown as CreateItineraryDto;

describe('ItineraryController — nối TwoTowerConfigService vào retrieval thật', () => {
  let controller: ItineraryController;
  let recommendationService: {
    retrieveCandidates: jest.Mock;
    planItinerary: jest.Mock;
  };
  let twoTowerConfig: { getConfig: jest.Mock };
  let itineraryService: { createGeneratedItinerary: jest.Mock };
  let configService: { get: jest.Mock };

  beforeEach(() => {
    recommendationService = {
      retrieveCandidates: jest.fn().mockResolvedValue({
        destination_name: 'Đà Lạt',
        city_id: 'city-b',
        total_candidates: 0,
        candidates: [],
      }),
      planItinerary: jest
        .fn()
        .mockResolvedValue({ days: [], hotel_id: 'hotel-1' }),
    };
    twoTowerConfig = {
      getConfig: jest.fn().mockResolvedValue(adminEditedConfig),
    };
    itineraryService = {
      createGeneratedItinerary: jest.fn().mockResolvedValue({
        id: 'itin-1',
        status: 'pending',
        totalDetails: 6,
      }),
    };
    configService = { get: jest.fn().mockReturnValue(undefined) };

    controller = new ItineraryController(
      itineraryService as unknown as ItineraryService,
      recommendationService as unknown as RecommendationService,
      twoTowerConfig as unknown as TwoTowerConfigService,
      configService as unknown as ConfigService,
    );
  });

  it('POST /itinerary (create) đọc config từ TwoTowerConfigService và truyền xuống retrieveCandidates', async () => {
    await controller.create(dto, undefined);

    expect(twoTowerConfig.getConfig).toHaveBeenCalledTimes(1);
    expect(recommendationService.retrieveCandidates).toHaveBeenCalledWith(
      dto,
      100,
      adminEditedConfig,
    );
  });

  it('POST /itinerary/plan đọc config từ TwoTowerConfigService và truyền xuống planItinerary', async () => {
    await controller.plan(dto, undefined);

    expect(twoTowerConfig.getConfig).toHaveBeenCalledTimes(1);
    expect(recommendationService.planItinerary).toHaveBeenCalledWith(
      dto,
      expect.any(Number),
      'scheduler_v2',
      adminEditedConfig,
    );
  });

  it('POST /itinerary/plan/preview đọc config từ TwoTowerConfigService và truyền xuống planItinerary', async () => {
    await controller.previewPlan(dto, undefined);

    expect(twoTowerConfig.getConfig).toHaveBeenCalledTimes(1);
    expect(recommendationService.planItinerary).toHaveBeenCalledWith(
      dto,
      expect.any(Number),
      'scheduler_v2',
      adminEditedConfig,
    );
  });
});
