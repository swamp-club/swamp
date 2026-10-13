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

/** @jsxRuntime automatic */
/** @jsxImportSource react */
// The Activity page's non-feed states: audit off, access denied, a failed
// feed, the loading skeleton, and the live/paused indicator. Styles live
// in styles/activity.css, imported by Activity.tsx.

import { type ReactNode, useEffect, useRef, useState } from "react";
import type { AuditStatus } from "../client/audit_state.ts";
import { Skeleton, SkeletonRegion, widthAt } from "../components/Skeleton.tsx";

/** Manual pages on audit: how it works, and reading it from a server. */
export const AUDIT_MANUAL_LINKS = [
  {
    label: "How swamp's audit system works",
    href: "https://swamp-club.com/manual/explanation/the-audit-system",
  },
  {
    label: "Read the audit timeline on a server",
    href:
      "https://swamp-club.com/manual/how-to/use-the-audit-timeline#view-the-timeline-on-a-server",
  },
] as const;

/** The default serve config path (`swamp serve --config`). */
export const SERVE_CONFIG_PATH = ".swamp/serve.yaml";

/**
 * The smallest config that turns the audit log on. A store without `type`
 * and `config` uses the repo's shared datastore; serve logs a warning
 * recommending a dedicated one.
 */
export const AUDIT_CONFIG_SNIPPET = `audit:
  stores:
    - target: security-audit
      # Production: give audit its own datastore, so
      # access to the main one cannot alter the log.
      # type: "@swamp/s3-datastore"
      # config:
      #   bucket: my-audit-bucket
      #   region: us-east-1
      retention:
        days: 90
`;

export const AUDIT_COLUMNS = [
  "Time",
  "",
  "Category",
  "Action",
  "Initiated by",
  "Resource",
] as const;

function Icon({ path }: { path: string }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: path }}
    />
  );
}

const ICON_WHO =
  '<circle cx="9" cy="6" r="3"/><path d="M3 16c.8-3 3.2-4.5 6-4.5s5.2 1.5 6 4.5"/>';
const ICON_LIVE = '<path d="M2 9h3l2-5 3 10 2-5h4"/>';
const ICON_EXPORT =
  '<path d="M9 2v9M5.5 7.5 9 11l3.5-3.5"/><path d="M3 12v3h12v-3"/>';
const ICON_LOCK =
  '<rect x="3.5" y="8" width="11" height="8" rx="1.5"/><path d="M6 8V5.5a3 3 0 016 0V8"/>';

/** Writes text to the clipboard, resolving whether it worked. */
export type CopyFn = (text: string) => Promise<boolean>;

/**
 * A copyable code block; announces the copy to screen readers. `copy` is
 * passed in (components/clipboard.ts in the app) so this renders outside a
 * browser.
 */
export function CopyableSnippet(
  { code, label, copy }: { code: string; label: string; copy: CopyFn },
) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onCopy = () => {
    copy(code)
      .then((ok) => setCopied(ok ? "copied" : "failed"))
      .catch(() => setCopied("failed"))
      .finally(() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied("idle"), 2000);
      });
  };

  return (
    <div className="act-snippet">
      <div className="act-snippet-head">
        <span className="mono">{label}</span>
        <button
          type="button"
          className="act-copy"
          onClick={onCopy}
          aria-label={`Copy ${label} snippet`}
        >
          {copied === "copied"
            ? "Copied"
            : copied === "failed"
            ? "Copy failed"
            : "Copy"}
        </button>
      </div>
      <pre className="act-snippet-code">
        <code>{code}</code>
      </pre>
      <span className="visually-hidden" aria-live="polite">
        {copied === "copied" ? "Snippet copied to the clipboard" : ""}
      </span>
    </div>
  );
}

function Benefit(
  { icon, title, children }: {
    icon: string;
    title: string;
    children: ReactNode;
  },
) {
  return (
    <li className="act-benefit">
      <span className="act-benefit-icon">
        <Icon path={icon} />
      </span>
      <span>
        <strong>{title}</strong>
        <span>{children}</span>
      </span>
    </li>
  );
}

