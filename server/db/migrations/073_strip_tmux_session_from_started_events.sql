-- #436: the tmux session NAME is enough to attach to a worker's terminal, which
-- is authority well beyond the Console API. `markRunStarted` no longer writes it
-- into the `started` event payload, but rows written before this migration still
-- carry it and `GET /api/runs/:id/events` returns them verbatim.
--
-- Rewrite the historical rows rather than filtering at response time: the value
-- has no consumer (no code reads `started.payload_json.tmux_session`), and
-- filtering a serialized payload on the way out is unreliable in a way that
-- removing it at rest is not.
--
-- json_remove leaves non-JSON or absent payloads untouched, and the WHERE clause
-- keeps the rewrite to rows that actually contain the key. `json_type` rather
-- than `json_extract` so an explicit `"tmux_session": null` is removed too:
-- json_extract cannot tell a null VALUE from an absent key.
UPDATE run_events
SET payload_json = json_remove(payload_json, '$.tmux_session')
WHERE event_type = 'started'
  AND payload_json IS NOT NULL
  AND json_valid(payload_json)
  AND json_type(payload_json, '$.tmux_session') IS NOT NULL;
