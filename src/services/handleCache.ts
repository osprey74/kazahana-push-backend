const handleCache = new Map<string, { handle: string; expiresAt: number }>();
const postTextCache = new Map<string, { text: string; expiresAt: number }>();

const HANDLE_TTL_MS = 10 * 60 * 1000; // 10分
const POST_TTL_MS = 5 * 60 * 1000; // 5分

export async function getHandle(did: string): Promise<string> {
  const cached = handleCache.get(did);
  if (cached && cached.expiresAt > Date.now()) return cached.handle;

  try {
    const res = await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`
    );
    if (!res.ok) return did;

    const profile = (await res.json()) as { handle: string };
    handleCache.set(did, { handle: profile.handle, expiresAt: Date.now() + HANDLE_TTL_MS });
    return profile.handle;
  } catch {
    return did;
  }
}

/** AT URIから投稿本文を取得（キャッシュ付き） */
export async function getPostText(uri: string): Promise<string | null> {
  const cached = postTextCache.get(uri);
  if (cached && cached.expiresAt > Date.now()) return cached.text;

  try {
    const res = await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`
    );
    if (!res.ok) return null;

    const data = (await res.json()) as {
      posts: Array<{ record: { text?: string } }>;
    };
    const text = data.posts[0]?.record?.text ?? null;
    if (text) {
      postTextCache.set(uri, { text, expiresAt: Date.now() + POST_TTL_MS });
    }
    return text;
  } catch {
    return null;
  }
}
