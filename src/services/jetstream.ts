import { notify } from "./notifier";
import { initApns } from "./apns";
import { initFcm } from "./fcm";

const JETSTREAM_BASE =
  process.env.JETSTREAM_URL || "wss://jetstream2.us-east.bsky.network/subscribe";

const WANTED_COLLECTIONS = [
  "app.bsky.graph.follow",
  "app.bsky.feed.like",
  "app.bsky.feed.repost",
];

let cursor: number | undefined = undefined;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 60000;

interface JetstreamEvent {
  time_us: number;
  did: string; // actor DID
  kind: string;
  commit?: {
    collection: string;
    operation: string;
    record?: {
      subject?: string | { uri: string; cid: string };
    };
  };
}

function buildUrl(): string {
  const params = WANTED_COLLECTIONS.map(
    (c) => `wantedCollections=${c}`
  ).join("&");
  const url = `${JETSTREAM_BASE}?${params}`;
  return cursor ? `${url}&cursor=${cursor}` : url;
}

/** AT URI (at://did:plc:xxx/collection/rkey) からDIDを抽出 */
function extractDidFromUri(uri: string): string | null {
  const match = uri.match(/^at:\/\/(did:[^/]+)\//);
  return match ? match[1] : null;
}

function handleEvent(event: JetstreamEvent): void {
  if (event.kind !== "commit") return;

  const commit = event.commit;
  if (!commit || commit.operation !== "create" || !commit.record) return;

  const actorDid = event.did;
  let targetDid: string | null = null;
  let type: "follow" | "like" | "repost" | null = null;

  switch (commit.collection) {
    case "app.bsky.graph.follow": {
      // subject はフォローされた側のDID（文字列）
      const subject = commit.record.subject;
      if (typeof subject === "string") {
        targetDid = subject;
        type = "follow";
      }
      break;
    }
    case "app.bsky.feed.like": {
      const subject = commit.record.subject;
      if (subject && typeof subject === "object" && "uri" in subject) {
        targetDid = extractDidFromUri(subject.uri);
        type = "like";
      }
      break;
    }
    case "app.bsky.feed.repost": {
      const subject = commit.record.subject;
      if (subject && typeof subject === "object" && "uri" in subject) {
        targetDid = extractDidFromUri(subject.uri);
        type = "repost";
      }
      break;
    }
  }

  if (targetDid && type && targetDid !== actorDid) {
    // 自分自身への通知は送らない
    notify(type, actorDid, targetDid).catch((err) =>
      console.error("Notification error:", err)
    );
  }
}

function connect(): void {
  const url = buildUrl();
  console.log(`Jetstream: connecting to ${url.slice(0, 80)}...`);

  const ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    console.log("Jetstream: connected");
    reconnectDelay = 1000; // リセット
  });

  ws.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data as string) as JetstreamEvent;
      cursor = data.time_us;
      handleEvent(data);
    } catch (err) {
      console.error("Jetstream: parse error", err);
    }
  });

  ws.addEventListener("close", () => {
    console.log(
      `Jetstream: disconnected, reconnecting in ${reconnectDelay}ms...`
    );
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  });

  ws.addEventListener("error", (err) => {
    console.error("Jetstream: WebSocket error", err);
    ws.close();
  });
}

export function startJetstream(): void {
  // プッシュプロバイダーを初期化
  initApns();
  initFcm();

  // Jetstream購読開始
  connect();
}
