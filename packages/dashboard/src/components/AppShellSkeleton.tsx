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
import type { CSSProperties } from "react";
import { Logo } from "./Logo.tsx";
import {
  Skeleton,
  SkeletonChart,
  SkeletonStats,
  widthAt,
} from "./Skeleton.tsx";
import { parseCollapsed, SIDEBAR_COLLAPSED_KEY } from "./sidebar_state.ts";

// The whole dashboard's frame while the app is still connecting: the
// sidebar with its real sections, and a page of placeholders shaped like
// the Overview (header, stat cards, chart, panels). It uses the app
// shell's own classes, so the collapsed rail and the mobile drawer
// behave exactly as they will once connected, and inline styles only, so
// it renders before any view's stylesheet has loaded.

const NAV: Array<[string, string[]]> = [
  ["Overview", ["Dashboard"]],
  ["Automation", ["Workflows", "Executions", "Models"]],
  ["Operations", ["Schedules", "Webhooks", "Approvals", "Activity"]],
  ["System", ["Data", "Vaults", "Extensions", "System"]],
];

// Placeholders on the always-dark sidebar use its own hover tone, so they
// read in both themes.
const ON_SIDEBAR: CSSProperties = { backgroundColor: "var(--sidebar-hover)" };

function readCollapsed(): boolean {
  try {
    return parseCollapsed(
      globalThis.localStorage?.getItem(SIDEBAR_COLLAPSED_KEY) ?? null,
    );
  } catch {
    return false;
  }
}

/**
 * The full-layout loading state shown before the dashboard can render —
 * while the auth mode is being discovered and while the connection to
 * serve opens. `label` is the visible and announced status ("Connecting to
 * swamp serve"). `collapsed` defaults to the viewer's saved rail state.
 */
export function AppShellSkeleton(
  { label = "Connecting", collapsed }: {
    label?: string;
    collapsed?: boolean;
  },
) {
  const isCollapsed = collapsed ?? readCollapsed();
  return (
    <div className={`app${isCollapsed ? " sidebar-collapsed" : ""}`}>
      <nav
        className="sidebar"
        aria-hidden="true"
        style={{
          background: "var(--sidebar-bg)",
          borderRight: "1px solid rgba(255,255,255,0.06)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          className="sidebar-header"
          style={{ display: "flex", alignItems: "center", gap: 10 }}
        >
          <Logo size="md" />
          <span
            className="sidebar-brand-text"
            style={{
              fontWeight: 600,
              fontSize: "0.82rem",
              color: "var(--sidebar-text)",
              letterSpacing: "0.02em",
            }}
          >
            Swamp
          </span>
        </div>
        {NAV.map(([section, items]) => (
          <div key={section} style={{ padding: "0 8px", marginBottom: 24 }}>
            <div
              className="sidebar-section-label"
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "0.6rem",
                fontWeight: 500,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--sidebar-text)",
                opacity: 0.5,
                padding: "0 12px 8px",
              }}
            >
              {section}
            </div>
            {items.map((item) => (
              <div
                key={item}
                className="nav-item"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 12px",
                  color: "var(--sidebar-text)",
                  fontSize: "0.88rem",
                  fontWeight: 500,
                  opacity: 0.55,
                }}
              >
                <Skeleton
                  width={18}
                  height={18}
                  radius={5}
                  style={ON_SIDEBAR}
                />
                <span className="nav-label">{item}</span>
              </div>
            ))}
          </div>
        ))}
        <div
          className="sidebar-footer"
          style={{
            marginTop: "auto",
            padding: 16,
            borderTop: "1px solid rgba(255,255,255,0.06)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <Skeleton width="70%" height={10} style={ON_SIDEBAR} />
          <Skeleton
            width="50%"
            height={8}
            style={ON_SIDEBAR}
            className="sidebar-health-text"
          />
        </div>
      </nav>
      <main className="main">
        <div className="mobile-topbar">
          <Logo size="sm" />
        </div>
        <div
          role="status"
          aria-busy="true"
          aria-live="polite"
          className="skel-region"
        >
          <div className="page-header">
            <Skeleton width={160} height={26} radius={6} />
            <div className="header-right">
              <span
                style={{
                  fontSize: "0.8rem",
                  color: "var(--text-3)",
                }}
              >
                {label}…
              </span>
            </div>
          </div>
          <SkeletonStats count={4} />
          <div className="chart-section" aria-hidden="true">
            <div className="chart-header">
              <Skeleton width={96} height={14} />
              <Skeleton width={180} height={10} />
            </div>
            <div className="chart-area">
              <SkeletonChart height="100%" />
            </div>
          </div>
          <div className="panels-grid" aria-hidden="true">
            {[0, 1].map((p) => (
              <div className="panel" key={p}>
                <div className="panel-header">
                  <Skeleton width={p ? 132 : 96} height={12} />
                </div>
                {Array.from(
                  { length: 4 },
                  (_, i) => (
                    <div className="skel-list-row" key={i}>
                      <Skeleton width={8} height={8} radius="50%" />
                      <span
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 6,
                          flex: 1,
                        }}
                      >
                        <Skeleton width={widthAt(i + p)} height={11} />
                        <Skeleton width="30%" height={9} />
                      </span>
                      <Skeleton width={48} height={10} />
                    </div>
                  ),
                )}
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
