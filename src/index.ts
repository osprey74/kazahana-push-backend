import { Hono } from "hono";
import { logger } from "hono/logger";
import { authMiddleware } from "./utils/auth";
import { device } from "./routes/device";
import { startJetstream } from "./services/jetstream";

const app = new Hono();

app.use("*", logger());

// ヘルスチェック（認証不要）
app.get("/health", (c) => c.json({ status: "ok" }));

// API routes（認証必須）
const api = new Hono();
api.use("*", authMiddleware);
api.route("/", device);
app.route("/api", api);

// Jetstream購読開始
startJetstream();

console.log("kazahana-push-backend starting on port 3000");

export default {
  port: 3000,
  fetch: app.fetch,
};
