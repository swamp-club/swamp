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

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import type { SwampClient } from "../client/client.ts";
import type {
  AppRequestMap,
  AppRequestType,
  DataChange,
  ModelMethodRunPayload,
  ModelMethodRunView,
  WorkflowRunPayload,
} from "../client/protocol.ts";
import { type DataChangesMode, followDataChanges } from "./data_changes.ts";
import {
  IDLE_METHOD_RUN,
  methodRunReducer,
  type MethodRunState,
} from "./method_run_state.ts";
import {
  IDLE_RUN,
  runReducer,
  type RunState,
  type RunStreamEvent,
} from "./run_state.ts";
import type { AppInfo, AppTheme, BridgePort } from "./bridge.ts";
import type { BridgeTransport } from "./bridge_transport.ts";
import { connectApp } from "./connect.ts";

interface SwampAppValue {
  readonly client: SwampClient;
  readonly connected: boolean;
  readonly app: AppInfo;
  readonly theme: AppTheme;
  readonly visible: boolean;
  readonly path: string;
  readonly health: unknown;
  /** Sends one read the app's capabilities allow, typed by its name. */
  request<K extends AppRequestType>(
    type: K,
    ...payload: PayloadArg<K>
  ): Promise<AppRequestMap[K]["reply"]>;
  /** Moves the dashboard's address to this path inside the app. */
  navigate(path: string): void;
  subscribeHealth(): () => void;
}

/** A request whose payload serve treats as optional may leave it out. */
type PayloadArg<K extends AppRequestType> = undefined extends
  AppRequestMap[K]["payload"] ? [payload?: AppRequestMap[K]["payload"]]
  : [payload: AppRequestMap[K]["payload"]];

function sendRequest<K extends AppRequestType>(
  client: SwampClient,
  type: K,
  payload: AppRequestMap[K]["payload"] | undefined,
): Promise<AppRequestMap[K]["reply"]> {
  return client.request<AppRequestMap[K]["reply"]>(
    type,
    payload as Record<string, unknown> | undefined,
  );
}

const SwampAppContext = createContext<SwampAppValue | null>(null);

