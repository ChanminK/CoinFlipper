import "dotenv/config";

export const ET_TZ = process.env.ET_TZ || "America/NewYork";
export const DATA_DIR = process.env.DATA_DIR || "./data";
export const STATE_FILE = process.env.STATE_FILE || "state.json";

export const LOG_LEVEL = 
    (process.env.LOG_LEVEL as "debug" | "info" | "warn" | "error") || "info";

// flags - make sure to switch off when offfical build
export const DEFAULT_FLAGS = {
    optIn: true,
    economy: true,
    shop: true,
    streaks: true,
    games: true,
    leaderboard: true,
    secretCoins: true,
    aiDebate: true,
} as const;

export const CONFIG = {
    etTz: ET_TZ,
    dataDir: DATA_DIR,
    stateFile: STATE_FILE,
    logLevel: LOG_LEVEL,
    defaultFlags: DEFAULT_FLAGS,
    leaderboardChannelId: process.env.SLACK_LEADERBOARD_CHANNEL_ID || "C08SKC6P85V", 

};