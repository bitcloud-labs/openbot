# BitMind gateway

The surface BitMind's run plane talks to, run as its own process
(`server/src/bitmind/main.ts`) inside the execution enclave. It exists so the two
sides can meet on the real protocol — AG-UI at the pinned `@ag-ui/core@0.0.57`
(bit-mind ADR-0002) — before the full server learns to boot without the Intelligence
contract.

## Surface

| Route | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/health` | GET | none | Liveness for a supervisor. Reports nothing else. |
| `/bitmind/v1/attestation` | GET | Bearer `BITMIND_SERVICE_TOKEN` | What is behind the door, honestly. |
| `/bitmind/v1/run` | POST | Bearer `BITMIND_SERVICE_TOKEN` | One `RunAgentInput` in, the AG-UI SSE event stream out. |

A run is validated against the pinned `RunAgentInputSchema` and relayed whole to the
configured downstream agent (`BITMIND_AGENT_URL`, by default `agent-langgraph` on
loopback), authenticated with that agent's managed-agent token. BitMind's identity
statement rides in `forwardedProps` — `workspace_id`, `agent_id`, `run_id`,
`message_id`, `fencing_token` — and is forwarded untouched.

## What the gateway owns

- **Service authentication**, timing-safe, on everything but `/health`.
- **Input validation** against the pinned protocol schemas; invalid bodies are
  refused without being echoed.
- **Admission control**: at most `BITMIND_MAX_CONCURRENT_RUNS` relays (staging starts
  at two, matching the enclave note); past the ceiling a run is refused with 429 and
  `retry-after` rather than degrading the host.
- **Idempotency**: BitMind sends `idempotency-key: run_id:fencing_token`; while a
  relay under that key is live, a second POST is refused with 409. BitMind's bounded
  retry and event dedupe absorb the rest.
- **A run ceiling** (`BITMIND_RUN_TIMEOUT_MS`) so an abandoned stream cannot hold a
  slot forever.

## What it deliberately does not do yet

- **No computers, no tools, no interrupts.** The relayed agent is prose-only; nothing
  consequential can happen through this door. That is why the attestation reports
  `isolated_computers: false` — BitMind's activation gate (bit-mind
  `docs/operations/openbot-single-host-enclave.md`) requires `true` before its worker
  may be enabled, and no isolation exists here to attest. The flag turns true when
  enclave-managed agent computers actually stand behind the gateway, not before.
- **No policy or audit surface.** Those live in the server's governed gateway; they
  join this path when tool execution does.
- **Interrupt-driven approvals** (`RUN_FINISHED` with an interrupt outcome, answered
  via `RunAgentInput.resume`) are the contract BitMind's approval gate is built
  against; this gateway relays them faithfully when the downstream emits them, but
  the shipped `agent-langgraph` does not yet.

## Running it

```
BITMIND_SERVICE_TOKEN=… BITMIND_AGENT_TOKEN=… bun run --filter server bitmind:start
```

It refuses to start without both tokens, binds loopback by default, and never holds
BitMind database credentials, OIDC secrets, or the Docker socket — per the enclave
boundary.
