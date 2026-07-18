// Shared fetch wrapper cho tat ca Supabase client (singleton/process-scoped).
// Muc dich: giam ap luc len Supavisor/PostgREST connection pool khi backend
// fan-out nhieu query song song (vd: tinh estimated cost cho danh sach
// itinerary), ma khong doi bat ky query/logic nghiep vu nao:
//   - Timeout per-request: tranh 1 request treo giu slot pool vo thoi han.
//   - Gioi han so request dong thoi tu process nay ra Supabase: request vuot
//     gioi han se xep hang cho thay vi ban thang ra Supabase cung luc.
type LimitedFetchOptions = {
  timeoutMs?: number;
  concurrency?: number;
};

export function createLimitedFetch(
  opts: LimitedFetchOptions = {},
): typeof fetch {
  const timeoutMs =
    opts.timeoutMs ?? Number(process.env.SUPABASE_FETCH_TIMEOUT_MS ?? 20000);
  const concurrency =
    opts.concurrency ?? Number(process.env.SUPABASE_FETCH_CONCURRENCY ?? 20);

  let active = 0;
  const queue: Array<() => void> = [];

  function acquire(): Promise<void> {
    if (active < concurrency) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => queue.push(resolve));
  }

  function release() {
    active--;
    const next = queue.shift();
    if (next) {
      active++;
      next();
    }
  }

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    await acquire();
    try {
      return await fetch(input, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } finally {
      release();
    }
  }) as typeof fetch;
}
