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
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/swamp-club/swamp/packages/serve-go/internal/protocol"
)

const MaxPending = 128
const MaxSessionFrames = 10000
const MaxQueueBytes = 8 << 20
const cleanupReserveBytes = 64 << 10

var ErrUnavailable = errors.New("engine transport unavailable; an admitted operation may have been interrupted")
var ErrBusy = errors.New("engine admission limit reached")
var ErrRetiring = &protocol.Error{Code: "engine_retiring", Message: "Engine is recovering authentication; reconnect after accepted work finishes"}

// Session is a bounded mailbox. A slow subscriber never stalls the pipe reader.
type Session struct {
	ID         string
	Generation string
	client     *Client
	mu         sync.Mutex
	queue      chan json.RawMessage
	bytes      int
	done       chan struct{}
	closed     *protocol.Closed
	released   sync.Once
	slot       *sessionSlot
}

func (s *Session) Done() <-chan struct{} { return s.done }
func (s *Session) Closed() protocol.Closed {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed != nil {
		return *s.closed
	}
	return protocol.Closed{Code: 1011, Reason: "Engine connection ended"}
}
func (s *Session) Receive(ctx context.Context) (json.RawMessage, error) {
	// Deliver frames already received before an EOF/close. In particular, a
	// final done frame must win over a process exit observed immediately after it.
	take := func(msg json.RawMessage) (json.RawMessage, error) {
		s.mu.Lock()
		s.bytes -= len(msg)
		s.mu.Unlock()
		return msg, nil
	}
	select {
	case msg := <-s.queue:
		return take(msg)
	default:
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-s.done:
		select {
		case msg := <-s.queue:
			return take(msg)
		default:
		}
		return nil, ErrUnavailable
	case msg := <-s.queue:
		return take(msg)
	}
}
func (s *Session) close(reason protocol.Closed) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed != nil {
		return
	}
	s.closed = &reason
	close(s.done)
}
func (s *Session) offer(msg json.RawMessage) {
	s.mu.Lock()
	if s.closed != nil {
		s.mu.Unlock()
		return
	}
	if s.bytes+len(msg) <= MaxQueueBytes {
		select {
		case s.queue <- msg:
			s.bytes += len(msg)
			s.mu.Unlock()
			return
		default:
		}
	}
	s.mu.Unlock()
	s.close(protocol.Closed{Code: 1013, Reason: "Subscriber queue limit reached; reconnect to attach"})
}

type pendingCall struct {
	answer      chan protocol.Envelope
	abandoned   bool
	onAbandoned func(protocol.Envelope)
}

// A slot remains reserved from open admission through its close acknowledgement.
// Timed-out callers cannot grow remote sessions or cleanup work without bounds.
type sessionSlot struct {
	key     string
	id      string
	closing bool
	closed  *protocol.Closed
	done    chan struct{}
	err     error
}

type Client struct {
	generation  string
	process     Process
	mu          sync.Mutex
	pending     map[string]*pendingCall
	sessions    map[string]*Session
	slots       map[string]*sessionSlot
	closes      map[string]*sessionSlot
	cleanup     chan []byte
	writes      chan []byte
	queuedBytes int
	done        chan struct{}
	once        sync.Once
	sequence    atomic.Uint64
	retiring    atomic.Bool
	workers     sync.WaitGroup
	exited      chan struct{}
	waitError   error
	finished    chan struct{}
	unconfirmed atomic.Bool
}

func NewClient(generation string, process Process) *Client {
	c := &Client{generation: generation, process: process, pending: make(map[string]*pendingCall), sessions: make(map[string]*Session), slots: make(map[string]*sessionSlot), closes: make(map[string]*sessionSlot), cleanup: make(chan []byte, MaxSessions), writes: make(chan []byte, MaxPending), done: make(chan struct{}), exited: make(chan struct{}), finished: make(chan struct{})}
	c.workers.Add(2)
	go c.read()
	go c.write()
	go func() { c.waitError = process.Wait(); close(c.exited); c.workers.Wait(); close(c.finished) }()
	return c
}

