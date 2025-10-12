import { store } from "./storage/fileStore";
import { grantDaily } from "./ledger";
import { todayEtIso } from "./time";
import { logger } from "./logger";

export const DAILY_GRANT_AMOUNT = 100;

export async function runDailyGrantForAll(dateEt?: string) {
  const effectiveDate = dateEt ?? todayEtIso();
  const s = store.get();
  const players = Object.values(s.users).filter(u => u.play);

  logger.info("Daily grant start", {
    dateEt: effectiveDate,
    users: players.length,
    amount: DAILY_GRANT_AMOUNT,
  });

  for (const u of players) {
    try {
      await grantDaily(u.id, DAILY_GRANT_AMOUNT, `daily:${effectiveDate}`);
    } catch (e: any) {
      logger.error("Daily grant failed", { userId: u.id, error: e?.message || String(e) });
    }
  }

  logger.info("Daily grant done", { dateEt: effectiveDate });
}

export function getBalance(userId: string): number {
  const bal = store.get().balances[userId];
  return bal?.amount ?? 0;
}

export function canStartBet(userId: string): { ok: boolean; balance: number; reason?: string } {
  const balance = getBalance(userId);
  if (balance < 0) return { ok: false, balance, reason: "Your balance is negative. You can't start a new bet." };
  return { ok: true, balance };
}
