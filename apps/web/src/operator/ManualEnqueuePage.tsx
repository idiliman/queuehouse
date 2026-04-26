import {
  type CSSProperties,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Link } from "react-router-dom";

type RegJob = { name: string; description: string; manualUi: boolean };

type EnqueueOk = {
  jobId: string;
  queueName: string;
  requestId: string;
  result?: unknown;
};

export function ManualEnqueuePage() {
  const [registry, setRegistry] = useState<RegJob[] | null>(null);
  const [jobName, setJobName] = useState("");
  const [payloadJson, setPayloadJson] = useState('{\n  "message": "hello"\n}');
  const [delay, setDelay] = useState("");
  const [runAt, setRunAt] = useState("");
  const [dedupeKey, setDedupeKey] = useState("");
  const [priority, setPriority] = useState("");
  const [waitTimeoutMs, setWaitTimeoutMs] = useState("");
  const [retryJson, setRetryJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastOk, setLastOk] = useState<EnqueueOk | null>(null);

  const manualJobs = useMemo(
    () => (registry ?? []).filter((j) => j.manualUi),
    [registry],
  );

  const refresh = useCallback(async () => {
    setError(null);
    const mRes = await fetch("/api/v1/meta/registered-jobs", { credentials: "include" });
    if (mRes.status === 401) {
      setRegistry([]);
      return;
    }
    if (!mRes.ok) {
      setError(`Failed to load job registry (${mRes.status}).`);
      return;
    }
    const mBody = (await mRes.json()) as { jobs: RegJob[] };
    setRegistry(mBody.jobs);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!jobName && manualJobs.length > 0) {
      setJobName(manualJobs[0]!.name);
    }
  }, [jobName, manualJobs]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setParseErr(null);
    setLastOk(null);
    let payload: unknown;
    try {
      payload = JSON.parse(payloadJson) as unknown;
    } catch {
      setParseErr("Payload must be valid JSON.");
      return;
    }
    let retry: { maxAttempts?: number; backoffMs?: number } | undefined;
    if (retryJson.trim() !== "") {
      try {
        retry = JSON.parse(retryJson) as { maxAttempts?: number; backoffMs?: number };
      } catch {
        setParseErr("Retry overrides must be valid JSON object.");
        return;
      }
    }
    const body: Record<string, unknown> = {
      jobName,
      payload,
    };
    if (delay.trim() !== "") {
      const n = parseInt(delay, 10);
      if (Number.isNaN(n) || n < 0) {
        setParseErr("Delay must be a non-negative integer (ms).");
        return;
      }
      body.delay = n;
    }
    if (runAt.trim() !== "") {
      body.runAt = runAt.trim();
    }
    if (dedupeKey.trim() !== "") body.dedupeKey = dedupeKey.trim();
    if (priority.trim() !== "") {
      const n = parseInt(priority, 10);
      if (Number.isNaN(n)) {
        setParseErr("Priority must be an integer.");
        return;
      }
      body.priority = n;
    }
    if (waitTimeoutMs.trim() !== "") {
      const n = parseInt(waitTimeoutMs, 10);
      if (Number.isNaN(n) || n < 0) {
        setParseErr("Wait timeout must be a non-negative integer (ms).");
        return;
      }
      body.waitTimeoutMs = n;
    }
    if (retry) body.retry = retry;

    setBusy(true);
    try {
      const res = await fetch("/api/v1/manual-enqueue", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const b = (await res.json().catch(() => ({}))) as {
        error?: string;
        issues?: unknown;
        jobId?: string;
        queueName?: string;
        requestId?: string;
        result?: unknown;
      };
      if (!res.ok) {
        if (b.error === "validation_failed" && b.issues) {
          setError(`Validation: ${JSON.stringify(b.issues)}`);
        } else if (b.error) {
          setError(`${b.error} (${res.status})`);
        } else {
          setError(`Enqueue failed (${res.status}).`);
        }
        return;
      }
      setLastOk({
        jobId: b.jobId!,
        queueName: b.queueName!,
        requestId: b.requestId!,
        result: b.result,
      });
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  };

  if (registry === null) {
    return <p style={{ color: "#444" }}>Loading jobs…</p>;
  }

  return (
    <div>
      <p style={{ marginBottom: "1rem", lineHeight: 1.5 }}>
        <Link to="/jobs" style={linkStyle}>
          ← Jobs
        </Link>
      </p>
      <h2 style={{ fontSize: "1.35rem", fontWeight: 600, margin: "0 0 0.75rem" }}>Manual enqueue</h2>
      <p style={{ color: "#444", fontSize: "0.95rem", lineHeight: 1.5, marginBottom: "1rem" }}>
        Enqueue jobs enabled for the operator UI. Options map to the admin manual-enqueue API (
        delay, scheduled run time, dedupe id, priority, retry overrides, optional wait-for-result).
      </p>

      {manualJobs.length === 0 ? (
        <p style={{ color: "#b42318" }}>No manual UI jobs are registered.</p>
      ) : (
        <form onSubmit={(e) => void onSubmit(e)} style={{ display: "grid", gap: "0.85rem", maxWidth: "36rem" }}>
          <label style={labelStyle}>
            Job
            <select
              value={jobName}
              onChange={(e) => setJobName(e.target.value)}
              required
              style={inputStyle}
            >
              {manualJobs.map((j) => (
                <option key={j.name} value={j.name}>
                  {j.name}
                  {j.description ? ` — ${j.description}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Payload (JSON)
            <textarea
              value={payloadJson}
              onChange={(e) => setPayloadJson(e.target.value)}
              rows={8}
              required
              spellCheck={false}
              style={{ ...inputStyle, fontFamily: "ui-monospace, monospace", fontSize: "0.9rem" }}
            />
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <label style={labelStyle}>
              Delay (ms)
              <input
                value={delay}
                onChange={(e) => setDelay(e.target.value)}
                placeholder="optional"
                style={inputStyle}
              />
            </label>
            <label style={labelStyle}>
              Run at (ISO 8601)
              <input
                value={runAt}
                onChange={(e) => setRunAt(e.target.value)}
                placeholder="optional, exclusive with delay"
                style={inputStyle}
              />
            </label>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <label style={labelStyle}>
              Dedupe key
              <input
                value={dedupeKey}
                onChange={(e) => setDedupeKey(e.target.value)}
                placeholder="BullMQ job id"
                style={inputStyle}
              />
            </label>
            <label style={labelStyle}>
              Priority (0 = highest)
              <input
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                placeholder="optional"
                style={inputStyle}
              />
            </label>
          </div>
          <label style={labelStyle}>
            Wait timeout (ms)
            <input
              value={waitTimeoutMs}
              onChange={(e) => setWaitTimeoutMs(e.target.value)}
              placeholder="0 = fire-and-forget; blocks until job completes or timeout"
              style={inputStyle}
            />
          </label>
          <label style={labelStyle}>
            Retry overrides (JSON object, optional)
            <input
              value={retryJson}
              onChange={(e) => setRetryJson(e.target.value)}
              placeholder='e.g. {"maxAttempts":3,"backoffMs":500}'
              style={inputStyle}
            />
          </label>
          {parseErr ? (
            <p role="alert" style={{ color: "#b42318", margin: 0, fontSize: "0.9rem" }}>
              {parseErr}
            </p>
          ) : null}
          {error ? (
            <p role="alert" style={{ color: "#b42318", margin: 0, fontSize: "0.9rem" }}>
              {error}
            </p>
          ) : null}
          <button type="submit" disabled={busy} style={buttonStyle}>
            {busy ? "Enqueueing…" : "Enqueue"}
          </button>
        </form>
      )}

      {lastOk ? (
        <section style={{ marginTop: "1.5rem", padding: "1rem", background: "#f5f5f5", borderRadius: 8 }}>
          <h3 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Last result</h3>
          <p style={{ margin: 0, fontSize: "0.9rem" }}>
            <strong>Job id:</strong> {lastOk.jobId} · <strong>Queue:</strong> {lastOk.queueName}
          </p>
          {lastOk.result !== undefined ? (
            <pre
              style={{
                marginTop: "0.5rem",
                fontSize: "0.85rem",
                overflow: "auto",
                maxHeight: "12rem",
              }}
            >
              {JSON.stringify(lastOk.result, null, 2)}
            </pre>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

const linkStyle: CSSProperties = { color: "#0b57d0", textDecoration: "none" };

const labelStyle: CSSProperties = {
  display: "grid",
  gap: "0.35rem",
  fontSize: "0.9rem",
  fontWeight: 500,
};

const inputStyle: CSSProperties = {
  padding: "0.5rem 0.65rem",
  fontSize: "1rem",
  borderRadius: 6,
  border: "1px solid #ccc",
};

const buttonStyle: CSSProperties = {
  marginTop: "0.25rem",
  padding: "0.55rem 1rem",
  fontSize: "1rem",
  borderRadius: 6,
  border: "1px solid #222",
  background: "#111",
  color: "#fff",
  cursor: "pointer",
};
