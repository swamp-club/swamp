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
import { useSwamp } from "../client/SwampProvider.tsx";
import { showsLogout } from "../components/sidebar_state.ts";
import { useHealthStream } from "../client/useHealthStream.ts";
import { useDocumentVisible } from "../client/run_activity.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { Logo } from "../components/Logo.tsx";
import { ThemeToggle } from "../components/ThemeToggle.tsx";
import { ThemePicker } from "../theme/ThemePicker.tsx";
import { AppFrame } from "./AppFrame.tsx";
import { useApps } from "./useApps.ts";
import {
  appPagePath,
  APPS_BASE,
  appsSegments,
  resolveAppPage,
} from "./apps_routes.ts";
import type { AppEntry } from "./app_types.ts";
import { isPlainLeftClick } from "../routes.ts";

function usePathname(): [string, (to: string, replace?: boolean) => void] {
  const [pathname, setPathname] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPathname(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const go = useCallback((to: string, replace = false) => {
    if (to === location.pathname) return;
    if (replace) history.replaceState(null, "", to);
    else history.pushState(null, "", to);
    setPathname(to);
  }, []);
  return [pathname, go];
}

/** The signed-in viewer's apps, outside the dashboard's chrome. */
export function AppsArea({ onLogout }: { onLogout: () => void }) {
  const { local, authMode } = useSwamp();
  const [pathname, go] = usePathname();
  const segments = appsSegments(pathname);
  const appOpen = segments.length > 0;
  const apps = useApps(appOpen);
  const { health } = useHealthStream(useDocumentVisible());
  const page = appOpen
    ? resolveAppPage(segments, apps.launchable.map((app) => app.name))
    : null;
  const current = page === null
    ? undefined
    : apps.launchable.find((app) => app.name === page.name);

  useEffect(() => {
    document.title = current ? `${current.title} · swamp` : "Apps · swamp";
  }, [current]);

  const link = (to: string) => (e: React.MouseEvent) => {
    if (!isPlainLeftClick(e)) return;
    e.preventDefault();
    go(to);
  };

  return (
    <div className="apps-area">
      <header className="apps-header">
        <a href={APPS_BASE} className="apps-home" onClick={link(APPS_BASE)}>
          <Logo size="sm" />
          <span>Apps</span>
        </a>
        {current && <span className="apps-current">{current.title}</span>}
        <nav className="apps-header-links">
          <ThemePicker placement="header" />
          <ThemeToggle placement="header" />
          {showsLogout(local, authMode) && (
            <button type="button" className="link-button" onClick={onLogout}>
              Log out
            </button>
          )}
        </nav>
      </header>
      <main className="apps-main">
        {!appOpen
          ? (
            <AppsIndex
              apps={apps.launchable}
              loaded={apps.loaded}
              onOpen={(name) => go(appPagePath(name))}
            />
          )
          : !apps.loaded
          ? <div className="app-frame-loading">Loading...</div>
          : page === null
          ? (
            <EmptyState title="This app isn't available">
              It isn't enabled, or you don't have access to it.
            </EmptyState>
          )
          : (
            <AppFrame
              key={page.name}
              name={page.name}
              path={page.path}
              health={health}
              onNavigate={(path) => go(appPagePath(page.name, path), true)}
            />
          )}
      </main>
    </div>
  );
}

function AppsIndex(
  { apps, loaded, onOpen }: {
    apps: readonly AppEntry[];
    loaded: boolean;
    onOpen: (name: string) => void;
  },
) {
  if (!loaded) return <div className="app-frame-loading">Loading...</div>;
  if (apps.length === 0) {
    return (
      <EmptyState title="No apps yet">
        There are no apps enabled that you have access to.
      </EmptyState>
    );
  }
  return (
    <ul className="apps-grid">
      {apps.map((app) => (
        <li key={app.name}>
          <a
            href={appPagePath(app.name)}
            className="apps-card"
            onClick={(e) => {
              if (!isPlainLeftClick(e)) return;
              e.preventDefault();
              onOpen(app.name);
            }}
          >
            <strong>{app.title}</strong>
            <small>{app.name}</small>
          </a>
        </li>
      ))}
    </ul>
  );
}
