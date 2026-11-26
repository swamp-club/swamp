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

import { cyan, dim, green, red, yellow } from "@std/fmt/colors";
import type { OutputMode } from "../output/output.ts";
import { prettyJson } from "../output/json_stream.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import {
  escapeControlCharacters,
  escapeControlCharactersInMessage,
} from "../../domain/control_characters.ts";
import { principalLabel } from "../../domain/access/principal.ts";
import type {
  ApprovalView,
  FanOutGateRunView,
  FanOutHaltRunView,
  FanOutMemberRunView,
  FanOutRunView,
  StepSkipReasonView,
  WorkflowRunView,
} from "../../libswamp/workflows/workflow_run_view.ts";

export function renderWorkflowRunDisplay(
  data: WorkflowRunView,
  mode: OutputMode,
): void {
  if (mode === "json") {
    // resource attributes can nest deeper than JSON.stringify's stack allows
    console.log(prettyJson(data));
  } else {
    renderLogWorkflowRun(data);
  }
}

function viaClient(client: string | undefined): string {
  return client !== undefined ? ` via ${escapeControlCharacters(client)}` : "";
}

function keySuffix(key: string | undefined): string {
  return key === undefined ? "" : ` (key ${escapeControlCharacters(key)})`;
}

function heldSuffix(receipt: { heldAsPending?: true }): string {
  return receipt.heldAsPending
    ? ", held as a pending signal until the wait took it"
    : "";
}

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function renderLogWorkflowRun(data: WorkflowRunView): void {
  writeOutput(`Workflow: ${data.workflowName} (Run ID: ${data.id})`);
  if (data.startedAt) {
    writeOutput(`Started:  ${formatTimestamp(data.startedAt)}`);
  }
  if (data.completedAt) {
    writeOutput(`Ended:    ${formatTimestamp(data.completedAt)}`);
  }

  for (const job of data.jobs) {
    const durationSuffix = job.duration !== undefined
      ? ` (${job.duration}ms)`
      : "";
    writeOutput(`  ${statusIcon(job.status)} ${job.name}${durationSuffix}`);

    for (const step of job.steps) {
      const stepDuration = step.duration !== undefined
        ? ` (${step.duration}ms)`
        : "";
      const stepIcon = step.status === "failed" && step.allowedFailure
        ? "\u26A0"
        : statusIcon(step.status);
      writeOutput(`    ${stepIcon} ${step.name}${stepDuration}`);

      if (step.nestedRun && step.status === "waiting_approval") {
        writeOutput(
          `      -> waiting on nested run ${step.nestedRun.runId} of workflow ${step.nestedRun.workflowName}`,
        );
      } else if (step.wait?.receipt && step.status === "waiting") {
        writeOutput(
          `      -> signal ${step.wait.receipt.id} received for wait ${step.wait.id}${
            keySuffix(step.wait.key)
          } from ${
            escapeControlCharacters(step.wait.receipt.submittedBy)
          } at ${step.wait.receipt.receivedAt}${
            heldSuffix(step.wait.receipt)
          }; a resume applies it`,
        );
      } else if (step.wait && step.status === "waiting") {
        writeOutput(
          `      -> waiting for signal ${step.wait.id}${
            keySuffix(step.wait.key)
          } until ${step.wait.deadline}`,
        );
      } else if (step.wait?.receipt?.heldAsPending) {
        writeOutput(
          `      -> signal ${step.wait.receipt.id} received for wait ${step.wait.id}${
            keySuffix(step.wait.key)
          } from ${
            escapeControlCharacters(step.wait.receipt.submittedBy)
          } at ${step.wait.receipt.receivedAt}${heldSuffix(step.wait.receipt)}`,
        );
      } else if (step.nestedRun?.detached) {
        writeOutput(
          `      -> nested run ${step.nestedRun.runId} of workflow ${step.nestedRun.workflowName} was detached when the run ended`,
        );
      }

      if (step.error) {
        writeOutput(
          `      -> ${red(escapeControlCharactersInMessage(step.error))}`,
        );
      }

      if (step.status === "skipped" && step.skipReason) {
        // word for word what the verification report says for the same fact; a
        // switch makes a missing skip kind a compile error
        const detail = ((r: StepSkipReasonView): string => {
          switch (r.kind) {
            case "guarded":
              return r.expression
                ? `guard: ${r.expression}${
                  r.result === undefined ? "" : ` → ${r.result}`
                }`
                : "guard";
            case "dependency":
              return "dependency condition not met";
            case "job_skipped":
              return "job was skipped";
          }
        })(step.skipReason);
        writeOutput(`      -> skipped (${detail})`);
      }

      if (step.approval) {
        const a = step.approval;
        if (a.status === "approved") {
          writeOutput(
            `      ${green("Approved")} by ${
              a.approvedBy === undefined ? "unknown" : escapeControlCharacters(
                principalLabel(a.approvedBy, a.approvedByUsername),
              )
            }${viaClient(a.client)} at ${formatTimestamp(a.approvedAt)}`,
          );
        } else if (a.status === "rejected") {
          writeOutput(
            `      ${red("Rejected")} by ${
              a.rejectedBy === undefined ? "unknown" : escapeControlCharacters(
                principalLabel(a.rejectedBy, a.rejectedByUsername),
              )
            }${viaClient(a.client)} at ${formatTimestamp(a.rejectedAt)}`,
          );
          if (a.reason) {
            writeOutput(`      Reason: ${escapeControlCharacters(a.reason)}`);
          }
        } else if (a.status === "timed_out") {
          const timeoutSuffix = a.timeoutAt
            ? ` at ${formatTimestamp(a.timeoutAt)}`
            : "";
          writeOutput(`      ${yellow("Timed out")}${timeoutSuffix}`);
        }
      }
    }

    if (job.fanOut) {
      writeOutput(fanOutLines(job.fanOut).join("\n"));
    }
  }

  if (data.parked === true) {
    // a refusal below names why serve will not continue it
    writeOutput(
      yellow(
        data.autoContinuation?.refused !== undefined
          ? "Parked for a serve restart"
          : "Parked for a serve restart: the next serve process continues it under the same run id unless the workflow sets autoContinue: false",
      ),
    );
  } else if (data.interruptReason !== undefined) {
    writeOutput(
      yellow(`Interrupted: ${escapeControlCharacters(data.interruptReason)}`),
    );
  }
  const continuation = data.autoContinuation;
  if (continuation?.refused !== undefined && data.status === "interrupted") {
    writeOutput(
      yellow(
        `Not continued automatically (${continuation.refused.reason}): ${
          escapeControlCharacters(continuation.refused.message)
        }`,
      ),
    );
  } else if (continuation?.continuedAt !== undefined) {
    const steps = continuation.resetSteps?.length
      ? `; re-checked guards on: ${
        escapeControlCharacters(continuation.resetSteps.join(", "))
      }`
      : "";
    writeOutput(
      `Continued automatically after ${
        escapeControlCharacters(
          continuation.interruptReason ?? "an interruption",
        )
      } at ${formatTimestamp(continuation.continuedAt)}${steps}`,
    );
  }

  const inherited = data.inheritedPlacement;
  if (inherited !== undefined) {
    const where = [
      inherited.target !== undefined ? `target ${inherited.target}` : "",
      inherited.labels !== undefined && Object.keys(inherited.labels).length > 0
        ? `labels ${
          Object.entries(inherited.labels).map(([k, v]) => `${k}=${v}`).join(
            ",",
          )
        }`
        : "",
      inherited.platform !== undefined ? `platform ${inherited.platform}` : "",
    ].filter((part) => part !== "").join(", ");
    const { workflowName, jobName, stepName } = inherited.source;
    writeOutput(
      dim(
        escapeControlCharacters(
          `Placement inherited from ${workflowName} / ${jobName} / ${stepName} by steps that place nothing themselves: ${where}`,
        ),
      ),
    );
  }

  const durationSuffix = data.duration !== undefined
    ? ` (${data.duration}ms)`
    : "";
  const resultText = `Result: ${
    data.parked === true ? "PARKED" : data.status.toUpperCase()
  }${durationSuffix}`;
  const colorize = data.parked === true
    ? yellow
    : data.status === "failed" || data.status === "interrupted"
    ? red
    : data.status === "cancelled"
    ? yellow
    : green;
  writeOutput(colorize(resultText));

  if (data.path) {
    writeOutput(`Saved to: ${data.path}`);
  }
}

