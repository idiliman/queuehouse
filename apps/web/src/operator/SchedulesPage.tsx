import { type CSSProperties, type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type RegJob = {
  name: string;
  description: string;
  manualUi: boolean;
  schedulable: boolean;
};

type ScheduleRow = {
  id: string;
  jobName: string;
  cronPattern: string;
  timeZone: string;
  payload: unknown;
  enabled: boolean;
  priority: number | null;
  retryOverride: unknown;
  schemaVersion: number;
  needsReview: boolean;
  needsReviewReason: string | null;
  createdAt: string;
  updatedAt: string;
  nextRunMs: number | null;
  nextRun: string | null;
};

export function SchedulesPage() {
  const [registry, setRegistry] = useState<RegJob[] | null>(null);
  const [rows, setRows] = useState<ScheduleRow[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [jobName, setJobName] = useState("");
  const [cronPattern, setCronPattern] = useState("0 * * * *");
  const [timeZone, setTimeZone] = useState("UTC");
  const [payloadJson, setPayloadJson] = useState('{\n  "message": "scheduled"\n}');
  const [enabled, setEnabled] = useState(true);
  const [priority, setPriority] = useState("");
  const [retryJson, setRetryJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewText, setPreviewText] = useState<string | null>(null);

  const schedulable = useMemo(
    () => (registry ?? []).filter((j) => j.schedulable),
    [registry],
  );

  const load = useCallback(async () => {
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
    const sRes = await fetch("/api/v1/schedules", { credentials: "include" });
    if (sRes.status === 401) {
      setRows([]);
      return;
    }
    if (!sRes.ok) {
      setError(`Failed to load schedules (${sRes.status}).`);
      return;
    }
    const sBody = (await sRes.json()) as { schedules: ScheduleRow[] };
    setRows(sBody.schedules);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!jobName && schedulable.length > 0) {
      setJobName(schedulable[0]!.name);
    }
  }, [jobName, schedulable]);

  const fillFromRow = (r: ScheduleRow) => {
    setEditingId(r.id);
    setJobName(r.jobName);
    setCronPattern(r.cronPattern);
    setTimeZone(r.timeZone);
    setPayloadJson(JSON.stringify(r.payload, null, 2));
    setEnabled(r.enabled);
    setPriority(r.priority == null ? "" : String(r.priority));
    setRetryJson(
      r.retryOverride == null
        ? ""
        : JSON.stringify(r.retryOverride as object, null, 2),
    );
    setParseErr(null);
    setPreviewText(null);
  };

  const clearForm = () => {
    setEditingId(null);
    setCronPattern("0 * * * *");
    setTimeZone("UTC");
    setPayloadJson('{\n  "message": "scheduled"\n}');
    setEnabled(true);
    setPriority("");
    setRetryJson("");
    if (schedulable.length > 0) {
      setJobName(schedulable[0]!.name);
    }
  };

  const onPreview = async () => {
    setParseErr(null);
    setPreviewText(null);
    setBusy(true);
    try {
      const res = await fetch("/api/v1/schedules/preview", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cronPattern, timeZone, count: 5 }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        runs?: { iso: string }[];
        error?: string;
      };
      if (!res.ok) {
        setParseErr(body.error === "invalid_cron" ? "Invalid cron pattern." : "Preview failed.");
        return;
      }
      if (body.runs) {
        setPreviewText(body.runs.map((x) => x.iso).join("\n"));
      }
    } finally {
      setBusy(false);
    }
  };

  const onSave = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setParseErr(null);
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
    const base: Record<string, unknown> = {
      jobName,
      cronPattern,
      timeZone,
      payload,
      enabled,
    };
    if (priority.trim() !== "") {
      const n = parseInt(priority, 10);
      if (Number.isNaN(n) || n < 0) {
        setParseErr("Priority must be a non-negative integer or empty.");
        return;
      }
      base.priority = n;
    }
    if (retry) {
      base.retry = retry;
    }
    setBusy(true);
    try {
      if (editingId) {
        const res = await fetch(`/api/v1/schedules/${editingId}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(base),
        });
        if (res.status === 401) {
          setError("Session expired.");
          return;
        }
        if (!res.ok) {
          const b = (await res.json().catch(() => ({}))) as { error?: string };
          setError(b.error ? `Error: ${b.error}` : `Save failed (${res.status}).`);
          return;
        }
      } else {
        const res = await fetch("/api/v1/schedules", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(base),
        });
        if (res.status === 401) {
          setError("Session expired.");
          return;
        }
        if (!res.ok) {
          const b = (await res.json().catch(() => ({}))) as { error?: string };
          setError(b.error ? `Error: ${b.error}` : `Create failed (${res.status}).`);
          return;
        }
      }
      clearForm();
      await load();
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (id: string) => {
    if (!window.confirm("Delete this schedule?")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/schedules/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.status === 204) {
        if (editingId === id) {
          clearForm();
        }
        await load();
      } else {
        setError(`Delete failed (${res.status}).`);
      }
    } finally {
      setBusy(false);
    }
  };

  if (rows === null || registry === null) {
    return <p style={{ color: "#444" }}>Loading…</p>;
  }

  return (
    <div style={{ display: "grid", gap: "1.5rem" }}>
      <h2 style={{ margin: 0, fontSize: "1.25rem" }}>Cron schedules</h2>
      {error ? (
        <p role="alert" style={{ color: "#b42318", margin: 0 }}>
          {error}
        </p>
      ) : null}
      {schedulable.length === 0 ? (
        <p style={{ color: "#666" }}>No schedulable job types are registered yet.</p>
      ) : (
        <>
          <section>
            <h3 style={h3Style}>Defined schedules</h3>
            {rows.length === 0 ? (
              <p style={{ color: "#666" }}>No schedules yet.</p>
            ) : (
              <div style={{ overflow: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: "0.9rem",
                  }}
                >
                  <thead>
                    <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                      <th style={thtd}>Job</th>
                      <th style={thtd}>Cron</th>
                      <th style={thtd}>Time zone</th>
                      <th style={thtd}>On</th>
                      <th style={thtd}>Review</th>
                      <th style={thtd}>Next run</th>
                      <th style={thtd}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} style={{ borderBottom: "1px solid #eee" }}>
                        <td style={thtd}>
                          <code>{r.jobName}</code>
                        </td>
                        <td style={thtd}>
                          <code>{r.cronPattern}</code>
                        </td>
                        <td style={thtd}>{r.timeZone}</td>
                        <td style={thtd}>{r.enabled ? "yes" : "no"}</td>
                        <td style={thtd}>
                          {r.needsReview ? (
                            <span
                              title={r.needsReviewReason ?? "Registry mismatch or invalid payload"}
                              style={{ color: "#b42318", fontWeight: 600 }}
                            >
                              needs review
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td style={thtd}>{r.nextRun ? <span title={r.nextRun}>{r.nextRun}</span> : "—"}</td>
                        <td style={thtd}>
                          <button type="button" onClick={() => fillFromRow(r)} style={linkBtn} disabled={busy}>
                            Edit
                          </button>{" "}
                          <button type="button" onClick={() => void onDelete(r.id)} style={linkBtn} disabled={busy}>
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <h3 style={h3Style}>{editingId ? "Edit schedule" : "New schedule"}</h3>
            {editingId ? (
              <p style={{ fontSize: "0.9rem", color: "#555" }}>
                Editing <code>{editingId}</code> —{" "}
                <button type="button" style={linkBtn} onClick={() => clearForm()}>
                  cancel edit
                </button>
              </p>
            ) : null}
            <form
              onSubmit={(e) => void onSave(e)}
              style={{ display: "grid", gap: "0.75rem", maxWidth: "36rem" }}
            >
              <label style={labelStyle}>
                Job type
                <select
                  value={jobName}
                  onChange={(e) => setJobName(e.target.value)}
                  required
                  style={inputStyle}
                >
                  {schedulable.map((j) => (
                    <option key={j.name} value={j.name}>
                      {j.name}
                    </option>
                  ))}
                </select>
              </label>
              <label style={labelStyle}>
                Cron pattern
                <input
                  value={cronPattern}
                  onChange={(e) => setCronPattern(e.target.value)}
                  required
                  style={inputStyle}
                />
              </label>
              <label style={labelStyle}>
                IANA time zone
                <input
                  value={timeZone}
                  onChange={(e) => setTimeZone(e.target.value)}
                  required
                  style={inputStyle}
                />
              </label>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <label style={{ ...labelStyle, margin: 0, flex: 1 }} className="block">
                  <span>Enabled</span>
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => setEnabled(e.target.checked)}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void onPreview()}
                  disabled={busy}
                  style={secondaryBtn}
                >
                  Preview next runs
                </button>
              </div>
              {previewText ? (
                <pre
                  style={{
                    margin: 0,
                    fontSize: "0.8rem",
                    background: "#f4f4f4",
                    padding: "0.5rem",
                    borderRadius: 4,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {previewText}
                </pre>
              ) : null}
              <label style={labelStyle}>
                Payload (JSON)
                <textarea
                  value={payloadJson}
                  onChange={(e) => setPayloadJson(e.target.value)}
                  rows={6}
                  style={taStyle}
                />
              </label>
              <label style={labelStyle}>
                Priority (optional, lower = higher priority; empty = default)
                <input
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                  style={inputStyle}
                />
              </label>
              <label style={labelStyle}>
                Retry override JSON (optional)
                <textarea
                  value={retryJson}
                  onChange={(e) => setRetryJson(e.target.value)}
                  rows={2}
                  style={taStyle}
                />
              </label>
              {parseErr ? (
                <p role="alert" style={{ color: "#b42318", margin: 0, fontSize: "0.9rem" }}>
                  {parseErr}
                </p>
              ) : null}
              <button type="submit" disabled={busy} style={buttonStyle}>
                {busy ? "Saving…" : editingId ? "Update schedule" : "Create schedule"}
              </button>
            </form>
          </section>
        </>
      )}
    </div>
  );
}

const h3Style: CSSProperties = {
  fontSize: "1.05rem",
  margin: "0 0 0.5rem 0",
};

const thtd: CSSProperties = { padding: "0.4rem 0.5rem", verticalAlign: "top" };
const linkBtn: CSSProperties = {
  background: "none",
  border: "none",
  color: "#0b57d0",
  cursor: "pointer",
  textDecoration: "underline",
  padding: 0,
  font: "inherit",
};

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

const taStyle: CSSProperties = { ...inputStyle, fontFamily: "ui-monospace, monospace" };

const buttonStyle: CSSProperties = {
  padding: "0.55rem 1rem",
  fontSize: "1rem",
  borderRadius: 6,
  border: "1px solid #222",
  background: "#111",
  color: "#fff",
  cursor: "pointer",
  justifySelf: "start",
};

const secondaryBtn: CSSProperties = {
  ...buttonStyle,
  background: "#f4f4f4",
  color: "#111",
  border: "1px solid #999",
  padding: "0.4rem 0.75rem",
  fontSize: "0.9rem",
};
