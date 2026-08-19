import { useCallback, useEffect, useState } from "react";
import { useSwamp } from "../client/SwampProvider";

export function Login() {
  const { authMode, login } = useSwamp();

  if (authMode === "oauth") {
    return <OAuthLogin onToken={login} />;
  }

  return <TokenLogin onToken={login} />;
}

function TokenLogin({ onToken }: { onToken: (t: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!value.trim()) return;
      setChecking(true);
      setError(null);

      try {
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(
          `${proto}//${location.host}/`,
          [`bearer.${value.trim()}`],
        );

        await new Promise<void>((resolve, reject) => {
          ws.onopen = () => {
            ws.close();
            resolve();
          };
          ws.onerror = () => reject(new Error("Invalid token"));
          ws.onclose = (event) => {
            if (event.code !== 1000) reject(new Error("Connection rejected"));
          };
          setTimeout(() => reject(new Error("Connection timeout")), 5000);
        });

        onToken(value.trim());
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Authentication failed",
        );
        setChecking(false);
      }
    },
    [value, onToken],
  );

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>swamp dashboard</h1>
        <p>Enter your serve token to connect.</p>
        {error && <div className="login-error">{error}</div>}
        <input
          type="password"
          placeholder="admin.xxxxxxxxxxxxxxxx"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        <button type="submit" disabled={checking}>
          {checking ? "Connecting..." : "Connect"}
        </button>
      </form>
    </div>
  );
}

interface DeviceGrant {
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  deviceCode: string;
  expiresIn: number;
  interval: number;
}

function OAuthLogin({ onToken }: { onToken: (t: string) => void }) {
  const [grant, setGrant] = useState<DeviceGrant | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  useEffect(() => {
    fetch("/auth/device", { method: "POST" })
      .then((r) => {
        if (!r.ok) throw new Error("Failed to start device flow");
        return r.json();
      })
      .then((data: DeviceGrant) => {
        setGrant(data);
        setPolling(true);
        if (data.verificationUriComplete) {
          globalThis.open(data.verificationUriComplete, "_blank");
        }
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Device flow failed")
      );
  }, []);

  useEffect(() => {
    if (!grant || !polling) return;

    const interval = setInterval(async () => {
      try {
        const resp = await fetch("/auth/device/token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceCode: grant.deviceCode }),
        });
        const data = await resp.json();

        if (data.token) {
          setPolling(false);
          onToken(data.token);
        } else if (data.error === "expired_token") {
          setPolling(false);
          setError("Device authorization expired. Refresh to try again.");
        }
      } catch {
        // keep polling
      }
    }, (grant.interval || 5) * 1000);

    return () => clearInterval(interval);
  }, [grant, polling, onToken]);

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>swamp dashboard</h1>
        <p>Authenticate via swamp-club to continue.</p>
        {error && <div className="login-error">{error}</div>}
        {grant
          ? (
            <div className="login-device">
              <p style={{ color: "var(--text-2)", marginBottom: 8 }}>
                A browser tab has been opened. Approve the request to continue.
              </p>
              <div className="code">{grant.userCode}</div>
              <p style={{ color: "var(--text-3)", fontSize: "0.82rem" }}>
                Waiting for authorization...
              </p>
              <p
                style={{
                  color: "var(--text-3)",
                  fontSize: "0.78rem",
                  marginTop: 12,
                }}
              >
                Didn't open?{" "}
                <a
                  href={grant.verificationUriComplete}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Click here
                </a>
              </p>
            </div>
          )
          : (
            !error && <div className="loading">Starting authorization...</div>
          )}
      </div>
    </div>
  );
}