function statusIcon(
  status:
    | "pending"
    | "running"
    | "waiting_approval"
    | "waiting"
    | "succeeded"
    | "failed"
    | "skipped"
    | "cancelled"
    | "unknown"
    | "interrupted",
): string {
  const icons: Record<string, string> = {
    pending: "\u25CB",
    running: "\u25D0",
    waiting_approval: "\u23F8",
    waiting: "\u23F8",
    succeeded: "\u2713",
    failed: "\u2717",
    skipped: "\u2298",
    cancelled: "\u2716",
    unknown: "?",
    interrupted: "\u26A0",
  };
  return icons[status] ?? "?";
}

const esc = escapeControlCharacters;

function workerList(workers: readonly string[]): string {
  return workers.length > 0 ? workers.map(esc).join(", ") : "none";
}

function allowedText(allowed: number | null): string {
  return allowed === null ? "no budget" : `${allowed} failed lane(s) allowed`;
}

function laneText(lane: NonNullable<FanOutMemberRunView["lane"]>): string {
  switch (lane) {
    case "succeeded":
      return green("succeeded");
    case "failed":
      return red("failed");
    case "held":
      return yellow("held");
    case "running":
      return "running";
    case "unknown":
      return yellow("unknown");
    case "not_run":
      return dim("not run");
  }
}