func (c *Client) Done() <-chan struct{}   { return c.done }
func (c *Client) Exited() <-chan struct{} { return c.exited }
func (c *Client) Retiring() bool          { return c.retiring.Load() }
func (c *Client) Stop()                   { c.fail() }
func (c *Client) Wait() error             { <-c.finished; return c.CleanupError() }

// There is one owned native reaper regardless of how many callers stop waiting.
// A timed-out join permanently fences replacement, even if reaping later ends.
func (c *Client) WaitContext(ctx context.Context) error {
	select {
	case <-c.finished:
		return c.CleanupError()
	default:
	}
	select {
	case <-c.finished:
		return c.CleanupError()
	case <-ctx.Done():
		select {
		case <-c.finished:
			return c.CleanupError()
		default:
		}
		c.unconfirmed.Store(true)
		return errors.Join(ErrUnconfirmedCommandCleanup, ctx.Err())
	}
}

// Exited publishes waitError; reading it before that boundary would race reaping.
func (c *Client) CleanupError() error {
	if c.unconfirmed.Load() {
		return ErrUnconfirmedCommandCleanup
	}
	select {
	case <-c.exited:
		if errors.Is(c.waitError, ErrUnconfirmedCommandCleanup) {
			return ErrUnconfirmedCommandCleanup
		}
	default:
	}
	return nil
}
func (c *Client) SetCleanupDeadline(ctx context.Context) {
	setProcessCleanupDeadline(c.process, ctx)
}

func (c *Client) fail() {
	c.once.Do(func() {
		close(c.done)
		_ = c.process.Input().Close()
		_ = c.process.Output().Close()
		_ = c.process.Kill()
		c.mu.Lock()
		for _, s := range c.sessions {
			s.close(protocol.Closed{Code: 1011, Reason: "Engine stopped; operation outcome may be indeterminate"})
		}
		c.mu.Unlock()
	})
}

func (c *Client) Call(ctx context.Context, method string, params interface{}, result interface{}) error {
	err, _ := c.call(ctx, method, params, result, nil)
	return err
}

// abandoned is true only when a queued control outlives its waiting caller.
// Its bounded correlation remains until a reply or transport failure; a late
// authentication result has its own cleanup callback. No control is replayed.
func (c *Client) call(ctx context.Context, method string, params interface{}, result interface{}, onAbandoned func(protocol.Envelope)) (error, bool) {
	if err := ctx.Err(); err != nil {
		return err, false
	}
	select {
	case <-c.done:
		return ErrUnavailable, false
	default:
	}
	p, err := protocol.Marshal(params)
	if err != nil {
		return &protocol.Error{Code: "invalid_request", Message: "Request cannot be encoded"}, false
	}
	id := fmt.Sprint(c.sequence.Add(1))
	frame, err := protocol.Encode(protocol.Envelope{Version: protocol.Version, Generation: c.generation, ID: id, Method: method, Params: p})
	if err != nil {
		if errors.Is(err, protocol.ErrFrameTooLarge) {
			return &protocol.Error{Code: "request_too_large", Message: "Request exceeds engine admission size limit"}, false
		}
		return err, false
	}
	call := &pendingCall{answer: make(chan protocol.Envelope, 1), onAbandoned: onAbandoned}
	c.mu.Lock()
	pendingLimit, byteLimit := MaxPending, MaxQueueBytes-cleanupReserveBytes
	if method == "request.dispatch" || method == "session.open" {
		pendingLimit -= 16
		byteLimit -= 64 << 10
	}
	if len(frame) > byteLimit {
		c.mu.Unlock()
		return &protocol.Error{Code: "request_too_large", Message: "Request exceeds engine admission size limit"}, false
	}
	if len(c.pending) >= pendingLimit || c.queuedBytes+len(frame) > byteLimit {
		c.mu.Unlock()
		return ErrBusy, false
	}
	c.pending[id] = call
	c.queuedBytes += len(frame)
	select {
	case c.writes <- frame:
	default:
		delete(c.pending, id)
		c.queuedBytes -= len(frame)
		c.mu.Unlock()
		return ErrBusy, false
	}
	c.mu.Unlock()
	decode := func(response protocol.Envelope) error {
		if response.Error != nil {
			return response.Error
		}
		if result != nil && json.Unmarshal(response.Result, result) != nil {
			c.fail()
			return protocol.ErrFrame
		}
		return nil
	}
	select {
	case <-ctx.Done():
		c.mu.Lock()
		call.abandoned = true
		// The reader may already have removed the correlation and queued its
		// answer. Claim that answer here so cleanup runs exactly once.
		var completed *protocol.Envelope
		if _, waiting := c.pending[id]; !waiting {
			select {
			case response := <-call.answer:
				completed = &response
			default:
			}
		}
		c.mu.Unlock()
		if completed != nil && onAbandoned != nil {
			onAbandoned(*completed)
		}
		return ctx.Err(), true
	case response := <-call.answer:
		return decode(response), false
	case <-c.done:
		select {
		case response := <-call.answer:
			return decode(response), false
		default:
			return ErrUnavailable, false
		}
	}
}

