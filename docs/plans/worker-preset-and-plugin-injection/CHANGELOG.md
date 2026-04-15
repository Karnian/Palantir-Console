# CHANGELOG — Worker Preset & Plugin Injection

## 2026-04-14 — Created

- **Scale:** L
- **Mode:** Forward
- **Stories:** 7 user stories (US-001 ~ US-007). US-007 EXCLUDED at Phase 10G closeout — argv-level Tier 2 wiring covers G1.
- **Status:** draft

## 2026-04-15 — Phase 10A~10G shipped (PRs #87, #89, #90, #91, #92, #93, #94)

- US-001~006, US-008 + G1/G6 verified by automated tests.
- US-007 (canary listing) excluded — see prd.json `status: excluded`.
- Status → **shipped** (GREEN).
- **Summary:** 2-tier Worker Preset system — Tier 1 (portable MCP + prompt) for all adapters, Tier 2 (--bare + --plugin-dir) for Claude only. Resolves ecosystem plugin reuse + host isolation. v3 Phase 10 equivalent.
- **Phases:** 10A (auth spike, gate) → 10B (DB+service) → 10C (Tier 1 spawn) → 10D (Tier 2 spawn) → 10E (UI) → 10F (snapshot) → 10G (agent-olympus smoke)
- **Total estimate:** 13-21 days solo
