import apn from "node-apn";
import { db } from "../db/client";

let apnsProvider: apn.Provider | null = null;

export function initApns() {
  const keyString = process.env.APNS_KEY;
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;

  if (!keyString || !keyId || !teamId) {
    console.warn("APNs not configured — iOS push disabled");
    return;
  }

  apnsProvider = new apn.Provider({
    token: {
      key: Buffer.from(keyString),
      keyId,
      teamId,
    },
    production: process.env.APNS_PRODUCTION === "true",
  });

  console.log("APNs provider initialized");
}

export async function sendApns(
  token: string,
  body: string,
  targetDid: string
): Promise<void> {
  if (!apnsProvider) return;

  const notification = new apn.Notification();
  notification.topic = process.env.APNS_BUNDLE_ID || "com.osprey74.kazahana";
  notification.alert = { title: "kazahana", body };
  notification.sound = "default";
  notification.payload = { target_did: targetDid };

  const result = await apnsProvider.send(notification, token);

  for (const failure of result.failed) {
    // 410 Gone = トークン無効
    if (failure.status === "410" || failure.response?.reason === "Unregistered") {
      console.log(`APNs: removing invalid token ${token.slice(0, 8)}...`);
      db.run(`DELETE FROM device_tokens WHERE token = ?`, [token]);
    }
  }
}
