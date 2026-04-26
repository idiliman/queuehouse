import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

type JobDetail = {
  jobId: string;
  queueName: string;
  state: string;
  jobName?: string;
  payload: unknown;
  result: unknown;
  failedReason?: string;
  stacktrace?: string[];
  progress: unknown;
  logs: string[];
  metadata: {
    requestId?: string;
    enqueuedBy?: { userId: string; role: string };
    priority: number;
    delay: number;
    attemptsMade: number;
    maxAttempts?: number;
    repeatJobKey?: string;
    deduplicationId?: string;
  };
  timestamps: { created?: number; processed?: number; finished?: number };
  requestId?: string;
  resolvedRetry?: { maxAttempts: number; backoffMs?: number };
};

const preStyle: CSSProperties = {
  margin: 0,
  padding: "0.75rem",
  background: "#f6f6f6",
  borderRadius: 6,
  fontSize: "0.82rem",
  overflow: "auto",
  maxHeight: "18rem",
  border: "1px solid #e0e0e0",
};

type SessionUser = { id: string; email: string; role: "VIEWER" | "ADMIN" };

export function JobDetailPage() {
  const { queueName, jobId } = useParams<{ queueName: string; jobId: string }>();
  const [detail, setDetail] = useState<JobDetail | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const refetch = useCallback(async () => {
    if (!queueName || !jobId) return;
    const res = await fetch(
      `/api/v1/jobs/${encodeURIComponent(queueName)}/${encodeURIComponent(jobId)}`,
      { credentials: "include" },
    );
    if (res.status === 200) {
      setDetail((await res.json()) as JobDetail);
    }
  }, [queueName, jobId]);

  useEffect(() => {
    let cancel = false;
    (async () => {
      const s = await fetch("/api/v1/auth/session", { credentials: "include" });
      if (cancel) return;
      if (s.status === 200) {
        const b = (await s.json()) as { user: SessionUser };
        setUser(b.user);
      } else {
        setUser(null);
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  useEffect(() => {
    if (!queueName || !jobId) {
      setError(null);
      setDetail(null);
      return;
    }
    let cancel = false;
    setError(null);
    setDetail(undefined);
    (async () => {
      const res = await fetch(
        `/api/v1/jobs/${encodeURIComponent(queueName)}/${encodeURIComponent(jobId)}`,
        { credentials: "include" },
      );
      if (cancel) return;
      if (res.status === 401) {
        setError("Session expired. Sign in again from the home page.");
        setDetail(null);
        return;
      }
      if (res.status === 404) {
        setError(null);
        setDetail(null);
        return;
      }
      if (!res.ok) {
        setError(`Load failed (${res.status}).`);
        setDetail(null);
        return;
      }
      setDetail((await res.json()) as JobDetail);
    })();
    return () => {
      cancel = true;
    };
  }, [queueName, jobId]);

  if (detail === undefined && !error) {
    return <p style={{ color: "#444" }}>Loading job…</p>;
  }

  if (error) {
    return (
      <div>
        <p role="alert">{error}</p>
        <p>
          <Link to="/" style={{ color: "#0b57d0" }}>
            Home
          </Link>{" "}
          ·{" "}
          <Link to="/jobs" style={{ color: "#0b57d0" }}>
            Jobs
          </Link>
        </p>
      </div>
    );
  }

  if (detail === null) {
    return (
      <div>
        <p style={{ lineHeight: 1.5 }}>
          This job is not available or is no longer retained in the queue. BullMQ may have removed it after
          retention, or the id may be wrong.
        </p>
        <p>
          <Link to="/jobs" style={{ color: "#0b57d0" }}>
            Back to jobs
          </Link>
        </p>
      </div>
    );
  }

  if (!detail) {
    return null;
  }

  const isAdmin = user?.role === "ADMIN";
  const canDlq = isAdmin && detail.state === "failed";

  const runRetry = async () => {
    if (!queueName || !jobId) return;
    setActionError(null);
    setActionBusy(true);
    try {
      const res = await fetch(
        `/api/v1/jobs/${encodeURIComponent(queueName)}/${encodeURIComponent(jobId)}/retry`,
        { method: "POST", credentials: "include" },
      );
      if (res.status === 403) {
        setActionError("Only admins can retry failed jobs.");
        return;
      }
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(b.error ?? `Request failed (${res.status}).`);
        return;
      }
      await refetch();
    } catch {
      setActionError("Network error.");
    } finally {
      setActionBusy(false);
    }
  };

  const runRemove = async () => {
    if (!queueName || !jobId) return;
    if (!window.confirm("Remove this failed job from the queue? This cannot be undone.")) {
      return;
    }
    setActionError(null);
    setActionBusy(true);
    try {
      const res = await fetch(
        `/api/v1/jobs/${encodeURIComponent(queueName)}/${encodeURIComponent(jobId)}`,
        { method: "DELETE", credentials: "include" },
      );
      if (res.status === 403) {
        setActionError("Only admins can remove failed jobs.");
        return;
      }
      if (res.status === 404) {
        setDetail(null);
        return;
      }
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(b.error ?? `Request failed (${res.status}).`);
        return;
      }
      setDetail(null);
    } catch {
      setActionError("Network error.");
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <div>
      <p>
        <Link to="/jobs" style={{ color: "#0b57d0" }}>
          ← Jobs
        </Link>{" "}
        ·{" "}
        <Link to="/jobs?state=failed" style={{ color: "#0b57d0" }}>
          DLQ
        </Link>
      </p>
      <h2 style={{ fontSize: "1.2rem", marginBottom: "0.5rem" }}>Job {detail.jobId}</h2>
      <p style={{ color: "#333", lineHeight: 1.4 }}>
        <strong>Queue</strong> {detail.queueName} · <strong>State</strong> {detail.state}
        {detail.jobName ? (
          <>
            {" "}
            · <strong>Type</strong> {detail.jobName}
          </>
        ) : null}
      </p>
      <h3 style={{ fontSize: "0.95rem", marginTop: "1.25rem" }}>Timestamps</h3>
      <ul style={{ lineHeight: 1.5, color: "#333" }}>
        <li>Created: {ts(detail.timestamps.created)}</li>
        <li>Processed: {ts(detail.timestamps.processed)}</li>
        <li>Finished: {ts(detail.timestamps.finished)}</li>
      </ul>
      {detail.resolvedRetry ? (
        <p style={{ fontSize: "0.88rem", color: "#444", lineHeight: 1.5 }}>
          <strong>Retry policy (registry)</strong> max {detail.resolvedRetry.maxAttempts} attempt
          {detail.resolvedRetry.maxAttempts === 1 ? "" : "s"}
          {detail.resolvedRetry.backoffMs != null
            ? ` · backoff ${detail.resolvedRetry.backoffMs}ms`
            : ""}
        </p>
      ) : null}
      {canDlq ? (
        <div style={{ marginTop: "0.75rem", display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
          <button
            type="button"
            onClick={() => void runRetry()}
            disabled={actionBusy}
            style={buttonSm}
          >
            Retry in place
          </button>
          <button
            type="button"
            onClick={() => void runRemove()}
            disabled={actionBusy}
            style={buttonSmDanger}
          >
            Remove from queue
          </button>
        </div>
      ) : null}
      {actionError ? (
        <p role="alert" style={{ color: "#b42318", fontSize: "0.9rem", marginTop: "0.5rem" }}>
          {actionError}
        </p>
      ) : null}
      <h3 style={{ fontSize: "0.95rem" }}>Metadata</h3>
      <pre style={preStyle}>{JSON.stringify(detail.metadata, null, 2)}</pre>
      {detail.requestId || detail.metadata.requestId ? (
        <p style={{ fontSize: "0.88rem", color: "#555" }}>
          Request: {detail.requestId ?? detail.metadata.requestId}
        </p>
      ) : null}
      <h3 style={{ fontSize: "0.95rem" }}>Payload (redacted)</h3>
      <pre style={preStyle}>{JSON.stringify(detail.payload, null, 2)}</pre>
      <h3 style={{ fontSize: "0.95rem" }}>Result (redacted)</h3>
      <pre style={preStyle}>{JSON.stringify(detail.result, null, 2)}</pre>
      <h3 style={{ fontSize: "0.95rem" }}>Progress</h3>
      <pre style={preStyle}>{JSON.stringify(detail.progress, null, 2)}</pre>
      {detail.failedReason ? (
        <>
          <h3 style={{ fontSize: "0.95rem" }}>Failed reason</h3>
          <pre style={preStyle}>{detail.failedReason}</pre>
        </>
      ) : null}
      {detail.stacktrace?.length ? (
        <>
          <h3 style={{ fontSize: "0.95rem" }}>Stack trace</h3>
          <pre style={preStyle}>{detail.stacktrace.join("\n")}</pre>
        </>
      ) : null}
      {detail.logs.length > 0 ? (
        <>
          <h3 style={{ fontSize: "0.95rem" }}>Logs</h3>
          <pre style={preStyle}>{detail.logs.join("\n")}</pre>
        </>
      ) : null}
    </div>
  );
}

const buttonSm: CSSProperties = {
  padding: "0.4rem 0.75rem",
  fontSize: "0.88rem",
  borderRadius: 6,
  border: "1px solid #222",
  background: "#111",
  color: "#fff",
  cursor: "pointer",
};

const buttonSmDanger: CSSProperties = {
  ...buttonSm,
  background: "#7c2d12",
  borderColor: "#5c1d0a",
};

function ts(n?: number): string {
  if (n == null) return "—";
  try {
    return `${new Date(n).toISOString()} (${n})`;
  } catch {
    return String(n);
  }
}
