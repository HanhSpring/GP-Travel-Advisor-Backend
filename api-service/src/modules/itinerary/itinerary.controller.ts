import {
  Controller,
  Post,
  Body,
  HttpStatus,
  HttpCode,
  Get,
  Param,
  Patch,
  Delete,
  Query,
  Logger,
  Res,
  Inject,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { randomUUID } from 'node:crypto';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBody,
  ApiQuery,
} from '@nestjs/swagger';
import { ItineraryService } from './itinerary.service';
import { RecommendationService } from '../recommendation/recommendation.service';
import { TwoTowerConfigService } from '../recommendation/two-tower-config.service';
import { TripCostConfigService } from '../recommendation/trip-cost-config.service';
import { GetItinerariesDto } from './dto/get-itineraries.dto';
import { CreateItineraryDto } from './dto/create-itinerary.dto';
import { ItineraryDetailResponseDto } from './dto/itinerary-detail-response.dto';
import { ItineraryResponseDto } from './dto/itinerary-response.dto';
import { ToggleVisibilityDto } from './dto/toggle-visibility.dto';
import { ShareItineraryDto } from './dto/share-itinerary.dto';
import { RespondItineraryShareDto } from './dto/respond-itinerary-share.dto';
import { CreateItineraryShareLinkDto } from './dto/create-itinerary-share-link.dto';
import { RespondItineraryShareLinkDto } from './dto/respond-itinerary-share-link.dto';
import { EditActivityDto } from './dto/edit-activity.dto';
import { AddActivityDto } from './dto/add-activity.dto';
import { UpdateItineraryDto } from './dto/update-itinerary.dto';
import { ReplaceActivityDto } from './dto/replace-activity.dto';
import {
  CustomizeActivityResponseDto,
  SuggestionsResponseDto,
} from './dto/customize-response.dto';
import { TwoTowerRetrievalResponseDto } from './dto/retrieval-response.dto';
import { HotelRoomResponseDto } from './dto/hotel-room-response.dto';
import { ConfigService } from '@nestjs/config';
import {
  PlannerEngine,
  resolvePlannerEngine,
} from '../../config/planner-engine';

// Cache tạm plan đã tính khi throw BUDGET_CONFIRMATION_REQUIRED, để client
// xác nhận (gửi lại confirmToken) không phải chạy lại toàn bộ thuật toán —
// xem nhánh `body.confirmToken` và điểm throw trong plan().
const ITINERARY_PLAN_CONFIRM_TTL_MS = 10 * 60 * 1000; // 10 phút
const ITINERARY_PLAN_CONFIRM_PREFIX = 'itinerary_plan_confirm';

@ApiTags('Itinerary')
@Controller('itinerary')
export class ItineraryController {
  private readonly logger = new Logger(ItineraryController.name);
  private readonly plannerEngine: PlannerEngine;

  constructor(
    private readonly service: ItineraryService,
    private readonly recommendationService: RecommendationService,
    private readonly twoTowerConfig: TwoTowerConfigService,
    private readonly tripCostConfig: TripCostConfigService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    configService: ConfigService,
  ) {
    const configuredValue = configService.get<string>(
      'ITINERARY_PLANNER_ENGINE',
    );
    const resolution = resolvePlannerEngine(configuredValue);
    this.plannerEngine = resolution.engine;
    if (resolution.usedFallback) {
      this.logger.warn(
        `ITINERARY_PLANNER_ENGINE=${JSON.stringify(configuredValue)} is missing or invalid; ` +
          'falling back to scheduler_v2.',
      );
    }
  }

  @Get('hotels/:placeId/rooms')
  @ApiOperation({
    summary: 'Lấy danh sách phòng và giá của một khách sạn',
    description: 'Đọc danh sách phòng theo place_id từ order_sys.hotel_rooms.',
  })
  @ApiParam({
    name: 'placeId',
    description: 'UUID của địa điểm lưu trú trong travel.places',
  })
  @ApiResponse({
    status: 200,
    description:
      'Danh sách phòng đang có giá hợp lệ, sắp xếp theo giá tăng dần.',
    type: HotelRoomResponseDto,
    isArray: true,
  })
  getHotelRooms(
    @Param('placeId') placeId: string,
  ): Promise<HotelRoomResponseDto[]> {
    return this.service.getHotelRooms(placeId);
  }

  @Get('my-itineraries')
  @ApiOperation({ summary: 'Lấy danh sách lịch trình của user' })
  @ApiResponse({ type: ItineraryResponseDto })
  getMyItineraries(@Query() query: GetItinerariesDto) {
    return this.service.getMyItineraries(query.userId, query.q);
  }

