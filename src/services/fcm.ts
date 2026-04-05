import admin from "firebase-admin";
import { db } from "../db/client";

let fcmInitialized = false;

export function initFcm() {
  const projectId = process.env.FCM_PROJECT_ID;
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (!projectId || !credentialsPath) {
    console.warn("FCM not configured — Android push disabled");
    return;
  }

  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId,
  });

  fcmInitialized = true;
  console.log("FCM initialized");
}

export async function sendFcm(
  token: string,
  body: string,
  targetDid: string
): Promise<void> {
  if (!fcmInitialized) return;

  try {
    await admin.messaging().send({
      token,
      notification: {
        title: "kazahana",
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
