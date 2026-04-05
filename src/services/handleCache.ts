const cache = new Map<string, { handle: string; expiresAt: number }>();
const TTL_MS = 10 * 60 * 1000; // 10分

export async function getHandle(did: string): Promise<string> {
  const cached = cache.get(did);
  if (cached && cached.expiresAt > Date.now()) return cached.handle;

  try {
    const res = await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`
    );
    if (!res.ok) return did; // フォールバック：DIDをそのまま返す

    const profile = (await res.json()) as { handle: string };
    cache.set(did, { handle: profile.handle, expiresAt: Date.now() + TTL_MS });
    return profile.handle;
  } catch {
    return did;
  }
}
