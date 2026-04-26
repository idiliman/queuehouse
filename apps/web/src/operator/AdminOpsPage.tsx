import { type CSSProperties, useCallback, useEffect, useState } from "react";

import { AUDIT_ACTION_BULK_DLQ, AUDIT_ACTION_BULK_DLQ_COMPLETE } from "./audit-actions";

type Actor = {
  type: "user" | "api_key";
  userEmail: string;
  apiKeyName: string | null;
  apiKeyId: string | null;
};

type AuditItem = {
  id: string;
  createdAt: string;
  requestId: string;
  action: string;
  summary: unknown;
  result: string;
  errorCode: string | null;
  actor: Actor;
};

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
  wordBreak: "break-word",
};

const mono: CSSProperties = { fontFamily: "ui-monospace, monospace", fontSize: "0.75rem" };

function summaryRecord(s: unknown): Record<string, unknown> {
  return s != null && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
}

/** Maps stored `remove` to operator-facing "delete" (#18: retry / discard / delete). */
function bulkDlqActionLabel(a: string): string {
  if (a === "remove") return "delete";
  return a;
}

/**
 * Bulk DLQ system jobs: enqueue + completion rows from the audit log (session-only API).
 */
export function AdminOpsPage() {
  const [items, setItems] = useState<AuditItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const limit = 40;

  const runFetch = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const p = new URLSearchParams();
      p.set("limit", String(limit));
      p.set("offset", String(offset));
      p.set("actions", `${AUDIT_ACTION_BULK_DLQ},${AUDIT_ACTION_BULK_DLQ_COMPLETE}`);
      const res = await fetch(`/api/v1/audit-logs?${p.toString()}`, { credentials: "include" });
      if (res.status === 401) {
        setError("Session expired. Sign in again.");
        setItems([]);
        return;
      }
      if (res.status === 403) {
        setError("You need an admin account to view admin operations.");
        setItems([]);
        return;
      }
      if (!res.ok) {
        setError(`Request failed (${res.status}).`);
        setItems([]);
        return;
      }
      const body = (await res.json()) as { items: AuditItem[]; total: number };
      setItems(body.items);
      setTotal(body.total);
    } finally {
      setLoading(false);
    }
  }, [offset]);

  useEffect(() => {
    void runFetch();
  }, [runFetch]);

  return (
    <div>
      <h2 style={{ fontSize: "1.2rem", fontWeight: 600, margin: "0 0 0.75rem" }}>Admin operations</h2>
      <p style={{ color: "#555", fontSize: "0.9rem", lineHeight: 1.45, maxWidth: "42rem" }}>
        Bulk DLQ recovery runs (system jobs): when an operation was enqueued and when it finished, with
        requested / executed / skipped / failed counts on completion.
      </p>
      {error ? (
        <p role="alert" style={{ color: "#b42318" }}>
          {error}
        </p>
      ) : null}
      {loading && items === null ? <p style={{ color: "#666" }}>Loading…</p> : null}
      {items && items.length === 0 && !loading ? (
        <p style={{ color: "#666" }}>No bulk DLQ operations recorded yet.</p>
      ) : null}
      {items && items.length > 0 ? (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              minWidth: "720px",
            }}
          >
            <thead>
              <tr>
                <th style={th}>Time (UTC)</th>
                <th style={th}>Event</th>
                <th style={th}>Op</th>
                <th style={th}>Counts</th>
                <th style={th}>Result</th>
                <th style={th}>Actor</th>
                <th style={th}>Request</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => {
                const sum = summaryRecord(row.summary);
                const op =
                  sum.action === "retry" || sum.action === "remove"
                    ? bulkDlqActionLabel(String(sum.action))
                    : "—";
                const isComplete = row.action === AUDIT_ACTION_BULK_DLQ_COMPLETE;
                const counts = isComplete ? (
                  <>
                    req {String(sum.requested ?? "—")} / ok {String(sum.executed ?? "—")} / skip{" "}
                    {String(sum.skipped ?? "—")} / fail {String(sum.failed ?? "—")}
                  </>
                ) : (
                  <>requested {String(sum.requested ?? "—")}</>
                );
                return (
                  <tr key={row.id}>
                    <td style={td}>
                      <span style={mono}>{row.createdAt.slice(0, 19)}Z</span>
                    </td>
                    <td style={td}>{isComplete ? "Completed" : "Enqueued"}</td>
                    <td style={td}>
                      <code style={mono}>{op}</code>
                    </td>
                    <td style={td}>
                      <span style={{ fontSize: "0.8rem" }}>{counts}</span>
                      {sum.systemJobId != null ? (
                        <div style={{ ...mono, marginTop: "0.25rem", color: "#555" }}>
                          job {String(sum.systemJobId)}
                          {sum.systemQueueName != null ? ` @ ${String(sum.systemQueueName)}` : ""}
                        </div>
                      ) : null}
                    </td>
                    <td style={td}>
                      <span
                        style={{
                          color: row.result === "SUCCESS" ? "#0a5c1f" : "#8a1c1c",
                          fontWeight: 600,
                          fontSize: "0.75rem",
                        }}
                      >
                        {row.result}
                      </span>
                      {row.errorCode ? (
                        <div style={{ ...mono, marginTop: "0.2rem" }}>{row.errorCode}</div>
                      ) : null}
                    </td>
                    <td style={td}>
                      <div style={{ fontSize: "0.8rem" }}>{row.actor.userEmail}</div>
                      {row.actor.type === "api_key" ? (
                        <div style={{ ...mono, color: "#555" }}>
                          API key {row.actor.apiKeyName || row.actor.apiKeyId || "—"}
                        </div>
                      ) : (
                        <div style={{ fontSize: "0.75rem", color: "#666" }}>Session</div>
                      )}
                    </td>
                    <td style={td}>
                      <span style={mono}>{row.requestId}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {items && items.length > 0 ? (
        <p style={{ fontSize: "0.85rem", color: "#666", marginTop: "0.75rem" }}>
          Showing {offset + 1}–{offset + items.length} of {total}
        </p>
      ) : null}
      {items && total > offset + items.length ? (
        <button
          type="button"
          onClick={() => setOffset((o) => o + limit)}
          disabled={loading}
          style={{ marginTop: "0.5rem", padding: "0.4rem 0.75rem" }}
        >
          Next page
        </button>
      ) : null}
      {offset > 0 ? (
        <button
          type="button"
          onClick={() => setOffset((o) => Math.max(0, o - limit))}
          disabled={loading}
          style={{ marginTop: "0.5rem", marginLeft: "0.5rem", padding: "0.4rem 0.75rem" }}
        >
          Previous page
        </button>
      ) : null}
    </div>
  );
}
