import { randomUUID } from "crypto";
import { State, Transaction, TransactionType } from "./types"; 
import { store } from "./storage/fileStore";
import { logger } from "./logger"; 
import { withLock } from "./locking";
import { runOnce } from "./idempotency";

function ensureUserBalance(state: State, userId: string) {
  if (!state.balances[userId]) {
    state.balances[userId] = {
      userId,
      amount: 0,
      updatedAt: new Date().toISOString(),
    };
  }
}

export async function addTransaction(
  userId: string,
  type: TransactionType,
  amount: number,
  opts?: { refId?: string; idemKey?: string }
): Promise<Transaction> {
  const key = opts?.idemKey ? `tx:${userId}:${opts.idemKey}` : `tx:${userId}:${randomUUID()}`;

  return await withLock(`balance:${userId}`, async () => {
    if (opts?.idemKey) {
      const idem = await runOnce(key, async () => "ok");
      if (!idem.ok) {
        const existing = store.get().transactions.find((t) => t.userId === userId && t.idemKey === opts!.idemKey);
        if (!existing) throw new Error("Idempotency claimed but transaction not found");
        return existing;
      }
    }

    let created: Transaction | undefined;
    let finalBalance: number = 0;

    await store.update((s) => {
      ensureUserBalance(s, userId);
      const bal = s.balances[userId];

      const newBal = bal.amount + amount;
      const tx: Transaction = {
        txId: randomUUID(),
        userId,
        type,
        amount,
        balanceAfter: newBal,
        refId: opts?.refId,
        idemKey: opts?.idemKey,
        createdAt: new Date().toISOString(),
      };
      s.transactions.push(tx);
      s.balances[userId] = { ...bal, amount: newBal, updatedAt: tx.createdAt };
      created = tx;
      finalBalance = newBal; 
    });

    if (!created) {
      throw new Error("Transaction creation failed");
    }

    logger.info("Transaction", { userId, type, amount, balanceAfter: finalBalance }); 
    return created;
  });
}

// helpers
export async function grantDaily(userId: string, amount: number, idemKey: string) {
  return addTransaction(userId, "grant", amount, { idemKey, refId: "daily_grant" });
}
