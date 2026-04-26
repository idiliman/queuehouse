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

export function JobsTablePage() {
  const [prefs, setPrefs] = useState<JobsTablePrefs>(() => loadJobsTablePrefs());
  const [rows, setRows] = useState<JobListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
              <tr key={`${j.queueName}\0${j.jobId}`} style={{ borderTop: "1px solid #e8e8e8" }}>
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
