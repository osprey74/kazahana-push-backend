import { notify } from "./notifier";
import { initApns } from "./apns";
import { initFcm } from "./fcm";

const JETSTREAM_BASE =
  process.env.JETSTREAM_URL || "wss://jetstream2.us-east.bsky.network/subscribe";

const WANTED_COLLECTIONS = [
  "app.bsky.graph.follow",
  "app.bsky.feed.like",
  "app.bsky.feed.repost",
  "app.bsky.feed.post",
];

let cursor: number | undefined = undefined;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 60000;

type NotificationType = "follow" | "like" | "repost" | "reply" | "mention" | "quote";

interface MentionFacet {
  features: Array<{
    $type: string;
    did?: string;
  }>;
}

interface JetstreamEvent {
  time_us: number;
  did: string; // actor DID
  kind: string;
  commit?: {
    collection: string;
    operation: string;
    record?: {
      text?: string;
      subject?: string | { uri: string; cid: string };
      reply?: {
        parent: { uri: string };
        root: { uri: string };
      };
      facets?: MentionFacet[];
      embed?: {
        $type: string;
        record?: { uri: string };
      };
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

interface Notification {
  type: NotificationType;
  targetDid: string;
  postText?: string;    // イベントから直接取得できる投稿本文（reply/mention/quote）
  subjectUri?: string;  // いいね・リポスト対象のAT URI（API取得用）
}

/** 通知対象を収集（1イベントから複数通知が発生しうる） */
function collectNotifications(
  event: JetstreamEvent
): Notification[] {
  if (event.kind !== "commit") return [];

  const commit = event.commit;
  if (!commit || commit.operation !== "create" || !commit.record) return [];

  const actorDid = event.did;
  const results: Notification[] = [];

  switch (commit.collection) {
    case "app.bsky.graph.follow": {
      const subject = commit.record.subject;
      if (typeof subject === "string") {
        results.push({ type: "follow", targetDid: subject });
      }
      break;
    }
    case "app.bsky.feed.like": {
      const subject = commit.record.subject;
      if (subject && typeof subject === "object" && "uri" in subject) {
        const did = extractDidFromUri(subject.uri);
        if (did) results.push({ type: "like", targetDid: did, subjectUri: subject.uri });
      }
      break;
    }
    case "app.bsky.feed.repost": {
      const subject = commit.record.subject;
      if (subject && typeof subject === "object" && "uri" in subject) {
        const did = extractDidFromUri(subject.uri);
        if (did) results.push({ type: "repost", targetDid: did, subjectUri: subject.uri });
      }
      break;
    }
    case "app.bsky.feed.post": {
      const record = commit.record;
      const postText = record.text;
      const notifiedDids = new Set<string>();

      // リプライ
      if (record.reply) {
        const parentDid = extractDidFromUri(record.reply.parent.uri);
        if (parentDid) {
          results.push({ type: "reply", targetDid: parentDid, postText });
          notifiedDids.add(parentDid);
        }
      }

      // 引用
      if (record.embed) {
        const embedType = record.embed.$type;
        if (
          (embedType === "app.bsky.embed.record" ||
            embedType === "app.bsky.embed.recordWithMedia") &&
          record.embed.record?.uri
        ) {
          const quotedDid = extractDidFromUri(record.embed.record.uri);
          if (quotedDid && !notifiedDids.has(quotedDid)) {
            results.push({ type: "quote", targetDid: quotedDid, postText });
            notifiedDids.add(quotedDid);
          }
        }
      }

      // メンション
      if (record.facets) {
        for (const facet of record.facets) {
          for (const feature of facet.features) {
            if (
              feature.$type === "app.bsky.richtext.facet#mention" &&
              feature.did &&
              !notifiedDids.has(feature.did)
            ) {
              results.push({ type: "mention", targetDid: feature.did, postText });
              notifiedDids.add(feature.did);
            }
          }
        }
      }
      break;
    }
  }

  // 自分自身への通知を除外
  return results.filter((r) => r.targetDid !== actorDid);
}

function handleEvent(event: JetstreamEvent): void {
  const notifications = collectNotifications(event);
  for (const n of notifications) {
    notify(n.type, event.did, n.targetDid, n.postText, n.subjectUri).catch(
      (err) => console.error("Notification error:", err)
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
