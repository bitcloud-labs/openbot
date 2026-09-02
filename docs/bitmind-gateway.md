# BitMind gateway

The surface BitMind's run plane talks to, served by the OpenBot server itself inside
the execution enclave. It exists so the two sides can meet on the real protocol —
AG-UI at the pinned `@ag-ui/core@0.0.57` (bit-mind ADR-0002).

It began as a separate process, because the server refused to boot without the
Intelligence contract and the enclave has none. Standalone mode removed that reason,
so the gateway now boots with the server: one process for the enclave to supervise,
one shutdown, one place a deployment's configuration is read.

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

Set the variables and start the server as usual:

```
OPENBOT_RUNTIME_MODE=standalone \
BITMIND_SERVICE_TOKEN=… BITMIND_AGENT_TOKEN=… \
bun run --filter server dev
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `BITMIND_SERVICE_TOKEN` | — | Required. What BitMind authenticates with. |
| `BITMIND_AGENT_TOKEN` | — | Required. The downstream agent's managed-agent token. |
| `BITMIND_AGENT_URL` | `http://localhost:4201/ag-ui` | Where runs are relayed. |
| `BITMIND_GATEWAY_HOST` | `127.0.0.1` | Loopback unless deliberately changed. |
| `BITMIND_GATEWAY_PORT` | `4310` | The gateway's own port. |
| `BITMIND_MAX_CONCURRENT_RUNS` | `2` | Admission ceiling. |
| `BITMIND_RUN_TIMEOUT_MS` | `900000` | Whole-run relay ceiling. |

Setting none of them mounts no gateway; setting any of them requires all of the
required ones, so a half-configured enclave fails at boot rather than answering
BitMind with a server that cannot relay.

### Why a second port rather than a path on the server's

The gateway listens on its own host and port, in the server's process. The server's
port is what an operator publishes — an ingress, a compose port mapping — and putting a
service-token-authenticated relay on it would export the enclave's private surface
wherever that port goes, without anybody choosing it. Loopback stays the default here,
as bit-mind's `docs/operations/openbot-single-host-enclave.md` requires. A boot test
asserts both halves: the gateway answers on its own port, and the server's port answers
`404` to `/bitmind/v1/attestation` even with the service token in hand.

It refuses to start without both tokens, binds loopback by default, and never holds
BitMind database credentials, OIDC secrets, or the Docker socket — per the enclave
boundary.
