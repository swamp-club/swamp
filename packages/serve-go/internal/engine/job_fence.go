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
	"sync"
	"time"
)

// The accounting loop is platform-neutral so Windows lifecycle ordering is
// exercised on every host; only the Job Object adapter uses native Windows APIs.
type accountedJob interface {
	terminate() error
	activeProcesses() (uint32, error)
	close() error
}

type jobFence struct {
	timeout    time.Duration
	context    context.Context
	cancel     context.CancelFunc
	mu         sync.Mutex
	deadlineAt time.Time
	deadline   *time.Timer
	disposed   bool
	jobMu      sync.Mutex
	job        accountedJob
	closed     bool
	closeError error
	failed     chan struct{}
	once       sync.Once
	result     error
}

func newJobFence(timeout time.Duration) *jobFence {
	ctx, cancel := context.WithCancel(context.Background())
	return &jobFence{timeout: timeout, context: ctx, cancel: cancel, failed: make(chan struct{})}
}
func (*jobFence) Path() string              { return "none" }
func (f *jobFence) Failed() <-chan struct{} { return f.failed }
func (f *jobFence) attach(job accountedJob) { f.jobMu.Lock(); defer f.jobMu.Unlock(); f.job = job }
func (f *jobFence) terminate() error {
	f.jobMu.Lock()
	defer f.jobMu.Unlock()
	if f.closed || f.job == nil {
		return ErrUnconfirmedCommandCleanup
	}
	return f.job.terminate()
}
func (f *jobFence) activeProcesses() (uint32, error) {
	f.jobMu.Lock()
	defer f.jobMu.Unlock()
	if f.closed || f.job == nil {
		return 0, ErrUnconfirmedCommandCleanup
	}
	return f.job.activeProcesses()
}
func (f *jobFence) close() error {
	f.jobMu.Lock()
	defer f.jobMu.Unlock()
	if !f.closed {
		f.closed = true
		if f.job != nil {
			f.closeError = f.job.close()
		}
	}
	return f.closeError
}
func (f *jobFence) SetDeadline(deadline time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.disposed || (f.deadline != nil && !deadline.Before(f.deadlineAt)) {
		return
	}
	f.deadlineAt = deadline
	if f.deadline != nil {
		f.deadline.Stop()
	}
	f.deadline = time.AfterFunc(max(0, time.Until(deadline)), f.cancel)
}
func (f *jobFence) SealAndWait() error {
	f.once.Do(func() {
		ctx, cancel := context.WithTimeout(f.context, f.timeout)
		defer cancel()
		f.result = finishJobCleanup(ctx, f, waitJobAccounting)
		if f.result != nil {
			close(f.failed)
		}
		f.Close()
	})
	return f.result
}
func (f *jobFence) Close() {
	f.cancel()
	f.mu.Lock()
	f.disposed = true
	if f.deadline != nil {
		f.deadline.Stop()
	}
	f.mu.Unlock()
	_ = f.close()
}

func waitJobAccounting(ctx context.Context) error {
	timer := time.NewTimer(10 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// Termination initiates cleanup; only a zero accounting count proves it ended.
// Keep the handle open throughout observation, including failure, and close it
// exactly once after the decision. A failed proof can never authorize restart.
func finishJobCleanup(ctx context.Context, job accountedJob, wait func(context.Context) error) (result error) {
	defer func() {
		if err := job.close(); err != nil {
			result = errors.Join(result, ErrUnconfirmedCommandCleanup, err)
		}
	}()
	if err := job.terminate(); err != nil {
		return errors.Join(ErrUnconfirmedCommandCleanup, err)
	}
	for {
		if err := ctx.Err(); err != nil {
			return errors.Join(ErrUnconfirmedCommandCleanup, err)
		}
		active, err := job.activeProcesses()
		if err != nil {
			return errors.Join(ErrUnconfirmedCommandCleanup, err)
		}
		if active == 0 {
			return nil
		}
		if err := wait(ctx); err != nil {
			return errors.Join(ErrUnconfirmedCommandCleanup, err)
		}
	}
}
