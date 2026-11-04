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
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/swamp-club/swamp/packages/serve-go/internal/protocol"
)

type fakeProcess struct {
	inR     *io.PipeReader
	inW     *io.PipeWriter
	outR    *io.PipeReader
	outW    *io.PipeWriter
	done    chan struct{}
	once    sync.Once
	writeMu sync.Mutex
	kills   atomic.Int32
}

func (p *fakeProcess) Input() io.WriteCloser { return p.inW }
func (p *fakeProcess) Output() io.ReadCloser { return p.outR }
func (p *fakeProcess) Wait() error           { <-p.done; return nil }
func (p *fakeProcess) Kill() error           { p.kills.Add(1); p.finish(); return nil }
func (p *fakeProcess) finish() {
	p.once.Do(func() { p.inR.Close(); p.inW.Close(); p.outW.Close(); close(p.done) })
}
func (p *fakeProcess) send(e protocol.Envelope) {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	frame, err := protocol.Encode(e)
	if err == nil {
		_ = protocol.Write(p.outW, frame)
	}
}
func (p *fakeProcess) reply(e protocol.Envelope, value interface{}) {
	result, _ := json.Marshal(value)
	p.send(protocol.Envelope{Version: 1, Generation: e.Generation, ID: e.ID, Result: result})
}
func openingSessionID(e protocol.Envelope) string {
	var params struct {
		SessionID string `json:"sessionId"`
	}
	_ = json.Unmarshal(e.Params, &params)
	return params.SessionID
}
func newFake(handler func(*fakeProcess, protocol.Envelope)) *fakeProcess {
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	p := &fakeProcess{inR: inR, inW: inW, outR: outR, outW: outW, done: make(chan struct{})}
	go func() {
		defer p.finish()
		for {
			e, err := protocol.Read(inR)
			if err != nil {
				return
			}
			handler(p, e)
		}
	}()
	return p
}
func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	return ctx
}

