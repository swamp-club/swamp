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

package engine

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sync"
	"testing"
	"time"
)

type fakeAccountedJob struct {
	mu               sync.Mutex
	counts           []uint32
	queries          int
	events           []string
	terminationError error
	queryError       error
	closeError       error
}

func (j *fakeAccountedJob) terminate() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.events = append(j.events, "terminate")
	return j.terminationError
}
func (j *fakeAccountedJob) activeProcesses() (uint32, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	active := j.counts[min(j.queries, len(j.counts)-1)]
	j.queries++
	j.events = append(j.events, fmt.Sprintf("active:%d", active))
	return active, j.queryError
}
func (j *fakeAccountedJob) close() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.events = append(j.events, "close")
	return j.closeError
}
func (j *fakeAccountedJob) snapshot() []string {
	j.mu.Lock()
	defer j.mu.Unlock()
	return append([]string(nil), j.events...)
}

func TestJobCleanupRetainsHandleUntilEveryProcessHasExited(t *testing.T) {
	job := &fakeAccountedJob{counts: []uint32{2, 1, 0}}
	polled, advance := make(chan struct{}), make(chan struct{})
	completed := make(chan error, 1)
	ctx := testContext(t)
	go func() {
		completed <- finishJobCleanup(ctx, job, func(ctx context.Context) error {
			select {
			case polled <- struct{}{}:
			case <-ctx.Done():
				return ctx.Err()
			}
			select {
			case <-advance:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
	}()
	for _, remaining := range []uint32{2, 1} {
		select {
		case <-polled:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		events := job.snapshot()
		if events[len(events)-1] != fmt.Sprintf("active:%d", remaining) {
			t.Fatalf("wrong accounting observation: %v", events)
		}
		select {
		case err := <-completed:
			t.Fatalf("engine root exit/termination claimed descendant cleanup: %v", err)
		default:
		}
		advance <- struct{}{}
	}
	select {
	case err := <-completed:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if got, want := job.snapshot(), []string{"terminate", "active:2", "active:1", "active:0", "close"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("unsafe Job lifecycle: %v", got)
	}
}

func TestJobCleanupNeverTreatsErrorsOrDeadlineAsProof(t *testing.T) {
	for _, scenario := range []string{"terminate", "query", "pending", "expired", "close"} {
		t.Run(scenario, func(t *testing.T) {
			failure := errors.New("injected Job API failure")
			job := &fakeAccountedJob{counts: []uint32{0}}
			ctx, cancel := context.WithCancel(testContext(t))
			defer cancel()
			switch scenario {
			case "terminate":
				job.terminationError = failure
			case "query":
				job.queryError = failure
			case "close":
				job.closeError = failure
			case "pending":
				job.counts = []uint32{1}
			case "expired":
				cancel()
			}
			err := finishJobCleanup(ctx, job, func(context.Context) error { cancel(); return ctx.Err() })
			if !errors.Is(err, ErrUnconfirmedCommandCleanup) {
				t.Fatalf("uncertain accounting was accepted: %v", err)
			}
			events := job.snapshot()
			if events[0] != "terminate" || events[len(events)-1] != "close" {
				t.Fatalf("Job ownership lost: %v", events)
			}
			closes := 0
			for _, event := range events {
				if event == "close" {
					closes++
				}
			}
			if closes != 1 {
				t.Fatalf("handle close count %d", closes)
			}
		})
	}
}

func TestJobFenceOwnsHandleExactlyOnceAndRetainsFailure(t *testing.T) {
	failure := errors.New("accounting unavailable")
	job := &fakeAccountedJob{counts: []uint32{1}, queryError: failure}
	f := newJobFence(time.Minute)
	f.attach(job)
	for i := 0; i < 2; i++ {
		if err := f.SealAndWait(); !errors.Is(err, ErrUnconfirmedCommandCleanup) || !errors.Is(err, failure) {
			t.Fatalf("sticky cleanup result lost: %v", err)
		}
	}
	f.Close()
	if got, want := job.snapshot(), []string{"terminate", "active:1", "close"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("closed or queried handle again: %v", got)
	}
	select {
	case <-f.Failed():
	default:
		t.Fatal("unconfirmed cleanup did not signal failure")
	}
}

func TestJobFenceHonorsEarlierAbsoluteDeadlineAndStopsTimerOnClose(t *testing.T) {
	f := newJobFence(time.Minute)
	defer f.Close()
	later := time.Date(2040, 1, 1, 0, 0, 0, 0, time.UTC)
	f.SetDeadline(later)
	f.SetDeadline(time.Time{})
	f.SetDeadline(later)
	select {
	case <-f.context.Done():
	case <-testContext(t).Done():
		t.Fatal("absolute cleanup deadline was extended")
	}
	job := &fakeAccountedJob{counts: []uint32{1}}
	f.attach(job)
	if err := f.SealAndWait(); !errors.Is(err, ErrUnconfirmedCommandCleanup) {
		t.Fatalf("expired budget permitted cleanup: %v", err)
	}
	f.SetDeadline(later)
	if !f.deadlineAt.IsZero() {
		t.Fatal("closed fence acquired a new timer")
	}
	if got, want := job.snapshot(), []string{"terminate", "close"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("accounting continued after deadline: %v", got)
	}
}
