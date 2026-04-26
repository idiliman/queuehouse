import { type CSSProperties, useCallback, useEffect, useState } from "react";

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

export function AuditLogPage() {
  const [items, setItems] = useState<AuditItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [actionFilter, setActionFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const limit = 30;

  const runFetch = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const p = new URLSearchParams();
      p.set("limit", String(limit));
      p.set("offset", String(offset));
      if (actionFilter.trim()) p.set("action", actionFilter.trim());
      const res = await fetch(`/api/v1/audit-logs?${p.toString()}`, { credentials: "include" });
      if (res.status === 401) {
        setError("Session expired. Sign in again.");
        setItems([]);
        return;
      }
      if (res.status === 403) {
        setError("You need an admin account to view the audit log.");
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
  }, [actionFilter, offset]);

  useEffect(() => {
    void runFetch();
  }, [runFetch]);

  return (
    <div>
      <h2 style={{ fontSize: "1.2rem", fontWeight: 600, margin: "0 0 0.75rem" }}>Audit log</h2>
      <p style={{ color: "#555", fontSize: "0.9rem", lineHeight: 1.45, maxWidth: "42rem" }}>
        Operator and API key mutations (redacted). Raw job payloads are never stored.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          void runFetch();
        }}
        style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "end", margin: "1rem 0" }}
      >
        <label style={{ display: "grid", gap: "0.25rem", fontSize: "0.8rem" }}>
          Action (exact match)
          <input
            type="text"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            placeholder="e.g. job.enqueue"
            style={{
              padding: "0.35rem 0.5rem",
              fontSize: "0.85rem",
              minWidth: "12rem",
            }}
          />
        </label>
        <button type="submit" style={{ padding: "0.4rem 0.75rem", fontSize: "0.9rem" }}>
          Apply
        </button>
      </form>
      {error ? (
        <p role="alert" style={{ color: "#b42318" }}>
          {error}
        </p>
      ) : null}
      {loading && items === null ? <p style={{ color: "#666" }}>Loading…</p> : null}
      {items && items.length === 0 && !loading ? (
        <p style={{ color: "#666" }}>No audit entries match.</p>
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
                <th style={th}>Action</th>
                <th style={th}>Result</th>
                <th style={th}>Actor</th>
                <th style={th}>Summary</th>
                <th style={th}>Request</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id}>
                  <td style={td}>
                    <span style={mono}>{row.createdAt.slice(0, 19)}Z</span>
                  </td>
                  <td style={td}>
                    <code style={mono}>{row.action}</code>
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
                    <pre
                      style={{
                        ...mono,
                        margin: 0,
                        whiteSpace: "pre-wrap",
                        maxWidth: "22rem",
                      }}
                    >
                      {JSON.stringify(row.summary)}
                    </pre>
                  </td>
                  <td style={td}>
                    <span style={mono}>{row.requestId}</span>
                  </td>
                </tr>
              ))}
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
