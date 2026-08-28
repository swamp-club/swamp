// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import { useCallback, useEffect, useState } from "react";
import { useSwamp } from "../client/SwampProvider";
import { Logo } from "../components/Logo";

function providerHost(verificationBaseUri: string | null): string {
  if (!verificationBaseUri) return "swamp-club.com";
  try {
    return new URL(verificationBaseUri).hostname;
  } catch {
    return "swamp-club.com";
  }
}

export function Login() {
  const { authMode, verificationBaseUri, login } = useSwamp();

  if (authMode === "oauth") {
    return (
      <OAuthLogin
        onToken={login}
        providerHost={providerHost(verificationBaseUri)}
      />
    );
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
      <div className="login-container">
        <LoginBrand />
        <form className="login-card" onSubmit={handleSubmit}>
          <h2>Sign in to your dashboard</h2>
          <p>Enter your serve token to connect to this instance.</p>
          {error && <div className="login-error">{error}</div>}
          <label className="login-label">Token</label>
          <input
            type="password"
            placeholder="admin.xxxxxxxxxxxxxxxx"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
          <button type="submit" disabled={checking}>
            {checking ? "Connecting..." : "Sign in"}
          </button>
          <p className="login-hint">
            Generate a token with <code>swamp access token mint</code>
          </p>
        </form>
      </div>
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

type OAuthState = "idle" | "starting" | "waiting" | "error";

function OAuthLogin(
  { onToken, providerHost }: {
    onToken: (t: string) => void;
    providerHost: string;
  },
) {
  const [state, setState] = useState<OAuthState>("idle");
  const [grant, setGrant] = useState<DeviceGrant | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startLogin = useCallback(() => {
    setState("starting");
    setError(null);

    fetch("/auth/device", { method: "POST" })
      .then((r) => {
        if (!r.ok) throw new Error("Failed to start login");
        return r.json();
      })
      .then((data: DeviceGrant) => {
        setGrant(data);
        setState("waiting");
        if (data.verificationUriComplete) {
          globalThis.open(data.verificationUriComplete, "_blank");
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Login failed");
        setState("error");
      });
  }, []);

  useEffect(() => {
    if (!grant || state !== "waiting") return;

    const interval = setInterval(async () => {
      try {
        const resp = await fetch("/auth/device/token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceCode: grant.deviceCode }),
        });
        const data = await resp.json();

        if (data.token) {
          onToken(data.token);
        } else if (data.error === "expired_token") {
          setError("Login expired. Please try again.");
          setState("error");
        }
      } catch {
        // keep polling
      }
    }, (grant.interval || 5) * 1000);

    return () => clearInterval(interval);
  }, [grant, state, onToken]);

  return (
    <div className="login-page">
      <div className="login-container">
        <LoginBrand />
        <div className="login-card">
          {state === "idle" && (
            <>
              <h2>Sign in to your dashboard</h2>
              <p>
                You'll be redirected to {providerHost}{" "}
                to authenticate with your account.
              </p>
              <button
                type="button"
                onClick={startLogin}
                style={{
                  width: "100%",
                  padding: "10px",
                  border: "none",
                  borderRadius: 6,
                  background: "var(--accent)",
                  color: "#000",
                  fontFamily: "inherit",
                  fontSize: "0.88rem",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Login with {providerHost}
              </button>
            </>
          )}

          {state === "starting" && (
            <>
              <h2>Sign in to your dashboard</h2>
              <div className="login-waiting">
                <div className="login-spinner" />
                Starting login...
              </div>
            </>
          )}

          {state === "waiting" && grant && (
            <>
              <h2>Complete login in your browser</h2>
              <p>
                A new tab has opened at{" "}
                {providerHost}. Enter the code below to confirm it's you.
              </p>
              <div className="login-code-block">
                <div className="login-code-label">Confirmation code</div>
                <div className="login-code">{grant.userCode}</div>
              </div>
              <div className="login-waiting">
                <div className="login-spinner" />
                Waiting for you to approve...
              </div>
              <p className="login-hint">
                Tab didn't open?{" "}
                <a
                  href={grant.verificationUriComplete}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open {providerHost} manually
                </a>
              </p>
            </>
          )}

          {state === "error" && (
            <>
              <h2>Sign in to your dashboard</h2>
              {error && <div className="login-error">{error}</div>}
              <button
                type="button"
                onClick={() => {
                  setState("idle");
                  setGrant(null);
                  setError(null);
                }}
                style={{
                  width: "100%",
                  padding: "10px",
                  border: "none",
                  borderRadius: 6,
                  background: "var(--accent)",
                  color: "#000",
                  fontFamily: "inherit",
                  fontSize: "0.88rem",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Try again
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function LoginBrand() {
  return (
    <div className="login-brand">
      <Logo size="lg" />
      <h1>Swamp</h1>
    </div>
  );
}
