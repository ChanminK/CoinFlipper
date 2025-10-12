import { promises as fs } from "fs";
import * as path from "path";
import { CONFIG } from "../config.js";
import { State } from "../types.js";
import { logger } from "../logger.js";

const DEFAULT_STATE = (): State => ({
  version: 1,
  users: {},
  balances: {},
  inventory: {},
  transactions: [],
  games: {},
  announcements: { dailyTopEnabled: false, weeklyResetEnabled: false },
  secretCoins: { globalCap: 3, awards: [] },
  idempotency: {},
  featureFlags: { ...CONFIG.defaultFlags },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

async function atomicWriteJson(filePath: string, json: string) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(
    dir,
    `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  );

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmp, json, "utf8");

  try {
    await fs.rename(tmp, filePath);
  } catch (err: any) {
    if (err?.code === "ENOENT" || err?.code === "EPERM" || err?.code === "EXDEV") {
      await fs.writeFile(filePath, json, "utf8");
      try { await fs.unlink(tmp); } catch {}
    } else {
      try { await fs.unlink(tmp); } catch {}
      throw err;
    }
  }
}

export class FileStore {
  private state: State = DEFAULT_STATE();
  private filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor() {
    this.filePath = path.join(CONFIG.dataDir, CONFIG.stateFile);
  }

  async init() {
    await fs.mkdir(CONFIG.dataDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.state = JSON.parse(raw) as State;
      logger.info("State loaded", { file: this.filePath });
    } catch {
      logger.warn("No existing state; creating new", { file: this.filePath });
      await this.save();
    }
  }

  get(): State {
    return this.state;
  }

  private async persist() {
    this.state.updatedAt = new Date().toISOString();
    const data = JSON.stringify(this.state, null, 2);
    await atomicWriteJson(this.filePath, data);
    logger.debug("State saved", { file: this.filePath });
  }

  async save() {
    this.writeQueue = this.writeQueue.then(() => this.persist()).catch((e) => {
      logger.error("State save failed", { error: e?.message });
    });
    return this.writeQueue;
  }

  async update(mutator: (s: State) => void) {
    mutator(this.state);
    await this.save();
  }
}

export const store = new FileStore();
