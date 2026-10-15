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

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import {
  keepLocalToken,
  localToken,
  PAGE_WORKSPACE,
} from "./client/workspace_path.ts";
import { parseTokenFromHash } from "./views/start/helpers.ts";
// Self-hosted fonts: the dashboard is served locally and makes no
// third-party requests.
import "@fontsource/orbitron/900.css";
import "@fontsource/plus-jakarta-sans/400.css";
import "@fontsource/plus-jakarta-sans/500.css";
import "@fontsource/plus-jakarta-sans/600.css";
import "@fontsource/plus-jakarta-sans/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles.css";

// `swamp dashboard` lands on a workspace's dashboard with the start token in
// the fragment: keep it, as the start page would, so "All workspaces" works.
// A workspace page keeps the token its URL carried (or the start page's) for
// this tab and later ones, and takes it out of the address bar.
if (PAGE_WORKSPACE !== null) {
  const token = parseTokenFromHash(location.hash) ?? localToken();
  if (token) keepLocalToken(token);
  if (location.hash) {
    history.replaceState(null, "", location.pathname + location.search);
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
