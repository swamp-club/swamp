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
import type { ReactNode } from "react";
import { MiniDag } from "./MiniDag.tsx";
import { Skeleton } from "./Skeleton.tsx";
import { gateContext, type WorkflowJobDef } from "../lib/gate_dag.ts";

interface GateDetailsProps {
  workflowName: string;
  stepName: string;
  /**
   * The link to the gated run (a RouteLink in the app). A slot, so this
   * component stays free of the router and renders anywhere.
   */
  runLink: ReactNode;
  prompt?: string;
  /** The workflow's jobs; null while they load or when they failed to. */
  jobs: readonly WorkflowJobDef[] | null;
  /** Why the jobs could not be read, if they could not. */
  error?: string | null;
}

/**
 * What a gate holds back, shown inline under an approval: the run, the
 * gated step, its prompt, what runs next, and the workflow's jobs with the
 * gate's job and everything downstream of it highlighted.
 */
export function GateDetails(
  { workflowName, stepName, runLink, prompt, jobs, error }: GateDetailsProps,
) {
  const ctx = jobs ? gateContext(jobs, stepName) : null;
  return (
    <div className="gate-details">
      <dl className="gate-facts">
        <div>
          <dt>Run</dt>
          <dd>{runLink}</dd>
        </div>
        <div>
          <dt>Gated step</dt>
          <dd>
            <span className="mono">{stepName}</span>
            {ctx?.gateJob && (
              <span className="gate-muted gate-job">
                in job <span className="mono">{ctx.gateJob}</span>
              </span>
            )}
          </dd>
        </div>
        {prompt && (
          <div className="gate-prompt">
            <dt>Prompt</dt>
            <dd>{prompt}</dd>
          </div>
        )}
        <div>
          <dt>Runs next</dt>
          <dd>
            {ctx === null
              ? error
                ? <span className="gate-muted">Unknown</span>
                : <Skeleton width={140} height={10} />
              : ctx.next.length > 0
              ? ctx.next.map((name, i) => (
                <span key={name}>
                  {i > 0 && ", "}
                  <span className="mono">{name}</span>
                </span>
              ))
              : (
                <span className="gate-muted">
                  {ctx.gateJob
                    ? "Nothing else waits on this job — the rest of it continues"
                    : "The rest of the run"}
                </span>
              )}
          </dd>
        </div>
      </dl>

      {error
        ? (
          <p className="gate-error" role="alert">
            Couldn't load the workflow's jobs: {error}
          </p>
        )
        : ctx === null
        ? (
          <div className="gate-dag-loading" role="status" aria-busy="true">
            <span className="visually-hidden">Loading the workflow's jobs</span>
            <Skeleton width={148} height={30} radius={6} />
            <Skeleton width={148} height={30} radius={6} />
            <Skeleton width={148} height={30} radius={6} />
          </div>
        )
        : ctx.nodes.length > 0 && (
          <div className="gate-dag">
            <MiniDag
              nodes={ctx.nodes}
              edges={ctx.edges}
              highlight={ctx.highlight}
              label={`Jobs of ${workflowName}`}
              layout={{ nodeWidth: 132, columnGap: 28 }}
            />
            {ctx.gateJob && (
              <ul className="mini-dag-legend" aria-label="Legend">
                <li>
                  <span className="mini-dag-swatch tone-suspended" />
                  Holds the gate
                </li>
                {ctx.downstream.length > 0 && (
                  <li>
                    <span className="mini-dag-swatch tone-waiting" />
                    Waits on the gate
                  </li>
                )}
              </ul>
            )}
          </div>
        )}
    </div>
  );
}
