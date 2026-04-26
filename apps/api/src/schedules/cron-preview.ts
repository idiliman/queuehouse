import { parseExpression } from "cron-parser";

export function assertValidIanaTimeZone(tz: string): void {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    const e = new Error("invalid_time_zone") as Error & { code?: string };
    e.code = "invalid_time_zone";
    throw e;
  }
}

export function previewCronRuns(
  pattern: string,
  timeZone: string,
  count: number,
): { iso: string; timestampMs: number }[] {
  const interval = parseExpression(pattern, {
    tz: timeZone,
    currentDate: new Date(),
  });
  const out: { iso: string; timestampMs: number }[] = [];
  for (let i = 0; i < count; i++) {
    const d = interval.next();
    const date = d.toDate();
    out.push({ iso: date.toISOString(), timestampMs: date.getTime() });
  }
  return out;
}
