# Manager message durable FIFO contract

## Decision

Top and Operator chat input uses the SQLite-backed `manager_message_queue`
instead of an in-memory queue.

SQLite was chosen because Palantir Console already treats the local SQLite WAL
database as its authoritative runtime store. A separate broker would add an
operational dependency without improving the single-host ordering contract,
while an in-memory queue would lose accepted input whenever the server or
manager session is recreated.

Each conversation has at most one `sending` or `processing` row. FIFO order is
the row's monotonic `sequence`; the driver claims only the oldest available
`queued` row when no active row exists for that conversation.

## Delivery and duplicate contract

- Admission is durable before the API reports success.
- Delivery is **at least once**. An expired claim is recovered after restart
  and replayed unless a correlated terminal run event is already stored.
- The client supplies an idempotency key (body or `Idempotency-Key` header).
  `(conversation_id, idempotency_key)` is unique, so HTTP retries return the
  original row rather than enqueueing a duplicate.
- A random claim token plus a compare-and-swap update (`queued → sending`)
  prevents two drivers from delivering the same live claim concurrently.
- The queue message id is passed to adapters as `invocationId`.
  `mgr.turn_completed` / `mgr.turn_failed` terminal events correlate the
  external turn back to the durable row.
- There is an unavoidable external-side-effect window: if the server dies
  after an adapter accepts a turn but before any terminal event is persisted,
  restart recovery replays it to satisfy at-least-once delivery. Ingress
  idempotency and CAS prevent application duplicates, but the Claude/Codex
  protocols do not provide an exactly-once idempotency primitive. A repeated
  model turn is therefore possible only in this crash window.

The existing conversation target/binding checks, authentication middleware,
memory/codebase injection, and parent-notice peek-then-commit-drain path remain
the actual dispatcher. Queueing does not bypass or duplicate those contracts.

## State model

`queued → sending → processing → delivered | failed`

`queued → cancelled` is also supported. `sending` can be brief, but it is
persisted before crossing the adapter boundary.

The ManagerChat UI renders the user bubble optimistically as `queued`, then
uses `conversation:message_status` SSE frames and the durable messages API to
show every subsequent transition. A terminal failure includes `last_error`.

## Lifecycle policy

- **Several consecutive messages:** preserved and delivered in conversation
  FIFO order. Top and every Operator conversation have independent
  single-flight lanes; no lane runs two manager turns concurrently.
- **Operator scheduler turns:** use the same lane. Because the scheduler
  already owns its own durable invocation/retry state, it requests an
  immediate queue claim: if chat work is active or waiting it receives
  `OPERATOR_BUSY` and retries through the scheduler instead of creating a
  second durable copy. Its invocation id is still the adapter correlation id.
- **Images/attachments:** the full validated base64 payload is stored with the
  text and follows the same FIFO/recovery policy. The public queue projection
  returns only attachment count, never the base64 data. HTTP input remains
  subject to the existing Express 2 MB request limit; the service rejects
  serialized payloads above 12 MB for non-HTTP callers.
- **Graceful server restart:** queued rows remain queued. A prior
  sending/processing claim remains durable, its lease expires, and the new
  owner first looks for a correlated terminal event before replaying it.
- **Explicit Manager stop/reset or adapter replacement:** queued rows are
  preserved for the next session with the same conversation identity. An
  already sending/processing row is marked failed with
  `session_ended_during_processing`; it is not silently replayed across an
  explicit identity/adapter boundary.
- **Input arriving during an Operator reset/adapter transition:** a valid
  Operator target is admitted and waits for the replacement session. A brand
  new Top input with no active Top session retains the legacy 404 behavior;
  the queue is not an offline Top mailbox.
- **Invalid/deleted target:** rejected before admission. Existing
  router/conversation binding validation still runs again at delivery time.

## Limits, backpressure, cancellation, and retry

- Active cap: **50 rows per conversation** (`queued + sending + processing`).
  The next admission returns HTTP 429, code `MANAGER_QUEUE_FULL`, and
  `Retry-After: 1`.
- Cancellation: only a `queued` row can be cancelled. Once sending begins, the
  external acceptance boundary may have been crossed, so cancellation returns
  409 rather than pretending recall was safe.
- Busy, transition, and temporarily missing Operator states return the claim to
  `queued` and retry after 1–5 seconds without consuming the terminal retry
  budget.
- Other explicitly retryable transport failures use exponential delay and stop
  after three delivery attempts.
- Binding/configuration/input failures are terminal immediately.
- `mgr.turn_failed` is terminal and is not automatically replayed, because the
  model may already have produced side effects. The user receives the reason
  and may submit a deliberate new message.

## API

- `POST /api/conversations/:id/message`
  - accepts `Idempotency-Key` or `idempotencyKey`
  - immediate idle delivery keeps `status: "sent"` and adds
    `deliveryStatus` plus `message`
  - busy delivery returns `status: "queued"`
- `GET /api/conversations/:id/messages?limit=100`
  - returns status metadata for recent durable messages
- `DELETE /api/conversations/:id/messages/:messageId`
  - cancels a queued row

The legacy Top and project Operator message aliases feed the same queue.
