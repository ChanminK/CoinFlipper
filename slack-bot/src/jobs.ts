import { App } from "@slack/bolt";
import { CONFIG } from "./config";
import { store } from "./storage/fileStore";
import { logger } from "./logger";
import { scheduleDailyEt, scheduleWeeklyMondayEt } from "./scheduler";
import { runDailyGrantForAll, DAILY_GRANT_AMOUNT } from "./economy";

export function scheduleJobs(app: App) {
  scheduleDailyEt("daily-midnight-et", async () => {
    try {
      await runDailyGrantForAll(); 
      logger.info("Daily tick (ET) complete");
    } catch (e: any) {
      logger.warn("Daily grant failed", { error: e?.message });
    }

    const text = buildTop10Text();
    const channels = CONFIG.leaderboardChannelIds ?? [];
    if (channels.length === 0) {
      logger.info("No leaderboard channels configured; skipping daily Top 10.");
      return;
    }

    for (const channel of channels) {
      try {
        await app.client.chat.postMessage({ channel, text });
        logger.info("Posted daily Top 10", { channel });
      } catch (e: any) {
        logger.warn("Failed to post daily Top 10", { channel, error: e?.data?.error || e?.message });
      }
      await delay(1200); 
    }
  });

  scheduleWeeklyMondayEt("weekly-monday-et", async () => {
    await store.update(s => {
      const now = new Date().toISOString();
      for (const uid of Object.keys(s.balances)) {
        s.balances[uid].amount = 0;
        s.balances[uid].updatedAt = now;
      }
      (s as any).weeksCompleted = ((s as any).weeksCompleted || 0) + 1;
    });

    const channels = CONFIG.leaderboardChannelIds ?? [];
    if (channels.length === 0) {
      logger.info("No leaderboard channels configured; skipping weekly post.");
      return;
    }

    const announce =
      `📣 *Weekly reset!*\n` +
      `Everyone's balance has been set to \`0\` after seven daily grants.\n` +
      `Daily grant remains *+${DAILY_GRANT_AMOUNT}* each day. Good luck this week!`;

    for (const channel of channels) {
      try {
        await app.client.chat.postMessage({ channel, text: announce });
        logger.info("Posted weekly reset", { channel });
      } catch (e: any) {
        logger.warn("Failed to post weekly reset", { channel, error: e?.data?.error || e?.message });
      }
      await delay(1200);
    }
  });
}

function buildTop10Text(): string {
  const s = store.get();
  const balances = Object.values(s.balances || {}) as Array<{ userId: string; amount: number }>;
  const top = balances.sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0)).slice(0, 10);

  if (top.length === 0) return "🏆 *Top 10 Coin Holders*\n\n_No players yet._";
  const lines = top.map((b, i) => `${i + 1}. <@${b.userId}> — ${b.amount} coins`);
  return `🏆 *Top 10 Coin Holders*\n\n${lines.join("\n")}`;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