function memberLines(member: FanOutMemberRunView): string[] {
  const reason = member.reason !== undefined ? ` (${esc(member.reason)})` : "";
  const batch = member.batch !== undefined
    ? `batch ${member.batch + 1}`
    : "no lane";
  const lane = member.lane !== undefined ? `, ${laneText(member.lane)}` : "";
  const lines = [
    `        ${esc(member.worker)}: ${
      esc(member.disposition)
    }${reason}, ${batch}${lane}`,
  ];
  for (const failed of member.failedSteps ?? []) {
    lines.push(
      `          failed ${esc(failed.step)}${
        failed.error !== undefined ? `: ${esc(failed.error)}` : ""
      }`,
    );
  }
  for (const assertion of member.assertions ?? []) {
    lines.push(
      `          assertion ${esc(assertion.step)} (${
        esc(assertion.severity)
      }): ${esc(assertion.message)}`,
    );
  }
  return lines;
}

function decisionText(approval: ApprovalView): string {
  if (approval.status === "approved") {
    return `${green("approved")} by ${
      approval.approvedBy === undefined
        ? "unknown"
        : esc(principalLabel(approval.approvedBy, approval.approvedByUsername))
    }${viaClient(approval.client)} at ${formatTimestamp(approval.approvedAt)}`;
  }
  if (approval.status === "rejected") {
    return `${red("rejected")} by ${
      approval.rejectedBy === undefined
        ? "unknown"
        : esc(principalLabel(approval.rejectedBy, approval.rejectedByUsername))
    }${viaClient(approval.client)} at ${formatTimestamp(approval.rejectedAt)}`;
  }
  return yellow("timed out");
}

function gateLines(gate: FanOutGateRunView): string[] {
  let text: string;
  if (gate.approval !== undefined) {
    text = decisionText(gate.approval);
  } else if (gate.status === "expired") {
    text = `${yellow("expired")} at ${formatTimestamp(gate.expiredAt)}`;
  } else if (gate.status === "held") {
    text = dim("not reached");
  } else {
    text = gate.status === "failed" ? red("failed") : gate.status;
  }
  const lines = [`        ${gate.kind}: ${text}`];
  if (gate.approval?.reason) {
    lines.push(`          Reason: ${esc(gate.approval.reason)}`);
  }
  return lines;
}

function haltLine(halt: FanOutHaltRunView, attempt: number): string {
  if (halt.reason === "gate_rejected") {
    return `        ${halt.gate} gate rejected: held ${workerList(halt.held)}`;
  }
  return `        attempt ${attempt}: ${red("budget spent")} in batch ${
    halt.batch + 1
  } (${allowedText(halt.maxFailures)}); failed ${
    workerList(halt.failed)
  }; held ${workerList(halt.held)}`;
}

function fanOutLines(fanOut: FanOutRunView): string[] {
  const selector = Object.entries(fanOut.selector.labels ?? {}).map((
    [key, value],
  ) => `${esc(key)}=${esc(value)}`);
  if (fanOut.selector.platform !== undefined) {
    selector.push(`platform=${esc(fanOut.selector.platform)}`);
  }
  const policy = fanOut.policy !== undefined
    ? `offline ${
      esc(fanOut.policy.offline)
    }, minWorkers ${fanOut.policy.minWorkers}`
    : dim("policy not recorded");
  const lines = [
    `    ${cyan("Fan-out:")} ${
      selector.length > 0 ? selector.join(", ") : dim("selector not recorded")
    }; ${policy}`,
    `      Planned lanes: ${fanOut.plannedLanes}; budget: ${fanOut.budget.used} used, ${
      allowedText(fanOut.budget.allowed)
    }`,
  ];
  fanOut.batches.forEach((batch, index) => {
    lines.push(`      Batch ${index + 1}: ${workerList(batch)}`);
  });
  lines.push(`      ${cyan("Members:")}`);
  for (const member of fanOut.members) {
    for (const line of memberLines(member)) lines.push(line);
  }
  if (fanOut.gates.length > 0) {
    lines.push(`      ${cyan("Gates:")}`);
    for (const gate of fanOut.gates) {
      for (const line of gateLines(gate)) lines.push(line);
    }
  }
  if (fanOut.halts.length > 0) {
    lines.push(`      ${cyan("Halts:")}`);
    let attempt = 0;
    for (const halt of fanOut.halts) {
      if (halt.reason === "budget") attempt++;
      lines.push(haltLine(halt, attempt));
    }
  }
  if (fanOut.resume !== undefined) {
    lines.push(
      `      Latest resume at ${formatTimestamp(fanOut.resume.at)}: rerun ${
        workerList(fanOut.resume.rerun)
      }; kept ${workerList(fanOut.resume.kept)}`,
    );
  }
  return lines;
}
