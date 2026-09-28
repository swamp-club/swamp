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

/** A data artifact reference as recorded on a workflow run. */
export interface RunArtifactRef {
  dataId: string;
  name: string;
  version: number;
  tags?: Record<string, string>;
}

/** The parts of a workflow run view that carry data artifacts. */
export interface RunArtifacts {
  jobs?: Array<{
    name?: string;
    steps?: Array<{
      name?: string;
      modelName?: string;
      dataArtifacts?: RunArtifactRef[];
    }>;
  }>;
  workflowDataArtifacts?: RunArtifactRef[];
}

/** One artifact the run produced, with the step that produced it if any. */
export interface RunArtifact {
  ref: RunArtifactRef;
  jobName?: string;
  stepName?: string;
  modelName?: string;
}

export type RunReportResolution =
  | { kind: "found"; artifact: RunArtifact }
  | { kind: "ambiguous"; candidates: RunArtifact[] }
  | { kind: "notFound" };

/** Every artifact a run recorded: per-step first, then workflow-scope. */
export function runArtifacts(run: RunArtifacts): RunArtifact[] {
  const out: RunArtifact[] = [];
  for (const job of run.jobs ?? []) {
    for (const step of job.steps ?? []) {
      for (const ref of step.dataArtifacts ?? []) {
        out.push({
          ref,
          jobName: job.name,
          stepName: step.name,
          modelName: step.modelName,
        });
      }
    }
  }
  for (const ref of run.workflowDataArtifacts ?? []) {
    out.push({ ref });
  }
  return out;
}

/**
 * True when `ref` is the `-json` twin of a Markdown report output the same
 * run recorded. Both carry identical report tags, so the pairing is by name.
 */
function isJsonTwin(ref: RunArtifactRef, all: RunArtifact[]): boolean {
  if (!ref.name.endsWith("-json")) return false;
  const markdownName = ref.name.slice(0, -"-json".length);
  return all.some((a) =>
    a.ref.name === markdownName && a.ref.tags?.type === "report"
  );
}

/** True when the artifact is a report's Markdown output. */
export function isReportOutput(
  artifact: RunArtifact,
  all: RunArtifact[],
): boolean {
  return artifact.ref.tags?.type === "report" &&
    !isJsonTwin(artifact.ref, all);
}

/**
 * Finds the Markdown output of `reportName` in a run, pinned to the version
 * the run recorded. Several matches (vary variants, or one method report
 * emitted by several steps) are returned for the user to choose rather than
 * guessed. `reportName` is the unsanitized name carried in the tags, so the
 * data-name sanitization is not reimplemented here.
 */
export function resolveRunReport(
  run: RunArtifacts,
  reportName: string,
): RunReportResolution {
  const all = runArtifacts(run);
  const matches = all.filter((a) =>
    a.ref.tags?.reportName === reportName && isReportOutput(a, all)
  );
  if (matches.length === 0) return { kind: "notFound" };
  if (matches.length === 1) return { kind: "found", artifact: matches[0] };
  return { kind: "ambiguous", candidates: matches };
}

/** The distinct report names whose output the run recorded, sorted. */
export function runReportNames(run: RunArtifacts): string[] {
  const all = runArtifacts(run);
  const names = new Set<string>();
  for (const artifact of all) {
    const name = artifact.ref.tags?.reportName;
    if (name && isReportOutput(artifact, all)) names.add(name);
  }
  return [...names].sort();
}

/** Where an artifact was recorded: the same step, or workflow scope. */
function sameLocation(a: RunArtifact, b: RunArtifact): boolean {
  return a.jobName === b.jobName && a.stepName === b.stepName;
}

/**
 * Finds the run artifact with `dataId` (optionally at `version`), and the
 * `-json` twin recorded alongside it in the same step or at workflow scope.
 * Prefers a twin at the same version, since both are written together.
 */
export function findArtifactWithTwin(
  run: RunArtifacts,
  dataId: string,
  version?: number,
): { artifact: RunArtifact; twin?: RunArtifact } | null {
  const all = runArtifacts(run);
  const artifact = all.find((a) =>
    a.ref.dataId === dataId &&
    (version === undefined || a.ref.version === version)
  );
  if (!artifact) return null;
  const twins = all.filter((a) =>
    a.ref.name === `${artifact.ref.name}-json` && sameLocation(a, artifact)
  );
  const twin = twins.find((t) => t.ref.version === artifact.ref.version) ??
    twins[0];
  return { artifact, twin };
}
