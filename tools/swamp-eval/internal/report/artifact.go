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

package report

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/swamp-club/swamp/tools/swamp-eval/internal/eval"
	"github.com/swamp-club/swamp/tools/swamp-eval/internal/models"
	"github.com/swamp-club/swamp/tools/swamp-eval/internal/runner"
)

const SchemaVersion = 1

const (
	StatusCompleted = "completed"
	StatusCancelled = "cancelled"
	StatusFailed    = "failed"
)

type Artifact struct {
	SchemaVersion      int          `json:"schema_version"`
	Status             string       `json:"status"`
	Error              *eval.Error  `json:"error,omitempty"`
	StartedAt          time.Time    `json:"started_at"`
	FinishedAt         time.Time    `json:"finished_at"`
	RepositoryRevision *string      `json:"repository_revision"`
	Tool               ToolInfo     `json:"tool"`
	Model              ModelInfo    `json:"model"`
	Options            RunOptions   `json:"options"`
	Summary            Totals       `json:"summary"`
	Suites             []SuiteTotal `json:"suites"`
	Cases              []CaseRecord `json:"cases"`
}

type ToolInfo struct {
	SourceTree string  `json:"source_tree"`
	GoVersion  string  `json:"go_version"`
	CLIVersion *string `json:"cli_version"`
}

type ModelInfo struct {
	Alias          string   `json:"alias"`
	Route          string   `json:"route"`
	ConfiguredID   string   `json:"configured_id"`
	ResolvedModels []string `json:"resolved_models"`
}

type RunOptions struct {
	Concurrency int     `json:"concurrency"`
	TimeoutMS   int64   `json:"timeout_ms"`
	Threshold   float64 `json:"threshold"`
}

type TokenUsage struct {
	Input       *int64 `json:"input"`
	CachedInput *int64 `json:"cached_input"`
	Output      *int64 `json:"output"`
}

type Totals struct {
	Total            int            `json:"total"`
	Passed           int            `json:"passed"`
	Failed           int            `json:"failed"`
	Errors           int            `json:"errors"`
	NotRun           int            `json:"not_run"`
	PassRate         float64        `json:"pass_rate"`
	MetThreshold     bool           `json:"met_threshold"`
	LatencyMS        int64          `json:"latency_ms"`
	TokenUsage       TokenUsage     `json:"token_usage"`
	EstimatedCostUSD *float64       `json:"estimated_cost_usd"`
	ErrorCategories  map[string]int `json:"error_categories"`
}

type SuiteTotal struct {
	Suite string `json:"suite"`
	Totals
}

type CaseRecord struct {
	ID                string      `json:"id"`
	Suite             string      `json:"suite"`
	Description       string      `json:"description"`
	Expect            string      `json:"expect"`
	ExpectedTool      string      `json:"expected_tool"`
	ActualTool        *string     `json:"actual_tool"`
	Outcome           string      `json:"outcome"`
	Error             *eval.Error `json:"error"`
	LatencyMS         int64       `json:"latency_ms"`
	InputTokens       *int64      `json:"input_tokens"`
	CachedInputTokens *int64      `json:"cached_input_tokens"`
	OutputTokens      *int64      `json:"output_tokens"`
	ResolvedModel     *string     `json:"resolved_model"`
}

type BuildInput struct {
	Model      models.Model
	Route      models.Route
	Options    RunOptions
	Suites     []eval.Suite
	Results    []runner.Result
	StartedAt  time.Time
	FinishedAt time.Time
	Revision   *string
	Tool       ToolInfo
	Cancelled  bool
	WallClock  time.Duration
}

func Build(in BuildInput) Artifact {
	a := Artifact{
		SchemaVersion:      SchemaVersion,
		Status:             StatusCompleted,
		StartedAt:          in.StartedAt.UTC(),
		FinishedAt:         in.FinishedAt.UTC(),
		RepositoryRevision: in.Revision,
		Tool:               in.Tool,
		Model: ModelInfo{
			Alias:          in.Model.Alias,
			Route:          string(in.Route),
			ConfiguredID:   in.Model.ConfiguredID(in.Route),
			ResolvedModels: []string{},
		},
		Options: in.Options,
		Suites:  []SuiteTotal{},
		Cases:   make([]CaseRecord, 0, len(in.Results)),
	}
	if in.Cancelled {
		a.Status = StatusCancelled
	}
	var pricing *models.Pricing
	if in.Route == models.RouteAPI && in.Model.API != nil {
		pricing = in.Model.API.Pricing
	}
	for _, r := range in.Results {
		rec := CaseRecord{
			ID:                r.Case.ID,
			Suite:             string(r.Case.Suite),
			Description:       r.Case.Description,
			Expect:            string(r.Case.Expect),
			ExpectedTool:      r.Case.Label(r.Case.ExpectedTool),
			Outcome:           string(r.Outcome),
			Error:             r.Err,
			LatencyMS:         r.Latency.Milliseconds(),
			InputTokens:       r.InputTokens,
			CachedInputTokens: r.CachedInputTokens,
			OutputTokens:      r.OutputTokens,
		}
		if r.Actual != "" {
			actual := r.Case.Label(r.Actual)
			rec.ActualTool = &actual
		}
		if r.ResolvedModel != "" {
			rec.ResolvedModel = &r.ResolvedModel
			if !slices.Contains(a.Model.ResolvedModels, r.ResolvedModel) {
				a.Model.ResolvedModels = append(a.Model.ResolvedModels, r.ResolvedModel)
			}
		}
		a.Cases = append(a.Cases, rec)
	}
	slices.Sort(a.Model.ResolvedModels)
	a.Summary = totals(a.Cases, in.Options.Threshold, pricing)
	a.Summary.LatencyMS = in.WallClock.Milliseconds()
	for _, s := range in.Suites {
		var cases []CaseRecord
		for _, c := range a.Cases {
			if c.Suite == string(s) {
				cases = append(cases, c)
			}
		}
		a.Suites = append(a.Suites, SuiteTotal{Suite: string(s), Totals: totals(cases, in.Options.Threshold, pricing)})
	}
	return a
}

