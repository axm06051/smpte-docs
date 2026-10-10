import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'FATAL';

const LOG_CONFIG: Record<LogLevel, { rank: number; color: string }> = {
  TRACE: { rank: 10, color: 'gray' },
  DEBUG: { rank: 20, color: 'cyan' },
  INFO: { rank: 30, color: 'white' },
  WARNING: { rank: 40, color: 'yellow' },
  ERROR: { rank: 50, color: 'red' },
  FATAL: { rank: 60, color: 'magenta' },
};

const configured = (process.env.LOG_LEVEL || 'INFO').toUpperCase() as LogLevel;
const depth = Number(process.env.LOG_DEPTH) || 3;
const currentRank = LOG_CONFIG[configured]?.rank ?? LOG_CONFIG.INFO.rank;
const logFile = process.env.LOG_FILE ?? '.data/server.log';

if (logFile) {
  try {
    mkdirSync(dirname(logFile), { recursive: true });
  } catch {}
}

const flat = (s: string) => s.replace(/\n\s*/g, ' ');

export const logger = Object.fromEntries(
  Object.entries(LOG_CONFIG).map(([level, cfg]) => {
    const isEnabled = cfg.rank >= currentRank;
    const color = Bun.color(cfg.color, 'ansi');
    const reset = '\x1b[0m';
    const fn =
      level === 'ERROR' || level === 'FATAL'
        ? console.error
        : level === 'WARNING'
          ? console.warn
          : console.log;

    return [
      level.toLowerCase(),
      (...args: unknown[]) => {
        if (!isEnabled) return;

        const timestamp = new Date().toISOString();
        const line = args.map((arg) =>
          typeof arg === 'object' && arg !== null
            ? flat(Bun.inspect(arg, { colors: true, depth: depth }))
            : arg,
        );

        fn(`${color}${timestamp} [${level}]${reset}`, ...line);

        if (logFile) {
          const plain = args
            .map((arg) =>
              typeof arg === 'object' && arg !== null
                ? flat(Bun.inspect(arg, { colors: false, depth: depth }))
                : String(arg),
            )
            .join(' ');
          try {
            appendFileSync(logFile, `${timestamp} [${level}] ${plain}\n`);
          } catch {} // a full disk or bad path must never break the request being logged
        }
      },
    ];
  }),
) as Record<Lowercase<LogLevel>, (...args: unknown[]) => void>;
