import { db } from "../db/client";
import { getHandle } from "./handleCache";

type NotificationType = "follow" | "like" | "repost" | "reply" | "mention" | "quote";

// メモリ内カウンター（定期リセット）
const notificationCounts: Record<NotificationType, number> = {
  follow: 0, like: 0, repost: 0, reply: 0, mention: 0, quote: 0,
};
const activeRecipientDids = new Set<string>();
let periodStart = Date.now();

/** 通知送信時に呼び出す */
export function recordNotification(type: NotificationType, targetDid: string): void {
  notificationCounts[type]++;
  activeRecipientDids.add(targetDid);
}

/** 現在の統計を取得してカウンターをリセット */
export function flushStats() {
  const stats = {
    periodStart: new Date(periodStart).toISOString(),
    periodEnd: new Date().toISOString(),
    notificationsSent: { ...notificationCounts },
    totalSent: Object.values(notificationCounts).reduce((a, b) => a + b, 0),
    activeRecipients: activeRecipientDids.size,
  };

  // リセット
  for (const key of Object.keys(notificationCounts) as NotificationType[]) {
    notificationCounts[key] = 0;
  }
  activeRecipientDids.clear();
  periodStart = Date.now();

  return stats;
}

interface RegisteredToken {
  did: string;
  platform: string;
}

/** DB から登録ユーザー統計を取得 */
export async function getRegistrationStats() {
  const tokens = db.query<RegisteredToken, []>(
    `SELECT did, platform FROM device_tokens ORDER BY did`
  ).all();

  const platformCounts = { ios: 0, android: 0 };
  const uniqueDids = new Set<string>();
  for (const t of tokens) {
    uniqueDids.add(t.did);
    if (t.platform === "ios") platformCounts.ios++;
    else platformCounts.android++;
  }

  // DIDからhandle解決
  const users = await Promise.all(
    tokens.map(async (t) => ({
      handle: await getHandle(t.did),
      did: t.did,
      platform: t.platform,
    }))
  );

  return {
    registeredUsers: uniqueDids.size,
    platformCounts,
    users,
  };
}

/** 定期ログ出力 */
export function logStats(): void {
  const stats = flushStats();
  if (stats.totalSent === 0) {
    console.log(`[stats] ${stats.periodStart} ~ ${stats.periodEnd}: 通知なし`);
    return;
  }

  const breakdown = Object.entries(stats.notificationsSent)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");

  console.log(
    `[stats] ${stats.periodStart} ~ ${stats.periodEnd}: ` +
    `通知 ${stats.totalSent}件 (${breakdown}), ` +
    `受信ユーザー ${stats.activeRecipients}人`
  );
}