/** Applies host tokens as `--swamp-*`, which `theme.css` maps for shadcn. */
export function applyTheme(theme: AppTheme): void {
  const root = document.documentElement;
  root.dataset.theme = theme.mode;
  root.classList.toggle("dark", theme.mode === "dark");
  for (const [name, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(`--swamp-${name}`, value);
  }
}

export function SwampAppProvider(
  { children, port, fallback = null }: {
    children: ReactNode;
    /** A mock host's port; leave unset inside the dashboard. */
    port?: BridgePort;
    fallback?: ReactNode;
  },
) {
  const [state, setState] = useState<
    {
      client: SwampClient;
      transport: BridgeTransport;
      app: AppInfo;
    } | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [theme, setTheme] = useState<AppTheme>({ mode: "light", tokens: {} });
  const [visible, setVisible] = useState(true);
  const [path, setPath] = useState("/");
  const [health, setHealth] = useState<unknown>(null);
  const subscribers = useRef(0);

  useEffect(() => {
    let active = true;
    connectApp({
      onTheme: (next) => {
        applyTheme(next);
        setTheme(next);
      },
      onConnection: setConnected,
      onHealth: setHealth,
      onVisibility: setVisible,
      onPath: setPath,
    }, port).then(({ client, session, transport }) => {
      if (!active) return;
      applyTheme(session.theme);
      setTheme(session.theme);
      setConnected(session.connected);
      setPath(session.path);
      setState({ client, transport, app: session.app });
    }).catch((reason: unknown) => {
      if (active) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
    return () => {
      active = false;
    };
  }, [port]);

  const transport = state?.transport;
  const client = state?.client;
  const request = useCallback(
    <K extends AppRequestType>(type: K, ...payload: PayloadArg<K>) => {
      if (client === undefined) {
        return Promise.reject(new Error("The app is not connected yet."));
      }
      return sendRequest(client, type, payload[0]);
    },
    [client],
  );
  const navigate = useCallback((next: string) => {
    transport?.post({ kind: "navigate", path: next });
    setPath(next);
  }, [transport]);

  const subscribeHealth = useCallback(() => {
    if (subscribers.current++ === 0) {
      transport?.post({ kind: "health-subscribe" });
    }
    return () => {
      if (--subscribers.current === 0) {
        transport?.post({ kind: "health-unsubscribe" });
      }
    };
  }, [transport]);

  if (error !== null) return <p role="alert">{error}</p>;
  if (state === null) return <>{fallback}</>;
  return (
    <SwampAppContext.Provider
      value={{
        client: state.client,
        app: state.app,
        connected,
        theme,
        visible,
        path,
        health,
        request,
        navigate,
        subscribeHealth,
      }}
    >
      {children}
    </SwampAppContext.Provider>
  );
}

export function useSwamp(): SwampAppValue {
  const value = useContext(SwampAppContext);
  if (value === null) {
    throw new Error("useSwamp must be used within SwampAppProvider");
  }
  return value;
}

export function useTheme(): AppTheme {
  return useSwamp().theme;
}

/** The latest health snapshot, while this component is mounted. */
export function useHealth<T = unknown>(): T | null {
  const { health, subscribeHealth } = useSwamp();
  useEffect(() => subscribeHealth(), [subscribeHealth]);
  return health as T | null;
}

export interface UseRequestResult<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: string | null;
  refetch(): void;
}

export interface UseRequestOptions {
  /** False holds the request back, e.g. until its payload is known. */
  enabled?: boolean;
}

/** The name picks the payload and reply types, so a typo or a wrong field fails to compile. */
export function useRequest<K extends AppRequestType>(
  type: K,
  ...args: [...PayloadArg<K>, options?: UseRequestOptions]
): UseRequestResult<AppRequestMap[K]["reply"]> {
  const { client, connected } = useSwamp();
  const payload = args[0] as AppRequestMap[K]["payload"] | undefined;
  const options = (args[1] ?? {}) as UseRequestOptions;
  const enabled = options.enabled ?? true;
  const [data, setData] = useState<AppRequestMap[K]["reply"] | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify(payload ?? null);

  useEffect(() => {
    if (!enabled || !connected) return;
    let current = true;
    setLoading(true);
    setError(null);
    sendRequest(client, type, JSON.parse(key) ?? undefined)
      .then((value) => {
        if (current) setData(value);
      })
      .catch((reason: unknown) => {
        if (current) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [client, connected, enabled, type, key, attempt]);

  const refetch = useCallback(() => setAttempt((n) => n + 1), []);
  return { data, loading, error, refetch };
}

export interface UseWorkflowRun {
  /** The run as its events have built it; `IDLE_RUN` before any. */
  readonly run: RunState;
  /** Whether events are still arriving; false once the run ends or `stop()`. */
  readonly following: boolean;
  /** Starts a workflow listed under `run:` and follows it. */
  start(payload: WorkflowRunPayload): Promise<void>;
  /** Follows a run already going; needs `runs:read`. */
  attach(runId: string): Promise<void>;
  /** Stops following; the run itself goes on. */
  stop(): void;
}

/** Starting or attaching a run lets the previous one go, as does unmounting. */
export function useWorkflowRun(): UseWorkflowRun {
  const { client } = useSwamp();
  const [run, dispatch] = useReducer(runReducer, IDLE_RUN);
  const following = useRef<AbortController | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => () => following.current?.abort(), []);

  const follow = useCallback(
    async (open: (signal: AbortSignal) => AsyncIterable<RunStreamEvent>) => {
      following.current?.abort();
      const controller = new AbortController();
      following.current = controller;
      setActive(true);
      dispatch({ kind: "begin", at: Date.now() });
      try {
        for await (const event of open(controller.signal)) {
          if (controller.signal.aborted) return;
          dispatch({ kind: "event", at: Date.now(), event });
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          dispatch({
            kind: "failed",
            at: Date.now(),
            error: reason instanceof Error ? reason.message : String(reason),
          });
        }
      } finally {
        if (following.current === controller) {
          following.current = null;
          setActive(false);
        }
      }
    },
    [],
  );

  const start = useCallback(
    (payload: WorkflowRunPayload) =>
      follow((signal) => client.workflowRunStream(payload, { signal })),
    [client, follow],
  );
  const attach = useCallback(
    (runId: string) =>
      follow((signal) => client.runAttachStream({ runId }, { signal })),
    [client, follow],
  );
  const stop = useCallback(() => {
    following.current?.abort();
    following.current = null;
    setActive(false);
  }, []);

  return { run, following: active, start, attach, stop };
}

export interface UseMethodRun {
  /** The latest call, as its events have built it; `IDLE_METHOD_RUN` before any. */
  readonly state: MethodRunState;
  /** Whether any call is still running. */
  readonly running: boolean;
  /** Rejects with why the run failed, so each caller handles its own call. */
  run(payload: ModelMethodRunPayload): Promise<ModelMethodRunView>;
}

/** Calls may overlap: each resolves on its own and `state` follows the latest; unmounting leaves them running. */
export function useMethodRun(): UseMethodRun {
  const { client } = useSwamp();
  const [state, dispatch] = useReducer(methodRunReducer, IDLE_METHOD_RUN);
  const [inFlight, setInFlight] = useState(0);
  const controllers = useRef(new Set<AbortController>());
  const latest = useRef<AbortController | null>(null);

  useEffect(() => () => {
    for (const controller of controllers.current) controller.abort();
  }, []);

  const run = useCallback(
    async (payload: ModelMethodRunPayload): Promise<ModelMethodRunView> => {
      const controller = new AbortController();
      controllers.current.add(controller);
      latest.current = controller;
      const show = (action: Parameters<typeof methodRunReducer>[1]) => {
        if (latest.current === controller && !controller.signal.aborted) {
          dispatch(action);
        }
      };
      setInFlight((n) => n + 1);
      show({
        kind: "begin",
        modelName: payload.modelIdOrName,
        methodName: payload.methodName,
      });
      try {
        const events = client.modelMethodRunStream(payload, {
          signal: controller.signal,
        });
        for await (const event of events) {
          show({ kind: "event", event });
          if (event.kind === "error") throw new Error(event.error.message);
          if (event.kind === "cancelled") {
            throw new Error(
              event.reason ?? `${payload.methodName} was cancelled`,
            );
          }
          if (event.kind === "completed") {
            if (event.run.status !== "succeeded") {
              throw new Error(
                `${payload.methodName} finished ${event.run.status}`,
              );
            }
            return event.run;
          }
        }
        throw new Error(`${payload.methodName} ended without a result`);
      } catch (reason) {
        const error = reason instanceof Error
          ? reason
          : new Error(String(reason));
        show({ kind: "failed", error: error.message });
        throw error;
      } finally {
        controllers.current.delete(controller);
        setInFlight((n) => n - 1);
      }
    },
    [client],
  );

  return { state, running: inFlight > 0, run };
}

export interface UseDataChangesOptions {
  /** Behavior names to hear about; any the viewer may read when absent. */
  readonly behaviors?: readonly string[];
  /** Behavior types to hear about; any when absent. */
  readonly types?: readonly string[];
  /** How often to look again where serve has no change feed; 5 s by default. */
  readonly pollMs?: number;
  /** False holds the subscription back. */
  readonly enabled?: boolean;
}

export interface UseDataChanges {
  /** Moves whenever data may have changed, missed changes included; refetch when it does. */
  readonly version: number;
  /** `live` while serve pushes changes, `polling` where it cannot. */
  readonly mode: DataChangesMode;
  /** The newest changes heard, oldest first, up to 200. */
  readonly changes: readonly DataChange[];
}

const MAX_KEPT_CHANGES = 200;

/** Pushed where serve keeps a change feed, polled where not; a dropped subscription resumes from its cursor. */
export function useDataChanges(
  options: UseDataChangesOptions = {},
): UseDataChanges {
  const { client } = useSwamp();
  const [version, setVersion] = useState(0);
  const [mode, setMode] = useState<DataChangesMode>("connecting");
  const [changes, setChanges] = useState<readonly DataChange[]>([]);
  const enabled = options.enabled ?? true;
  const pollMs = options.pollMs ?? 5_000;
  const filter = JSON.stringify({
    ...(options.behaviors ? { behaviors: options.behaviors } : {}),
    ...(options.types ? { types: options.types } : {}),
  });

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const { signal } = controller;
    const bump = () => setVersion((v) => v + 1);
    followDataChanges({
      filter: JSON.parse(filter),
      signal,
      pollMs,
      subscribe: (payload, signal) =>
        client.dataSubscribeStream(payload, { signal }),
      onChanges: (page) => {
        setChanges((kept) =>
          [...kept, ...page.changes].slice(-MAX_KEPT_CHANGES)
        );
        bump();
      },
      onStale: bump,
      onMode: setMode,
      wait: (ms) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        }),
    }).catch(() => setMode("connecting"));
    return () => controller.abort();
  }, [client, enabled, filter, pollMs]);

  return { version, mode, changes };
}
