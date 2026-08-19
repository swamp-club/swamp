import type { HealthSnapshot } from "../client/useHealthStream";
import { Logo } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";

export type View =
  | "overview"
  | "workflows"
  | "executions"
  | "models"
  | "schedules"
  | "webhooks"
  | "approvals"
  | "data"
  | "vaults"
  | "extensions"
  | "system";

const ICONS: Record<string, string> = {
  overview:
    '<rect x="1" y="1" width="7" height="7" rx="1.5"/><rect x="10" y="1" width="7" height="7" rx="1.5"/><rect x="1" y="10" width="7" height="7" rx="1.5"/><rect x="10" y="10" width="7" height="7" rx="1.5"/>',
  workflows:
    '<circle cx="4" cy="4" r="2.5"/><circle cx="14" cy="9" r="2.5"/><circle cx="4" cy="14" r="2.5"/><path d="M6.5 4H10a1 1 0 011 1v3.5M6.5 14H10a1 1 0 001-1V9.5"/>',
  executions: '<path d="M3 3v12h12"/><path d="M6 12l3-4 3 2 3-5"/>',
  models:
    '<rect x="2" y="3" width="14" height="12" rx="2"/><path d="M6 7h6M6 10h4"/>',
  schedules: '<circle cx="9" cy="9" r="7"/><path d="M9 5v4l2.5 2.5"/>',
  webhooks:
    '<path d="M9 2v3M9 13v3M2 9h3M13 9h3M4.2 4.2l2.1 2.1M11.7 11.7l2.1 2.1M4.2 13.8l2.1-2.1M11.7 6.3l2.1-2.1"/>',
  approvals:
    '<path d="M9 2l7 4v6l-7 4-7-4V6z"/><path d="M2 6l7 4m0 0l7-4m-7 4v8"/>',
  data: '<rect x="2" y="2" width="14" height="14" rx="2"/><path d="M2 6h14M6 6v10"/>',
  vaults:
    '<rect x="4" y="2" width="10" height="14" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M9 2v5M9 11v5M4 9h3M11 9h3"/>',
  extensions: '<path d="M3 5h12M3 9h12M3 13h8"/>',
  system:
    '<path d="M9 2a7 7 0 110 14A7 7 0 019 2z"/><path d="M12 9a3 3 0 01-6 0 3 3 0 016 0z"/><path d="M9 1v2M9 15v2M1 9h2M15 9h2M3.3 3.3l1.4 1.4M13.3 13.3l1.4 1.4M3.3 14.7l1.4-1.4M13.3 4.7l1.4-1.4"/>',
};

interface NavItemProps {
  label: string;
  view: View;
  active: boolean;
  onClick: (view: View) => void;
  badge?: number;
}

function NavItem({ label, view, active, onClick, badge }: NavItemProps) {
  const iconSvg = ICONS[view] ?? "";
  return (
    <div
      className={`nav-item${active ? " active" : ""}`}
      onClick={() => onClick(view)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        borderRadius: 6,
        color: active ? "var(--sidebar-text-active)" : "var(--sidebar-text)",
        background: active ? "var(--sidebar-active)" : "transparent",
        cursor: "pointer",
        fontSize: "0.88rem",
        fontWeight: 500,
        position: "relative",
        userSelect: "none",
        transition: "background 0.15s, color 0.15s",
      }}
    >
      {active && (
        <span
          style={{
            position: "absolute",
            left: 0,
            top: "50%",
            transform: "translateY(-50%)",
            width: 3,
            height: 16,
            borderRadius: "0 2px 2px 0",
            background: "var(--sidebar-accent)",
          }}
        />
      )}
      <svg
        width="18"
        height="18"
        viewBox="0 0 18 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        style={{ flexShrink: 0, opacity: active ? 1 : 0.7 }}
        dangerouslySetInnerHTML={{ __html: iconSvg }}
      />
      {label}
      {badge !== undefined && badge > 0 && (
        <span
          style={{
            marginLeft: "auto",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "0.65rem",
            fontWeight: 500,
            padding: "1px 7px",
            borderRadius: 10,
            background: "var(--sidebar-accent)",
            color: "#000",
          }}
        >
          {badge}
        </span>
      )}
    </div>
  );
}

