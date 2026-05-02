type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const minLevel: Level = (process.env.BRIDGE_LOG_LEVEL as Level) ?? 'info';

function log(level: Level, msg: string, ctx?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
  const line = {
    t: new Date().toISOString(),
    level,
    msg,
    ...(ctx ?? {}),
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(line));
}

export const logger = {
  debug: (msg: string, ctx?: Record<string, unknown>) => log('debug', msg, ctx),
  info:  (msg: string, ctx?: Record<string, unknown>) => log('info',  msg, ctx),
  warn:  (msg: string, ctx?: Record<string, unknown>) => log('warn',  msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => log('error', msg, ctx),
};
