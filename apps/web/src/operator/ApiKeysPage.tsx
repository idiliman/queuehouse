import { type CSSProperties, type FormEvent, useCallback, useEffect, useState } from "react";

type ApiKeyRow = {
  id: string;
  name: string | null;
  createdAt: string;
  scopes: string[];
  allowedJobTypes: string[];
  revokedAt: string | null;
};

type RegJob = { name: string; description: string };

const SCOPE_OPTIONS = [
  { id: "read", label: "Read jobs (list & detail)" },
  { id: "enqueue", label: "Enqueue" },
  { id: "admin", label: "Admin (retry / remove / retry-as-new on allow-listed jobs)" },
] as const;

export function ApiKeysPage() {
  const [rows, setRows] = useState<ApiKeyRow[] | null>(null);
  const [registry, setRegistry] = useState<RegJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [scopePick, setScopePick] = useState<Set<string>>(
    () => new Set(["read", "enqueue"]),
  );
  const [jobPick, setJobPick] = useState<Set<string>>(() => new Set());
  const [newToken, setNewToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    const [kRes, mRes] = await Promise.all([
      fetch("/api/v1/api-keys", { credentials: "include" }),
      fetch("/api/v1/meta/registered-jobs", { credentials: "include" }),
    ]);
    if (kRes.status === 401 || mRes.status === 401) {
      setRows([]);
      return;
    }
    if (!kRes.ok) {
      setError(`Failed to load API keys (${kRes.status}).`);
      return;
    }
    if (!mRes.ok) {
      setError(`Failed to load job registry (${mRes.status}).`);
      return;
    }
    const kBody = (await kRes.json()) as { apiKeys: ApiKeyRow[] };
    const mBody = (await mRes.json()) as { jobs: RegJob[] };
    setRows(kBody.apiKeys);
    setRegistry(mBody.jobs);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleJob = (name: string) => {
    setJobPick((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (scopePick.size === 0) {
      setError("Select at least one scope.");
      return;
    }
    if (jobPick.size === 0) {
      setError("Select at least one job type the key can access.");
      return;
    }
    setBusy(true);
    setError(null);
    setNewToken(null);
    try {
      const res = await fetch("/api/v1/api-keys", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || undefined,
          scopes: [...scopePick],
          allowedJobTypes: [...jobPick],
        }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error === "forbidden" ? "Forbidden." : `Create failed (${res.status}).`);
        return;
      }
      const body = (await res.json()) as { token: string };
      setNewToken(body.token);
      setName("");
      void refresh();
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  };

  const onRevoke = async (id: string) => {
    if (!window.confirm("Revoke this key? It will stop working immediately.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/api-keys/${id}`, { method: "DELETE", credentials: "include" });
      if (res.status === 404) {
        setError("Key not found (already revoked?)");
        return;
      }
      if (!res.ok) {
        setError(`Revoke failed (${res.status}).`);
        return;
      }
      void refresh();
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  };

  if (rows === null || registry === null) {
    return <p style={{ color: "#444" }}>Loading…</p>;
  }

  return (
    <div style={{ display: "grid", gap: "1.5rem" }}>
      <h2 style={{ fontSize: "1.25rem", fontWeight: 600, margin: 0 }}>API keys</h2>
      <p style={{ color: "#444", lineHeight: 1.5, margin: 0, maxWidth: "40rem" }}>
        Keys authenticate as you for automation. The secret is shown only once. Store it as an environment
        variable or secret manager entry.
      </p>

      {error ? (
        <p role="alert" style={{ color: "#b42318", margin: 0 }}>
          {error}
        </p>
      ) : null}
      {newToken ? (
        <div
          style={{
            padding: "1rem",
            border: "1px solid #0b57d0",
            borderRadius: 8,
            background: "#f0f6ff",
          }}
        >
          <p style={{ margin: 0, fontWeight: 600, color: "#0b57d0" }}>Copy this token now</p>
          <p style={{ margin: "0.5rem 0 0", fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }}>
            {newToken}
          </p>
        </div>
      ) : null}

      <form
        onSubmit={(e) => void onCreate(e)}
        style={{
          display: "grid",
          gap: "0.75rem",
          maxWidth: "32rem",
          padding: "1rem",
          border: "1px solid #ddd",
          borderRadius: 8,
        }}
      >
        <h3 style={{ fontSize: "1rem", fontWeight: 600, margin: 0 }}>New key</h3>
        <label style={{ display: "grid", gap: "0.35rem", fontSize: "0.9rem" }}>
          Label (optional)
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={input}
            maxLength={200}
            autoComplete="off"
          />
        </label>
        <fieldset style={{ border: "none", margin: 0, padding: 0 }}>
          <legend style={{ fontSize: "0.9rem", fontWeight: 500, marginBottom: "0.35rem" }}>Scopes</legend>
          {SCOPE_OPTIONS.map((s) => (
            <label
              key={s.id}
              style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.9rem" }}
            >
              <input
                type="checkbox"
                checked={scopePick.has(s.id)}
                onChange={() =>
                  setScopePick((prev) => {
                    const n = new Set(prev);
                    if (n.has(s.id)) n.delete(s.id);
                    else n.add(s.id);
                    return n;
                  })
                }
              />
              {s.label}
            </label>
          ))}
        </fieldset>
        <div>
          <p style={{ fontSize: "0.9rem", fontWeight: 500, margin: "0 0 0.35rem" }}>Allowed job types</p>
          <div
            style={{
              display: "grid",
              gap: "0.35rem",
              maxHeight: "12rem",
              overflow: "auto",
              fontSize: "0.9rem",
            }}
          >
            {registry.map((j) => (
              <label key={j.name} style={{ display: "flex", alignItems: "start", gap: "0.5rem" }}>
                <input
                  type="checkbox"
                  checked={jobPick.has(j.name)}
                  onChange={() => toggleJob(j.name)}
                />
                <span>
                  <span style={{ fontFamily: "ui-monospace, monospace" }}>{j.name}</span>
                  {j.description ? (
                    <span style={{ color: "#555", display: "block", fontSize: "0.85rem" }}>
                      {j.description}
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
        </div>
        <button type="submit" disabled={busy} style={btn}>
          {busy ? "Creating…" : "Create key"}
        </button>
      </form>

      <div>
        <h3 style={{ fontSize: "1rem", fontWeight: 600, margin: "0 0 0.5rem" }}>Existing keys</h3>
        {rows.length === 0 ? (
          <p style={{ color: "#666", margin: 0 }}>No keys yet.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.75rem" }}>
            {rows.map((r) => (
              <li
                key={r.id}
                style={{
                  padding: "0.75rem 1rem",
                  border: "1px solid #e0e0e0",
                  borderRadius: 8,
                  opacity: r.revokedAt ? 0.55 : 1,
                }}
              >
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "baseline" }}>
                  <code style={{ fontSize: "0.85rem" }}>{r.id}</code>
                  {r.name ? <span style={{ color: "#333" }}>{r.name}</span> : null}
                  {r.revokedAt ? (
                    <span style={{ color: "#a30", fontSize: "0.85rem" }}>Revoked</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void onRevoke(r.id)}
                      disabled={busy}
                      style={btnSmall}
                    >
                      Revoke
                    </button>
                  )}
                </div>
                <p style={{ margin: "0.35rem 0 0", fontSize: "0.85rem", color: "#555" }}>
                  Scopes: {r.scopes.join(", ") || "—"}
                </p>
                <p style={{ margin: "0.2rem 0 0", fontSize: "0.85rem", color: "#555" }}>
                  Jobs: {r.allowedJobTypes.join(", ")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const input: CSSProperties = {
  padding: "0.5rem 0.65rem",
  fontSize: "1rem",
  borderRadius: 6,
  border: "1px solid #ccc",
};

const btn: CSSProperties = {
  marginTop: "0.25rem",
  padding: "0.55rem 1rem",
  fontSize: "1rem",
  borderRadius: 6,
  border: "1px solid #222",
  background: "#111",
  color: "#fff",
  cursor: "pointer",
};

const btnSmall: CSSProperties = {
  ...btn,
  marginTop: 0,
  padding: "0.2rem 0.5rem",
  fontSize: "0.85rem",
};
