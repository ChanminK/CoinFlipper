import { CONFIG } from "./config";
import { setLogLevel, logger } from "./logger";
import { store } from "./storage/fileStore";
import { buildSlackApp, startSlackApp } from "./slackApp";

async function init() {
  setLogLevel(CONFIG.logLevel);
  await store.init();

  logger.info("Inital functions", {
    dataDir: CONFIG.dataDir,
    stateFile: CONFIG.stateFile,
    tz: CONFIG.etTz,
    flags: store.get().featureFlags,
  });

  const app = buildSlackApp();
  await startSlackApp(app);

}

init().catch((e) => {
  logger.error("Fatal init error", { error: e?.message || String(e), stack: e?.stack });
  process.exit(1);
});