// Pause the caller after it queues a control but before it can consume the
// reply. The pipe reader can then deterministically process later envelopes.
type pausedDoneContext struct {
	context.Context
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (ctx *pausedDoneContext) Done() <-chan struct{} {
	ctx.once.Do(func() {
		close(ctx.entered)
		<-ctx.release
	})
	return ctx.Context.Done()
}

func TestOpenRetainsRevocationBeforePublishingSession(t *testing.T) {
	for _, code := range []int{4002, 4003} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			p := newFake(func(p *fakeProcess, e protocol.Envelope) {
				if e.Method == "session.open" {
					id := openingSessionID(e)
					p.reply(e, map[string]string{"sessionId": id})
					p.send(protocol.Envelope{Version: 1, Generation: e.Generation, SessionID: id, Closed: &protocol.Closed{Code: code, Reason: "Session ended"}})
					return
				}
				p.reply(e, struct{}{})
			})
			c := NewClient("generation", p)
			t.Cleanup(func() { c.Stop(); c.Wait() })
			ctx := testContext(t)
			paused := &pausedDoneContext{Context: ctx, entered: make(chan struct{}), release: make(chan struct{})}
			var releaseOnce sync.Once
			release := func() { releaseOnce.Do(func() { close(paused.release) }) }
			defer release()
			result := make(chan error, 1)
			go func() {
				s, err := c.Open(paused, "credential", "ip")
				if s != nil {
					result <- errors.New("revoked authentication published a session")
					return
				}
				result <- err
			}()
			select {
			case <-paused.entered:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			// This response follows both the open result and the unsolicited close.
			if err := c.Call(ctx, "engine.status", struct{}{}, nil); err != nil {
				t.Fatal(err)
			}
			release()
			select {
			case err := <-result:
				var failure *protocol.Error
				if !errors.As(err, &failure) || failure.Code != "unauthorized" {
					t.Fatalf("early revocation was lost: %v", err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			c.mu.Lock()
			slots, sessions := len(c.slots), len(c.sessions)
			c.mu.Unlock()
			if slots != 0 || sessions != 0 || p.kills.Load() != 0 {
				t.Fatalf("early revocation leaked accounting or stopped peers: slots=%d sessions=%d kills=%d", slots, sessions, p.kills.Load())
			}
		})
	}
}

func TestOpenRejectsEngineChangingPreallocatedSessionID(t *testing.T) {
	p := newFake(func(p *fakeProcess, e protocol.Envelope) {
		p.reply(e, map[string]string{"sessionId": "different-session"})
	})
	c := NewClient("generation", p)
	t.Cleanup(func() { c.Stop(); c.Wait() })
	s, err := c.Open(testContext(t), "credential", "ip")
	if s != nil || !errors.Is(err, protocol.ErrFrame) || p.kills.Load() != 1 {
		t.Fatalf("changed authentication identity accepted: session=%v err=%v kills=%d", s, err, p.kills.Load())
	}
}

func TestAbandonedAuthenticationStillSignalsRetirement(t *testing.T) {
	opened := make(chan protocol.Envelope, 1)
	p := newFake(func(p *fakeProcess, e protocol.Envelope) {
		if e.Method == "session.open" {
			opened <- e
			return
		}
		p.reply(e, struct{}{})
	})
	c := NewClient("generation", p)
	t.Cleanup(func() { c.Stop(); c.Wait() })
	ctx := testContext(t)
	authentication, cancel := context.WithCancel(ctx)
	result := make(chan error, 1)
	go func() { _, err := c.Open(authentication, "credential", "ip"); result <- err }()
	var request protocol.Envelope
	select {
	case request = <-opened:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	cancel()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("caller cancellation was lost: %v", err)
	}
	p.send(protocol.Envelope{Version: 1, Generation: request.Generation, ID: request.ID, Error: ErrRetiring})
	if err := c.Call(ctx, "engine.status", struct{}{}, nil); err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	slots, pending := len(c.slots), len(c.pending)
	c.mu.Unlock()
	if !c.Retiring() || slots != 0 || pending != 0 || p.kills.Load() != 0 {
		t.Fatalf("abandoned retirement leaked state or fenced peers: retiring=%v slots=%d pending=%d kills=%d", c.Retiring(), slots, pending, p.kills.Load())
	}
	if _, err := c.Open(ctx, "later", "ip"); !errors.Is(err, ErrRetiring) {
		t.Fatalf("new authentication entered retiring engine: %v", err)
	}
	if len(opened) != 0 {
		t.Fatal("retiring engine received a new authentication")
	}
}

func TestClientSeparatesIdenticalPublicIDsBySession(t *testing.T) {
	p := newFake(func(p *fakeProcess, e protocol.Envelope) {
		switch e.Method {
		case "session.open":
			p.reply(e, map[string]string{"sessionId": openingSessionID(e)})
		case "request.dispatch":
			var params struct {
				SessionID string          `json:"sessionId"`
				Request   json.RawMessage `json:"request"`
			}
			_ = json.Unmarshal(e.Params, &params)
			p.send(protocol.Envelope{Version: 1, Generation: e.Generation, SessionID: params.SessionID, Message: params.Request})
			p.reply(e, struct{}{})
		}
	})
	c := NewClient("generation", p)
	t.Cleanup(func() { c.Stop(); c.Wait() })
	ctx := testContext(t)
	a, err := c.Open(ctx, "secret-a", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	b, err := c.Open(ctx, "secret-b", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []*Session{a, b} {
		if err := s.Dispatch(ctx, json.RawMessage(`{"type":"data.query","id":"same","payload":{}}`)); err != nil {
			t.Fatal(err)
		}
	}
	for _, s := range []*Session{a, b} {
		if _, err := s.Receive(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if len(a.queue) != 0 || len(b.queue) != 0 {
		t.Fatal("cross-session duplicate delivery")
	}
}
func TestClientSlowSessionDoesNotBlockPeer(t *testing.T) {
	var sessions []string
	p := newFake(func(p *fakeProcess, e protocol.Envelope) {
		if e.Method == "session.open" {
			sessions = append(sessions, openingSessionID(e))
			p.reply(e, map[string]string{"sessionId": openingSessionID(e)})
			return
		}
		if e.Method == "flood" {
			for i := 0; i <= MaxSessionFrames; i++ {
				p.send(protocol.Envelope{Version: 1, Generation: e.Generation, SessionID: sessions[0], Message: json.RawMessage(`{"type":"event","id":"x"}`)})
			}
			p.send(protocol.Envelope{Version: 1, Generation: e.Generation, SessionID: sessions[1], Message: json.RawMessage(`{"type":"done","id":"y"}`)})
		}
		p.reply(e, struct{}{})
	})
	c := NewClient("generation", p)
	t.Cleanup(func() { c.Stop(); c.Wait() })
	ctx := testContext(t)
	a, _ := c.Open(ctx, "a", "ip")
	b, _ := c.Open(ctx, "b", "ip")
	if err := c.Call(ctx, "flood", struct{}{}, nil); err != nil {
		t.Fatal(err)
	}
	select {
	case <-a.Done():
	default:
		t.Fatal("slow consumer remained open")
	}
	if a.Closed().Code != 1013 {
		t.Fatal("wrong slow consumer close code")
	}
	if _, err := b.Receive(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-c.Done():
		t.Fatal("slow subscriber failed generation")
	default:
	}
}
func TestClientRejectsStaleGeneration(t *testing.T) {
	p := newFake(func(p *fakeProcess, e protocol.Envelope) {
		p.send(protocol.Envelope{Version: 1, Generation: "old", ID: e.ID, Result: json.RawMessage(`{}`)})
	})
	c := NewClient("new", p)
	t.Cleanup(func() { c.Stop(); c.Wait() })
	if err := c.Call(testContext(t), "engine.status", struct{}{}, nil); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("stale generation accepted: %v", err)
	}
}
func TestClientCancelledControlPreservesGenerationWithoutRetry(t *testing.T) {
	accepted := make(chan struct{})
	var mutations atomic.Int32
	p := newFake(func(p *fakeProcess, e protocol.Envelope) {
		if e.Method == "request.dispatch" {
			mutations.Add(1)
			close(accepted)
			return
		}
		p.reply(e, struct{}{})
	})
	c := NewClient("g", p)
	t.Cleanup(func() { c.Stop(); c.Wait() })
	ctx, cancel := context.WithCancel(testContext(t))
	result := make(chan error, 1)
	go func() { result <- c.Call(ctx, "request.dispatch", struct{}{}, nil) }()
	<-accepted
	cancel()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	select {
	case <-c.Done():
		t.Fatal("individual timed-out mutation killed every peer")
	default:
	}
	if err := c.Call(testContext(t), "engine.status", struct{}{}, nil); err != nil || mutations.Load() != 1 {
		t.Fatalf("timeout replayed mutation or blocked other controls: %v", err)
	}
}

func TestAbandonedAuthenticationClosesLateSessionWithoutStoppingPeers(t *testing.T) {
	accepted := make(chan protocol.Envelope, 1)
	closed := make(chan string, 2)
	p := newFake(func(p *fakeProcess, e protocol.Envelope) {
		var params map[string]string
		_ = json.Unmarshal(e.Params, &params)
		switch e.Method {
		case "session.open":
			if params["credential"] == "slow" {
				accepted <- e
				return
			}
			p.reply(e, map[string]string{"sessionId": params["sessionId"]})
		case "session.close":
			p.reply(e, struct{}{})
			closed <- params["sessionId"]
		default:
			p.reply(e, struct{}{})
		}
	})
	c := NewClient("g", p)
	t.Cleanup(func() { c.Stop(); c.Wait() })
	ctx := testContext(t)
	healthy, err := c.Open(ctx, "healthy", "ip")
	if err != nil {
		t.Fatal(err)
	}
	opening, cancel := context.WithCancel(ctx)
	result := make(chan error, 1)
	go func() { _, err := c.Open(opening, "slow", "ip"); result <- err }()
	late := <-accepted
	cancel()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if err := healthy.Dispatch(ctx, json.RawMessage(`{"id":"peer","type":"data.query"}`)); err != nil {
		t.Fatal(err)
	}
	var params map[string]string
	_ = json.Unmarshal(late.Params, &params)
	p.reply(late, map[string]string{"sessionId": params["sessionId"]})
	if id := <-closed; id != params["sessionId"] || id == healthy.ID {
		t.Fatal("abandoned auth closed wrong session")
	}
	if err := c.Call(ctx, "engine.status", struct{}{}, nil); err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	slots, pending, cleanups := len(c.slots), len(c.pending), len(c.closes)
	c.mu.Unlock()
	if slots != 1 || pending != 0 || cleanups != 0 || p.kills.Load() != 0 {
		t.Fatal("late authentication leaked a slot, correlation or engine")
	}
	if err := healthy.Close(ctx); err != nil {
		t.Fatal(err)
	}
}

type observedWrite struct {
	io.WriteCloser
	entered chan struct{}
	once    sync.Once
}

func (w *observedWrite) Write(frame []byte) (int, error) {
	if strings.Contains(string(frame), `"method":"session.open"`) {
		w.once.Do(func() { close(w.entered) })
	}
	return w.WriteCloser.Write(frame)
}

type observedProcess struct {
	*fakeProcess
	input io.WriteCloser
}

func (p *observedProcess) Input() io.WriteCloser { return p.input }

func TestQueuedOpenTimeoutCannotSendCloseBeforeOpen(t *testing.T) {
	blocked, release, closed := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var statuses int
	p := newFake(func(p *fakeProcess, e protocol.Envelope) {
		switch e.Method {
		case "engine.status":
			statuses++
			if statuses == 1 {
				close(blocked)
				<-release
			}
			p.reply(e, struct{}{})
		case "session.open":
			var params map[string]string
			_ = json.Unmarshal(e.Params, &params)
			p.reply(e, map[string]string{"sessionId": params["sessionId"]})
		case "session.close":
			p.reply(e, struct{}{})
			close(closed)
		}
	})
	write := &observedWrite{WriteCloser: p.inW, entered: make(chan struct{})}
	c := NewClient("g", &observedProcess{fakeProcess: p, input: write})
	t.Cleanup(func() { c.Stop(); c.Wait() })
	ctx := testContext(t)
	status := make(chan error, 1)
	go func() { status <- c.Call(ctx, "engine.status", struct{}{}, nil) }()
	<-blocked
	opening, cancel := context.WithCancel(ctx)
	result := make(chan error, 1)
	go func() { _, err := c.Open(opening, "token", "ip"); result <- err }()
	<-write.entered
	cancel()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	c.mu.Lock()
	cleanups, slots := len(c.closes), len(c.slots)
	c.mu.Unlock()
	if cleanups != 0 || slots != 1 {
		t.Fatal("unsent open was forgotten or prematurely closed")
	}
	close(release)
	if err := <-status; err != nil {
		t.Fatal(err)
	}
	<-closed
	if err := c.Call(ctx, "engine.status", struct{}{}, nil); err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	slots = len(c.slots)
	c.mu.Unlock()
	if slots != 0 || p.kills.Load() != 0 {
		t.Fatal("queued authentication leaked or stopped peers")
	}
}
func TestClientBoundsPendingControls(t *testing.T) {
	accepted := make(chan struct{}, MaxPending)
	p := newFake(func(p *fakeProcess, e protocol.Envelope) { accepted <- struct{}{} })
	c := NewClient("g", p)
	ctx := testContext(t)
	var workers sync.WaitGroup
	for i := 0; i < MaxPending; i++ {
		workers.Add(1)
		go func() { defer workers.Done(); _ = c.Call(ctx, "blocked", struct{}{}, nil) }()
	}
	for i := 0; i < MaxPending; i++ {
		select {
		case <-accepted:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if err := c.Call(ctx, "overflow", struct{}{}, nil); !errors.Is(err, ErrBusy) {
		t.Fatalf("pending queue accepted overflow: %v", err)
	}
	c.Stop()
	c.Wait()
	workers.Wait()
}

func TestStatusCancellationDoesNotFenceAndLateReplyIsIgnored(t *testing.T) {
	accepted := make(chan struct{})
	release := make(chan struct{})
	p := newFake(func(p *fakeProcess, e protocol.Envelope) {
		if e.Method == "engine.status" {
			close(accepted)
			<-release
		}
		p.reply(e, struct{}{})
	})
	c := NewClient("g", p)
	t.Cleanup(func() { c.Stop(); c.Wait() })
	ctx, cancel := context.WithCancel(testContext(t))
	result := make(chan error, 1)
	go func() { result <- c.Call(ctx, "engine.status", struct{}{}, nil) }()
	<-accepted
	cancel()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if p.kills.Load() != 0 {
		t.Fatal("read-only probe killed busy engine")
	}
	close(release)
	if err := c.Call(testContext(t), "request.dispatch", struct{}{}, nil); err != nil {
		t.Fatalf("late status reply prevented further admission: %v", err)
	}
}

func TestRequestSizeRejectedBeforeHandoffAndHTMLIsNotExpanded(t *testing.T) {
	var handedOff atomic.Int32
	p := newFake(func(p *fakeProcess, e protocol.Envelope) {
		handedOff.Add(1)
		p.reply(e, struct{}{})
	})
	c := NewClient("g", p)
	t.Cleanup(func() { c.Stop(); c.Wait() })
	for _, size := range []int{MaxQueueBytes - 1024, protocol.MaxFrameBytes + 1} {
		err := c.Call(testContext(t), "request.dispatch", map[string]string{"value": strings.Repeat("a", size)}, nil)
		var failure *protocol.Error
		if !errors.As(err, &failure) || failure.Code != "request_too_large" {
			t.Fatalf("pre-handoff size failure was ambiguous: %v", err)
		}
	}
	if handedOff.Load() != 0 || p.kills.Load() != 0 {
		t.Fatal("oversized request reached or fenced engine")
	}
	// json.Marshal's default escaping would expand this valid 2 MiB request
	// past 8 MiB. Pipe JSON has no HTML embedding requirement.
	err := c.Call(testContext(t), "request.dispatch", json.RawMessage(`{"value":"`+strings.Repeat("<", 2<<20)+`"}`), nil)
	if err != nil || handedOff.Load() != 1 {
		t.Fatalf("valid opaque request expanded before handoff: %v", err)
	}
}

func TestReplayBurstBeyond128FramesRemainsAvailable(t *testing.T) {
	var sessionID string
	p := newFake(func(p *fakeProcess, e protocol.Envelope) {
		if e.Method == "session.open" {
			sessionID = openingSessionID(e)
			p.reply(e, map[string]string{"sessionId": sessionID})
			return
		}
		for i := 0; i < 512; i++ {
			message := json.RawMessage(fmt.Sprintf(`{"type":"event","id":"attach","seq":%d}`, i))
			p.send(protocol.Envelope{Version: 1, Generation: e.Generation, SessionID: sessionID, Message: message})
		}
		p.reply(e, struct{}{})
	})
	c := NewClient("g", p)
	t.Cleanup(func() { c.Stop(); c.Wait() })
	ctx := testContext(t)
	s, err := c.Open(ctx, "credential", "ip")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Dispatch(ctx, json.RawMessage(`{"id":"attach","type":"run.attach"}`)); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 512; i++ {
		msg, err := s.Receive(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var event struct {
			Seq int `json:"seq"`
		}
		if json.Unmarshal(msg, &event) != nil || event.Seq != i {
			t.Fatal("replay lost ordering")
		}
	}
	select {
	case <-s.Done():
		t.Fatal("ordinary replay burst was treated as a slow client")
	default:
	}
}
