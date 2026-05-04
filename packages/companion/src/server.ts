import express from 'express';
import http from 'http';
import * as path from 'path';
import * as os from 'os';
import { buildRoutes } from './http-routes';
import { WsHub } from './ws-hub';
import { AssetStore } from './asset-store';
import { logger } from './logger';

const PORT = Number(process.env.BRIDGE_PORT ?? 7711);
const HOST = '127.0.0.1';
const CACHE_DIR = process.env.BRIDGE_CACHE_DIR ?? path.join(os.homedir(), '.bridge-cache');

async function main(): Promise<void> {
  const store = new AssetStore(CACHE_DIR);
  await store.init();

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(buildRoutes(store));

  const server = http.createServer(app);
  // Allow up to 5 minutes for large image uploads.
  server.requestTimeout = 300_000;

  const assetBaseUrl = `http://${HOST}:${PORT}`;
  const hub = new WsHub(assetBaseUrl, { maxPayload: 50 * 1024 * 1024 });
  hub.attach(server);

  server.listen(PORT, HOST, () => {
    logger.info('companion.listening', {
      host: HOST,
      port: PORT,
      ws: `ws://${HOST}:${PORT}/bridge`,
      assetBaseUrl,
      cacheDir: CACHE_DIR,
    });
  });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      logger.info('companion.shutdown', { signal: sig });
      server.close(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  logger.error('companion.fatal', { error: String(err) });
  process.exit(1);
});
