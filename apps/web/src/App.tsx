import {
  type CSSProperties,
  type FormEvent,
  useCallback,
  useEffect,
  useState,
} from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { AdminOpsPage } from "./operator/AdminOpsPage";
import { ApiKeysPage } from "./operator/ApiKeysPage";
import { ManualEnqueuePage } from "./operator/ManualEnqueuePage";
import { SchedulesPage } from "./operator/SchedulesPage";
import { AuditLogPage } from "./operator/AuditLogPage";
import { JobDetailPage } from "./operator/JobDetailPage";
import { JobsTablePage } from "./operator/JobsTablePage";
import { WorkersPage } from "./operator/WorkersPage";

type Role = "VIEWER" | "ADMIN";

type SessionUser = {
  id: string;
  email: string;
  role: Role;
};

async function fetchSession(): Promise<SessionUser | null> {
  const res = await fetch("/api/v1/auth/session", { credentials: "include" });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`session ${res.status}`);
  const body = (await res.json()) as { user: SessionUser };
  return body.user;
}

export function App() {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setUser(await fetchSession());
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onLogin = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/v1/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error === "invalid_credentials" ? "Invalid email or password." : "Login failed.");
        return;
      }
      const body = (await res.json()) as { user: SessionUser };
      setUser(body.user);
      setPassword("");
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  };

  const onLogout = async () => {
    setBusy(true);
    try {
      await fetch("/api/v1/auth/logout", { method: "POST", credentials: "include" });
      setUser(null);
    } finally {
      setBusy(false);
    }
  };

  if (user === undefined) {
    return (
      <main style={shell}>
        <p style={{ color: "#444" }}>Loading session…</p>
      </main>
    );
  }

  return (
    <main style={shell}>
      <header style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "1rem" }}>
        <h1 style={{ fontSize: "1.75rem", fontWeight: 600, margin: 0 }}>Queuehouse</h1>
        {user ? (
          <nav style={{ display: "flex", gap: "0.75rem", fontSize: "0.95rem" }}>
            <Link to="/" style={navStyle}>
              Home
            </Link>
            <Link to="/jobs" style={navStyle}>
              Jobs
            </Link>
            <Link to="/dlq" style={navStyle}>
              DLQ
            </Link>
            <Link to="/workers" style={navStyle}>
              Workers
            </Link>
            {user.role === "ADMIN" ? (
              <>
                <Link to="/enqueue" style={navStyle}>
                  Enqueue
                </Link>
                <Link to="/schedules" style={navStyle}>
                  Schedules
                </Link>
                <Link to="/api-keys" style={navStyle}>
                  API keys
                </Link>
                <Link to="/audit" style={navStyle}>
                  Audit
                </Link>
                <Link to="/admin-ops" style={navStyle}>
                  Admin ops
                </Link>
              </>
            ) : null}
          </nav>
        ) : null}
      </header>

      <Routes>
        <Route
          path="/"
          element={
            <section style={{ marginTop: "1.5rem" }}>
              {user ? (
                <div>
                  <p style={{ color: "#444", lineHeight: 1.5 }}>
                    Signed in as <strong>{user.email}</strong> ({user.role.toLowerCase()}).
                  </p>
                  <p style={{ lineHeight: 1.5 }}>
                    <Link to="/jobs" style={navStyle}>
                      Open jobs
                    </Link>
                  </p>
                  <button
                    type="button"
                    onClick={() => void onLogout()}
                    disabled={busy}
                    style={buttonStyle}
                  >
                    Log out
                  </button>
                </div>
              ) : (
                <div style={{ maxWidth: "22rem" }}>
                  <form onSubmit={(e) => void onLogin(e)} style={{ display: "grid", gap: "0.75rem" }}>
                    <label style={labelStyle}>
                      Email
                      <input
                        type="email"
                        name="email"
                        autoComplete="username"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                        style={inputStyle}
                      />
                    </label>
                    <label style={labelStyle}>
                      Password
                      <input
                        type="password"
                        name="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        style={inputStyle}
                      />
                    </label>
                    {error ? (
                      <p role="alert" style={{ color: "#b42318", margin: 0, fontSize: "0.9rem" }}>
                        {error}
                      </p>
                    ) : null}
                    <button type="submit" disabled={busy} style={buttonStyle}>
                      {busy ? "Signing in…" : "Sign in"}
                    </button>
                  </form>
                </div>
              )}
            </section>
          }
        />
        <Route
          path="/jobs"
          element={
            user ? (
              <section style={{ marginTop: "1.5rem" }}>
                <JobsTablePage role={user.role} />
              </section>
            ) : (
              <Navigate to="/" replace />
            )
          }
        />
        <Route
          path="/dlq"
          element={
            user ? (
              <section style={{ marginTop: "1.5rem" }}>
                <JobsTablePage role={user.role} initialState="failed" />
              </section>
            ) : (
              <Navigate to="/" replace />
            )
          }
        />
        <Route
          path="/workers"
          element={
            user ? (
              <section style={{ marginTop: "1.5rem" }}>
                <WorkersPage role={user.role} />
              </section>
            ) : (
              <Navigate to="/" replace />
            )
          }
        />
        <Route
          path="/enqueue"
          element={
            user?.role === "ADMIN" ? (
              <section style={{ marginTop: "1.5rem" }}>
                <ManualEnqueuePage />
              </section>
            ) : (
              <Navigate to="/" replace />
            )
          }
        />
        <Route
          path="/schedules"
          element={
            user?.role === "ADMIN" ? (
              <section style={{ marginTop: "1.5rem" }}>
                <SchedulesPage />
              </section>
            ) : (
              <Navigate to="/" replace />
            )
          }
        />
        <Route
          path="/api-keys"
          element={
            user?.role === "ADMIN" ? (
              <section style={{ marginTop: "1.5rem" }}>
                <ApiKeysPage />
              </section>
            ) : (
              <Navigate to="/" replace />
            )
          }
        />
        <Route
          path="/audit"
          element={
            user?.role === "ADMIN" ? (
              <section style={{ marginTop: "1.5rem" }}>
                <AuditLogPage />
              </section>
            ) : (
              <Navigate to="/" replace />
            )
          }
        />
        <Route
          path="/admin-ops"
          element={
            user?.role === "ADMIN" ? (
              <section style={{ marginTop: "1.5rem" }}>
                <AdminOpsPage />
              </section>
            ) : (
              <Navigate to="/" replace />
            )
          }
        />
        <Route
          path="/jobs/:queueName/:jobId"
          element={
            user ? (
              <section style={{ marginTop: "1.5rem" }}>
                <JobDetailPage />
              </section>
            ) : (
              <Navigate to="/" replace />
            )
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </main>
  );
}

const shell: CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  padding: "2rem",
  maxWidth: "56rem",
  margin: "0 auto",
};

const navStyle: CSSProperties = {
  color: "#0b57d0",
  textDecoration: "none",
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
