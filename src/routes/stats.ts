import { Hono } from "hono";
import { flushStats, getRegistrationStats } from "../services/stats";

const stats = new Hono();

stats.get("/stats", async (c) => {
  const [period, registration] = await Promise.all([
    Promise.resolve(flushStats()),
    getRegistrationStats(),
  ]);

  return c.json({
    period: {
      start: period.periodStart,
      end: period.periodEnd,
      notificationsSent: period.notificationsSent,
      totalSent: period.totalSent,
      activeRecipients: period.activeRecipients,
    },
    registration: {
      registeredUsers: registration.registeredUsers,
      platformCounts: registration.platformCounts,
      users: registration.users,
    },
  });
});

export { stats };
