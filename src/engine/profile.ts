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

import type { DatastoreConfig } from "../domain/datastore/datastore_config.ts";
import { UserError } from "../domain/errors.ts";
import { parseTimerDuration } from "../domain/runtime/timer_duration.ts";
import type { PlacementFields } from "../domain/workflows/placement.ts";
import type { Workflow } from "../domain/workflows/workflow.ts";
import type { ModelMethodRunPayload } from "../serve/protocol.ts";
import type {
  MergedServeOptions,
  ServeConfigFile,
} from "../serve/serve_config.ts";

/** A fixed repository admission diagnostic; accepts no untrusted message. */
export class EngineRepositoryNotInitializedError extends UserError {
  override readonly code = "repository_not_initialized";

  constructor() {
    super(
      "The repository has no .swamp.yaml marker. Select an initialized repository with --repo, or restore its .swamp.yaml file.",
    );
    this.name = "EngineRepositoryNotInitializedError";
  }
}

/** A refusal of a feature outside the experimental local engine profile. */
export class EngineProfileError extends UserError {
  override readonly code = "unsupported_profile";

  constructor(
    feature: string,
    recovery = "Use swamp serve for this configuration.",
  ) {
    super(
      `The local-v1 engine profile does not support ${feature}. ${recovery}`,
    );
    this.name = "EngineProfileError";
  }
}

/** A profile refusal raised before the first write: the repo can be served read-only. */
export class EngineReadOnlyFallback extends EngineProfileError {
  constructor(refusal: EngineProfileError) {
    super("");
    this.message = refusal.message;
    this.name = "EngineReadOnlyFallback";
  }
}

/** An untrusted workspace's datastore is extension code the engine won't load. */
export class EngineWorkspaceUntrustedError extends UserError {
  override readonly code = "workspace_untrusted";

  constructor() {
    super(
      "This workspace is not trusted and its datastore is an extension. Trust the workspace to open its dashboard.",
    );
    this.name = "EngineWorkspaceUntrustedError";
  }
}

/**
 * Validate resolved options too: an environment override has the same policy
 * meaning as its serve.yaml setting. The composition root supplies local-v1
 * defaults before merging (token authentication, no schedules, detached runs).
 */