func (c *Client) read() {
	defer c.workers.Done()
	defer c.fail()
	for {
		e, err := protocol.Read(c.process.Output())
		if err != nil || e.Generation != c.generation {
			return
		}
		if e.ID != "" {
			if (e.Error == nil) == (len(e.Result) == 0) || e.Method != "" || e.SessionID != "" {
				return
			}
			// Retirement is an engine-owned decision. Remember it even if the
			// requesting HTTP client already left and its response is abandoned.
			if e.Error != nil && e.Error.Code == "engine_retiring" {
				c.retiring.Store(true)
			}
			c.mu.Lock()
			if slot := c.closes[e.ID]; slot != nil {
				delete(c.closes, e.ID)
				if e.Error != nil {
					slot.err = e.Error
				}
				if e.Error == nil {
					delete(c.slots, slot.key)
				}
				close(slot.done)
				c.mu.Unlock()
				continue
			}
			call := c.pending[e.ID]
			delete(c.pending, e.ID)
			var abandoned func(protocol.Envelope)
			if call != nil {
				if call.abandoned {
					abandoned = call.onAbandoned
				} else {
					call.answer <- e
				}
			}
			c.mu.Unlock()
			if abandoned != nil {
				abandoned(e)
			}
			continue
		}
		if (len(e.Message) == 0) == (e.Closed == nil) {
			return
		}
		c.mu.Lock()
		s := c.sessions[e.SessionID]
		if s == nil && e.Closed != nil {
			// Authentication can finish and revoke the session before Open's
			// caller resumes. Retain that close on its bounded reservation.
			if slot := c.slots[e.SessionID]; slot != nil && slot.closed == nil {
				closed := *e.Closed
				slot.closed = &closed
			}
		}
		c.mu.Unlock()
		if s != nil {
			if e.Closed != nil {
				s.close(*e.Closed)
			} else {
				s.offer(e.Message)
			}
		}
	}
}

func (c *Client) write() {
	defer c.workers.Done()
	for {
		var frame []byte
		cleanup := false
		// Cleanup has reserved frames and bytes, independent of abandoned public
		// controls. A close is queued only after its open response was received.
		select {
		case frame = <-c.cleanup:
			cleanup = true
		default:
		}
		if frame == nil {
			select {
			case <-c.done:
				return
			case frame = <-c.cleanup:
				cleanup = true
			case frame = <-c.writes:
			}
		}
		if protocol.Write(c.process.Input(), frame) != nil {
			c.fail()
			return
		}
		if !cleanup {
			c.mu.Lock()
			c.queuedBytes -= len(frame)
			c.mu.Unlock()
		}
	}
}

func (c *Client) releaseSlot(slot *sessionSlot) {
	c.mu.Lock()
	delete(c.slots, slot.key)
	c.mu.Unlock()
}

func (c *Client) confirmSlot(slot *sessionSlot, id string) bool {
	// The engine must acknowledge the caller's preallocated ID. This binds
	// early revocation and late authentication cleanup to the same reservation.
	return id == slot.id
}