  /**
   * Two-Tower retrieval: nhận tham số chuyến đi → trả top-K địa điểm
   * (cosine_score, predict_ranking = null chờ ranking model).
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Two-Tower retrieval — trả top-K địa điểm phù hợp',
    description:
      'Gọi FastAPI encode-query → pgvector search → trả danh sách candidates. ' +
      'predict_ranking sẽ được điền bởi ranking model (thành viên khác).',
  })
  @ApiQuery({
    name: 'top_k',
    required: false,
    type: Number,
    example: 100,
    description: 'Số lượng candidates tối đa (mặc định 100)',
  })
  @ApiResponse({
    status: 201,
    description: 'Top-K địa điểm theo cosine similarity',
    type: TwoTowerRetrievalResponseDto,
  })
  async create(
    @Body() body: CreateItineraryDto,
    @Query('top_k') topK?: string,
  ): Promise<TwoTowerRetrievalResponseDto> {
    const k = topK ? Math.min(parseInt(topK, 10) || 100, 200) : 100;
    const config = await this.twoTowerConfig.getConfig();
    return this.recommendationService.retrieveCandidates(body, k, config);
  }

  @Post('plan')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a full itinerary using the configured planner engine',
    description:
      'Runs candidate retrieval, fetches full place details, calls FastAPI /itinerary/plan, then persists to DB.',
  })
  @ApiQuery({
    name: 'top_k',
    required: false,
    type: Number,
    example: 60,
    description:
      'Số candidates Two-Tower tối đa. Nếu không truyền, backend tự scale theo số ngày: min(200, max(60, days * 20)). Số điểm đưa vào GA/Goong được cap riêng.',
  })
  @ApiBody({
    type: CreateItineraryDto,
    examples: {
      createFromSwagger: {
        summary: 'Create and persist itinerary',
        description:
          'Replace userId, departureLocationId and destinationLocationId with real UUIDs from Supabase before trying it in Swagger.',
        value: {
          userId: '00000000-0000-0000-0000-000000000000',
          tripType: 'ROUND_TRIP',
          departureLocationId: '11111111-1111-1111-1111-111111111111',
          destinationLocationId: '22222222-2222-2222-2222-222222222222',
          transportMode: 'ROAD',
          startDate: '2026-06-10',
          endDate: '2026-06-12',
          dailyStartTime: '08:00',
          dailyEndTime: '21:00',
          tripIntent: 'KhÃ¡m phÃ¡ tá»•ng há»£p',
          adultCount: 2,
          childCount: 0,
          budget: 5000000,
          foodPreferences: ['LOCAL'],
        },
      },
    },
  })
  async plan(@Body() body: CreateItineraryDto, @Query('top_k') topK?: string) {
    const startedAt = Date.now();
    const requestedDays = this.calcRequestedDays(body.startDate, body.endDate);
    const k = topK
      ? Math.min(parseInt(topK, 10) || 60, 200)
      : this.calcRetrievalTopK(requestedDays);
    const plannerEngine = this.plannerEngine;

    // Xác nhận ngân sách vòng 2: nếu client gửi kèm confirmToken từ lỗi
    // BUDGET_CONFIRMATION_REQUIRED trước đó, dùng thẳng plan đã cache —
    // bỏ qua region-detection + planItinerary + budget-check bên dưới,
    // tránh chạy lại CP-SAT chỉ để tái tạo 1 plan tương đương đã có sẵn.
    if (body.confirmToken) {
      const cacheKey = `${ITINERARY_PLAN_CONFIRM_PREFIX}:${body.confirmToken}`;
      const cachedPlan = await this.cache.get<any>(cacheKey);
      if (cachedPlan) {
        await this.cache.del(cacheKey); // single-use, tránh replay
        return this.persistAndRespond(
          body,
          cachedPlan,
          plannerEngine,
          startedAt,
          0,
          requestedDays,
          k,
        );
      }
      this.logger.warn(
        `itinerary/plan confirmToken cache miss (hết hạn hoặc đã dùng): ${body.confirmToken}`,
      );
      // rơi xuống flow bình thường bên dưới — không throw, không chặn user
    }

    // Chặn sớm ngân sách quá thấp — KHÔNG chạy Two-Tower/CP-SAT (tốn thời
    // gian, xem thảo luận "case 1 chậm") nếu ngân sách nhập vào rõ ràng
    // không đủ ngay cả ở mức sàn tối thiểu thật sự. Mốc sàn = tham quan/ăn
    // uống mỗi ngày + chỗ ở mỗi ĐÊM (luôn TỐI THIỂU 1 đêm kể cả chuyến 1
    // ngày, vì mọi lịch trình đều bắt buộc có khách sạn thật) — dùng
    // NGUYÊN VĂN đơn vị MỖI NGƯỜI LỚN (minDailyBudgetFloor/minHotelNightFloor
    // đều tính theo "VND/ngày/người lớn"), so sánh THẲNG với
    // earlyRequestedBudget (cũng mỗi người lớn) — không nhân/quy đổi qua số
    // người ở đây, tránh lệch đơn vị.
    const earlyAdultCount = Math.max(1, Number(body.adultCount ?? 1));
    const earlyChildCount = Math.max(0, Number(body.childCount ?? 0));
    const earlyParticipantCount = earlyAdultCount + earlyChildCount;
    const earlyRequestedBudget = Number(body.budget ?? 0);
    if (earlyRequestedBudget > 0) {
      const costConfig = await this.tripCostConfig.getConfig();
      const earlyNights = Math.max(1, requestedDays - 1);
      const minSaneBudget =
        Math.max(1, costConfig.minDailyBudgetFloor) * requestedDays +
        Math.max(1, costConfig.minHotelNightFloor) * earlyNights;
      if (earlyRequestedBudget < minSaneBudget) {
        throw new UnprocessableEntityException({
          code: 'BUDGET_TOO_LOW',
          message:
            `Ngân sách bạn nhập quá thấp cho ${requestedDays} ngày ` +
            `(mỗi người lớn). Ngân sách tối thiểu nên khoảng ` +
            `${Math.round(minSaneBudget).toLocaleString('vi-VN')}đ/người lớn.`,
          requestedBudget: earlyRequestedBudget,
          minimumBudget: Math.round(minSaneBudget),
          requestedDays,
          participantCount: earlyParticipantCount,
        });
      }
    }

    const planStartedAt = Date.now();
    const config = await this.twoTowerConfig.getConfig();

    // Region-allocation wizard, step 1: always runs before the first real
    // plan attempt — cheap macro-cluster detection, no hotel/CP-SAT. Once
    // the client resubmits with `regionAllocations`, skip straight to
    // planning below.
    if (!body.regionAllocations?.length) {
      const detection = await this.recommendationService.detectRegions(
        body,
        k,
        config,
      );
      throw new UnprocessableEntityException({
        code: 'REGION_ALLOCATION_REQUIRED',
        message:
          'Hệ thống đã nhận diện được các vùng địa lý trong lịch trình của bạn.',
        numDays: detection.num_days,
        estimatedTotalDays: detection.estimated_total_days,
        shortfallDays: detection.shortfall_days,
        regions: detection.regions.map((region) => ({
          regionName: region.region_name,
          placeIds: region.place_ids,
          placeNames: region.place_names,
          maxDays: region.max_days,
          suggestedDays: region.suggested_days,
          totalVisitMinutes: region.total_visit_minutes,
          travelMinutesFromCentral: region.travel_minutes_from_central,
          isRemote: region.is_remote,
          centroidLat: region.centroid_lat,
          centroidLng: region.centroid_lng,
          boundary: region.boundary,
        })),
      });
    }

    let plan: any = await this.recommendationService.planItinerary(
      body,
      k,
      plannerEngine,
      config,
    );
    this.logPlanSummary(plan as any, plannerEngine);

    const requestedBudget = Number(body.budget ?? 0);
    const adultCount = Number(body.adultCount ?? 0);
    const childCount = Number(body.childCount ?? 0);

    if (plan?.validation_is_feasible === false && requestedBudget > 0) {
      // A hard budget can leave the solver with zero activities, which the
      // validator reports as no_feasible_activities instead of
      // budget_exceeded. Retry anchored to a low but non-zero per-day floor
      // (thay vì budget=0 hoàn toàn bỏ ràng buộc giá) — daily_budget_soft
      // + pre-pruning theo giá trong scheduler_v2.py vẫn kích hoạt bình
      // thường với mốc sàn này, nên plan retry hướng tới rẻ nhất-khả-thi
      // thay vì tối ưu chất lượng bỏ qua chi phí. Either way, this becomes
      // the plan we validate/persist from here on.
      const costConfig = await this.tripCostConfig.getConfig();
      const floorBudget =
        Math.max(1, costConfig.minDailyBudgetFloor) * requestedDays;
      const floorAnchoredBody = { ...body, budget: floorBudget };
      plan = await this.recommendationService.planItinerary(
        floorAnchoredBody,
        k,
        plannerEngine,
        config,
      );
    }

    // Ngân sách chỉ có thể biết CHÍNH XÁC sau khi đã có 1 plan feasible thật
    // — Python tự báo "feasible" dựa trên chi phí nó tự ước tính nội bộ
    // (bảng cost-per-km của ai-service chỉ đồng bộ 1 lần lúc khởi động,
    // trong khi NestJS đọc cùng bảng đó mỗi 60s — 2 bên có thể lệch nhau
    // sau khi đổi cấu hình mà chưa restart ai-service). Vì vậy KHÔNG được
    // tin validation_is_feasible của Python là "chắc chắn trong ngân sách
    // thật" — luôn tự đối chiếu lại bằng calculatePlanEstimatedCost(), đúng
    // công thức NestJS dùng để persist, trước khi coi là an toàn để tạo
    // lịch trình.
    //
    // hasUsablePlan chỉ nới lỏng cho ĐÚNG lý do budget_exceeded (xem
    // assertPlanFeasible's allowBudgetExceeded bên dưới) — vượt ngân sách
    // (kể cả sau retry mức sàn, budget > 0 nên scheduler vẫn tối ưu theo
    // hướng rẻ nhất-có-thể) thì plan vẫn nên đưa ra gợi ý ngân sách cho user
    // chọn thay vì chặn cứng vứt bỏ. Mọi lý do infeasible KHÁC (kể cả khi
    // không giới hạn ngân sách) vẫn bị chặn như cũ — không được vì "có vài
    // điểm dùng được" mà lờ đi các vi phạm khác không liên quan tới tiền.
    const hasUsablePlan = Number((plan as any)?.total_visited ?? 0) > 0;

    if (
      requestedBudget > 0 &&
      hasUsablePlan &&
      !body.proceedWithOverBudget
    ) {
      // childPriceRatio/transportMode/tripCostConfig bắt buộc truyền vào —
      // thiếu childPriceRatio thì bỏ qua tỉ lệ giá trẻ em; thiếu 2 cái sau
      // thì calculatePlanEstimatedCost không tính lại được transport cost
      // bằng đúng công thức NestJS dùng lúc persist (xem
      // derivePlanCostComponents), khiến calculatedCost thấp hơn thật.
      const costConfigForCalc = await this.tripCostConfig.getConfig();
      // calculatedCost/requestedBudget đều là đơn vị MỖI NGƯỜI LỚN — so
      // sánh thẳng, không quy đổi qua tổng nhóm.
      const calculatedCost = this.service.calculatePlanEstimatedCost(
        plan as any,
        adultCount,
        childCount,
        costConfigForCalc.childPriceRatio,
        body.transportMode,
        costConfigForCalc,
      );
      if (calculatedCost > requestedBudget) {
        const recommendedBudget = this.service.calculateRecommendedBudget(
          plan as any,
          adultCount,
          childCount,
          costConfigForCalc.childPriceRatio,
          body.transportMode,
          costConfigForCalc,
        );
        const participantCount = Math.max(1, adultCount + childCount);
        const confirmToken = randomUUID();
        await this.cache.set(
          `${ITINERARY_PLAN_CONFIRM_PREFIX}:${confirmToken}`,
          plan,
          ITINERARY_PLAN_CONFIRM_TTL_MS,
        );
        throw new UnprocessableEntityException({
          code: 'BUDGET_CONFIRMATION_REQUIRED',
          // Câu ngắn, không nhắc lại "mức chi phí khác bên dưới" mơ hồ — số
          // cụ thể (recommendedBudget) do CLIENT tự chèn vào câu (xem
          // _showBudgetConfirmationDialog), tránh lặp ý khi ghép 2 câu lại.
          message: 'Không tìm thấy lịch trình phù hợp với ngân sách bạn đã nhập.',
          userBudget: requestedBudget,
          calculatedCost,
          reserveRate: 0.1,
          recommendedBudget,
          participantCount,
          confirmToken,
        });
      }
    }

    const planTimeMs = Date.now() - planStartedAt;
    // Luôn gọi assertPlanFeasible — nó tự no-op nếu plan thật sự feasible.
    // Chỉ nới lỏng riêng cho lý do budget_exceeded khi plan có nội dung
    // dùng được (đã qua nhánh gợi ý ngân sách ở trên, hoặc requestedBudget=0
    // nên budget_exceeded không thể xảy ra) — mọi lý do infeasible khác vẫn
    // bị chặn đúng như trước, không phân biệt có giới hạn ngân sách hay không.
    if (!body.proceedWithOverBudget) {
      this.assertPlanFeasible(plan, plannerEngine, {
        allowBudgetExceeded: hasUsablePlan,
      });
    }

    return this.persistAndRespond(
      body,
      plan,
      plannerEngine,
      startedAt,
      planTimeMs,
      requestedDays,
      k,
    );
  }

  /** Lưu plan (đã feasible/đã được user xác nhận) và dựng response chung
   * cho cả flow tạo mới lẫn flow xác nhận qua confirmToken (không chạy lại
   * planner) — xem nhánh `body.confirmToken` ở đầu plan(). */
  private async persistAndRespond(
    body: CreateItineraryDto,
    plan: any,
    plannerEngine: PlannerEngine,
    startedAt: number,
    planTimeMs: number,
    requestedDays: number,
    k: number,
  ) {
    const persistStartedAt = Date.now();
    const created = await this.service.createGeneratedItinerary(
      body,
      plan as any,
    );
    const persistTimeMs = Date.now() - persistStartedAt;
    const executionTimeMs = Date.now() - startedAt;
    const sparseResult = created.totalDetails < requestedDays * 2;

    this.logger.warn(
      `POST /itinerary/plan completed in ${executionTimeMs}ms ` +
        `(planner=${planTimeMs}ms, persist=${persistTimeMs}ms, ` +
        `details=${created.totalDetails}, days=${requestedDays}, topK=${k}, engine=${plannerEngine})`,
    );

    return {
      id: created.id,
      itineraryId: created.id,
      status: created.status,
      totalDetails: created.totalDetails,
      executionTimeMs,
      executionTimeSeconds: Number((executionTimeMs / 1000).toFixed(2)),
      planner_engine: plannerEngine,
      metrics: {
        topK: k,
        requestedDays,
        plannerMs: planTimeMs,
        persistMs: persistTimeMs,
        totalMs: executionTimeMs,
        totalDetails: created.totalDetails,
        sparseResult,
        engine: plannerEngine,
      },
      warning: sparseResult
        ? 'Khu vực này hiện có ít địa điểm phù hợp, lịch trình có thể ngắn hơn số ngày yêu cầu.'
        : null,
    };
  }

