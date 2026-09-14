# Launch readiness: BitMind + OpenBot

**Status:** draft findings only. Do not merge as if it were a feature. Do not deploy.
**Assessor:** kit skill `code-reviewer` (`agent_id` `0f542ca8-9438-4cb5-a409-0c2eaef68197`).
**Date:** 2026-09-14.
**Question:** how far until Bit Bot can launch with real agents and real computers?
**Headline:** **~35% ready.** OpenBot already has computers, a CEL gateway, and Chromium. BitMind already has threads, a worker, and a real AG-UI adapter. The product cannot launch because those two planes are not joined for a signed-in bit-bot-site user, computers are not attested on public `main`, and both chat (Qwen) and computer-use (UI-TARS) are SPEC-only.

No secrets, host credentials, or token values appear in this document. Environment **names** only.

---

## Scope and where each plane lives

The product stack is **Bit Bot client → BitMind (orchestration / threads / identity) → OpenBot (computers + CEL gateway + Chromium)**. BitMind is **not** a package in this monorepo. It is a sibling service.

| Plane | Repository | Role |
| --- | --- | --- |
| Bit Bot iOS / macOS | `bitcloud-labs/bit-bot` | Conversation client. Talks only to BitMind `/v1`. Never OpenBot, AG-UI, TARS, or VNC. |
| bit-bot-site | `bitcloud-labs/bit-bot-site` | Web / auth / billing face on Contabo. Better Auth + Stripe. Marketing `#computers` / `#bitmind` are illustration, not the plane. |
| BitMind | `bitcloud-labs/bit-mind` | Durable control plane: identity, workspaces, threads, events, runs, approvals. AG-UI adapter **to** OpenBot. |
| OpenBot (this repo) | `bitcloud-labs/openbot` | Public fork of `CopilotKit/OpenBot`. Execution plane: CEL gateway, per-bot computers, Chromium, BitMind relay. |
| OpenBot derivative | `bitcloud-labs/openbot-private` | Private, unforked copy (bit-mind [ADR-0003](https://github.com/bitcloud-labs/bit-mind/blob/main/docs/architecture/decisions/0003-openbot-private-repository.md)). Ahead of this `main` on BitMind computer routes. |

This file assesses **this** checkout (`openbot` `main` @ `ac1b7d1`) and cites siblings where the contract lives. It does not vendor those files.

---

## Overall score

**~35%** toward “a signed-in Bit Bot / site user can start a real agent that uses a private computer.”

| Slice | Meaning | Ready |
| --- | --- | --- |
| OpenBot laptop / admin product | CEL + Chromium + supervisor, CopilotKit Intelligence threads | **~80%** (alpha, but the machinery exists) |
| BitMind control plane in isolation | Threads, OIDC identity, durable runs, AG-UI client | **~55%** |
| Bit Bot → BitMind → OpenBot, prose agent | Auth handoff + enclave + attested relay | **~30%** |
| Same path, real computer-use | Tools attested, CEL on the BitMind path, TARS optional | **~20%** |
| Scaled chat (Qwen) + CU-3 customer grant | GPU workers, Redis slots, Stripe computer SKU | **~8%** |

The 35% headline is the prose-agent slice plus the computer **capability** that already exists on OpenBot and is not yet reachable from Bit Bot.

---

## Assessment (Done / In progress / Missing)

### 1. BitMind: threads, identity, orchestration, AG-UI boundary — **In progress (~55%)**

BitMind is a separate Fastify + PostgreSQL service (`bit-mind` README: “durable, multi-tenant control plane”). It is not under `packages/` here.

| Piece | Status | Evidence |
| --- | --- | --- |
| Threads / conversations / group policy | **Done** (code) | `bit-mind` `src/messaging/` — `repository.ts`, `resources.ts`, `event-catalog.ts`, `group-policy.ts`. Exists because Intelligence threads are one-agent-only ([`docs/architecture.md`](architecture.md) “an Intelligence thread is owned by exactly one agent”; `bit-mind` `docs/architecture/service-specification.md` §1). |
| Identity | **In progress** | OIDC device flow + JWKS verifier (`src/identity/device-client.ts`, `token-verifier.ts`). Public paths: `/v1/auth/device/start`, `/poll`, `/refresh` (`src/api/authentication.ts`). **Not** Better Auth JWT from bit-bot-site (see §3). |
| Orchestration / worker | **In progress** | Real `RunWorker` + `OpenBotRunEngine` (`src/worker/main.ts`, `src/runs/openbot-engine.ts`). README still says “Phase 0 scaffold” / “worker intentionally idle” — the code has moved past that. |
| AG-UI boundary | **In progress** | Rewritten against `@ag-ui/client` `HttpAgent` and `RunAgentInput` (bit-mind [ADR-0002](https://github.com/bitcloud-labs/bit-mind/blob/main/docs/architecture/decisions/0002-openbot-fork-and-ag-ui-pin.md)). Pin **0.0.57**, matching this repo (`server/src/bitmind/config.ts` `AG_UI_PROTOCOL_VERSION`). Identity rides in `forwardedProps` (`workspace_id`, `agent_id`, `run_id`, `message_id`, `fencing_token`) — same schema this gateway validates. |
| Tools on the BitMind→OpenBot hop | **Missing** | `OpenBotRunEngine.start` always sends `tools: []`. This gateway refuses any run with tools while attestation says `tools: false` (`server/src/bitmind/gateway.ts`). |
| `/internal/runs/assert`, `/internal/runs/tools`, `/internal/roster` | **Missing** here | Specified in `service-specification.md` §4.2. This tree has `/internal/routines/run` only (`server/src/app.ts`). BitMind is never supposed to sit on the tool path; those internals are still the join for grants and run assertions. |

OpenBot’s own threads (Intelligence) are a **different** store: `server/src/channels/thread-identity.ts` fingerprints CopilotKit thread ids. Standalone / enclave mode unmounts that chat surface (`server/src/config.ts` `OPENBOT_RUNTIME_MODE=standalone`). That is correct for BitMind: BitMind owns the product log; OpenBot in the enclave should not also be Intelligence.

**Blocked on:** bit-mind [#20](https://github.com/bitcloud-labs/bit-mind/issues/20) (enclave) and [#21](https://github.com/bitcloud-labs/bit-mind/issues/21) (wire durable runs; status `blocked`).

---

### 2. OpenBot: per-bot computers, CEL gateway, Chromium / desktop — **In progress (~70%)**

Two paths. Do not collapse them.

#### Product path (OpenBot app → server → computer) — **Done**

| Piece | Evidence |
| --- | --- |
| CEL decide-before / audit-after | [`docs/architecture.md`](architecture.md) “Browser action governance”; `server/src/computer/gateway.ts` (resolve snapshot → policy → audit row → act). Fail closed. |
| Per-bot computers | `COMPUTER_SUPERVISOR_URL` → `server/src/computer/supervisor.ts` (ensure / stop / reset / list). Without it, every Bot shares `AGENT_COMPUTER_URL` ([`docs/deployment.md`](deployment.md)). |
| Chromium + workspace | `agent-computer` (port 4100). Compose binds loopback. Helm sandbox / StatefulSet for a cluster (`charts/openbot/`). |
| Human takeover | `computer.help_requested` / `control_taken` / `control_released`. Bot actions refused while a person drives. |
| Shared work queue | `work_items` + `select … for update skip locked` (`server/src/work/queue.ts`) for routines, handoffs, computer culler. |

This path is what the OpenBot web app uses. It is **not** what Bit Bot calls.

#### BitMind path (this `main`) — **Missing computers behind the door**

On public `main`:

- Attestation hard-codes `isolated_computers: false` (`server/src/bitmind/gateway.ts`).
- Relayed agent is prose-only; tools and resume are refused.
- No `/bitmind/v1/computer/{id}` routes. BitMind’s `OpenBotComputerGatewayClient` (`bit-mind` `src/computer/gateway-client.ts`) already calls `computer/{id}`, `/ensure`, `/screenshot`, `/control` under the same `/bitmind/v1` root. Those 404 here.

On **`openbot-private`** and open PR [#5](https://github.com/bitcloud-labs/openbot/pull/5) (`feat/gateway-supervisor-wiring` @ `1f2b986`):

- `isolated_computers` is true only while `ComputerGateway.provider.list()` succeeds.
- Observe / ensure / screenshot / control are served through the **same** `ComputerGateway` the product UI uses (not a second supervisor client).
- Attestation still reports `tools: false` and `interrupts: false`.

So computers exist; the BitMind activation gate on **this** `main` is still honest that they are not behind its door. Merging #5 (or treating `openbot-private` as the deploy source) is the next OpenBot ticket, not a new architecture.

Helm `charts/openbot/ci/standalone-values.yaml` is the enclave shape: `runtimeMode: standalone`, no Intelligence secrets. The chart job matrix in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) does **not** yet include `standalone` (the values file itself says so).

---

### 3. Auth handoff from Better Auth / bit-bot-site users — **Missing (~15%)**

Three identity systems, no join.

| System | What it is | Live? |
| --- | --- | --- |
| bit-bot-site Better Auth 1.6.30 | Email/password on Contabo. Roles `admin` / `dev` / `customer` on `"user"."role"`. Stripe `metadata.userId` = BA id. | **Yes** (Phase 0). Google/Apple callbacks documented; provider secrets still pending. [`SPEC-auth-production.md`](https://github.com/bitcloud-labs/bit-bot-site/blob/main/docs/SPEC-auth-production.md), `docs/auth-production.md`. |
| BitMind identity | OIDC device authorization + `OidcTokenVerifier` (RS256/ES256 JWKS). Workspace membership after `/v1/account/bootstrap`. | **Code yes; not BA.** |
| OpenBot Better Auth | Google / Microsoft / Okta / runtime SAML+OIDC, or `OPENBOT_SINGLE_USER`. Own `users` table. | **Yes** for the OpenBot app. Irrelevant to a site user until actor ids are mapped. |

The computer-use SPEC requires the site to mint a **service JWT to BitMind only** (`sub` = BA user id, `aud` = `bitmind`, `exp` ≤ 120s). BitMind does not verify that JWT today. The service spec’s shared keys are OpenBot `users.id` and `agents.id` — opaque strings BitMind must front, not invent.

There is no implemented path:

```
bit-bot-site Better Auth session
    → BitMind workspace principal
    → OpenBot ActionActor / users.id
```

Control-transfer on the private gateway stamps `x-bitmind-actor-id` as `bitmind:{id}` and explicitly notes there is **no row in OpenBot `users`**. That is honest and not a handoff.

**P0 for any launch that uses the site as the front door.**

---

### 4. Chat workers / Qwen path vs stub — **Missing (~8%)**

| Layer | Status | Evidence |
| --- | --- | --- |
| SPEC + operator roadmap | **Done (docs)** | `bit-bot-site` [`SPEC-bitbot-qwen-scale.md`](https://github.com/bitcloud-labs/bit-bot-site/blob/main/docs/SPEC-bitbot-qwen-scale.md), [`bitbot-qwen-scale.md`](https://github.com/bitcloud-labs/bit-bot-site/blob/main/docs/bitbot-qwen-scale.md). Phases **0–4**. Phase 0 is the SPEC itself. |
| Production chat / vLLM / gateway | **Missing** | Operator doc: “Chat / GPU: **None.** No `/chat`, no vLLM, no gateway.” `CHAT_ENABLED` must stay unset on Contabo until wired. |
| Contabo | **Must stay empty** | App limit 256m / 0.5 CPU. vLLM on that box is forbidden. |
| OpenBot built-in / LangGraph Bots | **Stub relative to Qwen** | `agent-langgraph` / `agent-bot` speak AG-UI and use OpenAI / Anthropic / Google keys — not Qwen3.6-27B, not a gated slot pool. Fine for a lab relay; not the product chat plane. |
| BitMind `BuiltinRunEngine` | **Stub** | Direct model HTTP when `RUN_ENGINE=builtin`. Not Qwen, not slotted. |

Qwen is a **sibling gated plane** to computer-use. Do not load Qwen and TARS in one process or one JWT `aud`.

---

### 5. UI-TARS / computer-use under OpenBot (not site → GPU) — **Missing (~8%)**

| Layer | Status | Evidence |
| --- | --- | --- |
| Architecture SPEC | **Done (docs)** | `bit-bot-site` [`SPEC-bitbot-computer-use.md`](https://github.com/bitcloud-labs/bit-bot-site/blob/main/docs/SPEC-bitbot-computer-use.md), [`bitbot-computer-use.md`](https://github.com/bitcloud-labs/bit-bot-site/blob/main/docs/bitbot-computer-use.md). Phases **CU-0 … CU-3**. This PR is CU-0. |
| Anti-pattern named and refused | **Done (docs)** | `bit-bot-site → TARS → desktop` is out of scope. Sequence must be BitMind session → OpenBot decide-before → TARS on **that** coworker’s sandbox → audit-after. |
| TARS plugin / weights in OpenBot | **Missing** | No UI-TARS, UI-TARS-2, or vision-plugin registration in this tree or (from searchable names) in `bit-mind`. |
| Site / Contabo TARS | **Correctly absent** | “Do not put TARS, Chromium, OpenBot, or VNC on the Contabo box.” |
| CU-1 lab loop | **Missing** | Prove BitMind → decide-before → click → audit-after → destroy. Allowed to start **during** Qwen Phase 1. No site → TARS. |

TARS **strengthens** OpenBot. It does not replace CEL, Chromium, or BitMind. CU-1 starter model is UI-TARS-1.5-7B; CU-3 target is UI-TARS-2. Chat stays Qwen3.6-27B.

---

### 6. Multi-user / slots / queue — **In progress (~30%)**

| Mechanism | Status | Evidence |
| --- | --- | --- |
| BitMind gateway admission | **Done (single process)** | In-memory `Map` of live relays. Ceiling `BITMIND_MAX_CONCURRENT_RUNS` default **2**, 429 + `retry-after` (`server/src/bitmind/gateway.ts`, `config.ts`). Matches the enclave note (two concurrent computers). |
| OpenBot `work_items` | **Done** | Postgres claim/lease for routines, handoffs, culler. Multi-replica safe. |
| Product slots (`COMPUTER_MAX_SLOTS`, `COMPUTER_QUEUE_MAX`, 503 `queue_full`) | **Missing** | Specified on the OpenBot / BitMind worker, not Contabo (`bitbot-computer-use.md`). No Redis semaphore in this repo. |
| Chat slots (`CHAT_QUEUE_MAX` = vLLM `--max-num-seqs`) | **Missing** | Qwen SPEC. |
| Multi-replica gateway admission | **Missing** | The live-run `Map` is process-local. Two replicas double the ceiling. The PR template (`.github/pull_request_template.md`) already forbids this class of state. |

A full pool **must** 503 `queue_full`. An OOM kill is a missed gate.

---

### 7. Deploy topology vs Contabo Tier-1 site-only — **In progress (~25%)**

**What is live (do not re-do):**

```
Browser → bit-bot-site + Postgres 17   (Contabo VPS, 256m / 0.5 CPU)
          Better Auth email/password, RBAC, Stripe seats
          No BitMind, no OpenBot, no Qwen, no TARS, no Chromium
```

**What the SPECs require:**

```
Browser → Tier 1 site (Contabo: auth + billing + optional BitMind BFF)
                │  service JWT to BitMind only
                ▼
           BitMind
        ┌────────┴────────┐
        ▼                 ▼
  Chat: Qwen GPU     Computer: OpenBot enclave
  (RunPod etc.)      (not Contabo; loopback / private)
        │                 │
        │                 ▼
        │            CEL → per-bot Chromium
        │            TARS plugin (CU-1+)
```

| Target | Status |
| --- | --- |
| Contabo stays site-only | **Done** as policy and as current deploy |
| BitMind staging / production host | **In progress** (compose + ops docs; not the launch join) |
| OpenBot single-host enclave | **Specified, not activated** — `bit-mind` [`docs/operations/openbot-single-host-enclave.md`](https://github.com/bitcloud-labs/bit-mind/blob/main/docs/operations/openbot-single-host-enclave.md). Rootless `openbot-exec`, no BitMind DB URL, loopback gateway, start at two computers. Activation gate: `isolated_computers=true` **plus** service auth, fencing idempotency, cancellation, action audit. A failed attestation leaves jobs queued; BitMind never falls back to local execution. Issue [#20](https://github.com/bitcloud-labs/bit-mind/issues/20) still open. |
| OpenBot one-container image | **Done** as an artefact ([`docs/deployment.md`](deployment.md)). **No supervisor** in the image → shared browser. Not a tenant boundary. Not the enclave. |
| Helm cluster (per-bot sandbox computers) | **Done** as templates; not the Contabo topology. |
| `openbot-private` vs this `main` | **Split.** ADR-0003: deploy the private derivative; keep this public fork. Private is ahead on BitMind computer routes (commits after `ac1b7d1`). Public PR #5 is that delta, unmerged. |

---

### 8. Tests / CI / SPECs that define remaining phases — **In progress (~60%)**

#### Phase map (cite these; do not renumber)

**Auth → chat workers → computer-use** is defined on **bit-bot-site**, not here.

| Phase | Ship | Repo |
| --- | --- | --- |
| Auth 0 | Better Auth email/password live on Contabo | `SPEC-auth-production.md` — **done, do not re-do** |
| Auth 1–2 | Email/password harden + Google/Apple + RBAC | Same SPEC — **in progress / secrets pending** |
| Email OTP | Postmark OTP + orbit UI | `SPEC-email-otp.md`, `SPEC-email-otp-orbit.md` |
| Qwen 0 | Chat SPEC | `SPEC-bitbot-qwen-scale.md` — **this is the current chat phase** |
| Qwen 1 | One GPU worker + gateway + Redis; prove 503 before OOM; site `CHAT_ENABLED=false` | same |
| Qwen 2 | `/chat` UI | same |
| Qwen 3 | Autoscale from queue depth | same |
| Qwen 4 | Stripe monthly token allowance | same |
| CU-0 | Computer-use SPEC | `SPEC-bitbot-computer-use.md` |
| CU-1 | TARS-1.5-7B as OpenBot plugin on a **lab** computer | same — may overlap Qwen 1 |
| CU-2 | Site viewer via BitMind BFF (`admin`/`dev`) | after chat SSE **or** watchable computer events |
| CU-3 | UI-TARS-2 + customer Stripe grant | weights stay on OpenBot |

**BitMind delivery plan** (`docs/architecture/delivery-plan.md`):

| Phase | Exit |
| --- | --- |
| 0 Executable contract | Clean checkout builds; API/worker + Postgres — largely **done** |
| 1 Identity + messaging | BitBot authenticates to staging; direct/group/thread/reconnect — **in progress** (OIDC, not site BA) |
| 2 Agent runs | Persisted message → resumable run; no AG-UI types on iOS — **blocked** on #20/#21 |
| 3 Safety + collaboration | Approvals, policy, takeover — **in progress** in code, not joined |
| 4 Product completion | Search, memories, routines, APNs, retention — **later** |

**This repo CI** ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)): format/lint/types, `agent-computer` + `supervisor` typecheck, Helm render + refusals (self-hosted / EKS / GKE / AKS), Postgres integration tests, migrations drift, image boot (PRs need `full-ci`). BitMind gateway unit + standalone boot tests: `server/tests/bitmind-gateway.test.ts`, `standalone-boot.integration.test.ts` (asserts `isolated_computers: false` and that `/bitmind/v1` is **not** on the public server port).

There was **no** launch-readiness document in this tree before this file.

---

## Dependency map

```
bit-bot-site Better Auth (live)
        │  P0: service JWT / principal map
        ▼
   BitMind identity + workspace
        │
        ├─ threads / events          (code exists)
        ├─ RunWorker + HttpAgent     (code exists; tools:[])
        │        │
        │        ▼
        │   OpenBot BitMind gateway  (this main: prose relay)
        │        │
        │        ├─ #5 / openbot-private: isolated_computers from ComputerGateway
        │        ├─ P0: tools + interrupts attestation when CEL path is live
        │        └─ P0: bit-mind #20 rootless enclave (not Contabo)
        │                 │
        │                 ▼
        │            supervisor → agent-computer (CEL already here)
        │                 │
        │                 └─ CU-1: TARS plugin on that computer (not site→GPU)
        │
        └─ Qwen 1–4: chat GPU plane (not Contabo; not TARS)
```

Hard rules already written down (do not “simplify” them at launch):

1. Bit Bot / the browser never see an OpenBot, AG-UI, TARS, VNC, or GPU URL.
2. BitMind never executes browser/file/shell/MCP locally.
3. OpenBot never holds BitMind DB URLs, OIDC secrets, or the root Docker socket.
4. Contabo never runs OpenBot, Chromium, vLLM, or TARS.
5. Qwen and TARS never share a process or a slot pool.

---

## P0 / P1

### P0 — without these, do not advertise real agents or computers

1. **Choose the OpenBot deploy source and land computer attestation.** Merge public PR #5 or ship from `openbot-private`, so `isolated_computers` can become true when a supervisor actually answers. Do not flip the flag by hand.
2. **Stand up the enclave (bit-mind #20).** Rootless account, loopback gateway, two-computer ceiling, no BitMind secrets in the enclave. Until attestation passes, keep the BitMind worker from treating OpenBot as live computers.
3. **Auth handoff.** bit-bot-site BA user id → BitMind principal/workspace → opaque OpenBot actor. One mapping, tested both ways. Google/Apple on the site can wait; email/password is already live.
4. **Do not enable tools on the BitMind hop until CEL + audit are on that hop.** Today `tools: false` is load-bearing. Turning it on without the product gateway in the path would be the site→GPU class of bug, just one layer down.
5. **Keep Contabo site-only.** Kill switches: `CHAT_ENABLED=false`, `COMPUTER_USE_ENABLED=false`. Never `docker compose down -v` on Contabo (`bitbot-pgdata`).

### P1 — needed for a launch people will pay for, not for a first honest agent

1. Qwen Phase 1: one worker + Redis slots; prove 503 `queue_full` before OOM; site flag off until then.
2. CU-1 lab: TARS-1.5-7B as an OpenBot plugin; BitMind → decide-before → click → audit → destroy.
3. Durable gateway admission (not an in-process `Map`) if more than one OpenBot replica exists.
4. `GET /internal/runs/tools` + run-assertion mint so BitMind can offer granted tools without sitting on the tool path (`service-specification.md` §4.2).
5. AG-UI interrupt / resume so BitMind approvals are not racing `TOOL_CALL_START` (ADR-0002 follow-up; this gateway still attests `interrupts: false`).
6. Helm CI matrix includes `standalone`; pin `@ag-ui/*` 0.0.57 on both sides when either moves.
7. bit-mind #21 acceptance (one persisted message → one run; reconnect; cancel; approval pause) before calling the join “done.”
8. Site Google/Apple secrets and CU-3 Stripe `computer_use` grant — after CU-2 works for `admin`/`dev`.

### Not P0

- UI-TARS-2 weights, Qwen autoscale, Stripe token meters, watch companion polish, ACS/Codex R&D (bit-mind #95–#113).
- Re-doing Auth Phase 0 or putting Intelligence back into the enclave.

---

## Minimum launch slice

Ship **one** honest vertical, then stop.

**Slice ML-1 — “signed-in person, one prose coworker, private computer visible, no TARS, no Qwen GPU.”**

1. Contabo remains the auth/billing face. Email/password is enough.
2. BitMind accepts that user (BA JWT **or** a short-lived exchange onto today’s OIDC principal — pick one, document it, test it).
3. OpenBot runs **standalone** in the enclave (`OPENBOT_RUNTIME_MODE=standalone`), gateway on loopback, supervisor + one `agent-computer` per coworker, CEL on.
4. Land #5 / `openbot-private` computer routes. Attestation may say `isolated_computers: true` only while the supervisor answers.
5. First agent is the existing LangGraph (or built-in) AG-UI endpoint behind the relay. Prose is enough. **Leave `tools: false` until a single governed click is proven on this hop.**
6. BitMind run: user message → worker lease → `HttpAgent` POST `/bitmind/v1/run` → SSE normalized into the BitMind event log → client.
7. Computer: ensure + screenshot + take/release via BitMind `/v1` (opaque ids). Human takeover uses the existing OpenBot control verbs. No live CDP pipe required (bit-bot#58 baseline is a snapshot).
8. Caps: `BITMIND_MAX_CONCURRENT_RUNS=2`, one computer per coworker, destroy on stop/TTL. 429/503 when full.
9. **Out of ML-1:** Qwen workers, TARS, customer `computer_use`, site `/chat` UI, Intelligence, shared Contabo desktop.

**Exit for ML-1:** a staging user who signed in on the site (or Bit Bot device) sees a thread, gets a streamed prose reply from a real AG-UI agent, can open that coworker’s screenshot, and every computer act that *is* allowed has an OpenBot audit row. Isolation attestation is true. Tools that are not attested cannot be sent.

**Then:**

- **ML-2** = Qwen Phase 1 (chat GPU, still no Contabo GPU) in parallel with **CU-1** (TARS on the same OpenBot computer, still no site→TARS).
- **ML-3** = `tools: true` on the BitMind hop **after** CEL+audit are proven for a click that originated from that hop; then CU-2 site viewer for `admin`/`dev`.

Anything that advertises “own computer” or “workforce” on the marketing face before ML-1 exits is selling the illustration in `bit-bot-site` `computers.tsx`.

---

## What this repo should do next (OpenBot-only)

These are the tickets that belong **here** (or on `openbot-private`), not on the site:

1. Merge or re-apply PR #5 so public `main` matches the computer surface BitMind already calls.
2. Add `standalone` to the Helm CI matrix (values file already asks for it).
3. When tools are ready: attest `tools: true` only after the relayed agent’s tool callbacks hit `server/src/computer/gateway.ts`, not a side door.
4. Replace the in-process admission `Map` before a second replica.
5. Keep this document updated when #5 / #20 / the BA handoff land — or supersede it.

---

## Sources (no secrets)

**This repo:** [`docs/bitmind-gateway.md`](bitmind-gateway.md), [`docs/architecture.md`](architecture.md), [`docs/deployment.md`](deployment.md), `server/src/bitmind/{gateway,config,mount}.ts`, `server/src/computer/{gateway,supervisor}.ts`, `server/src/work/queue.ts`, `server/src/config.ts`, `.github/workflows/ci.yml`, `charts/openbot/ci/standalone-values.yaml`, PRs #1–#5.

**bit-mind:** README, `docs/architecture/{README,delivery-plan,service-specification}.md`, ADR-0002, ADR-0003, `docs/operations/openbot-single-host-enclave.md`, `src/runs/openbot-engine.ts`, `src/computer/gateway-client.ts`, `src/identity/token-verifier.ts`, `src/api/authentication.ts`, issues #20, #21.

**bit-bot-site:** `SPEC-auth-production.md`, `SPEC-bitbot-qwen-scale.md`, `SPEC-bitbot-computer-use.md`, operator summaries `bitbot-qwen-scale.md` / `bitbot-computer-use.md`.

**openbot-private:** `server/src/bitmind/gateway.ts` @ `1f2b986` (computer routes + derived `isolated_computers`).
