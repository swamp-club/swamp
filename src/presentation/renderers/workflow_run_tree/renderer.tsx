// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { render } from "ink";
import type { EventHandlers, WorkflowRunEvent } from "../../../libswamp/mod.ts";
import type {
  WorkflowRunRenderer,
  WorkflowRunRenderOpts,
} from "../workflow_run.ts";
import { UserError } from "../../../domain/errors.ts";
import { suppressInkTtyErrors } from "../../output/ink_lifecycle.ts";
import { EventBridge, WorkflowRunTree } from "./workflow_run_tree.tsx";

export class InkWorkflowRunRenderer implements WorkflowRunRenderer {
  private _failed = false;
  private bridge: EventBridge;
  private cleanup: (() => void) | null = null;
  private workflowName: string;

  constructor(opts: WorkflowRunRenderOpts) {
    this.workflowName = opts.workflowName;
    this.bridge = new EventBridge();
  }

  private mount(): void {
    if (this.cleanup) return;
    const ttyCleanup = suppressInkTtyErrors();
    const instance = render(
      <WorkflowRunTree
        bridge={this.bridge}
        workflowName={this.workflowName}
        onDone={(failed) => {
          this._failed = failed;
        }}
      />,
      { maxFps: 15 },
    );
    this.cleanup = () => {
      instance.unmount();
      ttyCleanup();
    };
  }

  handlers(): EventHandlers<WorkflowRunEvent> {
    this.mount();

    const forward = (event: WorkflowRunEvent) => this.bridge.push(event);

    return {
      validating_inputs: forward,
      evaluating_workflow: forward,
      started: forward,
      job_started: forward,
      job_completed: forward,
      job_skipped: forward,
      step_started: forward,
      step_completed: forward,
      step_skipped: forward,
      step_failed: forward,
      model_resolved: forward,
      env_var_warning: forward,
      method_executing: forward,
      method_output: forward,
      method_event: forward,
      report_started: forward,
      report_completed: forward,
      report_failed: forward,
      completed: (e) => {
        if (e.run.status === "failed") this._failed = true;
        forward(e);
        this.bridge.close();
        // Allow brief render cycle for the final frame
        setTimeout(() => this.cleanup?.(), 100);
      },
      error: (e) => {
        forward(e);
        this.bridge.close();
        this.cleanup?.();
        throw new UserError(e.error.message);
      },
    };
  }

  workflowFailed(): boolean {
    return this._failed;
  }
}
