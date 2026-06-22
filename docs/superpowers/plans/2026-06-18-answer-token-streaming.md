# Answer Token Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the streaming run feel like a real typewriter by emitting answer token deltas instead of only showing trace events.

**Architecture:** Keep the existing trace SSE route and add an `answer_delta` event. Add optional provider streaming via `completeStream()` for final-answer turns, while tool-call turns continue using the existing non-streaming completion path. React appends `answer_delta.delta` into a live answer preview and still renders trace events below it.

**Tech Stack:** Fastify, TypeScript, OpenAI-compatible chat completion streaming, Server-Sent Events, React, Vitest, Testing Library.

---

## Task 1: Provider Streaming Contract

- [ ] Add `answer_delta` to `AgentStreamEvent`.
- [ ] Add `completeStream(request, onDelta)` to the provider interface as an optional method.
- [ ] Test OpenAI-compatible streaming parser with SSE chunks containing `choices[0].delta.content`.
- [ ] Implement `stream: true` requests in `OpenAiCompatibleProvider.completeStream()`.

## Task 2: AgentService Delta Events

- [ ] Test that final-answer turns emit `answer_delta` events before `final_answer` when the provider supports streaming.
- [ ] Keep tool-call turns on the existing `complete()` path so tool execution remains stable.
- [ ] Fall back to the existing `complete()` path when a provider does not implement `completeStream()`.

## Task 3: React Typewriter UX

- [ ] Test that clicking “流式运行” appends `answer_delta` text into the answer panel.
- [ ] Add `answer_delta` to frontend event types.
- [ ] Update `handleStreamRun()` to build the answer incrementally.
- [ ] Keep Trace visible but focused on event titles and payloads.

## Task 4: Verification

- [ ] Run `npm run test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Verify `/agents/stream` returns `answer_delta` chunks with CORS headers.
