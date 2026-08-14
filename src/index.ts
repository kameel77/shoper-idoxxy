import { createApp } from "./app";
import { env } from "./config/env";
import { startDataRetentionScheduler } from "./services/dataRetentionService";
import { startRateLimitSweeper } from "./middleware/rateLimit";
import { startSessionStoreSweeper } from "./services/sessionStore";

const app = createApp();

app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Shoper ↔ Idoxxy integration server listening on port ${env.PORT}`);
});

// GDPR data-lifecycle purge (sync_logs retention + post-uninstall grace
// period - see src/services/dataRetentionService.ts). Started ONLY here,
// never from src/app.ts's createApp(): the test suite calls createApp()
// many times across the test files, and a stray 24h setInterval started
// there would leak a timer handle per call and risk hanging `vitest run`.
// This file (src/index.ts) is the single production process entry point, so
// it is the only appropriate place for a background scheduler.
startDataRetentionScheduler();

// Rate-limit bucket sweeper (see src/middleware/rateLimit.ts) - same rule as
// the retention scheduler above: started ONLY here, never from createApp(),
// so the test suite's many createApp() calls never accumulate timers.
startRateLimitSweeper();

// SQLite session store expiry sweep (see src/services/sessionStore.ts) - same
// rule as the two schedulers above: started ONLY here, never from createApp(),
// so the test suite's many createApp() calls never accumulate timers.
startSessionStoreSweeper();
