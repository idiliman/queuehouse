import {
  type CSSProperties,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { loadJobsTablePrefs, saveJobsTablePrefs, type JobsTablePrefs } from "./jobsPrefs";

/** Matches `BULK_DLQ_MAX_TARGETS` in API; bulk-dlq rejects larger batches. */
const BULK_DLQ_MAX = 500;

type JobListItem = {
  jobId: string;
  queueName: string;
  state: string;
  jobName?: string;
  created?: number;
  processedOn?: number;
  finishedOn?: number;
  attemptsMade: number;
  maxAttempts?: number;
  priority: number;
  failedReason?: string;
  schedulerId?: string;
};

const labelStyle: CSSProperties = {
  display: "grid",
  gap: "0.35rem",
  fontSize: "0.8rem",
  fontWeight: 500,
};

const inputStyle: CSSProperties = {
  padding: "0.35rem 0.5rem",
  fontSize: "0.85rem",
  borderRadius: 4,
  border: "1px solid #ccc",
  minWidth: 0,
};

function initialJobsPrefsFromLocation(): JobsTablePrefs {
  const base = loadJobsTablePrefs();
  if (typeof window === "undefined") return base;
  const u = new URLSearchParams(window.location.search);
  const st = u.get("state");
  if (st) return { ...base, state: st };
  return base;
}

export type JobsTablePageProps = {
  role: "VIEWER" | "ADMIN";
  /** Seeds the state filter on first mount (e.g. dedicated `/dlq` route). */
  initialState?: string;
};

function rowKey(j: JobListItem): string {
  return `${j.queueName}\0${j.jobId}`;
}

export function JobsTablePage({ role, initialState }: JobsTablePageProps) {
  const [prefs, setPrefs] = useState<JobsTablePrefs>(() => {
    const base = loadJobsTablePrefs();
    if (initialState) return { ...base, state: initialState };
    return initialJobsPrefsFromLocation();
  });
  const [rows, setRows] = useState<JobListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedFailed, setSelectedFailed] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [filterPreviewLoading, setFilterPreviewLoading] = useState(false);
  const [filterPreview, setFilterPreview] = useState<{
    targets: { queueName: string; jobId: string }[];
    matchingCount: number;
    hasMore: boolean;
    cap: number;
  } | null>(null);

  useEffect(() => {
    saveJobsTablePrefs(prefs);
  }, [prefs]);

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (prefs.queue.trim()) p.set("queue", prefs.queue.trim());
    if (prefs.state.trim()) p.set("state", prefs.state.trim());
    if (prefs.jobName.trim()) p.set("jobName", prefs.jobName.trim());
    if (prefs.jobId.trim()) p.set("jobId", prefs.jobId.trim());
    if (prefs.schedulerId.trim()) p.set("schedulerId", prefs.schedulerId.trim());
    if (prefs.from.trim()) p.set("from", prefs.from.trim());
    if (prefs.to.trim()) p.set("to", prefs.to.trim());
    if (prefs.minAttempts.trim()) p.set("minAttempts", prefs.minAttempts.trim());
    if (prefs.maxAttempts.trim()) p.set("maxAttempts", prefs.maxAttempts.trim());
    p.set("limit", prefs.limit.trim() || "50");
    return p.toString();
  }, [prefs]);

  const runFetch = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/jobs?${queryString}`, { credentials: "include" });
      if (res.status === 401) {
        setError("Session expired. Sign in again.");
        setRows([]);
        return;
      }
      if (!res.ok) {
        setError(`Request failed (${res.status}).`);
        setRows([]);
        return;
      }
      const body = (await res.json()) as { jobs: JobListItem[] };
      setRows(body.jobs);
    } catch {
      setError("Network error.");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [queryString]);

  useEffect(() => {
    void runFetch();
  }, [runFetch]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void runFetch();
  };

  const sorted = useMemo(() => {
    const list = [...rows];
    const key = prefs.sortKey;
    const dir = prefs.sortDir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      const av = sortVal(a, key);
      const bv = sortVal(b, key);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return list;
  }, [rows, prefs.sortKey, prefs.sortDir]);

  const failedOnPage = useMemo(() => sorted.filter((j) => j.state === "failed"), [sorted]);
  const isAdmin = role === "ADMIN";
  const targetsFromSelection = useCallback((): { queueName: string; jobId: string }[] => {
    return [...selectedFailed].map((k) => {
      const i = k.indexOf("\0");
      return { queueName: k.slice(0, i), jobId: k.slice(i + 1) };
    });
  }, [selectedFailed]);

  useEffect(() => {
    setSelectedFailed((prev) => {
      const allowed = new Set(failedOnPage.map(rowKey));
      let changed = false;
      const next = new Set<string>();
      for (const k of prev) {
        if (allowed.has(k)) next.add(k);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [failedOnPage]);

  const runFilterPreview = useCallback(async () => {
    setBulkError(null);
    setBulkMessage(null);
    setFilterPreview(null);
    setFilterPreviewLoading(true);
    try {
      const res = await fetch(`/api/v1/admin/bulk-dlq-targets?${queryString}`, {
        credentials: "include",
      });
      const body = (await res.json().catch(() => ({}))) as {
        cap?: number;
        hasMore?: boolean;
        matchingCount?: number;
        targets?: { queueName: string; jobId: string }[];
        error?: string;
      };
      if (res.status === 401) {
        setBulkError("Session expired. Sign in again.");
        return;
      }
      if (res.status === 403) {
        setBulkError("Only admins can preview bulk targets.");
        return;
      }
      if (!res.ok) {
        setBulkError(body.error ?? `Preview failed (${res.status}).`);
        return;
      }
      setFilterPreview({
        cap: body.cap ?? BULK_DLQ_MAX,
        hasMore: Boolean(body.hasMore),
        matchingCount: body.matchingCount ?? 0,
        targets: body.targets ?? [],
      });
    } catch {
      setBulkError("Network error.");
    } finally {
      setFilterPreviewLoading(false);
    }
  }, [queryString]);

  const runBulkDlq = async (action: "retry" | "remove", targets: { queueName: string; jobId: string }[]) => {
    if (targets.length === 0) return;
    setBulkError(null);
    setBulkMessage(null);
    const capNote =
      targets.length >= BULK_DLQ_MAX ? ` (capped at ${BULK_DLQ_MAX} per operation)` : "";
    const msg =
      action === "retry"
        ? `Retry ${targets.length} failed job(s) in place?${capNote} This enqueues a background bulk operation.`
        : `Remove ${targets.length} failed job(s) from the queue?${capNote} This cannot be undone.`;
    if (!window.confirm(msg)) return;
    setBulkBusy(true);
    try {
      const res = await fetch("/api/v1/admin/bulk-dlq", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, targets }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        jobId?: string;
        queueName?: string;
        issues?: unknown;
      };
      if (res.status === 401) {
        setBulkError("Session expired. Sign in again.");
        return;
      }
      if (res.status === 403) {
        setBulkError("Only admins can run bulk DLQ actions.");
        return;
      }
      if (!res.ok) {
        if (body.error === "validation_failed" && body.issues) {
          setBulkError(`Validation failed: ${JSON.stringify(body.issues)}`);
        } else {
          setBulkError(body.error ?? `Request failed (${res.status}).`);
        }
        return;
      }
      setBulkMessage(
        `Bulk ${action} enqueued (system job ${body.jobId} on ${body.queueName}). Audit and job list will update when processing finishes.`,
      );
      setSelectedFailed(new Set());
      setFilterPreview(null);
      void runFetch();
    } catch {
      setBulkError("Network error.");
    } finally {
      setBulkBusy(false);
    }
  };

  const cellPad = prefs.density === "compact" ? "0.3rem 0.45rem" : "0.45rem 0.55rem";
  const fontSize = prefs.density === "compact" ? "0.8rem" : "0.88rem";

  return (
    <div>
      <p style={{ marginTop: 0, color: "#333", lineHeight: 1.4 }}>
        Filter jobs stored in BullMQ. Preferences (filters, sort, density) persist in this browser.
      </p>
      <form
        onSubmit={onSubmit}
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(10rem, 1fr))",
          gap: "0.6rem",
          marginBottom: "1rem",
          alignItems: "end",
        }}
      >
        <label style={labelStyle}>
          Queue
          <input
            value={prefs.queue}
            onChange={(e) => setPrefs((x) => ({ ...x, queue: e.target.value }))}
            style={inputStyle}
            title="BullMQ queue name"
          />
        </label>
        <label style={labelStyle}>
          State
          <input
            value={prefs.state}
            onChange={(e) => setPrefs((x) => ({ ...x, state: e.target.value }))}
            style={inputStyle}
            placeholder="e.g. completed,failed"
            title="Comma-separated BullMQ list states"
          />
        </label>
        <label style={labelStyle}>
          Job name
          <input
            value={prefs.jobName}
            onChange={(e) => setPrefs((x) => ({ ...x, jobName: e.target.value }))}
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          Job id
          <input
            value={prefs.jobId}
            onChange={(e) => setPrefs((x) => ({ ...x, jobId: e.target.value }))}
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          Scheduler id
          <input
            value={prefs.schedulerId}
            onChange={(e) => setPrefs((x) => ({ ...x, schedulerId: e.target.value }))}
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          From (ms)
          <input
            value={prefs.from}
            onChange={(e) => setPrefs((x) => ({ ...x, from: e.target.value }))}
            style={inputStyle}
            inputMode="numeric"
          />
        </label>
        <label style={labelStyle}>
          To (ms)
          <input
            value={prefs.to}
            onChange={(e) => setPrefs((x) => ({ ...x, to: e.target.value }))}
            style={inputStyle}
            inputMode="numeric"
          />
        </label>
        <label style={labelStyle}>
          Min att.
          <input
            value={prefs.minAttempts}
            onChange={(e) => setPrefs((x) => ({ ...x, minAttempts: e.target.value }))}
            style={inputStyle}
            inputMode="numeric"
          />
        </label>
        <label style={labelStyle}>
          Max att.
          <input
            value={prefs.maxAttempts}
            onChange={(e) => setPrefs((x) => ({ ...x, maxAttempts: e.target.value }))}
            style={inputStyle}
            inputMode="numeric"
          />
        </label>
        <label style={labelStyle}>
          Limit
          <input
            value={prefs.limit}
            onChange={(e) => setPrefs((x) => ({ ...x, limit: e.target.value }))}
            style={inputStyle}
            inputMode="numeric"
          />
        </label>
        <label style={labelStyle}>
          Sort
          <select
            value={`${prefs.sortKey}:${prefs.sortDir}`}
            onChange={(e) => {
              const [k, d] = e.target.value.split(":") as [JobsTablePrefs["sortKey"], "asc" | "desc"];
              setPrefs((x) => ({ ...x, sortKey: k, sortDir: d }));
            }}
            style={inputStyle}
          >
            <option value="created:desc">Created ↓</option>
            <option value="created:asc">Created ↑</option>
            <option value="state:asc">State A→Z</option>
            <option value="state:desc">State Z→A</option>
            <option value="queue:asc">Queue A→Z</option>
            <option value="queue:desc">Queue Z→A</option>
            <option value="jobName:asc">Job A→Z</option>
            <option value="jobName:desc">Job Z→A</option>
            <option value="attempts:desc">Attempts ↓</option>
            <option value="attempts:asc">Attempts ↑</option>
            <option value="priority:asc">Priority ↑</option>
            <option value="priority:desc">Priority ↓</option>
          </select>
        </label>
        <label style={labelStyle}>
          Density
          <select
            value={prefs.density}
            onChange={(e) =>
              setPrefs((x) => ({ ...x, density: e.target.value as JobsTablePrefs["density"] }))
            }
            style={inputStyle}
          >
            <option value="normal">Normal</option>
            <option value="compact">Compact</option>
          </select>
        </label>
        <button type="submit" style={{ ...inputStyle, background: "#111", color: "#fff", borderColor: "#111" }}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </form>
      {isAdmin ? (
        <div
          style={{
            marginBottom: "0.75rem",
            padding: "0.5rem 0.65rem",
            background: "#f4f4ff",
            border: "1px solid #c8c8e6",
            borderRadius: 4,
            fontSize: "0.85rem",
          }}
        >
          <span style={{ fontWeight: 600 }}>Filter-based bulk (failed only) </span>
          <span style={{ color: "#444" }}>
            Respects the fields above; only failed jobs are included, newest first, up to {BULK_DLQ_MAX} per run. The State field does not change which failed jobs are chosen.
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center", marginTop: "0.45rem" }}>
            <button
              type="button"
              disabled={filterPreviewLoading || bulkBusy}
              style={inputStyle}
              onClick={() => void runFilterPreview()}
            >
              {filterPreviewLoading ? "…" : "Preview targets"}
            </button>
            {filterPreview ? (
              <>
                <span>
                  {filterPreview.matchingCount === 0
                    ? "No failed jobs match these filters."
                    : filterPreview.hasMore
                      ? `${filterPreview.matchingCount} failed job(s) match; ${filterPreview.targets.length} will be enqueued (cap ${filterPreview.cap}, newest first; more than ${filterPreview.cap} match).`
                      : `${filterPreview.matchingCount} failed job(s) match; up to ${filterPreview.targets.length} will be enqueued.`}
                </span>
                <button
                  type="button"
                  disabled={bulkBusy || filterPreview.targets.length === 0}
                  style={{ ...inputStyle, background: "#1a4d1a", color: "#fff", borderColor: "#1a4d1a" }}
                  onClick={() => void runBulkDlq("retry", filterPreview.targets)}
                >
                  {bulkBusy ? "…" : "Bulk retry (from filters)"}
                </button>
                <button
                  type="button"
                  disabled={bulkBusy || filterPreview.targets.length === 0}
                  style={{ ...inputStyle, background: "#7a1f1f", color: "#fff", borderColor: "#7a1f1f" }}
                  onClick={() => void runBulkDlq("remove", filterPreview.targets)}
                >
                  {bulkBusy ? "…" : "Bulk remove (from filters)"}
                </button>
                <button type="button" style={inputStyle} onClick={() => setFilterPreview(null)}>
                  Dismiss preview
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      {isAdmin && failedOnPage.length > 0 ? (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.5rem",
            alignItems: "center",
            marginBottom: "0.75rem",
            padding: "0.5rem 0.65rem",
            background: "#f8f8f8",
            border: "1px solid #ddd",
            borderRadius: 4,
            fontSize: "0.85rem",
          }}
        >
          <span style={{ fontWeight: 600 }}>
            Bulk DLQ ({selectedFailed.size} selected
            {selectedFailed.size >= BULK_DLQ_MAX ? `, max ${BULK_DLQ_MAX}` : ""})
          </span>
          <button
            type="button"
            disabled={bulkBusy}
            style={inputStyle}
            onClick={() => {
              const next = new Set(
                failedOnPage.slice(0, BULK_DLQ_MAX).map(rowKey),
              );
              setSelectedFailed(next);
            }}
          >
            Select failed on page (max {Math.min(BULK_DLQ_MAX, failedOnPage.length)})
          </button>
          <button
            type="button"
            disabled={bulkBusy}
            style={inputStyle}
            onClick={() => setSelectedFailed(new Set())}
          >
            Clear selection
          </button>
          <button
            type="button"
            disabled={bulkBusy || selectedFailed.size === 0 || selectedFailed.size > BULK_DLQ_MAX}
            style={{ ...inputStyle, background: "#1a4d1a", color: "#fff", borderColor: "#1a4d1a" }}
            onClick={() => void runBulkDlq("retry", targetsFromSelection())}
          >
            {bulkBusy ? "…" : "Bulk retry in place"}
          </button>
          <button
            type="button"
            disabled={bulkBusy || selectedFailed.size === 0 || selectedFailed.size > BULK_DLQ_MAX}
            style={{ ...inputStyle, background: "#7a1f1f", color: "#fff", borderColor: "#7a1f1f" }}
            onClick={() => void runBulkDlq("remove", targetsFromSelection())}
          >
            {bulkBusy ? "…" : "Bulk remove"}
          </button>
          {failedOnPage.length > BULK_DLQ_MAX ? (
            <span style={{ color: "#664d00" }}>
              More than {BULK_DLQ_MAX} failed jobs match this page; select in batches.
            </span>
          ) : null}
        </div>
      ) : null}
      {bulkError ? (
        <p role="alert" style={{ color: "#b42318", marginTop: 0 }}>
          {bulkError}
        </p>
      ) : null}
      {bulkMessage ? (
        <p style={{ color: "#1e5a1e", marginTop: 0 }}>
          {bulkMessage}
        </p>
      ) : null}
      {error ? (
        <p role="alert" style={{ color: "#b42318" }}>
          {error}
        </p>
      ) : null}
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize,
            border: "1px solid #ddd",
          }}
        >
          <thead>
            <tr style={{ background: "#f4f4f4", textAlign: "left" }}>
              {isAdmin ? (
                <th style={{ padding: cellPad, width: "2.25rem" }} title="Select failed jobs for bulk actions">
                  Bulk
                </th>
              ) : null}
              <th style={{ padding: cellPad }}>Queue</th>
              <th style={{ padding: cellPad }}>Job id</th>
              <th style={{ padding: cellPad }}>Job</th>
              <th style={{ padding: cellPad }}>State</th>
              <th style={{ padding: cellPad }}>Scheduler</th>
              <th style={{ padding: cellPad }}>Created</th>
              <th style={{ padding: cellPad }}>Attempts</th>
              <th style={{ padding: cellPad }}>Priority</th>
              <th style={{ padding: cellPad }}>Detail</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((j) => (
              <tr key={rowKey(j)} style={{ borderTop: "1px solid #e8e8e8" }}>
                {isAdmin ? (
                  <td style={{ padding: cellPad, textAlign: "center" }}>
                    {j.state === "failed" ? (
                      <input
                        type="checkbox"
                        checked={selectedFailed.has(rowKey(j))}
                        disabled={bulkBusy}
                        onChange={() => {
                          const k = rowKey(j);
                          setSelectedFailed((prev) => {
                            const n = new Set(prev);
                            if (n.has(k)) n.delete(k);
                            else {
                              if (n.size >= BULK_DLQ_MAX) {
                                window.alert(
                                  `You can select at most ${BULK_DLQ_MAX} jobs per bulk operation.`,
                                );
                                return prev;
                              }
                              n.add(k);
                            }
                            return n;
                          });
                        }}
                        aria-label={`Select failed job ${j.jobId} for bulk action`}
                      />
                    ) : (
                      <span style={{ color: "#ccc" }}>—</span>
                    )}
                  </td>
                ) : null}
                <td style={{ padding: cellPad, fontFamily: "ui-monospace, monospace" }}>{j.queueName}</td>
                <td style={{ padding: cellPad, fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }}>
                  {j.jobId}
                </td>
                <td style={{ padding: cellPad }}>{j.jobName ?? "—"}</td>
                <td style={{ padding: cellPad }}>{j.state}</td>
                <td
                  style={{ padding: cellPad, maxWidth: "8rem", wordBreak: "break-all", fontSize: "0.85em" }}
                  title={j.schedulerId}
                >
                  {j.schedulerId ?? "—"}
                </td>
                <td style={{ padding: cellPad }}>{j.created != null ? formatTs(j.created) : "—"}</td>
                <td style={{ padding: cellPad }}>
                  {j.attemptsMade}
                  {j.maxAttempts != null ? ` / ${j.maxAttempts}` : ""}
                </td>
                <td style={{ padding: cellPad }}>{j.priority}</td>
                <td style={{ padding: cellPad }}>
                  <Link
                    to={`/jobs/${encodeURIComponent(j.queueName)}/${encodeURIComponent(j.jobId)}`}
                    style={{ color: "#0b57d0" }}
                  >
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && sorted.length === 0 ? (
          <p style={{ color: "#666", marginTop: "0.75rem" }}>No jobs match the current filters.</p>
        ) : null}
      </div>
    </div>
  );
}

function formatTs(ms: number): string {
  try {
    return new Date(ms).toISOString();
  } catch {
    return String(ms);
  }
}

function sortVal(
  j: JobListItem,
  key: JobsTablePrefs["sortKey"],
): string | number {
  switch (key) {
    case "created":
      return j.created ?? 0;
    case "state":
      return j.state;
    case "queue":
      return j.queueName;
    case "jobName":
      return j.jobName ?? "";
    case "attempts":
      return j.attemptsMade;
    case "priority":
      return j.priority;
    default:
      return 0;
  }
}