interface SidebarProps {
  activeView: View;
  onNavigate: (view: View) => void;
  health: HealthSnapshot | null;
  approvalCount: number;
  onLogout: () => void;
}

export function Sidebar({
  activeView,
  onNavigate,
  health,
  approvalCount,
  onLogout,
}: SidebarProps) {
  return (
    <nav
      style={{
        background: "var(--sidebar-bg)",
        borderRight: "1px solid rgba(255,255,255,0.06)",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
      }}
    >
      <div
        style={{
          padding: "20px 20px 24px",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <Logo size="md" />
        <span
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

      <div style={{ padding: "0 8px", marginBottom: 24 }}>
        <SectionLabel text="Overview" />
        <NavItem
          label="Dashboard"
          view="overview"
          active={activeView === "overview"}
          onClick={onNavigate}
        />
      </div>

      <div style={{ padding: "0 8px", marginBottom: 24 }}>
        <SectionLabel text="Automation" />
        <NavItem
          label="Workflows"
          view="workflows"
          active={activeView === "workflows"}
          onClick={onNavigate}
        />
        <NavItem
          label="Executions"
          view="executions"
          active={activeView === "executions"}
          onClick={onNavigate}
        />
        <NavItem
          label="Models"
          view="models"
          active={activeView === "models"}
          onClick={onNavigate}
        />
      </div>

      <div style={{ padding: "0 8px", marginBottom: 24 }}>
        <SectionLabel text="Operations" />
        <NavItem
          label="Schedules"
          view="schedules"
          active={activeView === "schedules"}
          onClick={onNavigate}
        />
        <NavItem
          label="Webhooks"
          view="webhooks"
          active={activeView === "webhooks"}
          onClick={onNavigate}
        />
        <NavItem
          label="Approvals"
          view="approvals"
          active={activeView === "approvals"}
          onClick={onNavigate}
          badge={approvalCount > 0 ? approvalCount : undefined}
        />
      </div>

      <div style={{ padding: "0 8px", marginBottom: 24 }}>
        <SectionLabel text="System" />
        <NavItem
          label="Data"
          view="data"
          active={activeView === "data"}
          onClick={onNavigate}
        />
        <NavItem
          label="Vaults"
          view="vaults"
          active={activeView === "vaults"}
          onClick={onNavigate}
        />
        <NavItem
          label="Extensions"
          view="extensions"
          active={activeView === "extensions"}
          onClick={onNavigate}
        />
        <NavItem
          label="System"
          view="system"
          active={activeView === "system"}
          onClick={onNavigate}
        />
      </div>

      <ThemeToggle />

      <div
        style={{
          marginTop: "auto",
          padding: 16,
          borderTop: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        {health && (
          <>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: "0.75rem",
                color: "var(--sidebar-text)",
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: health.ready
                    ? "var(--sidebar-accent)"
                    : "var(--warning)",
                  flexShrink: 0,
                }}
              />
              {health.ready ? "Instance healthy" : "Degraded"}
            </div>
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "0.65rem",
                color: "var(--sidebar-text)",
                opacity: 0.6,
                marginTop: 4,
              }}
            >
              {health.instanceId.slice(0, 8)} &middot;{" "}
              {formatUptime(health.uptimeMs)}
            </div>
          </>
        )}
        <button
          type="button"
          onClick={onLogout}
          style={{
            marginTop: 12,
            width: "100%",
            padding: "6px 0",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 5,
            background: "transparent",
            color: "var(--sidebar-text)",
            fontSize: "0.75rem",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Logout
        </button>
      </div>
    </nav>
  );
}

function SectionLabel({ text }: { text: string }) {
  return (
    <div
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
      {text}
    </div>
  );
}

function formatUptime(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m uptime`;
  return `${minutes}m uptime`;
}
