# Launch readiness: OpenBot computers (BitMind as caller)

**Status:** draft findings only. Do not merge as if it were a feature. Do not deploy.
**Assessor:** kit skill `code-reviewer` (`agent_id` `0f542ca8-9438-4cb5-a409-0c2eaef68197`).
**Date:** 2026-09-14. Recast the same day: this review is **OpenBot-only**.
**Question:** how far until Bit Bot can launch with real agents and real computers, **from this execution plane**?
**Headline:** **~45% ready on the OpenBot side.** Per-bot Chromium, the CEL decide-before / audit-after gateway, and the supervisor are built. The BitMind-facing door on public `main` is still a prose-only relay that attests `isolated_computers: false`. Computers are not behind that door until PR #5 / `openbot-private` lands. UI-TARS is not in this tree.

No secrets, host credentials, or token values appear in this document. Environment **names** only.

---

## Scope

This file reviews **`bitcloud-labs/openbot`** (`main` @ `ac1b7d1`): computers, CEL policy, Chromium, the supervisor, and the contract OpenBot exposes for BitMind.

**BitMind is an external dependency**, not a package in this monorepo. It lives at [`bitcloud-labs/bit-mind`](https://github.com/bitcloud-labs/bit-mind) — durable control plane and orchestration for BitBot (threads, identity, runs). Another agent is reviewing that repo. This document names the **caller contract** OpenBot already implements and the **gaps on this side of the wire**. It does not score BitMind internals.

Product stack (for orientation only):

```
Bit Bot / bit-bot-site  →  BitMind (external)  →  OpenBot (this repo)
                                               computers + CEL + Chromium
```

| Plane | Repository | This review |
| --- | --- | --- |
| Bit Bot clients | `bitcloud-labs/bit-bot`, `bitcloud-labs/bit-bot-site` | Cited only where they constrain OpenBot (no site→GPU, Contabo is site-only). |
| BitMind | `bitcloud-labs/bit-mind` | **External caller.** See “How OpenBot expects BitMind.” |
| OpenBot | **this repo** | **In scope.** |
| OpenBot derivative | `bitcloud-labs/openbot-private` | Noted where it is ahead of this `main` (computer routes on the BitMind door). |

---

## How OpenBot expects BitMind

OpenBot does not embed BitMind. It optionally **mounts a private AG-UI door** that BitMind is supposed to call. Ordinary OpenBot deployments mount nothing (`server/src/bitmind/mount.ts`: any `BITMIND_*` variable means “serve BitMind”; none means no gateway).

What this repo requires of that caller, today:

| Expectation | Where OpenBot enforces it |
| --- | --- |
| Service bearer `BITMIND_SERVICE_TOKEN`, timing-safe, on every route except `/health` | `server/src/bitmind/gateway.ts`, [`docs/bitmind-gateway.md`](bitmind-gateway.md) |
| AG-UI `@ag-ui/core` **0.0.57** — one `POST /bitmind/v1/run` → SSE `text/event-stream` | `server/src/bitmind/config.ts` `AG_UI_PROTOCOL_VERSION`; body = `RunAgentInputSchema` |
| Identity in `forwardedProps`: `workspace_id`, `agent_id`, `run_id`, `message_id`, `fencing_token` (non-negative int). `run_id` must match `runId`. | `BitmindForwardedPropsSchema` in `gateway.ts`. Forwarded **untouched**; OpenBot does not resolve BitMind users. |
| `idempotency-key: run_id:fencing_token` while a relay is live → 409 | same |
| Concurrent relays ≤ `BITMIND_MAX_CONCURRENT_RUNS` (default **2**) → 429 + `retry-after` | `config.ts` |
| Loopback by default (`BITMIND_GATEWAY_HOST=127.0.0.1`, port **4310**), **not** a path on the published server port | `mount.ts`; boot test asserts `/bitmind/v1/attestation` is 404 on the app port |
| Honest attestation: `isolated_computers`, `execution.tools`, `execution.interrupts` | `gateway.ts` `BitmindAttestation`. On this `main`, computers/tools/interrupts are all **false**. |
| No BitMind database URL, OIDC secret, or Docker socket in this process | [`docs/bitmind-gateway.md`](bitmind-gateway.md); `OPENBOT_RUNTIME_MODE=standalone` unmounts Intelligence chat (`server/src/config.ts`) |

What OpenBot does **not** do for BitMind on this `main`:

- Does not mint BitMind sessions, threads, or workspace memberships.
- Does not verify bit-bot-site Better Auth cookies or JWTs. The door is a **service token**, not a user session.
- Does not put CEL / audit on the `/bitmind/v1/run` hop. Policy lives on `server/src/computer/gateway.ts` for the OpenBot app path. The BitMind door refuses tools until it attests `tools: true`.
- Does not serve `/bitmind/v1/computer/{id}` (observe / ensure / screenshot / control). That exists on `openbot-private` and PR [#5](https://github.com/bitcloud-labs/openbot/pull/5). On `main`, those URLs 404.
- Does not implement `/internal/runs/assert`, `/internal/runs/tools`, or `/internal/roster` (named in BitMind’s service spec as fork work). This tree has `/internal/routines/run` only.

BitMind’s activation note (`docs/operations/openbot-single-host-enclave.md` in that repo) says: do not enable its worker until this gateway attests `isolated_computers=true` plus service auth, fencing idempotency, cancellation, and action audit. OpenBot’s own docs agree the flag must stay false until enclave-managed computers actually stand behind the door.

---

## Overall score (OpenBot side)

**~45%** toward “BitMind can point at this deployment and get a real isolated computer, governed by CEL.”

| Slice | Meaning | Ready |
| --- | --- | --- |
| OpenBot laptop / admin product | CEL + Chromium + supervisor; Intelligence threads for the web app | **~80%** (alpha, machinery exists) |
| BitMind door: prose relay | Service auth, `RunAgentInput`, identity props, admission, standalone boot | **~70%** |
| BitMind door: computers behind it | Attest isolation; ensure / screenshot / control on `/bitmind/v1` | **~25%** on `main` (**~60%** if #5 / `openbot-private` is the deploy source) |
| BitMind door: governed tool / click | `tools: true` only after CEL+audit sit on that hop | **~10%** |
| UI-TARS on an OpenBot computer | Vision plugin inside the enclave, not site→GPU | **~5%** (SPEC elsewhere; no code here) |

The 45% headline is the product computer stack plus a working prose relay, minus computers-on-the-BitMind-door and TARS.

---

## Assessment (Done / In progress / Missing)

### 1. BitMind caller contract (AG-UI door) — **In progress (~70% as a relay; not a computer plane)**

Assessed **as OpenBot implements it**. BitMind’s threads, identity, and worker are out of scope.

| Piece | Status | Evidence in this repo |
| --- | --- | --- |
| Optional mount, fail-closed config | **Done** | `server/src/bitmind/mount.ts`, `config.ts` |
| Service auth + pinned AG-UI 0.0.57 | **Done** | `gateway.ts`, `AG_UI_PROTOCOL_VERSION` |
| Identity statement on the run | **Done** | `forwardedProps` schema; forwarded, not interpreted |
| Admission + idempotency + timeout | **Done** (single process) | default 2 runs; 409 / 429 |
| Standalone (no Intelligence) | **Done** | `OPENBOT_RUNTIME_MODE=standalone`; Helm `charts/openbot/ci/standalone-values.yaml` |
| Honest “no computers yet” | **Done** | `isolated_computers: false` literal; tests pin it (`server/tests/bitmind-gateway.test.ts`, `standalone-boot.integration.test.ts`) |
| Computers / tools / interrupts on this door | **Missing** on `main` | [`docs/bitmind-gateway.md`](bitmind-gateway.md) “What it deliberately does not do yet” |
| `/internal/runs/*` join for grants | **Missing** | Specified as fork work; not in this tree |

---

### 2. Per-bot computers, CEL gateway, Chromium — **Done on the product path; Missing behind the BitMind door**

Do not collapse the two paths.

#### Product path (OpenBot app → server → computer) — **Done**

| Piece | Evidence |
| --- | --- |
| CEL decide-before / audit-after | [`docs/architecture.md`](architecture.md); `server/src/computer/gateway.ts`: resolve snapshot → policy → audit row → act. Deny first; empty or broken policy fails closed. Shipped default is `deny: []`, `allow: ["true"]` unless replaced. |
| Per-bot computers | `COMPUTER_SUPERVISOR_URL` → `server/src/computer/supervisor.ts` (ensure / stop / reset / list). Without it, every Bot shares `AGENT_COMPUTER_URL` ([`docs/deployment.md`](deployment.md)). |
| Chromium + `/workspace` | `agent-computer` (port 4100). Compose binds `127.0.0.1`. Helm sandbox / StatefulSet for a cluster. |
| Actor type | `ActionActor` on the computer gateway. Product path uses a real `users` row. |
| Human takeover | `computer.help_requested` / `control_taken` / `control_released`. Bot actions refused while a person drives. |
| Shared work queue | `work_items` + `select … for update skip locked` (`server/src/work/queue.ts`) for routines, handoffs, computer culler. |

This is what `/admin/computers`, `/bot`, and channel screens use. Bit Bot never calls it.

#### BitMind path (this `main`) — **Missing computers behind the door**

- Attestation hard-codes `isolated_computers: false`.
- Relayed agent is prose-only; `tools.length > 0` and `resume` are 400.
- No `/bitmind/v1/computer/{id}` routes.

On **`openbot-private`** and open PR [#5](https://github.com/bitcloud-labs/openbot/pull/5) (`feat/gateway-supervisor-wiring`):

- `isolated_computers` is true only while `ComputerGateway.provider.list()` succeeds (same seam as the product UI).
- Observe / ensure / screenshot / control are served. Control requires `x-bitmind-actor-id` and stamps `bitmind:{id}` — **not** an OpenBot `users` row.
- Attestation still reports `tools: false` and `interrupts: false`.

Merging #5 (or deploying `openbot-private`) is the next **OpenBot** ticket. It does not require a BitMind rewrite.

---

### 3. Auth: what OpenBot will accept from a BitMind hop — **In progress for the service door; user handoff is not OpenBot’s job**

| Layer | Status | Evidence |
| --- | --- | --- |
| OpenBot app sign-in | **Done** | Better Auth: Google / Microsoft / Okta / runtime SAML+OIDC, or `OPENBOT_SINGLE_USER`. Own `users` table. [`README.md`](../README.md) Sign in; `server/src/auth/`. |
| BitMind **service** door | **Done** | Bearer `BITMIND_SERVICE_TOKEN` only. No cookie, no BA JWT. |
| Map site / BitMind human → OpenBot `users.id` | **Missing here; belongs to BitMind + site** | This gateway does not verify bit-bot-site sessions. PR #5’s control path treats the BitMind actor as foreign on purpose. |
| Site Better Auth (Contabo) | **External** | Live email/password is a **bit-bot-site** fact. OpenBot must not grow a second password table or accept `VITE_*` computer URLs. |

OpenBot’s P0 on auth is: keep the BitMind door service-token-only, loopback, and honest about actors that are not local users. The BA → BitMind principal map is the other review.

---

### 4. Chat workers / Qwen vs what OpenBot actually runs — **OpenBot agents exist; Qwen is not this plane**

| Layer | Status | Evidence |
| --- | --- | --- |
| AG-UI Bots in this repo | **Done** (lab) | `agent-bot` (4200), `agent-langgraph` (4201). Default BitMind relay target is `http://localhost:4201/ag-ui`. OpenAI / Anthropic / Google keys — not Qwen3.6-27B, not a vLLM slot pool. |
| One-container image | **No Bot process** | [`docs/deployment.md`](deployment.md): `MANAGED_AGENT_AG_UI_URL` unset omits the shipped coworker. Enclave must run an agent beside the gateway. |
| Qwen Phases 0–4 | **Not OpenBot** | Specified on bit-bot-site (`SPEC-bitbot-qwen-scale.md`). Chat GPU must not land in this image or on Contabo. |

For an OpenBot-side launch slice, `agent-langgraph` behind the BitMind door is a valid **prose** backend. It is not the product chat plane.

---

### 5. UI-TARS / computer-use under OpenBot (not site → GPU) — **Missing**

| Layer | Status | Evidence |
| --- | --- | --- |
| Decide-before / audit-after host | **Done** | `server/src/computer/gateway.ts` is the only acting path on the product side. |
| TARS / UI-TARS-2 / vision plugin | **Missing** | No matches in this tree. |
| Anti-pattern | **Documented elsewhere; OpenBot must not grow a bypass** | bit-bot-site `SPEC-bitbot-computer-use.md`: `bit-bot-site → TARS → desktop` is refused. Sequence is BitMind session → **this** CEL gateway → TARS on **that** coworker’s computer → audit-after. |
| CU-1…CU-3 | **External phase names** | Same SPEC. CU-1 is “TARS-1.5-7B as an OpenBot plugin on a lab computer.” That plugin would land **here**, not on Contabo. |

TARS strengthens OpenBot. It does not replace CEL or Chromium. Do not load TARS and Qwen in one process.

---

### 6. Multi-user / slots / queue — **In progress**

| Mechanism | Status | Evidence |
| --- | --- | --- |
| BitMind-door admission | **Done (one process)** | In-memory `Map`; `BITMIND_MAX_CONCURRENT_RUNS` default 2; 429. Matches the enclave “two computers” ceiling. |
| Product `work_items` | **Done** | Multi-replica safe (`server/src/work/queue.ts`). |
| `COMPUTER_MAX_SLOTS` / `COMPUTER_QUEUE_MAX` / 503 `queue_full` | **Missing** | Named on the computer-use SPEC for this plane (or BitMind’s worker). Not implemented here. |
| Multi-replica BitMind-door admission | **Missing** | The live-run `Map` is process-local. Two replicas double the ceiling. `.github/pull_request_template.md` already forbids that class of state. |

A full pool must refuse (429/503). An OOM kill is a missed gate. Chromium sizing: [`docs/deployment.md`](deployment.md) ~1 GB per concurrent browser; image floor 2 GB / recommended 4 GB.

---

### 7. Deploy topology vs Contabo Tier-1 site-only — **In progress**

**Contabo is not an OpenBot host.** bit-bot-site runs there (256m / 0.5 CPU). Chromium, the supervisor, TARS, and vLLM must not.

| OpenBot deploy shape | Status | Fit for BitMind |
| --- | --- | --- |
| Laptop compose (`scripts/start.sh`) | **Done** | Shared or per-bot computers; Intelligence required unless standalone. |
| One-container image | **Done** as artefact | **No supervisor** → one shared browser. Not a tenant boundary. Not the enclave. |
| Helm (EKS / GKE / AKS / self-hosted / sandbox) | **Done** as templates | Per-bot computers when `computers.mode: sandbox`. Chart CI does **not** yet render `standalone` (the values file says to add it). |
| Standalone + BitMind door (enclave) | **Code done; host not this review** | `OPENBOT_RUNTIME_MODE=standalone` + `BITMIND_*`. Loopback gateway. BitMind’s #20 is the **external** host/rootless-Docker ticket. |
| `openbot-private` vs this `main` | **Split** | Private is ahead on BitMind computer routes (after `ac1b7d1`). Public PR #5 is that delta, unmerged. |

OpenBot must not hold BitMind DB URLs or OIDC secrets. The enclave note in the BitMind repo is the **caller’s** activation gate; this repo’s job is to attest honestly and bind loopback.

---

### 8. Tests / CI / SPECs that define remaining phases — **In progress**

**This repo CI** ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)): format / lint / types; `agent-computer` + `supervisor` typecheck; Helm render + refusals; Postgres integration tests; migration drift; image boot (PRs need `full-ci`). BitMind-door tests pin `isolated_computers: false` and the second-port rule.

**Phase map (sibling SPECs — cite, do not renumber; not implemented here):**

| Phase | What it asks of **OpenBot** |
| --- | --- |
| Auth 0–2 (bit-bot-site `SPEC-auth-production`) | Nothing on this door. Do not become the site IdP. |
| Qwen 0–4 (`SPEC-bitbot-qwen-scale`) | Do not run vLLM. Keep AG-UI Bots as the enclave prose backend until Qwen exists elsewhere. |
| CU-0 (`SPEC-bitbot-computer-use`) | Docs only today. |
| CU-1 | TARS plugin **on this computer**, behind CEL. No site→TARS. May overlap Qwen 1. |
| CU-2 | Frames/status BitMind can project; OpenBot remains the ledger. |
| CU-3 | UI-TARS-2 weights stay **on OpenBot**. |

There was no launch-readiness document in this tree before this file.

---

## Dependency map (OpenBot-centric)

```
BitMind (EXTERNAL — other review)
        │  Bearer BITMIND_SERVICE_TOKEN
        │  POST /bitmind/v1/run   (AG-UI 0.0.57 + forwardedProps)
        │  GET  /bitmind/v1/attestation
        ▼
OpenBot BitMind door   (loopback :4310, this process)
        │
        ├─ this main: prose relay → BITMIND_AGENT_URL (agent-langgraph)
        │         isolated_computers: false
        │         tools / interrupts refused
        │
        ├─ #5 / openbot-private:
        │         ComputerGateway.list() → isolated_computers
        │         /bitmind/v1/computer/{id}  ensure | screenshot | control
        │
        └─ product CEL path (already here, not on the BitMind door yet)
                  supervisor → agent-computer (Chromium + /workspace)
                  decide-before → audit-after
                  CU-1 later: TARS plugin on THAT computer
```

Hard rules (already written; do not “simplify” at launch):

1. The BitMind door stays off the published app port.
2. `isolated_computers` is true only when a computer provider is actually answering.
3. `tools: true` only after acting calls hit `server/src/computer/gateway.ts`.
4. No BitMind secrets, Docker socket, or site→TARS/VNC URL in this process.
5. Contabo never runs this image as the computer plane.

---

## P0 / P1 (OpenBot tickets)

### P0 — without these, BitMind cannot honestly enable computers

1. **Land computers on the BitMind door.** Merge PR #5 or ship `openbot-private` so attestation can become true when the supervisor answers. Do not flip the flag by hand.
2. **Keep `tools: false` until one governed click uses `ComputerGateway`.** Turning tools on while the relay is prose-only would bypass CEL.
3. **Enclave bind + standalone.** Loopback (or private) gateway, `OPENBOT_RUNTIME_MODE=standalone`, no Intelligence contract, no BitMind credentials in this process. Host/rootless-Docker is BitMind #20 (external).
4. **Do not put OpenBot on Contabo.** Kill switch is “unset `BITMIND_*` / don’t schedule this image there,” not a site flag.

### P1 — OpenBot follow-through after the door has computers

1. CU-1: TARS-1.5-7B as a plugin/sidecar **inside** a per-bot computer. Screenshot in, closed verbs out, CEL still in front.
2. Attest `tools: true` / `interrupts: true` only after those paths are real (`agent-langgraph` HITL is not there yet — [`docs/bitmind-gateway.md`](bitmind-gateway.md)).
3. Durable admission if a second replica serves `/bitmind/v1` (replace the in-process `Map`).
4. `/internal/runs/tools` + run-assertion mint if BitMind still needs grant catalogues without sitting on the tool path.
5. Add `standalone` to the Helm CI matrix.
6. `COMPUTER_MAX_SLOTS` / 503 `queue_full` on this plane (not Contabo).
7. Pin `@ag-ui/*` 0.0.57 until BitMind’s pin moves.

### Not this repo

- BitMind threads, OIDC, worker leases, BA JWT exchange, Qwen GPU, Stripe grants, site `/chat` UI.
- Re-doing bit-bot-site Auth Phase 0.

---

## Minimum launch slice (what OpenBot must present)

**ML-1 — OpenBot enclave BitMind can point at:** standalone server, loopback BitMind door, supervisor + one Chromium per coworker, CEL on the product gateway, `#5` computer routes, `isolated_computers` derived from reachability, `tools: false`, `BITMIND_MAX_CONCURRENT_RUNS=2`, LangGraph (or equivalent) as the prose agent. Screenshot + take/release are enough; no CDP pipe, no TARS, no Qwen.

**Exit:** BitMind (external) can authenticate, start one prose run, ensure a computer, fetch a screenshot, and read an attestation that is true only while that supervisor is up. Every acting computer verb that exists still goes through CEL + audit. Tools that are not attested cannot be sent.

**Then ML-2 (OpenBot):** CU-1 TARS on that same computer. **ML-3:** `tools: true` after a click that originated on the BitMind hop is decide-before / audit-after proven.

---

## Sources (no secrets)

**This repo:** [`docs/bitmind-gateway.md`](bitmind-gateway.md), [`docs/architecture.md`](architecture.md), [`docs/deployment.md`](deployment.md), `server/src/bitmind/{gateway,config,mount}.ts`, `server/src/computer/{gateway,supervisor}.ts`, `server/src/work/queue.ts`, `server/src/config.ts`, `.github/workflows/ci.yml`, `charts/openbot/ci/standalone-values.yaml`, PRs #1–#5.

**External (contract citations only):** `bitcloud-labs/bit-mind` ADR-0002 / `openbot-single-host-enclave.md`; `bitcloud-labs/bit-bot-site` `SPEC-bitbot-qwen-scale.md`, `SPEC-bitbot-computer-use.md`; `bitcloud-labs/openbot-private` `server/src/bitmind/gateway.ts` @ `1f2b986`.