/** Serve runs without an audit log: what it would give, and how to turn it on. */
export function AuditDisabledState({ copy }: { copy: CopyFn }) {
  return (
    <section
      className="act-state act-disabled"
      aria-labelledby="audit-disabled-title"
      data-audit-state="disabled"
    >
      <div className="act-state-intro">
        <span className="act-state-badge">Audit log off</span>
        <h2 id="audit-disabled-title">See who did what, as it happens</h2>
        <p>
          This server is running without an audit log, so there is no activity
          to show. Turn it on to record every request made to{" "}
          <code>swamp serve</code>.
        </p>
      </div>

      <ul className="act-benefits">
        <Benefit icon={ICON_WHO} title="Who ran, approved or changed what">
          Every run, approval, secret read and config change, attributed to the
          user or token behind it, with the access decision that allowed it.
        </Benefit>
        <Benefit icon={ICON_LIVE} title="A live activity feed">
          Events stream onto this page as they happen, filterable by category
          and outcome.
        </Benefit>
        <Benefit icon={ICON_EXPORT} title="Search and export">
          Query history with <code>swamp audit log</code>, follow it with{" "}
          <code>--follow</code>, or export it as JSON or CEF for your SIEM.
        </Benefit>
        <Benefit icon={ICON_LOCK} title="Tamper-evident">
          Events are chain-hashed; <code>swamp audit verify</code>{" "}
          reports gaps or edits.
        </Benefit>
      </ul>

      <div className="act-enable">
        <h3>Turn it on</h3>
        <ol className="act-steps">
          <li>
            Add an <code>audit</code> block to <code>{SERVE_CONFIG_PATH}</code>
            {" "}
            (or the file you pass to <code>swamp serve --config</code>):
            <CopyableSnippet
              code={AUDIT_CONFIG_SNIPPET}
              label="serve.yaml"
              copy={copy}
            />
          </li>
          <li>
            Check it with <code>swamp serve check-config</code>, then restart
            {" "}
            <code>swamp serve</code>.
          </li>
          <li>
            Reading the log needs <code>admin</code> on{" "}
            <code>access:audit</code>.
          </li>
        </ol>
        <ul className="act-doc-links">
          {AUDIT_MANUAL_LINKS.map((link) => (
            <li key={link.href}>
              <a
                className="act-doc-link"
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {link.label}
                <span aria-hidden="true">↗</span>
                <span className="visually-hidden">(opens in a new tab)</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** The signed-in principal may not read the audit log. */
export function AuditDeniedState({ message }: { message?: string | null }) {
  return (
    <section
      className="act-state act-compact"
      role="status"
      data-audit-state="denied"
    >
      <span className="act-state-badge act-badge-warning">No access</span>
      <h2>You can't view the audit log</h2>
      <p>
        Reading activity needs <code>admin</code> on <code>access:audit</code>.
        {" "}
        Ask an administrator to grant it.
      </p>
      {message && <p className="act-state-detail mono">{message}</p>}
    </section>
  );
}

/** The live feed failed for a reason other than audit being off. */
export function AuditErrorState(
  { message, onRetry }: { message?: string | null; onRetry: () => void },
) {
  return (
    <section
      className="act-state act-compact"
      role="alert"
      data-audit-state="error"
    >
      <span className="act-state-badge act-badge-danger">Disconnected</span>
      <h2>The live activity feed stopped</h2>
      {message && <p className="act-state-detail mono">{message}</p>}
      <button type="button" className="act-button" onClick={onRetry}>
        Reconnect
      </button>
    </section>
  );
}

const GRID = "act-row-grid";

/** Placeholder rows shaped like the feed while it loads. */
/**
 * What the feed area shows: only the error when the stream failed with
 * nothing to show (never "No activity yet" for a feed that didn't load), a
 * skeleton until the first answer, else the feed.
 */
export function auditFeedView(
  status: string,
  eventCount: number,
  historyLoaded: boolean,
): "error" | "loading" | "feed" {
  if (eventCount > 0) return "feed";
  if (status === "error") return "error";
  return !historyLoaded || status === "connecting" ? "loading" : "feed";
}

export function AuditFeedSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <SkeletonRegion label="Loading activity" className="act-feed">
      <div className={`${GRID} act-feed-head`} aria-hidden="true">
        {AUDIT_COLUMNS.map((c, i) => <span key={i}>{c}</span>)}
      </div>
      {Array.from(
        { length: rows },
        (_, i) => (
          <div className={`${GRID} act-skel-row`} key={i}>
            <Skeleton width={56} height={10} />
            <Skeleton width={8} height={8} radius="50%" />
            <Skeleton width={58} height={16} radius={4} />
            <Skeleton width={widthAt(i)} height={10} />
            <Skeleton width={widthAt(i + 3)} height={10} />
            <Skeleton width={widthAt(i + 5)} height={10} />
          </div>
        ),
      )}
    </SkeletonRegion>
  );
}

const STATUS_TEXT: Record<
  Exclude<AuditStatus, "disabled" | "denied">,
  { label: string; hint: string }
> = {
  live: { label: "Live", hint: "Pause the live feed" },
  connecting: { label: "Connecting…", hint: "Pause the live feed" },
  paused: { label: "Paused", hint: "Resume the live feed" },
  error: { label: "Disconnected", hint: "Reconnect the live feed" },
};

/**
 * The live/paused toggle. Renders nothing when there is no feed to toggle
 * (audit off or access denied).
 */
export function AuditLiveToggle(
  { status, onToggle }: { status: AuditStatus; onToggle: () => void },
) {
  if (status === "disabled" || status === "denied") return null;
  const { label, hint } = STATUS_TEXT[status];
  return (
    <button
      type="button"
      className={`act-live act-live-${status}`}
      onClick={onToggle}
      aria-pressed={status === "live" || status === "connecting"}
      title={hint}
    >
      <span className="act-live-dot" aria-hidden="true" />
      <span>{label}</span>
      <span className="visually-hidden">— {hint}</span>
    </button>
  );
}
