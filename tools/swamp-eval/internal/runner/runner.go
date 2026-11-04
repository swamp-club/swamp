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
	"sync"
	"time"

	"github.com/swamp-club/swamp/tools/swamp-eval/internal/eval"
	"github.com/swamp-club/swamp/tools/swamp-eval/internal/providers"
)

type Outcome string

const (
	Pass   Outcome = "pass"
	Fail   Outcome = "fail"
	Error  Outcome = "error"
	NotRun Outcome = "not_run"
)

type Options struct {
	Concurrency int
	Timeout     time.Duration
	// Delay is the pause a worker takes after each call.
	Delay    time.Duration
	Progress func(done, total int, r Result)
}

type Result struct {
	Case          eval.Case
	Outcome       Outcome
	Actual        string
	Err           *eval.Error
	Latency       time.Duration
	InputTokens   *int64
	OutputTokens  *int64
	ResolvedModel string
}

const MaxConcurrency = 100

// Run classifies every case and returns results in case order. It never stops
// on a failed case; cancelling ctx stops admitting cases, and those never
// started come back NotRun.
func Run(ctx context.Context, cases []eval.Case, p providers.Provider, opts Options) []Result {
	results := make([]Result, len(cases))
	for i, c := range cases {
		results[i] = Result{Case: c, Outcome: NotRun}
	}
	jobs := make(chan int)
	var mu sync.Mutex
	done := 0
	var wg sync.WaitGroup
	for range min(max(opts.Concurrency, 1), MaxConcurrency) {
		wg.Go(func() {
			for i := range jobs {
				results[i] = classify(ctx, cases[i], p, opts.Timeout)
				if opts.Progress != nil {
					mu.Lock()
					done++
					opts.Progress(done, len(cases), results[i])
					mu.Unlock()
				}
				if opts.Delay > 0 {
					select {
					case <-ctx.Done():
					case <-time.After(opts.Delay):
					}
				}
			}
		})
	}
feed:
	for i := range cases {
		select {
		case <-ctx.Done():
			break feed
		case jobs <- i:
		}
	}
	close(jobs)
	wg.Wait()
	return results
}

func classify(ctx context.Context, c eval.Case, p providers.Provider, timeout time.Duration) Result {
	caseCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	start := time.Now()
	resp := p.Classify(caseCtx, c.Request())
	if resp.Err == nil && caseCtx.Err() != nil {
		resp.Err = eval.Errorf(eval.ErrTimeout, "case exceeded %s", timeout)
	}
	r := Result{
		Case:          c,
		Latency:       time.Since(start),
		Err:           resp.Err,
		InputTokens:   resp.InputTokens,
		OutputTokens:  resp.OutputTokens,
		ResolvedModel: resp.ResolvedModel,
	}
	switch {
	case resp.Err != nil:
		r.Outcome = Error
	case c.Passes(resp.Tool):
		r.Outcome, r.Actual = Pass, resp.Tool
	default:
		r.Outcome, r.Actual = Fail, resp.Tool
	}
	return r
}
