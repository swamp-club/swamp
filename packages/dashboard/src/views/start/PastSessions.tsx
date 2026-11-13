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

import { useEffect, useRef, useState } from "react";
import { NavIcon } from "../../components/nav_icons.tsx";
import { AgentBadge } from "./AgentBadge.tsx";
import {
  isValidWorkspaceName,
  parseExcludedPaths,
  PAST_SESSIONS_DEFAULT_WINDOW,
  PAST_SESSIONS_WINDOWS,
  type PastSessionsHarness,
  pastSessionsHarnesses,
  swampifyWorkspaceName,
} from "./helpers.ts";
import {
  describeChooseError,
  ErrorBox,
  type ScreenProps,
  useLaunch,
} from "./parts.tsx";
import type { HarnessList, StartStatus } from "./types.ts";

/** The collapsed card's one line. */
export const PAST_SESSIONS_CARD_TEXT =
  "Find tasks to automate from your agent session history.";

const PAST_SESSIONS_HARNESS_NAMES: Record<PastSessionsHarness, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/**
 * "Start from your past sessions": says what will be read and stored, then
 * creates a workspace and saves a Swampify kick-off task in it. The page
 * sends only the window, the excluded paths and the agent; the server writes
 * the task text.
 */
export function PastSessionsPanel(
  { status, client, onStatus, taken, disabled, open, onOpenChange }:
    & ScreenProps
    & {
      taken: readonly string[];
      disabled: boolean;
      /** Held by the workspace screen, so the browser's Back can close it. */
      open: boolean;
      onOpenChange: (open: boolean) => void;
    },
) {
  const offered = pastSessionsHarnesses(status.signals);
  const [windowDays, setWindowDays] = useState(PAST_SESSIONS_DEFAULT_WINDOW);
  const [excludeText, setExcludeText] = useState("");
  const [scopeOpen, setScopeOpen] = useState(false);
  const [picked, setPicked] = useState<PastSessionsHarness | null>(null);
  const [name, setName] = useState("");
  const [installed, setInstalled] = useState<Record<string, boolean> | null>(
    null,
  );
  // Swampify! saves the kick-off, then launches it at once: the click is the
  // trust confirmation, as it is on the Swampify page.
  const launcher = useLaunch(client, onStatus);
  const [saved, setSaved] = useState<StartStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const busy = saving || launcher.running;
  const error = saveError ?? launcher.error;
  // The card and the panel replace each other, so focus follows the swap.
  const backRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current === open) return;
    wasOpen.current = open;
    (open ? backRef : cardRef).current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    client.request<HarnessList>("start.harness.list")
      .then((reply) => {
        if (!active) return;
        const found: Record<string, boolean> = {};
        for (const h of reply?.harnesses ?? []) found[h.id] = h.found;
        setInstalled(found);
      })
      .catch(() => {
        if (active) setInstalled({});
      });
    return () => {
      active = false;
    };
  }, [open, client]);
  const harness = picked !== null && offered.includes(picked)
    ? picked
    : offered.find((h) => installed?.[h] !== false) ?? offered[0];
  const suggested = swampifyWorkspaceName(taken);
  const finalName = name.trim() || suggested;
  const nameOk = isValidWorkspaceName(finalName);
  const harnessOk = harness !== undefined && installed?.[harness] !== false;
  const canSubmit = !busy && !disabled &&
    (saved !== null || (nameOk && harnessOk));

  if (!open) {
    return (
      <div className="start-past-card">
        <NavIcon name="swampify" className="start-past-card-icon" />
        <p className="start-past-card-text">{PAST_SESSIONS_CARD_TEXT}</p>
        <button
          type="button"
          ref={cardRef}
          className="start-primary start-small"
          onClick={() => onOpenChange(true)}
          disabled={disabled}
        >
          Swampify!
        </button>
      </div>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    // A retry after a failed launch only launches: the task is already saved.
    if (saved === null) {
      if (harness === undefined) return;
      const exclude = parseExcludedPaths(excludeText);
      setSaving(true);
      setSaveError(null);
      try {
        setSaved(
          await client.request<StartStatus>("start.swampify.kickoff", {
            name: finalName,
            windowDays,
            ...(exclude.length > 0 ? { exclude } : {}),
            harness,
          }),
        );
      } catch (err) {
        setSaveError(describeChooseError(err));
        return;
      } finally {
        setSaving(false);
      }
    }
    await launcher.launch();
  };

  return (
    <form
      className="start-form-panel start-past-sessions"
      onSubmit={(e) => void submit(e)}
      aria-labelledby="start-past-sessions-title"
    >
      <p className="start-past-back">
        <button
          ref={backRef}
          type="button"
          className="start-secondary start-small"
          onClick={() => saved !== null ? onStatus(saved) : onOpenChange(false)}
          disabled={busy}
        >
          ← Your workspaces
        </button>
      </p>
      <h3 id="start-past-sessions-title" className="start-form-title">
        Start from your past sessions
      </h3>
      <p className="start-panel-intro">
        Have an agent examine your Claude Code and Codex history for chores
        worth automating.
      </p>
      <ul className="start-disclosure">
        <li>
          <strong>What it reads:</strong>{" "}
          transcript text on this machine, including your prompts and the
          agent's replies.
        </li>
        <li>
          <strong>What the workspace stores:</strong>{" "}
          counts, token costs, and up to five short, redacted excerpts for each
          repeated chore.
        </li>
        <li>
          <strong>Where it goes:</strong>{" "}
          this workspace's data stays on this machine unless you choose to sync
          it to a datastore or serve it.
        </li>
      </ul>
      <ErrorBox message={error} />
      <fieldset className="start-past-fields" disabled={saved !== null}>
        <div className="start-past-row">
          <label className="start-field-label" htmlFor="start-past-window">
            Window
          </label>
          <select
            id="start-past-window"
            className="start-input start-select"
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value))}
          >
            {PAST_SESSIONS_WINDOWS.map((days) => (
              <option key={days} value={days}>Last {days} days</option>
            ))}
          </select>
        </div>
        <div className="start-past-row">
          <div className="start-field-label" id="start-past-scope-label">
            Scope
          </div>
          <div className="start-past-control">
            <div className="start-past-inline">
              <button
                type="button"
                className={`start-past-scope${
                  scopeOpen ? " start-past-scope-open" : ""
                }`}
                aria-expanded={scopeOpen}
                aria-controls="start-past-exclude"
                onClick={() => setScopeOpen(!scopeOpen)}
              >
                {parseExcludedPaths(excludeText).length > 0
                  ? "Every session except these"
                  : "Every session on this machine"}
              </button>
            </div>
            {scopeOpen && (
              <>
                <textarea
                  id="start-past-exclude"
                  className="start-textarea start-input-mono start-past-exclude"
                  value={excludeText}
                  onChange={(e) => setExcludeText(e.target.value)}
                  rows={3}
                  placeholder="~/src/client-repo"
                  spellCheck={false}
                  aria-labelledby="start-past-scope-label"
                  aria-describedby="start-past-exclude-hint"
                />
                <p className="start-hint" id="start-past-exclude-hint">
                  One folder per line, starting with <code>/</code> or{" "}
                  <code>~</code>.
                </p>
              </>
            )}
          </div>
        </div>
        <div className="start-past-row">
          <div className="start-field-label" id="start-past-agent-label">
            Agent
          </div>
          <div
            className="start-past-agent-cards"
            role="radiogroup"
            aria-labelledby="start-past-agent-label"
          >
            {offered.map((id) => {
              const missing = installed?.[id] === false;
              return (
                <label
                  key={id}
                  className={`start-past-agent-card${
                    harness === id ? " start-past-agent-card-selected" : ""
                  }${missing ? " start-past-agent-card-missing" : ""}`}
                >
                  <input
                    type="radio"
                    name="start-past-agent"
                    value={id}
                    checked={harness === id}
                    onChange={() => setPicked(id)}
                    disabled={missing}
                  />
                  <AgentBadge id={id} size="md" />
                  <span className="start-past-agent-name">
                    {PAST_SESSIONS_HARNESS_NAMES[id]}
                  </span>
                  {missing && (
                    <span className="start-hint">not on your PATH</span>
                  )}
                </label>
              );
            })}
          </div>
        </div>
        <div className="start-past-row">
          <label className="start-field-label" htmlFor="start-past-name">
            Workspace name
          </label>
          <input
            id="start-past-name"
            className="start-input start-past-name"
            value={name}
            placeholder={suggested}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!nameOk}
          />
        </div>
      </fieldset>
      {saved !== null && launcher.error !== null
        ? (
          <p className="start-hint start-past-note">
            The workspace and its kick-off are saved. Try again, or choose
            another agent.
          </p>
        )
        : (
          <p className="start-hint start-past-note">
            Swampify! creates the workspace and opens{" "}
            {harness ? PAST_SESSIONS_HARNESS_NAMES[harness] : "your agent"}{" "}
            in it. Clicking it confirms you trust that folder.
          </p>
        )}
      <div className="start-actions">
        {saved !== null
          ? (
            <button
              type="button"
              className="start-secondary"
              onClick={() => onStatus(saved)}
              disabled={busy}
            >
              Choose another agent
            </button>
          )
          : (
            <button
              type="button"
              className="start-secondary"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </button>
          )}
        <button type="submit" className="start-primary" disabled={!canSubmit}>
          {saving
            ? "Setting up…"
            : launcher.running
            ? "Opening your agent…"
            : saved !== null
            ? "Try again"
            : "Swampify!"}
        </button>
      </div>
    </form>
  );
}
