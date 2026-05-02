import { Router, raw } from 'express';
import { BRIDGE_PROTOCOL_VERSION } from '@bridge/shared';
import { AssetStore } from './asset-store';
import { logger } from './logger';

const MAX_ASSET_BYTES = 64 * 1024 * 1024;

export function buildRoutes(store: AssetStore): Router {
  const r = Router();

  r.get('/health', (_req, res) => {
    res.json({
      ok: true,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      uptime: process.uptime(),
    });
  });

  r.post(
    '/assets',
    raw({ type: '*/*', limit: MAX_ASSET_BYTES }),
    async (req, res) => {
      try {
        const format = String(req.headers['content-type'] ?? '').split(';')[0]?.trim() || 'application/octet-stream';
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          res.status(400).json({ error: 'empty body' });
          return;
        }
        const result = await store.put(body, format);
        res.json(result);
      } catch (e) {
        logger.error('assets.post.error', { error: String(e) });
        res.status(500).json({ error: 'internal' });
      }
    }
  );

  r.get('/assets/:hash', async (req, res) => {
    const hash = req.params.hash;
    const found = await store.resolve(hash);
    if (!found) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.setHeader('Content-Type', found.format);
    res.setHeader('Content-Length', String(found.byteLength));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(found.path);
  });

  return r;
}
