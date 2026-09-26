import { getEnv } from "@codeguard/config";

/**
 * Minimal structured logger: one JSON line per event so Render/Datadog/etc. can
 * filter on fields like `reviewId`, `deliveryId` or `consumer`.
 */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

function make(base: Record<string, unknown>): Logger {
  const threshold = (() => {
    try {
      return ORDER[getEnv().LOG_LEVEL];
    } catch {
      return ORDER.info;
    }
  })();

  const write = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < threshold) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...base, ...fields });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };

  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (fields) => make({ ...base, ...fields }),
  };
}

export const logger = make({ service: "codeguard-workers" });
