import type { Context, Next } from "hono";

const API_SECRET = process.env.API_SECRET;

export async function authMiddleware(c: Context, next: Next) {
  if (!API_SECRET) {
    return c.json({ error: "Server misconfigured: API_SECRET not set" }, 500);
  }

  const authHeader = c.req.header("Authorization");
  if (!authHeader || authHeader !== `Bearer ${API_SECRET}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
}
