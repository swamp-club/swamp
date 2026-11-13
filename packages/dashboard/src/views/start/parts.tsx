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

import { type ReactNode, useCallback, useState } from "react";
import { RequestError } from "../../client/stream.ts";
import type { StartClient } from "./client.ts";
import {
  type LaunchStep,
  startErrorText,
  toLaunchEvent,
  workspaceChooseError,
} from "./helpers.ts";
import type { StartStatus } from "./types.ts";

export interface ScreenProps {
  status: StartStatus;
  client: StartClient;
  onStatus: (status: StartStatus) => void;
}

export function errorMessage(error: unknown, fallback: string): string {
  const friendly = error instanceof RequestError
    ? startErrorText(error.code)
    : null;
  if (friendly) return friendly;
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Runs one status-returning request at a time and keeps its error.
 */
export function useAction(
  onStatus: (status: StartStatus) => void,
  describeError?: (error: unknown) => string,
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (action: () => Promise<StartStatus>): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        onStatus(await action());
        return true;
      } catch (err) {
        setError(
          describeError
            ? describeError(err)
            : errorMessage(err, "Something went wrong. Try again."),
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onStatus, describeError],
  );
  return { busy, error, run, setError };
}

export function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="login-error" role="alert">{message}</div>;
}

export function describeChooseError(err: unknown): string {
  return workspaceChooseError(
    err instanceof RequestError ? err.code : undefined,
    err instanceof Error ? err.message : "",
  );
}

/** The workspace screen below its heading: the past-sessions card comes first. */
export function WorkspaceSections(
  { pastSessions, workspaces, after }: {
    pastSessions: ReactNode;
    workspaces: ReactNode;
    after: ReactNode;
  },
) {
  return (
    <>
      {pastSessions}
      {workspaces}
      {after}
    </>
  );
}

/**
 * Streams `start.launch` (or `start.resume`), tracking the furthest step and
 * any error. `launch` resolves true once the agent launched.
 */
export function useLaunch(
  client: StartClient,
  onStatus: (s: StartStatus) => void,
  request: "start.launch" | "start.resume" = "start.launch",
) {
  const [reached, setReached] = useState<LaunchStep | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `trustConfirmed` carries the user's trust confirmation with a resume;
  // `start.launch` always does, since only the trust screen sends it.
  const launch = useCallback(async (trustConfirmed = false) => {
    setRunning(true);
    setReached(null);
    setError(null);
    let failed = false;
    try {
      const status = await client.stream<StartStatus>(
        request,
        request === "start.launch" || trustConfirmed
          ? { trustConfirmed: true }
          : undefined,
        (raw) => {
          const event = toLaunchEvent(raw);
          if (!event) return;
          if (event.kind === "error") {
            failed = true;
            setError(event.message);
          } else {
            setReached(event.kind);
          }
        },
      );
      onStatus(status);
    } catch (err) {
      failed = true;
      setError(errorMessage(err, "Launch failed."));
    } finally {
      setRunning(false);
      if (!failed) setReached(null);
    }
    return !failed;
  }, [client, onStatus, request]);

  return { launch, running, reached, error };
}
