import { Hono } from "hono";
import { db } from "../db/client";

const device = new Hono();

// デバイストークン登録（UPSERT）
device.post("/device-token", async (c) => {
  const body = await c.req.json<{
    did: string;
    token: string;
    platform: "ios" | "android";
  }>();

  if (!body.did || !body.token || !body.platform) {
    return c.json({ error: "Missing required fields: did, token, platform" }, 400);
  }

  if (body.platform !== "ios" && body.platform !== "android") {
    return c.json({ error: "platform must be 'ios' or 'android'" }, 400);
  }

  db.run(
    `INSERT INTO device_tokens (did, token, platform, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(did, platform) DO UPDATE SET
       token = excluded.token,
       updated_at = datetime('now')`,
    [body.did, body.token, body.platform]
  );

  return c.json({ ok: true });
});

// デバイストークン削除
device.delete("/device-token", async (c) => {
  const body = await c.req.json<{
    did: string;
    platform: "ios" | "android";
  }>();

  if (!body.did || !body.platform) {
    return c.json({ error: "Missing required fields: did, platform" }, 400);
  }

  db.run(
    `DELETE FROM device_tokens WHERE did = ? AND platform = ?`,
    [body.did, body.platform]
  );

  return c.json({ ok: true });
});

export { device };
