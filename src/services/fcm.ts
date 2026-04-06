import admin from "firebase-admin";
import { db } from "../db/client";

let fcmInitialized = false;

export function initFcm() {
  const projectId = process.env.FCM_PROJECT_ID;
  const credentialsJson = process.env.FCM_SERVICE_ACCOUNT_JSON;

  if (!projectId || !credentialsJson) {
    console.warn("FCM not configured — Android push disabled");
    return;
  }

  const serviceAccount = JSON.parse(credentialsJson);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId,
  });

  fcmInitialized = true;
  console.log("FCM initialized");
}

export async function sendFcm(
  token: string,
  title: string,
  body: string,
  targetDid: string
): Promise<void> {
  if (!fcmInitialized) return;

  try {
    await admin.messaging().send({
      token,
      notification: {
        title,
        body,
      },
      data: {
        target_did: targetDid,
      },
      android: {
        notification: {
          sound: "default",
        },
      },
    });
  } catch (error: any) {
    if (error.code === "messaging/registration-token-not-registered") {
      console.log(`FCM: removing invalid token ${token.slice(0, 8)}...`);
      db.run(`DELETE FROM device_tokens WHERE token = ?`, [token]);
    } else {
      console.error("FCM send error:", error.message);
    }
  }
}