func (c *Client) queueClose(slot *sessionSlot) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	select {
	case <-c.done:
		delete(c.slots, slot.key)
		return ErrUnavailable
	default:
	}
	if slot.closing {
		return nil
	}
	id := fmt.Sprint(c.sequence.Add(1))
	params, _ := protocol.Marshal(map[string]string{"sessionId": slot.id})
	frame, err := protocol.Encode(protocol.Envelope{Version: protocol.Version, Generation: c.generation, ID: id, Method: "session.close", Params: params})
	// Every ID is bounded ASCII. At most MaxSessions reserved slots can queue
	// one close each, so the entire lane fits the reserved 64 KiB.
	if err != nil || len(frame) > cleanupReserveBytes/MaxSessions {
		return protocol.ErrFrame
	}
	slot.closing = true
	c.closes[id] = slot
	c.cleanup <- frame
	return nil
}

func (c *Client) Open(ctx context.Context, credential, sourceIP string) (*Session, error) {
	if c.Retiring() {
		return nil, ErrRetiring
	}
	authenticationTimeout := engineDeadline(ctx, 5*time.Minute)
	if authenticationTimeout <= 0 {
		return nil, context.DeadlineExceeded
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, err
	}
	id := hex.EncodeToString(nonce[:])
	slot := &sessionSlot{key: id, id: id, done: make(chan struct{})}
	c.mu.Lock()
	if len(c.slots) >= MaxSessions {
		c.mu.Unlock()
		return nil, ErrBusy
	}
	c.slots[id] = slot
	c.mu.Unlock()
	var result struct {
		SessionID string `json:"sessionId"`
	}
	abandoned := func(response protocol.Envelope) {
		if response.Error != nil {
			c.releaseSlot(slot)
			return
		}
		var late struct {
			SessionID string `json:"sessionId"`
		}
		if json.Unmarshal(response.Result, &late) != nil || !c.confirmSlot(slot, late.SessionID) {
			c.fail()
			return
		}
		if err := c.queueClose(slot); err != nil && !errors.Is(err, ErrUnavailable) {
			c.fail()
		}
	}
	err, outstanding := c.call(ctx, "session.open", struct {
		SessionID               string `json:"sessionId"`
		Credential              string `json:"credential"`
		SourceIP                string `json:"sourceIp"`
		AuthenticationTimeoutMs int64  `json:"authenticationTimeoutMs"`
	}{id, credential, sourceIP, authenticationTimeout}, &result, abandoned)
	if err != nil {
		if !outstanding {
			c.releaseSlot(slot)
		}
		return nil, err
	}
	if !c.confirmSlot(slot, result.SessionID) {
		c.fail()
		c.releaseSlot(slot)
		return nil, protocol.ErrFrame
	}
	s := &Session{ID: result.SessionID, Generation: c.generation, client: c, slot: slot, queue: make(chan json.RawMessage, MaxSessionFrames), done: make(chan struct{})}
	c.mu.Lock()
	if slot.closed != nil {
		delete(c.slots, slot.key)
		code := "session_closed"
		if slot.closed.Code == 4002 || slot.closed.Code == 4003 {
			code = "unauthorized"
		}
		c.mu.Unlock()
		return nil, &protocol.Error{Code: code, Message: "Session ended during authentication"}
	}
	c.sessions[s.ID] = s
	c.mu.Unlock()
	select {
	case <-c.done:
		s.close(protocol.Closed{Code: 1011, Reason: "Engine stopped"})
		c.releaseSlot(slot)
		return nil, ErrUnavailable
	default:
	}
	return s, nil
}

func (s *Session) Dispatch(ctx context.Context, request json.RawMessage) error {
	return s.client.Call(ctx, "request.dispatch", struct {
		SessionID string          `json:"sessionId"`
		Request   json.RawMessage `json:"request"`
	}{s.ID, request}, nil)
}
func (s *Session) Close(ctx context.Context) error {
	s.close(protocol.Closed{Code: 1000, Reason: "Session closed"})
	s.client.mu.Lock()
	delete(s.client.sessions, s.ID)
	s.client.mu.Unlock()
	if err := s.client.queueClose(s.slot); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-s.client.done:
		return ErrUnavailable
	case <-s.slot.done:
		s.client.mu.Lock()
		err := s.slot.err
		s.client.mu.Unlock()
		return err
	}
}
