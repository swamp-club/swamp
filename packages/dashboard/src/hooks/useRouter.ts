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

import { useCallback, useSyncExternalStore } from "react";
import type { View } from "../types.ts";
import {
  buildPath,
  type DetailView,
  parseRoute,
  type RouteState,
} from "../routes.ts";

let currentState: RouteState = parseRoute(location.pathname);
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): RouteState {
  return currentState;
}

function pushState(next: RouteState) {
  const path = buildPath(next);
  if (path !== buildPath(currentState)) {
    history.pushState(null, "", path);
  }
  currentState = next;
  notify();
}

function onPopState() {
  currentState = parseRoute(location.pathname);
  notify();
}

addEventListener("popstate", onPopState);

export interface Router {
  view: View;
  detail: DetailView;
  navigate: (view: View) => void;
  openModel: (modelName: string) => void;
  openWorkflow: (workflowName: string) => void;
  openRun: (workflowName: string, runId?: string) => void;
  closeDetail: () => void;
}

export function useRouter(): Router {
  const state = useSyncExternalStore(subscribe, getSnapshot);

  const navigate = useCallback((view: View) => {
    pushState({ view, detail: null });
  }, []);

  const openModel = useCallback((modelName: string) => {
    pushState({ view: "models", detail: { kind: "model", modelName } });
  }, []);

  const openWorkflow = useCallback((workflowName: string) => {
    pushState({
      view: "workflows",
      detail: { kind: "workflow", workflowName },
    });
  }, []);

  const openRun = useCallback(
    (workflowName: string, runId?: string) => {
      pushState({
        view: "workflows",
        detail: { kind: "run", workflowName, runId },
      });
    },
    [],
  );

  const closeDetail = useCallback(() => {
    pushState({ view: state.view, detail: null });
  }, [state.view]);

  return {
    view: state.view,
    detail: state.detail,
    navigate,
    openModel,
    openWorkflow,
    openRun,
    closeDetail,
  };
}
