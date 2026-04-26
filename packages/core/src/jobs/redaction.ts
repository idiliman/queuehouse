/**
 * Shallow-to-deep field redaction for operator-facing JSON using dot paths (e.g. `user.email`).
 * Missing paths are ignored; only existing own keys on plain objects are updated.
 */
export function redactObjectAtPaths(
  value: unknown,
  paths: string[] | undefined,
  placeholder = "[REDACTED]" as const,
): unknown {
  if (value == null) return value;
  if (!paths?.length) return value;
  let out: unknown;
  try {
    out = JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return value;
  }
  for (const p of paths) {
    setDotPath(out, p, placeholder);
  }
  return out;
}

function setDotPath(root: unknown, path: string, nextValue: unknown): void {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) return;
  let cur: unknown = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur === null || typeof cur !== "object") return;
    const k = parts[i]!;
    cur = (cur as Record<string, unknown>)[k];
  }
  if (cur === null || typeof cur !== "object") return;
  const last = parts[parts.length - 1]!;
  if (Object.prototype.hasOwnProperty.call(cur as object, last)) {
    (cur as Record<string, unknown>)[last] = nextValue;
  }
}