export function validateEngineConfig(
  config: ServeConfigFile | null,
  options: MergedServeOptions,
  datastore: DatastoreConfig,
): void {
  for (
    const [value, name] of [
      [options.maxConcurrentRuns, "max-concurrent-runs"],
      [options.maxRunsPerPrincipal, "max-runs-per-principal"],
    ] as const
  ) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new EngineProfileError(
        `invalid ${name} (expected a positive integer)`,
        `Set ${name} to a positive integer.`,
      );
    }
  }
  if (options.maxRunDuration !== undefined) {
    try {
      parseTimerDuration(options.maxRunDuration, "--max-run-duration");
    } catch {
      throw new EngineProfileError(
        "invalid max-run-duration (expected a positive duration no longer than 24.8 days)",
        "Set max-run-duration to a supported positive duration, such as 30s.",
      );
    }
  }
  if (datastore.type !== "filesystem") {
    throw new EngineProfileError("remote or custom datastores");
  }
  if (datastore.format === 3) {
    throw new EngineProfileError("format 3 datastores and replication");
  }
  if (datastore.namespace !== undefined) {
    throw new EngineProfileError("shared datastore namespaces");
  }
  if (options.authMode !== "token") {
    throw new EngineProfileError("authentication modes other than token");
  }
  if (!options.detachRuns) {
    throw new EngineProfileError(
      "connection-scoped execution (detach-runs: false)",
    );
  }
  const enabled: ReadonlyArray<readonly [boolean, string]> = [
    [options.schedule, "cron scheduling"],
    [options.hotReload, "extension hot reload"],
    [options.autoResume, "automatic continuation"],
    [options.dashboard, "the dashboard"],
    [options.remoteOnly, "remote-only execution"],
    [options.enableInternalApi, "the internal worker API"],
    [options.verifyOnEnroll, "worker enrollment"],
    [options.trustProxy, "forwarded proxy identity"],
    [
      Boolean(options.webhook?.length || options.webhookConfigs?.length),
      "webhooks",
    ],
    [
      Boolean(
        options.triggerOverrides &&
          Object.keys(options.triggerOverrides).length,
      ),
      "trigger overrides",
    ],
  ];
  for (const [active, feature] of enabled) {
    if (active) throw new EngineProfileError(feature);
  }

  // These settings have no service in local-v1. Refuse even apparently benign
  // values instead of implying their timeout, worker or maintenance policy ran.
  const unsupported: ReadonlyArray<readonly [unknown, string]> = [
    [options.queueTimeout, "worker queue-timeout"],
    [options.dispatchEnvAllow, "dispatch-env-allow"],
    [options.heartbeatInterval, "instance heartbeat-interval"],
    [options.staleTtl, "instance stale-ttl"],
    [options.reconciliationInterval, "instance reconciliation-interval"],
    [options.maxConcurrentScheduledRuns, "max-concurrent-scheduled-runs"],
    [options.maxConcurrentWebhookRuns, "max-concurrent-webhook-runs"],
    [options.hydrationTimeout, "remote hydration-timeout"],
    [options.datastorePollInterval, "datastore-poll-interval"],
    [options.continuationSweepInterval, "continuation-sweep-interval"],
    [options.maxSignalWaitTimeout, "max-signal-wait-timeout"],
    [options.tokenGcInterval, "token-gc-interval"],
    [options.tokenGcGracePeriod, "token-gc-grace-period"],
    [options.groupRefreshInterval, "OAuth group-refresh-interval"],
    [options.wsIdleTimeout, "WebSocket idle timeout (ws-idle-timeout)"],
    [
      options.shutdownDrainTimeout,
      "shutdown-drain-timeout (configure the Go listener)",
    ],
    [options.trustedHosts, "trusted-hosts (configure the Go listener)"],
    [options.certFile, "TLS cert-file (configure the Go listener)"],
    [options.keyFile, "TLS key-file (configure the Go listener)"],
    [config?.host, "serve.yaml host (configure the Go listener)"],
    [config?.port, "serve.yaml port (configure the Go listener)"],
  ];
  for (const [value, feature] of unsupported) {
    if (value !== undefined) throw new EngineProfileError(feature);
  }
  if (
    options.grantReload !== "auto"
  ) {
    throw new EngineProfileError("grant-reload modes other than auto");
  }
  if (
    config?.audit?.stores?.some((store) =>
      store.type !== undefined || store.config !== undefined
    ) ||
    config?.audit?.sinks?.length || config?.audit?.alerts?.length ||
    config?.audit?.hmac?.enabled === true ||
    config?.audit?.hmac?.vault !== undefined ||
    config?.audit?.hmac?.key !== undefined
  ) {
    throw new EngineProfileError(
      "external audit stores, sinks, alerts or HMAC",
    );
  }
  if (
    options.oauthProvider !== undefined ||
    options.oauthClientId !== undefined ||
    options.oauthClientName !== undefined ||
    options.groupsField !== undefined
  ) {
    throw new EngineProfileError("OAuth configuration");
  }
}

function validatePlacement(fields: PlacementFields, location: string): void {
  if (
    fields.target !== undefined || fields.platform !== undefined ||
    fields.queueTimeout !== undefined ||
    (fields.labels !== undefined && Object.keys(fields.labels).length > 0)
  ) {
    throw new EngineProfileError(`worker placement on ${location}`);
  }
}

/**
 * Check the exact canonical definition selected for execution, including a
 * cached evaluated definition when lastEvaluated is requested. Dormant stored
 * workflows are not scanned at startup. Explicit manual execution may use a
 * workflow with a dormant cron declaration, since scheduling itself is off.
 */
export function validateEngineWorkflow(workflow: Workflow): void {
  validatePlacement(workflow.placementFields, "the workflow");
  if (workflow.autoResume === true) {
    throw new EngineProfileError("workflow automatic continuation");
  }
  for (const job of workflow.jobs) {
    validatePlacement(job.placementFields, "a job");
    for (const step of job.steps) {
      validatePlacement(step.placementFields, "a step");
      const kind = step.task.data.type;
      if (kind !== "model_method" && kind !== "assert") {
        throw new EngineProfileError(`workflow step kind '${kind}'`);
      }
    }
  }
}

/** Public method execution selects an existing definition in this profile. */
export function validateEngineMethodRun(payload: ModelMethodRunPayload): void {
  if (payload.typeArg !== undefined || payload.definitionName !== undefined) {
    throw new EngineProfileError(
      "direct type execution that creates a definition",
    );
  }
}
