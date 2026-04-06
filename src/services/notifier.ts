import { db } from "../db/client";
import { getHandle, getPostText } from "./handleCache";
import { sendApns } from "./apns";
import { sendFcm } from "./fcm";

type NotificationType = "follow" | "like" | "repost" | "reply" | "mention" | "quote";

interface DeviceToken {
  token: string;
  platform: "ios" | "android";
}

const MAX_POST_TEXT_LENGTH = 80;

const findTokensStmt = db.prepare<DeviceToken, [string]>(
  `SELECT token, platform FROM device_tokens WHERE did = ?`
);

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "…";
}

function buildTitle(type: NotificationType, actorHandle: string): string {
  switch (type) {
    case "follow":
      return `@${actorHandle} にフォローされました`;
    case "like":
      return `@${actorHandle} がいいねしました`;
    case "repost":
      return `@${actorHandle} がリポストしました`;
    case "reply":
      return `@${actorHandle} が返信しました`;
    case "mention":
      return `@${actorHandle} がメンションしました`;
    case "quote":
      return `@${actorHandle} が引用しました`;
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

function buildBody(
  type: NotificationType,
  targetHandle: string,
  postText: string | null
): string {
  const prefix = `@${targetHandle}`;
  if (postText) {
    return `${prefix}: ${truncate(postText, MAX_POST_TEXT_LENGTH)}`;
  }
  // 本文が取得できなかった場合のフォールバック
  switch (type) {
    case "follow":
      return prefix;
    case "like":
    case "repost":
      return prefix;
    case "reply":
    case "mention":
    case "quote":
      return prefix;
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

/** 投稿本文を解決する（イベント直接取得 or API取得） */
async function resolvePostText(
  type: NotificationType,
  postText?: string,
  subjectUri?: string
): Promise<string | null> {
  // reply/mention/quote: イベントから直接取得済み
  if (postText) return postText;
  // like/repost: subject URIからAPI取得
  if (subjectUri) return await getPostText(subjectUri);
  return null;
}

export async function notify(
  type: NotificationType,
  actorDid: string,
  targetDid: string,
  postText?: string,
  subjectUri?: string
): Promise<void> {
  // 対象DIDのトークンをDBから検索（ヒット時のみ後続処理）
  const tokens = findTokensStmt.all(targetDid);
  if (tokens.length === 0) return;

  // handle取得と投稿本文解決を並行実行
  const [actorHandle, targetHandle, resolvedText] = await Promise.all([
    getHandle(actorDid),
    getHandle(targetDid),
    resolvePostText(type, postText, subjectUri),
  ]);

  const title = buildTitle(type, actorHandle);
  const body = buildBody(type, targetHandle, resolvedText);

  // 各トークンに送信
  await Promise.all(
    tokens.map((t) =>
      t.platform === "ios"
        ? sendApns(t.token, title, body, targetDid)
        : sendFcm(t.token, title, body, targetDid)
    )
  );
}
