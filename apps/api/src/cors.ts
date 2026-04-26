import type { QueuehouseConfig } from "@queuehouse/core";

const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

export function corsAllowedOrigins(config: QueuehouseConfig): string[] {
  if (config.nodeEnv === "production") {
    const raw = process.env.CORS_ORIGIN?.trim();
    if (!raw) return [];
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return DEV_ORIGINS;
}
