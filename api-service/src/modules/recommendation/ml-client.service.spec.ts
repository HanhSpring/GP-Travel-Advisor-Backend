import { of, throwError } from 'rxjs';
import { MlClientService, SessionRerankCandidate } from './ml-client.service';

function createHttpMock() {
  return { post: jest.fn() };
}

function createConfigMock() {
  return { get: jest.fn().mockReturnValue('http://localhost:8000') };
}

describe('MlClientService.sessionRerank — graceful degrade khi ai-service/model chưa sẵn sàng', () => {
  const candidates: SessionRerankCandidate[] = [
    {
      place_id: 'place-1',
      place_name: 'Hotel A',
      address: 'addr',
      image_url: null,
      category: 'accommodation',
      cosine_score: 0.9,
      average_rating: 4.5,
      is_top20_visited: true,
    },
    {
      place_id: 'place-2',
      place_name: 'Attraction B',
      address: 'addr2',
      image_url: null,
      category: 'attraction',
      cosine_score: 0.7,
      average_rating: null,
      is_top20_visited: false,
    },
  ];

  it('trả nguyên candidates (giữ thứ tự + cosine_score gốc) khi ai-service unreachable (network error)', async () => {
    const http = createHttpMock();
    http.post.mockReturnValue(
      throwError(() => new Error('connect ECONNREFUSED 127.0.0.1:8000')),
    );
    const service = new MlClientService(http as any, createConfigMock() as any);

    const result = await service.sessionRerank('user-1', candidates);

    expect(result).toBe(candidates); // graceful degrade: trả về đúng reference gốc, không throw
    expect(result.map((c) => c.place_id)).toEqual(['place-1', 'place-2']);
    expect(result[0].cosine_score).toBe(0.9);
    expect(result[0].predict_ranking).toBeUndefined();
  });

  it('trả nguyên candidates khi ai-service trả về passthrough (engine chưa train, ready=False)', async () => {
    const http = createHttpMock();
    // Giả lập đúng response của route /recommend/itinerary/session-rerank khi
    // engine is None hoặc chưa ready: trả nguyên candidates, không có predict_ranking.
    http.post.mockReturnValue(of({ data: { candidates } }));
    const service = new MlClientService(http as any, createConfigMock() as any);

    const result = await service.sessionRerank('user-1', candidates);

    expect(result).toBe(candidates);
    expect(result[0].cosine_score).toBe(0.9);
    expect(result[0].predict_ranking).toBeUndefined();
  });

  it('dùng đúng predict_ranking khi engine đã train và rerank thành công', async () => {
    const http = createHttpMock();
    const reranked = [
      { ...candidates[1], predict_ranking: 0.81, is_cold_start: true },
      { ...candidates[0], predict_ranking: 0.55, is_cold_start: true },
    ];
    http.post.mockReturnValue(of({ data: { candidates: reranked } }));
    const service = new MlClientService(http as any, createConfigMock() as any);

    const result = await service.sessionRerank('user-1', candidates);

    expect(result.map((c) => c.place_id)).toEqual(['place-2', 'place-1']);
    expect(result[0].predict_ranking).toBe(0.81);
  });
});
