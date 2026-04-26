import { type CSSProperties, useCallback, useEffect, useState } from "react";

type QueueRow = {
  name: string;
  paused: boolean;
  counts: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    paused: number;
  };
};

type WorkerRow = {
  instanceId: string;
  coreVersion: string;
  queues: string[];
  concurrency: number;
  hostname: string;
  pid: number;
  startedAt: string;
  heartbeatTtlSec: number;
  stale: boolean;
};

type Role = "VIEWER" | "ADMIN";

const th: CSSProperties = {
  textAlign: "left",
  fontSize: "0.75rem",
  fontWeight: 600,
  color: "#444",
  borderBottom: "1px solid #ddd",
  padding: "0.4rem 0.5rem",
  whiteSpace: "nowrap",
};

const td: CSSProperties = {
  fontSize: "0.8rem",
  borderBottom: "1px solid #eee",
  padding: "0.45rem 0.5rem",
  verticalAlign: "top",
};

const mono: CSSProperties = { fontFamily: "ui-monospace, monospace", fontSize: "0.75rem" };

export function WorkersPage(props: { role: Role }) {
  const [queues, setQueues] = useState<QueueRow[] | null>(null);
  const [workers, setWorkers] = useState<WorkerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyQueue, setBusyQueue] = useState<string | null>(null);

  const runFetch = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/v1/queues", { credentials: "include" });
      if (res.status === 401) {
        setError("Session expired. Sign in again.");
        setQueues([]);
        setWorkers([]);
        return;
      }
      if (res.status === 403) {
        setError("You do not have access to queue status.");
        setQueues([]);
        setWorkers([]);
        return;
      }
      if (!res.ok) {
        setError(`Request failed (${res.status}).`);
        setQueues([]);
        setWorkers([]);
        return;
      }
      const body = (await res.json()) as { queues: QueueRow[]; workers: WorkerRow[] };
      setQueues(body.queues);
      setWorkers(body.workers);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void runFetch();
    const t = setInterval(() => void runFetch(), 12_000);
    return () => clearInterval(t);
  }, [runFetch]);

  const pauseOrResume = async (queueName: string, action: "pause" | "resume") => {
    setBusyQueue(queueName);
    setError(null);
    try {
      const path =
        action === "pause"
          ? `/api/v1/queues/${encodeURIComponent(queueName)}/pause`
          : `/api/v1/queues/${encodeURIComponent(queueName)}/resume`;
      const res = await fetch(path, { method: "POST", credentials: "include" });
      if (res.status === 403) {
        setError("Only admins can pause or resume queues.");
        return;
      }
      if (!res.ok) {
        setError(`Could not ${action} queue (${res.status}).`);
        return;
      }
      await runFetch();
    } finally {
      setBusyQueue(null);
    }
  };

  return (
    <div>
      <h2 style={{ fontSize: "1.2rem", fontWeight: 600, margin: "0 0 0.75rem" }}>Queues & workers</h2>
      <p style={{ color: "#555", fontSize: "0.9rem", lineHeight: 1.5, marginBottom: "1rem" }}>
        Queue counts and pause state come from BullMQ. Workers publish a short-lived Redis key; TTL
        remaining is shown — low TTL or “stale” means the heartbeat is lagging or the process exited.
      </p>
      {error ? (
        <p role="alert" style={{ color: "#b42318", marginBottom: "0.75rem" }}>
          {error}
        </p>
      ) : null}
      <p style={{ fontSize: "0.85rem", color: "#666" }}>{loading ? "Refreshing…" : " "}</p>

      <h3 style={{ fontSize: "1rem", fontWeight: 600, margin: "1.25rem 0 0.5rem" }}>Queues</h3>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Queue</th>
              <th style={th}>Paused</th>
              <th style={th}>Waiting</th>
              <th style={th}>Active</th>
              <th style={th}>Delayed</th>
              <th style={th}>Failed</th>
              <th style={th}>Completed</th>
              {props.role === "ADMIN" ? <th style={th}>Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {(queues ?? []).map((q) => (
              <tr key={q.name}>
                <td style={td}>
                  <span style={mono}>{q.name}</span>
                </td>
                <td style={td}>{q.paused ? "yes" : "no"}</td>
                <td style={td}>{q.counts.waiting}</td>
                <td style={td}>{q.counts.active}</td>
                <td style={td}>{q.counts.delayed}</td>
                <td style={td}>{q.counts.failed}</td>
                <td style={td}>{q.counts.completed}</td>
                {props.role === "ADMIN" ? (
                  <td style={td}>
                    <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
                      <button
                        type="button"
                        disabled={busyQueue === q.name || q.paused}
                        onClick={() => void pauseOrResume(q.name, "pause")}
                        style={smallBtn}
                      >
                        Pause
                      </button>
                      <button
                        type="button"
                        disabled={busyQueue === q.name || !q.paused}
                        onClick={() => void pauseOrResume(q.name, "resume")}
                        style={smallBtn}
                      >
                        Resume
                      </button>
                    </div>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 style={{ fontSize: "1rem", fontWeight: 600, margin: "1.5rem 0 0.5rem" }}>Workers</h3>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Instance</th>
              <th style={th}>Host</th>
              <th style={th}>Queues</th>
              <th style={th}>Concurrency</th>
              <th style={th}>Core</th>
              <th style={th}>TTL (s)</th>
              <th style={th}>Stale</th>
            </tr>
          </thead>
          <tbody>
            {(workers ?? []).length === 0 ? (
              <tr>
                <td colSpan={7} style={{ ...td, color: "#666" }}>
                  No worker heartbeats in Redis. Start the worker process to see rows here.
                </td>
              </tr>
            ) : (
              (workers ?? []).map((w) => (
                <tr key={w.instanceId}>
                  <td style={td}>
                    <span style={mono}>{w.instanceId.slice(0, 8)}…</span>
                  </td>
                  <td style={td}>
                    {w.hostname}:{w.pid}
                  </td>
                  <td style={td}>
                    <span style={mono}>{w.queues.join(", ")}</span>
                  </td>
                  <td style={td}>{w.concurrency}</td>
                  <td style={td}>{w.coreVersion}</td>
                  <td style={td}>{w.heartbeatTtlSec}</td>
                  <td style={td}>{w.stale ? "yes" : "no"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p style={{ marginTop: "1rem" }}>
        <button type="button" onClick={() => void runFetch()} style={refreshBtn}>
          Refresh now
        </button>
      </p>
    </div>
  );
}

const smallBtn: CSSProperties = {
  padding: "0.25rem 0.5rem",
  fontSize: "0.75rem",
  borderRadius: 4,
  border: "1px solid #333",
  background: "#f8f8f8",
  cursor: "pointer",
};

const refreshBtn: CSSProperties = {
  padding: "0.4rem 0.75rem",
  fontSize: "0.85rem",
  borderRadius: 6,
  border: "1px solid #222",
  background: "#111",
  color: "#fff",
  cursor: "pointer",
};
