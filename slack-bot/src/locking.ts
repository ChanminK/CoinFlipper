const queues = new Map<string, Promise<unknown>>();

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) || Promise.resolve();
  let resolveNext: (v: unknown) => void;
  const next = new Promise((res) => (resolveNext = res));
  queues.set(key, prev.then(() => next));

  try {
    const result = await fn();
    resolveNext!(null);
    return result;
  } catch (err) {
    resolveNext!(null);
    throw err;
  } finally {
    if (queues.get(key) === next) queues.delete(key);
  }
}