// totals counts errors against the pass rate: an outage must never read as a
// pass, and the separate counts keep it from reading as a prompt regression.
func totals(cases []CaseRecord, threshold float64, pricing *models.Pricing) Totals {
	t := Totals{ErrorCategories: map[string]int{}}
	var latency int64
	for _, c := range cases {
		switch runner.Outcome(c.Outcome) {
		case runner.Pass:
			t.Passed++
		case runner.Fail:
			t.Failed++
		case runner.Error:
			t.Errors++
			t.ErrorCategories[string(c.Error.Category)]++
		case runner.NotRun:
			t.NotRun++
			continue
		}
		latency += c.LatencyMS
		t.TokenUsage.Input = addPtr(t.TokenUsage.Input, c.InputTokens)
		t.TokenUsage.CachedInput = addPtr(t.TokenUsage.CachedInput, c.CachedInputTokens)
		t.TokenUsage.Output = addPtr(t.TokenUsage.Output, c.OutputTokens)
	}
	t.Total = t.Passed + t.Failed + t.Errors
	t.LatencyMS = latency
	if t.Total > 0 {
		t.PassRate = math.Round(float64(t.Passed)/float64(t.Total)*1e4) / 1e4
	}
	t.MetThreshold = t.Total > 0 && t.NotRun == 0 && float64(t.Passed)/float64(t.Total) >= threshold
	if pricing != nil && t.TokenUsage.Input != nil && t.TokenUsage.Output != nil {
		var cached int64
		if t.TokenUsage.CachedInput != nil {
			cached = *t.TokenUsage.CachedInput
		}
		cost := math.Round(pricing.Cost(*t.TokenUsage.Input, cached, *t.TokenUsage.Output)*1e4) / 1e4
		t.EstimatedCostUSD = &cost
	}
	return t
}

func addPtr(total, v *int64) *int64 {
	if v == nil {
		return total
	}
	sum := *v
	if total != nil {
		sum += *total
	}
	return &sum
}

// Failed is the artifact for a run that stopped before any case, so the
// cross-model report can say why instead of only that it is missing.
func Failed(m models.Model, route models.Route, opts RunOptions, tool ToolInfo, err *eval.Error, now time.Time) Artifact {
	return Artifact{
		SchemaVersion: SchemaVersion,
		Status:        StatusFailed,
		Error:         err,
		StartedAt:     now.UTC(),
		FinishedAt:    now.UTC(),
		Tool:          tool,
		Model:         ModelInfo{Alias: m.Alias, Route: string(route), ConfiguredID: m.ConfiguredID(route), ResolvedModels: []string{}},
		Options:       opts,
		Summary:       Totals{ErrorCategories: map[string]int{}},
		Suites:        []SuiteTotal{},
		Cases:         []CaseRecord{},
	}
}

// WriteAtomic writes through a synced temp file and a rename, so a reader
// never sees a partial artifact.
func WriteAtomic(path string, a Artifact) error {
	data, err := json.MarshalIndent(a, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func Load(path string) (Artifact, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Artifact{}, err
	}
	var probe struct {
		SchemaVersion *int `json:"schema_version"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return Artifact{}, fmt.Errorf("not JSON: %w", err)
	}
	if probe.SchemaVersion == nil {
		return Artifact{}, fmt.Errorf("no schema_version")
	}
	if *probe.SchemaVersion != SchemaVersion {
		return Artifact{}, fmt.Errorf("schema_version %d, want %d", *probe.SchemaVersion, SchemaVersion)
	}
	var a Artifact
	if err := json.Unmarshal(data, &a); err != nil {
		return Artifact{}, err
	}
	if a.Model.Alias == "" {
		return Artifact{}, fmt.Errorf("artifact names no model")
	}
	return a, nil
}
