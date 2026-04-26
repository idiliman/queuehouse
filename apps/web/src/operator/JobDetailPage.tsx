import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

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
    retriedAsNewFrom?: { queueName: string; jobId: string };
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
  const navigate = useNavigate();
  const [detail, setDetail] = useState<JobDetail | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [retryAsNewText, setRetryAsNewText] = useState("");
  const [rawRevealed, setRawRevealed] = useState<{ payload: unknown; result: unknown } | null>(null);
  const [revealOpen, setRevealOpen] = useState(false);
  const [revealReason, setRevealReason] = useState("");
  const [revealBusy, setRevealBusy] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!queueName || !jobId) return;
    const res = await fetch(
      `/api/v1/jobs/${encodeURIComponent(queueName)}/${encodeURIComponent(jobId)}`,
      { credentials: "include" },
    );
    if (res.status === 200) {
      setRawRevealed(null);
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

  useEffect(() => {
    setRawRevealed(null);
    setRevealOpen(false);
    setRevealReason("");
    setRevealError(null);
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

  const retriedFrom = detail.metadata.retriedAsNewFrom;
  const isAdmin = user?.role === "ADMIN";
  const canDlq = isAdmin && detail.state === "failed";
  const displayPayload = rawRevealed ? rawRevealed.payload : detail.payload;
  const displayResult = rawRevealed ? rawRevealed.result : detail.result;

  const runRevealRaw = async () => {
    if (!queueName || !jobId) return;
    const reason = revealReason.trim();
    if (reason.length === 0) {
      setRevealError("A reason is required (audit log).");
      return;
    }
    setRevealError(null);
    setRevealBusy(true);
    try {
      const res = await fetch(
        `/api/v1/jobs/${encodeURIComponent(queueName)}/${encodeURIComponent(jobId)}/raw-reveal`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        },
      );
      if (res.status === 403) {
        setRevealError("Only admins can load raw data (not available with API keys).");
        return;
      }
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setRevealError(b.error ?? `Request failed (${res.status}).`);
        return;
      }
      const b = (await res.json()) as { payload: unknown; result: unknown };
      setRawRevealed({ payload: b.payload, result: b.result });
      setRevealOpen(false);
      setRevealReason("");
    } catch {
      setRevealError("Network error.");
    } finally {
      setRevealBusy(false);
    }
  };

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

  const runRetryAsNew = async () => {
    if (!queueName || !jobId) return;
    setActionError(null);
    setActionBusy(true);
    let body: unknown = {};
    const trimmed = retryAsNewText.trim();
    if (trimmed.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        setActionError("Invalid JSON. Fix the payload or clear the field to reuse the stored job payload.");
        setActionBusy(false);
        return;
      }
      body = { payload: parsed };
    }
    try {
      const res = await fetch(
        `/api/v1/jobs/${encodeURIComponent(queueName)}/${encodeURIComponent(jobId)}/retry-as-new`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (res.status === 403) {
        setActionError("Only admins can retry as new.");
        return;
      }
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(b.error ?? `Request failed (${res.status}).`);
        return;
      }
      const out = (await res.json()) as { jobId: string; queueName: string };
      navigate(
        `/jobs/${encodeURIComponent(out.queueName)}/${encodeURIComponent(out.jobId)}`,
        { replace: true },
      );
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
        <div style={{ marginTop: "0.75rem" }}>
          <p style={{ fontSize: "0.88rem", color: "#333", lineHeight: 1.5, maxWidth: "40rem" }}>
            <strong>Retry in place</strong> re-runs the same BullMQ job with the same id (when the failure was
            retryable). <strong>Retry as new</strong> enqueues a <em>separate</em> job; use it after correcting
            the input. Leave the JSON field empty to reuse the full stored payload (including fields that may
            be redacted here).
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "0.5rem" }}>
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
          <label
            style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginTop: "0.9rem" }}
            htmlFor="retry-as-new-json"
          >
            Optional new payload (JSON, job input object)
          </label>
          <textarea
            id="retry-as-new-json"
            value={retryAsNewText}
            onChange={(e) => setRetryAsNewText(e.target.value)}
            rows={5}
            disabled={actionBusy}
            style={{
              ...preStyle,
              width: "100%",
              maxWidth: "36rem",
              fontFamily: "ui-monospace, monospace",
              marginTop: "0.35rem",
            }}
            placeholder='e.g. { "message": "fixed" }  —  leave empty to reuse stored payload'
          />
          <div style={{ marginTop: "0.45rem" }}>
            <button
              type="button"
              onClick={() => void runRetryAsNew()}
              disabled={actionBusy}
              style={buttonSm}
            >
              Retry as new
            </button>
          </div>
        </div>
      ) : null}
      {retriedFrom ? (
        <p style={{ fontSize: "0.88rem", color: "#333", lineHeight: 1.5, marginTop: "0.9rem" }}>
          <strong>Retried as new from</strong> job{" "}
          <Link
            to={`/jobs/${encodeURIComponent(retriedFrom.queueName)}/${encodeURIComponent(retriedFrom.jobId)}`}
            style={{ color: "#0b57d0" }}
          >
            {retriedFrom.queueName}/{retriedFrom.jobId}
          </Link>
        </p>
      ) : null}
      {actionError ? (
        <p role="alert" style={{ color: "#b42318", fontSize: "0.9rem", marginTop: "0.5rem" }}>
          {actionError}
        </p>
      ) : null}
      {isAdmin ? (
        <div style={{ marginTop: "1rem", maxWidth: "40rem" }}>
          {rawRevealed ? (
            <p style={{ fontSize: "0.86rem", color: "#4a2c0a", lineHeight: 1.5, marginBottom: "0.5rem" }}>
              Showing <strong>raw</strong> payload/result (request audited).{" "}
              <button
                type="button"
                onClick={() => {
                  setRawRevealed(null);
                }}
                style={{ ...buttonSm, marginLeft: "0.35rem" }}
              >
                Back to redacted
              </button>
            </p>
          ) : (
            <>
              <p style={{ fontSize: "0.86rem", color: "#333", lineHeight: 1.5 }}>
                Raw job data is redacted. To load unredacted JSON for this job, provide a reason (stored in
                the audit log).
              </p>
              {!revealOpen ? (
                <button
                  type="button"
                  onClick={() => {
                    setRevealOpen(true);
                    setRevealError(null);
                  }}
                  style={{ ...buttonSm, marginTop: "0.35rem" }}
                >
                  Load raw payload &amp; result…
                </button>
              ) : (
                <div style={{ marginTop: "0.5rem" }}>
                  <label htmlFor="raw-reveal-reason" style={{ fontSize: "0.85rem", fontWeight: 600 }}>
                    Reason
                  </label>
                  <textarea
                    id="raw-reveal-reason"
                    value={revealReason}
                    onChange={(e) => setRevealReason(e.target.value)}
                    rows={2}
                    disabled={revealBusy}
                    style={{
                      ...preStyle,
                      width: "100%",
                      maxWidth: "36rem",
                      display: "block",
                      marginTop: "0.3rem",
                    }}
                    placeholder="e.g. ticket / incident id"
                  />
                  <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.4rem" }}>
                    <button
                      type="button"
                      onClick={() => void runRevealRaw()}
                      disabled={revealBusy}
                      style={buttonSm}
                    >
                      Confirm and load
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRevealOpen(false);
                        setRevealError(null);
                      }}
                      disabled={revealBusy}
                      style={buttonSm}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {revealError ? (
                <p role="alert" style={{ color: "#b42318", fontSize: "0.88rem", marginTop: "0.4rem" }}>
                  {revealError}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      <h3 style={{ fontSize: "0.95rem" }}>Metadata</h3>
      <pre style={preStyle}>{JSON.stringify(detail.metadata, null, 2)}</pre>
      {detail.requestId || detail.metadata.requestId ? (
        <p style={{ fontSize: "0.88rem", color: "#555" }}>
          Request: {detail.requestId ?? detail.metadata.requestId}
        </p>
      ) : null}
      <h3 style={{ fontSize: "0.95rem" }}>
        Payload ({rawRevealed ? "raw" : "redacted"}
        {rawRevealed ? ", audited" : ""})
      </h3>
      <pre style={preStyle}>{JSON.stringify(displayPayload, null, 2)}</pre>
      <h3 style={{ fontSize: "0.95rem" }}>
        Result ({rawRevealed ? "raw" : "redacted"}
        {rawRevealed ? ", audited" : ""})
      </h3>
      <pre style={preStyle}>{JSON.stringify(displayResult, null, 2)}</pre>
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
