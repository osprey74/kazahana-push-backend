import { db } from "../db/client";
import { getHandle } from "./handleCache";
import { sendApns } from "./apns";
import { sendFcm } from "./fcm";

type NotificationType = "follow" | "like" | "repost";

interface DeviceToken {
  token: string;
  platform: "ios" | "android";
}

const findTokensStmt = db.prepare<DeviceToken, [string]>(
  `SELECT token, platform FROM device_tokens WHERE did = ?`
);

function buildMessage(
  type: NotificationType,
  actorHandle: string,
  targetHandle: string
): string {
  switch (type) {
    case "follow":
      return `@${actorHandle} さんが @${targetHandle} をフォローしました`;
    case "like":
      return `@${actorHandle} さんが @${targetHandle} の投稿にいいねしました`;
    case "repost":
      return `@${actorHandle} さんが @${targetHandle} の投稿をリポストしました`;
  }
}

export async function notify(
  type: NotificationType,
  actorDid: string,
  targetDid: string
): Promise<void> {
  // 対象DIDのトークンをDBから検索（ヒット時のみ後続処理）
  const tokens = findTokensStmt.all(targetDid);
  if (tokens.length === 0) return;

  // actor・targetのhandleを並行取得
  const [actorHandle, targetHandle] = await Promise.all([
    getHandle(actorDid),
    getHandle(targetDid),
  ]);

  const body = buildMessage(type, actorHandle, targetHandle);

  // 各トークンに送信
  await Promise.all(
    tokens.map((t) =>
      t.platform === "ios"
        ? sendApns(t.token, body, targetDid)
        : sendFcm(t.token, body, targetDid)
    )
  );
}