  @Post('plan/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview itinerary using the configured planner engine',
    description:
      'Runs candidate retrieval and the server-configured planner, returns the full plan JSON, but does not persist anything to DB.',
  })
  @ApiQuery({
    name: 'top_k',
    required: false,
    type: Number,
    example: 120,
    description: 'Số candidates Two-Tower tối đa dùng để chạy thử planner.',
  })
  @ApiBody({ type: CreateItineraryDto })
  async previewPlan(
    @Body() body: CreateItineraryDto,
    @Query('top_k') topK?: string,
  ) {
    const startedAt = Date.now();
    const requestedDays = this.calcRequestedDays(body.startDate, body.endDate);
    const k = topK
      ? Math.min(parseInt(topK, 10) || 60, 200)
      : this.calcRetrievalTopK(requestedDays);

    const plannerEngine = this.plannerEngine;
    const config = await this.twoTowerConfig.getConfig();
    const plan = await this.recommendationService.planItinerary(
      body,
      k,
      plannerEngine,
      config,
    );
    const executionTimeMs = Date.now() - startedAt;
    this.logPlanSummary(plan as any, plannerEngine);

    this.logger.warn(
      `POST /itinerary/plan/preview completed in ${executionTimeMs}ms ` +
        `(persist=skipped, days=${requestedDays}, topK=${k}, engine=${plannerEngine})`,
    );

    return {
      mode: 'preview',
      persisted: false,
      planner_engine: plannerEngine,
      executionTimeMs,
      executionTimeSeconds: Number((executionTimeMs / 1000).toFixed(2)),
      metrics: {
        topK: k,
        requestedDays,
        totalMs: executionTimeMs,
        engine: plannerEngine,
      },
      plan,
    };
  }

  @Get('share-link/:token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Lấy thông tin lời mời chia sẻ lịch trình từ token',
  })
  @ApiParam({ name: 'token', description: 'Token trong link chia sẻ' })
  @ApiQuery({
    name: 'userId',
    required: false,
    description:
      'ID người bấm link, dùng kiểm tra đã là thành viên/chủ lịch trình chưa',
  })
  getShareLinkPreview(
    @Param('token') token: string,
    @Query('userId') userId?: string,
  ) {
    return this.service.getShareLinkPreview(token, userId);
  }

  @Get('share/recipients')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Tim tourist de moi chia se lich trinh' })
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'senderUserId', required: false })
  searchShareRecipients(
    @Query('q') q: string,
    @Query('senderUserId') senderUserId?: string,
  ) {
    return this.service.searchShareRecipients(q, senderUserId);
  }

  @Get('share/:token')
  @ApiOperation({
    summary: 'Mở link chia sẻ lịch trình và chuyển hướng sang app mobile',
  })
  @ApiParam({ name: 'token', description: 'Token trong link chia sẻ' })
  redirectShareLink(@Param('token') token: string, @Res() res: any) {
    return res.redirect(this.service.buildShareDeepLink(token));
  }

  @Post('share-link/respond')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Xác nhận hoặc từ chối lời mời chia sẻ lịch trình từ link',
  })
  @ApiBody({ type: RespondItineraryShareLinkDto })
  respondToShareLink(@Body() dto: RespondItineraryShareLinkDto) {
    return this.service.respondToShareLink(dto);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Lấy chi tiết lịch trình',
  })
  @ApiParam({
    name: 'id',
    description: 'ID của lịch trình',
    example: 'uuid-sg-3days',
  })
  @ApiQuery({ name: 'tourist_id', required: false, type: String })
  async getItineraryDetail(
    @Param('id') id: string,
    @Query('tourist_id') touristId?: string,
  ): Promise<any> {
    return this.service.getItineraryDetail(id, touristId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Xoá lịch trình' })
  @ApiParam({ name: 'id', description: 'ID lịch trình cần xoá' })
  async deleteItinerary(@Param('id') id: string): Promise<void> {
    await this.service.deleteItinerary(id);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cập nhật tên / mô tả lịch trình' })
  @ApiParam({ name: 'id', description: 'ID lịch trình' })
  @ApiBody({ type: UpdateItineraryDto })
  async updateItinerary(
    @Param('id') id: string,
    @Body() dto: UpdateItineraryDto,
  ) {
    return this.service.updateItinerary(id, dto);
  }

  @Patch(':id/visibility')
  @ApiOperation({ summary: 'Bật/Tắt trạng thái Công khai của lịch trình' })
  @ApiParam({ name: 'id', description: 'ID của lịch trình' })
  async toggleVisibility(
    @Param('id') id: string,
    @Body() toggleDto: ToggleVisibilityDto,
  ) {
    await this.service.toggleVisibility(id, toggleDto.isPublic);
    return {
      message: toggleDto.isPublic
        ? 'Lịch trình đã được công khai'
        : 'Lịch trình đã chuyển về riêng tư',
      success: true,
    };
  }

  @Post(':id/share')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Gửi lời mời chia sẻ lịch trình bằng email hoặc số điện thoại',
  })
  @ApiParam({ name: 'id', description: 'ID lịch trình cần chia sẻ' })
  @ApiBody({ type: ShareItineraryDto })
  shareItinerary(@Param('id') id: string, @Body() dto: ShareItineraryDto) {
    return this.service.shareItinerary(id, dto);
  }

  @Post(':id/share-link')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Tạo link chia sẻ lịch trình để gửi qua mạng xã hội',
  })
  @ApiParam({ name: 'id', description: 'ID lịch trình cần chia sẻ' })
  @ApiBody({ type: CreateItineraryShareLinkDto })
  createShareLink(
    @Param('id') id: string,
    @Body() dto: CreateItineraryShareLinkDto,
  ) {
    return this.service.createShareLink(id, dto);
  }

  @Post(':id/share/respond')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Xác nhận hoặc từ chối lời mời chia sẻ lịch trình',
  })
  @ApiParam({ name: 'id', description: 'ID lịch trình được chia sẻ' })
  @ApiBody({ type: RespondItineraryShareDto })
  respondToShare(
    @Param('id') id: string,
    @Body() dto: RespondItineraryShareDto,
  ) {
    return this.service.respondToShareInvitation(id, dto);
  }

  // ════════════════════════════════════════════════════════════════
  // CÁC ENDPOINT TÙY CHỈNH LỊCH TRÌNH (MỚI)
  // ════════════════════════════════════════════════════════════════

  /**
   * CHỈNH SỬA giờ đến, thời gian tham quan hoặc ghi chú của một hoạt động.
   *
   * - PATCH /:itineraryId/activities/:activityId
   * - Nếu truyền `arriveTime` → tự động ghim giờ (is_locked = true)
   * - Sau khi lưu, gọi FastAPI optimizer → trả về lịch ngày đã sắp xếp lại
   *
   * Response: CustomizeActivityResponseDto
   */
  @Patch(':itineraryId/activities/:activityId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Chỉnh sửa giờ đến / thời gian / ghi chú của một hoạt động',
    description:
      'Truyền `arriveTime` để ghim giờ. Truyền `isLocked: false` để bỏ ghim. ' +
      'Sau khi lưu, FastAPI tự động sắp xếp lại các hoạt động còn lại trong ngày.',
  })
  @ApiParam({ name: 'itineraryId', description: 'ID lịch trình' })
  @ApiParam({
    name: 'activityId',
    description: 'ID hoạt động (itinerary_details.id)',
  })
  @ApiBody({ type: EditActivityDto })
  @ApiResponse({ status: 200, type: CustomizeActivityResponseDto })
  async editActivity(
    @Param('itineraryId') itineraryId: string,
    @Param('activityId') activityId: string,
    @Body() dto: EditActivityDto,
  ) {
    return this.service.editActivity(itineraryId, activityId, dto);
  }

  /**
   * THÊM địa điểm mới vào lịch trình.
   *
   * - POST /:itineraryId/activities
   * - Hệ thống tự tìm khe thời gian trống phù hợp trong ngày
   * - Nếu truyền `preferredTime` → ghim giờ ngay
   * - FastAPI tối ưu và trả về toàn bộ ngày đã sắp xếp lại
   *
   * Response: CustomizeActivityResponseDto
   */
  @Post(':itineraryId/activities')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Thêm địa điểm mới vào lịch trình',
    description:
      'Cung cấp `placeId` và `dayNumber`. ' +
      'Hệ thống tự tính giờ dựa trên khe trống. ' +
      'Tùy chọn: `preferredTime` để ghim giờ ngay khi thêm.',
  })
  @ApiParam({ name: 'itineraryId', description: 'ID lịch trình' })
  @ApiBody({ type: AddActivityDto })
  @ApiResponse({ status: 201, type: CustomizeActivityResponseDto })
  async addActivity(
    @Param('itineraryId') itineraryId: string,
    @Body() dto: AddActivityDto,
  ) {
    return this.service.addActivity(itineraryId, dto);
  }

  /**
   * XÓA một hoạt động khỏi lịch trình.
   *
   * - DELETE /:itineraryId/activities/:activityId
   * - Xóa hoàn toàn khỏi DB (hard delete)
   * - FastAPI tối ưu lại ngày sau khi xóa
   *
   * Response: CustomizeActivityResponseDto
   */
  @Delete(':itineraryId/activities/:activityId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Xóa một hoạt động khỏi lịch trình',
    description:
      'Hard delete. Sau khi xóa, các hoạt động còn lại trong ngày được sắp xếp lại.',
  })
  @ApiParam({ name: 'itineraryId', description: 'ID lịch trình' })
  @ApiParam({ name: 'activityId', description: 'ID hoạt động cần xóa' })
  @ApiResponse({ status: 200, type: CustomizeActivityResponseDto })
  async deleteActivity(
    @Param('itineraryId') itineraryId: string,
    @Param('activityId') activityId: string,
  ) {
    return this.service.deleteActivity(itineraryId, activityId);
  }

  /**
   * THAY THẾ địa điểm bằng địa điểm khác.
   *
   * - PATCH /:itineraryId/activities/:activityId/replace
   * - Giữ nguyên thứ tự và giờ ghim (nếu có)
   * - FastAPI tối ưu lại để tính toán đường đi mới
   *
   * Response: CustomizeActivityResponseDto
   */
  @Patch(':itineraryId/activities/:activityId/replace')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Thay thế địa điểm bằng địa điểm khác',
    description:
      'Giữ nguyên thứ tự và giờ ghim. ' +
      'FastAPI tính lại đường đi với địa điểm mới.',
  })
  @ApiParam({ name: 'itineraryId', description: 'ID lịch trình' })
  @ApiParam({ name: 'activityId', description: 'ID hoạt động cần thay thế' })
  @ApiBody({ type: ReplaceActivityDto })
  @ApiResponse({ status: 200, type: CustomizeActivityResponseDto })
  async replaceActivity(
    @Param('itineraryId') itineraryId: string,
    @Param('activityId') activityId: string,
    @Body() dto: ReplaceActivityDto,
  ) {
    return this.service.replaceActivity(itineraryId, activityId, dto);
  }

  /**
   * LẤY GỢI Ý địa điểm thay thế cho một hoạt động.
   *
   * - GET /:itineraryId/activities/:activityId/suggestions
   * - Tìm địa điểm cùng danh mục, cùng thành phố, chưa có trong lịch trình
   * - Sắp xếp theo khoảng cách từ địa điểm hiện tại
   *
   * Response: SuggestionsResponseDto
   */
  @Get(':itineraryId/activities/:activityId/suggestions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Lấy danh sách gợi ý địa điểm thay thế',
    description:
      'Trả về tối đa 10 địa điểm cùng danh mục, cùng thành phố, ' +
      'chưa có trong lịch trình, sắp xếp theo khoảng cách.',
  })
  @ApiParam({ name: 'itineraryId', description: 'ID lịch trình' })
  @ApiParam({
    name: 'activityId',
    description: 'ID hoạt động cần tìm gợi ý thay thế',
  })
  @ApiResponse({ status: 200, type: SuggestionsResponseDto })
  async getSuggestions(
    @Param('itineraryId') itineraryId: string,
    @Param('activityId') activityId: string,
  ) {
    return this.service.getSuggestions(itineraryId, activityId);
  }

  /** See ItineraryService.getAddPlaceSuggestions for the ranking/fallback logic. */
  @Get(':id/place-suggestions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Lấy gợi ý địa điểm để thêm vào lịch trình',
    description:
      'Trả về tối đa `limit` địa điểm từ candidates thừa lúc tạo lịch trình, ' +
      'sắp xếp theo rating rồi review_count, đã loại các địa điểm có trong lịch trình.',
  })
  @ApiParam({ name: 'id', description: 'ID lịch trình' })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  async getAddPlaceSuggestions(
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    const safeLimit = limit ? Math.min(parseInt(limit, 10) || 10, 30) : 10;
    return this.service.getAddPlaceSuggestions(id, safeLimit);
  }

  @Patch(':id/activities')
  @ApiOperation({
    summary: 'Cập nhật danh sách hoạt động/thời gian của lịch trình',
  })
  @ApiParam({ name: 'id', description: 'ID của lịch trình' })
  async updateActivities(
    @Param('id') id: string,
    @Body() body: { days: any[] },
  ) {
    await this.service.updateActivities(id, body.days);
    return {
      message: 'Đã cập nhật lịch trình thành công',
      success: true,
    };
  }

  @Post('optimize-day')
  @ApiOperation({
    summary:
      'Tối ưu hoá các hoạt động trong một ngày bằng AI Service (OR-Tools)',
  })
  async optimizeDay(
    @Body()
    body: {
      activities: any[];
      dailyStartTime?: string;
      dailyEndTime?: string;
      allowReduceTime?: boolean;
      visitDate?: string;
    },
  ) {
    if (!body.activities || body.activities.length === 0) {
      return { optimized: [], reorderNotes: [] };
    }
    const result = await this.service.optimizeDayRoute(
      body.activities,
      body.dailyStartTime,
      body.dailyEndTime,
      body.allowReduceTime || false,
      body.visitDate,
    );
    return {
      optimized: result.optimized,
      reorderNotes: result.reorderNotes,
    };
  }

  private calcRequestedDays(startDate: string, endDate: string): number {
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${endDate}T00:00:00.000Z`);
    const diff = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
    return Math.max(1, diff);
  }

  private calcRetrievalTopK(numDays: number): number {
    return Math.min(200, Math.max(60, numDays * 20));
  }

  private assertPlanFeasible(
    plan: any,
    engine: string,
    options?: { allowBudgetExceeded?: boolean },
  ): void {
    if (plan?.validation_is_feasible !== false) {
      return;
    }
    const violations = Array.isArray(plan?.validation_violations)
      ? plan.validation_violations
      : [];
    const budgetViolation = violations.find(
      (violation: any) => violation?.violation_type === 'budget_exceeded',
    );
    // Lý do infeasible DUY NHẤT là vượt ngân sách, và caller đã xử lý (gợi ý
    // ngân sách đề xuất) hoặc không áp dụng (requestedBudget<=0) — không
    // chặn ở đây nữa. Mọi lý do khác (kể cả có budgetViolation kèm theo)
    // vẫn chặn bình thường.
    if (
      options?.allowBudgetExceeded &&
      budgetViolation &&
      violations.every(
        (violation: any) => violation?.violation_type === 'budget_exceeded',
      )
    ) {
      return;
    }
    const emptyViolation = violations.find(
      (violation: any) =>
        violation?.violation_type === 'no_feasible_activities',
    );
    const selected = budgetViolation ?? emptyViolation ?? violations[0];
    const message =
      selected?.detail ??
      'Không tìm được lịch trình thỏa ngân sách, thời gian và giờ mở cửa.';
    this.logger.warn(
      `Rejected infeasible ${engine} plan before persistence: ${message}`,
    );
    throw new UnprocessableEntityException({
      code: 'ITINERARY_INFEASIBLE',
      message,
      engine,
      violations,
      suggestions: [
        'Tăng tổng ngân sách chuyến đi.',
        'Giảm số ngày hoặc số người.',
        'Nới rộng khung giờ hoạt động.',
      ],
    });
  }

  private logPlanSummary(plan: any, configuredEngine: PlannerEngine): void {
    const days = Array.isArray(plan?.days) ? plan.days : [];
    const actualEngine = resolvePlannerEngine(
      plan?.planner_engine ?? configuredEngine,
    ).engine;
    const label = actualEngine.toUpperCase();
    this.logger.warn(
      `${label} plan summary: hotel=${plan?.hotel_name ?? 'unknown'} ` +
        `(${plan?.hotel_id ?? 'unknown'}), days=${days.length}, ` +
        `visited=${plan?.total_visited ?? 0}`,
    );
    for (const day of days) {
      this.logger.warn(
        `${label} day ${day.day}: fitness=${day.fitness}, ` +
          `visited=${day.visited_count}, travel=${day.total_travel_minutes}m, ` +
          `wait=${day.total_wait_minutes}m, visit=${day.total_visit_minutes}m, ` +
          `restaurant=${day.restaurant_count}, stopped=${day.stopped_reason}`,
      );
    }
  }

  private logComparisonSummary(plan: any): void {
    const comparison = plan?.comparison;
    if (!comparison?.engines) {
      return;
    }
    this.logger.warn(
      `Planner compare winner=${comparison.winner_hint ?? 'unknown'}`,
    );
    for (const [engine, summary] of Object.entries<any>(comparison.engines)) {
      this.logger.warn(
        `Compare ${engine}: elapsed=${summary.elapsed_ms}ms ` +
          `visited=${summary.total_visited}, travel=${summary.total_travel_minutes}m, ` +
          `wait=${summary.total_wait_minutes}m, distance=${summary.total_distance_km}km, ` +
          `cost=${summary.total_cost}, feasible=${summary.validation?.is_feasible}`,
      );
    }
  }
}
