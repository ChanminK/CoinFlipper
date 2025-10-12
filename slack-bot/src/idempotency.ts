import { store } from "./storage/fileStore.js";
import { logger } from "./logger.js";

export async function runOnce<T>(
  key: string,
  fn: () => Promise<T>,
  ttlMs?: number,
  meta?: Record<string, unknown>
): Promise<{ ok: boolean; value?: T }> {
  const state = store.get();

  const now = Date.now();
  const existing = state.idempotency[key];
  if (existing) {
    const created = new Date(existing.createdAt).getTime();
    const expired = typeof existing.ttlMs === "number" && now > created + existing.ttlMs;
    if (!expired) {
      logger.debug("Idempotent skip", { key });
      return { ok: false };
    }
  }

  const value = await fn();

  await store.update((s) => {
    s.idempotency[key] = {
      key,
      createdAt: new Date().toISOString(),
      ttlMs,
      meta,
    };
  });

  return { ok: true, value };
}
