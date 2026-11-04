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

package runner

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/swamp-club/swamp/tools/swamp-eval/internal/eval"
)

type fakeProvider struct {
	classify func(ctx context.Context, req eval.Request) eval.Response
}

func (f fakeProvider) ID() string { return "fake" }
func (f fakeProvider) Classify(ctx context.Context, req eval.Request) eval.Response {
	return f.classify(ctx, req)
}

func makeCases(n int) []eval.Case {
	out := make([]eval.Case, n)
	for i := range out {
		out[i] = eval.Case{
			ID:           fmt.Sprintf("c%d", i),
			Input:        fmt.Sprintf("q%d", i),
			Tools:        []eval.Tool{{Name: "a"}, {Name: "b"}},
			ExpectedTool: "a",
			Expect:       eval.ExpectSelect,
		}
	}
	return out
}

func TestRunKeepsCaseOrderAndClassifiesOutcomes(t *testing.T) {
	cases := makeCases(30)
	p := fakeProvider{func(_ context.Context, req eval.Request) eval.Response {
		var i int
		fmt.Sscanf(req.Input, "q%d", &i)
		time.Sleep(time.Duration(30-i) * time.Millisecond / 10)
		switch i % 3 {
		case 0:
			return eval.Response{Tool: "a"}
		case 1:
			return eval.Response{Tool: "b"}
		}
		return eval.Response{Err: eval.Errorf(eval.ErrRateLimit, "slow down")}
	}}
	results := Run(context.Background(), cases, p, Options{Concurrency: 8, Timeout: time.Second})
	for i, r := range results {
		if r.Case.ID != cases[i].ID {
			t.Fatalf("result %d is case %s", i, r.Case.ID)
		}
		want := []Outcome{Pass, Fail, Error}[i%3]
		if r.Outcome != want {
			t.Errorf("case %d outcome %s, want %s", i, r.Outcome, want)
		}
		if r.Outcome == Error && r.Actual != "" {
			t.Errorf("an errored case must not carry a tool")
		}
	}
}

func TestRunBoundsConcurrency(t *testing.T) {
	var active, peak atomic.Int32
	p := fakeProvider{func(context.Context, eval.Request) eval.Response {
		n := active.Add(1)
		for {
			old := peak.Load()
			if n <= old || peak.CompareAndSwap(old, n) {
				break
			}
		}
		time.Sleep(2 * time.Millisecond)
		active.Add(-1)
		return eval.Response{Tool: "a"}
	}}
	Run(context.Background(), makeCases(40), p, Options{Concurrency: 3, Timeout: time.Second})
	if peak.Load() > 3 {
		t.Errorf("peak concurrency %d exceeds 3", peak.Load())
	}
}

func TestRunTimesOutACase(t *testing.T) {
	p := fakeProvider{func(ctx context.Context, _ eval.Request) eval.Response {
		<-ctx.Done()
		return eval.Response{Tool: "a"}
	}}
	results := Run(context.Background(), makeCases(1), p, Options{Concurrency: 1, Timeout: 10 * time.Millisecond})
	if results[0].Outcome != Error || results[0].Err.Category != eval.ErrTimeout {
		t.Fatalf("result = %+v, want timeout error", results[0])
	}
}

func TestRunStopsAdmittingCasesOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var started atomic.Int32
	p := fakeProvider{func(ctx context.Context, _ eval.Request) eval.Response {
		if started.Add(1) == 2 {
			cancel()
		}
		<-ctx.Done()
		return eval.Response{Err: eval.Errorf(eval.ErrCancelled, "cancelled")}
	}}
	results := Run(ctx, makeCases(20), p, Options{Concurrency: 2, Timeout: time.Second})
	notRun := 0
	for _, r := range results {
		if r.Outcome == NotRun {
			notRun++
		}
	}
	if notRun < 15 {
		t.Errorf("only %d of 20 cases were left unstarted after cancel", notRun)
	}
}
