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

import { type FormEvent, useId, useMemo, useState } from "react";
import {
  CRON_PRESETS,
  describeCron,
  nextFireTimes,
  parseCron,
} from "../lib/cron.ts";
import { formatInputsJson, parseInputsJson } from "../lib/triggers.ts";
import { formatAbsoluteTime, formatRelativeTime } from "../lib/format.ts";

interface ScheduleEditorFormProps {
  workflowName: string;
  /** The effective schedule and inputs the form starts from. */
  initialSchedule: string;
  initialInputs: Record<string, unknown>;
  /** The workflow file's own schedule, offered as a starting point. */
  builtInSchedule?: string | null;
  saving: boolean;
  error?: string | null;
  onSave: (schedule: string, inputs: Record<string, unknown>) => void;
  onCancel: () => void;
  /** Clock for the preview; defaults to now. */
  now?: number;
  /** The browser's time zone, shown with the preview. */
  timeZone?: string;
}

/**
 * The text of a field's change event. Typed loosely so the form also
 * type-checks (and renders in tests) without the DOM library.
 */
function valueOf(e: { target: unknown }): string {
  const value = (e.target as { value?: unknown }).value;
  return typeof value === "string" ? value : "";
}

const PREVIEW_COUNT = 5;
const INPUTS_PLACEHOLDER = '{\n  "region": "eu-west-1"\n}';

function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function fireLabel(d: Date): string {
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Edits a schedule's cron expression and inputs. The expression is checked
 * as it is typed, described in words and previewed as its next fire times;
 * inputs must be a JSON object. Save stays off until something changed
 * and both are valid.
 */
export function ScheduleEditorForm(
  {
    workflowName,
    initialSchedule,
    initialInputs,
    builtInSchedule,
    saving,
    error,
    onSave,
    onCancel,
    now,
    timeZone,
  }: ScheduleEditorFormProps,
) {
  const id = useId();
  const [cron, setCron] = useState(initialSchedule);
  const initialInputsText = useMemo(
    () => formatInputsJson(initialInputs),
    [initialInputs],
  );
  const [inputsText, setInputsText] = useState(initialInputsText);

  const clock = now ?? Date.now();
  const parsed = parseCron(cron);
  const description = parsed.ok ? describeCron(cron) : null;
  const fires = parsed.ok
    ? nextFireTimes(parsed.schedule, new Date(clock), PREVIEW_COUNT)
    : [];
  const inputs = parseInputsJson(inputsText);
  const zone = timeZone ?? browserTimeZone();

  const cronUsable = parsed.ok || parsed.unsupported === true;
  const changed = cron.trim() !== initialSchedule.trim() ||
    (inputs.ok &&
      JSON.stringify(inputs.value) !== JSON.stringify(initialInputs));
  const canSave = !saving && cronUsable && inputs.ok && changed;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSave || !inputs.ok) return;
    onSave(cron.trim(), inputs.value);
  };

  const cronState = parsed.ok ? "ok" : parsed.unsupported ? "warn" : "error";

  return (
    <form className="sched-form" onSubmit={submit} noValidate>
      <div className="sched-field">
        <label htmlFor={`${id}-cron`}>Cron expression</label>
        <input
          id={`${id}-cron`}
          className="mono"
          value={cron}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={cronState === "error"}
          aria-describedby={`${id}-cron-help`}
          onChange={(e) => setCron(valueOf(e))}
        />
        <div
          className="sched-presets"
          role="group"
          aria-label="Common schedules"
        >
          {CRON_PRESETS.map((p) => (
            <button
              type="button"
              key={p.expression}
              className={`sched-chip${
                cron.trim() === p.expression ? " active" : ""
              }`}
              aria-pressed={cron.trim() === p.expression}
              onClick={() => setCron(p.expression)}
            >
              {p.label}
            </button>
          ))}
          {builtInSchedule && (
            <button
              type="button"
              className={`sched-chip${
                cron.trim() === builtInSchedule ? " active" : ""
              }`}
              aria-pressed={cron.trim() === builtInSchedule}
              title={`The schedule in ${workflowName}'s workflow file`}
              onClick={() => setCron(builtInSchedule)}
            >
              Workflow file: <span className="mono">{builtInSchedule}</span>
            </button>
          )}
        </div>
        <div
          id={`${id}-cron-help`}
          className={`sched-help tone-${cronState}`}
          aria-live="polite"
        >
          {parsed.ok
            ? <strong>{description ?? "Custom schedule"}</strong>
            : parsed.unsupported
            ? "The preview doesn't cover this syntax; serve checks it when you save."
            : parsed.error}
        </div>
        {fires.length > 0 && (
          <div className="sched-fires">
            <div className="sched-fires-head">
              Next {fires.length} runs
              {zone && <span>in your time zone ({zone})</span>}
            </div>
            <ol>
              {fires.map((d) => (
                <li key={d.getTime()}>
                  <time
                    dateTime={d.toISOString()}
                    title={formatAbsoluteTime(d)}
                  >
                    {fireLabel(d)}
                  </time>
                  <span>{formatRelativeTime(d, clock)}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
        {parsed.ok && fires.length === 0 && (
          <div className="sched-help tone-warn">
            This schedule never fires (no date matches it).
          </div>
        )}
      </div>

      <div className="sched-field">
        <label htmlFor={`${id}-inputs`}>
          Inputs <span className="sched-optional">JSON object</span>
        </label>
        <textarea
          id={`${id}-inputs`}
          className="mono"
          rows={6}
          value={inputsText}
          spellCheck={false}
          placeholder={INPUTS_PLACEHOLDER}
          aria-invalid={!inputs.ok}
          aria-describedby={`${id}-inputs-help`}
          onChange={(e) => setInputsText(valueOf(e))}
        />
        <div
          id={`${id}-inputs-help`}
          className={`sched-help tone-${inputs.ok ? "muted" : "error"}`}
          aria-live="polite"
        >
          {inputs.ok
            ? "Passed to every scheduled run of this workflow."
            : inputs.error}
        </div>
      </div>

      {error && (
        <div className="notice notice-danger sched-error" role="alert">
          {error}
        </div>
      )}

      <div className="sched-form-footer">
        <span className="sched-note">
          Saved as a serve override; the workflow file is not changed.
        </span>
        <div className="sched-form-buttons">
          <button
            type="button"
            className="trig-btn"
            disabled={saving}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="trig-btn primary"
            disabled={!canSave}
          >
            {saving ? "Saving…" : "Save schedule"}
          </button>
        </div>
      </div>
    </form>
  );
}
