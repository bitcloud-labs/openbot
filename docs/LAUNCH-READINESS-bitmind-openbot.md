# Launch readiness: OpenBot computers (BitMind as caller)

**Status:** draft findings only. Do not merge as if it were a feature. Do not deploy.
**Assessor:** kit skill `code-reviewer` (`agent_id` `0f542ca8-9438-4cb5-a409-0c2eaef68197`).
**Date:** 2026-09-14. Recast twice the same day: OpenBot-only, then **private-preferred**.
**Question:** how far until Bit Bot can launch with real agents and real computers, **from the production-ish OpenBot execution plane**?
**Headline:** **~55% ready on the OpenBot side** when the deploy source is `bitcloud-labs/openbot-private` @ `1f2b986` (VPS checkout `/home/dev/apps/openbot`). Per-bot Chromium, CEL, supervisor, and BitMind computer routes exist there. The door still attests `tools: false`. UI-TARS is not in either tree. Public `bitcloud-labs/openbot` `main` @ `ac1b7d1` is the tracking fork and this PR’s home; it is **behind** on the BitMind computer door.

No secrets, host credentials, or token values appear in this document. Environment **names** only. This review did not SSH the VPS; `/home/dev/apps/openbot` is the operator-stated checkout path.

---

## Scope

**Preferred tree for the BitMind / Bit Bot path:** [`bitcloud-labs/openbot-private`](https://github.com/bitcloud-labs/openbot-private) tip **`1f2b986`**. That is the production-ish clone (ADR-0003 private unforked derivative). Operator checkout: **`/home/dev/apps/openbot`**.

**This workspace / PR home:** [`bitcloud-labs/openbot`](https://github.com/bitcloud-labs/openbot) `main` @ `ac1b7d1` — public CopilotKit tracking fork. Use it for docs that must land in the public tree. Do **not** treat public `main` as the launch source for computers-behind-BitMind.

**BitMind is an external dependency**, not a package in either OpenBot tree. It lives at [`bitcloud-labs/bit-mind`](https://github.com/bitcloud-labs/bit-mind). Another agent reviews that repo. This document names the **caller contract** OpenBot already implements and the **gaps on this side of the wire**.

Product stack (for orientation only):

```
Bit Bot / bit-bot-site  →  BitMind (external)  →  OpenBot (private clone on the VPS)
                                               computers + CEL + Chromium
```

| Plane | Repository | This review |
| --- | --- | --- |
| Bit Bot clients | `bitcloud-labs/bit-bot`, `bitcloud-labs/bit-bot-site` | Cited only where they constrain OpenBot (no site→GPU, Contabo is site-only). |
| BitMind | `bitcloud-labs/bit-mind` | **External caller.** See “How OpenBot expects BitMind.” |
| OpenBot (launch path) | **`openbot-private` @ `1f2b986`** | **In scope. Prefer this.** |
| OpenBot (public / this PR) | this repo `main` @ `ac1b7d1` | Tracking fork. Computer door is PR [#5](https://github.com/bitcloud-labs/openbot/pull/5), unmerged. |

---

## How OpenBot expects BitMind

OpenBot does not embed BitMind. It optionally **mounts a private AG-UI door** that BitMind is supposed to call. Ordinary OpenBot deployments mount nothing (`server/src/bitmind/mount.ts`: any `BITMIND_*` variable means “serve BitMind”; none means no gateway). That mount contract is the same on public and private.

What this plane requires of that caller, today (private and public agree unless noted):

| Expectation | Where OpenBot enforces it |
| --- | --- |
| Service bearer `BITMIND_SERVICE_TOKEN`, timing-safe, on every route except `/health` | `server/src/bitmind/gateway.ts` |
| AG-UI `@ag-ui/core` **0.0.57** — one `POST /bitmind/v1/run` → SSE `text/event-stream` | `server/src/bitmind/config.ts` `AG_UI_PROTOCOL_VERSION`; body = `RunAgentInputSchema` |
| Identity in `forwardedProps`: `workspace_id`, `agent_id`, `run_id`, `message_id`, `fencing_token` (non-negative int). `run_id` must match `runId`. | `BitmindForwardedPropsSchema`. Forwarded **untouched**; OpenBot does not resolve BitMind users. |
| `idempotency-key: run_id:fencing_token` while a relay is live → 409 | same |
| Concurrent relays ≤ `BITMIND_MAX_CONCURRENT_RUNS` (default **2**) → 429 + `retry-after` | `config.ts` |
| Loopback by default (`BITMIND_GATEWAY_HOST=127.0.0.1`, port **4310**), **not** a path on the published server port | `mount.ts`; boot test asserts `/bitmind/v1/attestation` is 404 on the app port |
| Honest attestation: `isolated_computers`, `execution.tools`, `execution.interrupts` | `BitmindAttestation`. **Private:** `isolated_computers` is derived from `ComputerGateway.provider.list()` (async, not cached). **Public `main`:** the flag is a `false` literal. Both still attest `tools: false`, `interrupts: false`. |
| No BitMind database URL, OIDC secret, or Docker socket in this process | `OPENBOT_RUNTIME_MODE=standalone` unmounts Intelligence chat (`server/src/config.ts`) |

What OpenBot does **not** do for BitMind on **either** tree:

- Does not mint BitMind sessions, threads, or workspace memberships.
- Does not verify bit-bot-site Better Auth cookies or JWTs. The door is a **service token**, not a user session.
- Does not put CEL / audit on the `/bitmind/v1/run` hop. Policy lives on `server/src/computer/gateway.ts`. The BitMind door refuses tools until it attests `tools: true`.
- Does not implement `/internal/runs/assert`, `/internal/runs/tools`, or `/internal/roster` (named in BitMind’s service spec as fork work). Both trees have `/internal/routines/run` only.
- Does not live-relay CDP `/stream` (snapshot baseline; bit-bot#58).

**Private-only (launch path):** serves `GET /bitmind/v1/computer/{id}`, `POST …/ensure`, `GET …/screenshot`, `POST …/control` (`take` \| `release`). Control requires `x-bitmind-actor-id` and stamps `bitmind:{id}` — **not** an OpenBot `users` row (`ActionActor.userId` is FK-optional).

**Public `main`:** those computer URLs 404. Do not launch Bit Bot computers from public `main` alone.

**Docs drift on the preferred tree:** private `docs/bitmind-gateway.md` @ `3de8a817` still says “No computers… `isolated_computers: false`” and does **not** list the computer routes. **Code is ahead of docs.** Public [`docs/bitmind-gateway.md`](bitmind-gateway.md) matches public `main` (prose-only). Treat private gateway **source** as truth for launch, not private prose.

BitMind’s activation note (`docs/operations/openbot-single-host-enclave.md` in that repo) says: do not enable its worker until this gateway attests `isolated_computers=true` plus service auth, fencing idempotency, cancellation, and action audit. Private can attest isolation when the supervisor answers. Public `main` cannot.

---

## Overall score (OpenBot side, private-preferred)

**~55%** toward “BitMind can point at the VPS OpenBot clone and get a real isolated computer, governed by CEL.”

If someone deployed **public** `main` instead, the computer-door slice drops and the headline is ~45%. That is the wrong launch source.

| Slice | Meaning | Ready |
| --- | --- | --- |
| OpenBot laptop / admin product | CEL + Chromium + supervisor; Intelligence threads for the web app | **~80%** (alpha, machinery exists; same on both trees) |
| BitMind door: prose relay | Service auth, `RunAgentInput`, identity props, admission, standalone boot | **~70%** |
| BitMind door: computers behind it | Attest isolation; ensure / screenshot / control on `/bitmind/v1` | **~60%** on **private** (code present; docs stale; VPS process not inspected). **~25%** on public `main`. |
| BitMind door: governed tool / click | `tools: true` only after CEL+audit sit on that hop | **~10%** |
| UI-TARS on an OpenBot computer | Vision plugin inside the enclave, not site→GPU | **~5%** (SPEC elsewhere; no code in either tree) |

The 55% headline is the product computer stack plus a working prose relay **plus** private computer routes, minus attested tools, TARS, durable admission, and a live VPS confirmation.

---

## Assessment (Done / In progress / Missing)

Scores below prefer **`openbot-private` @ `1f2b986`**. Public `main` deltas are called out.

### 1. BitMind caller contract (AG-UI door) — **In progress (~75% as a relay + computer door on private; not a governed-click plane)**

Assessed **as OpenBot implements it**. BitMind’s threads, identity, and worker are out of scope.

| Piece | Status | Evidence |
| --- | --- | --- |
| Optional mount, fail-closed config | **Done** | `server/src/bitmind/mount.ts`, `config.ts` (both trees) |
| Service auth + pinned AG-UI 0.0.57 | **Done** | `gateway.ts`, `AG_UI_PROTOCOL_VERSION` |
| Identity statement on the run | **Done** | `forwardedProps` schema; forwarded, not interpreted |
| Admission + idempotency + timeout | **Done** (single process) | default 2 runs; 409 / 429 |
| Standalone (no Intelligence) | **Done** | `OPENBOT_RUNTIME_MODE=standalone`; Helm `charts/openbot/ci/standalone-values.yaml` |
| Isolated computers on this door | **Done on private** (derived, not cached) | `openbot-private` `server/src/bitmind/gateway.ts` @ `1f2b986`: `isolated_computers` ⇔ `computerGateway.provider.list()` reachable. **Missing on public `main`** (literal `false`). |
| Computer observe / ensure / screenshot / control | **Done on private** | `/bitmind/v1/computer/{id}` routes. **Missing on public `main`** (404). Public copy is PR #5. |
| Honest “no tools / no resume yet” | **Done** | Both trees: `tools: false`, `interrupts: false`; run refuses tools/resume |
| Gateway docs match code | **Missing on private** | private `docs/bitmind-gateway.md` still describes the prose-only door |
| `/internal/runs/*` join for grants | **Missing** | Specified as fork work; not in either tree |

---

### 2. Per-bot computers, CEL gateway, Chromium — **Done on the product path; Done-enough behind the private BitMind door**

Do not collapse the two paths.

#### Product path (OpenBot app → server → computer) — **Done**

Same machinery on public and private.

| Piece | Evidence |
| --- | --- |
| CEL decide-before / audit-after | [`docs/architecture.md`](architecture.md); `server/src/computer/gateway.ts`: resolve snapshot → policy → audit row → act. Deny first; empty or broken policy fails closed. Shipped default is `deny: []`, `allow: ["true"]` unless replaced. |
| Per-bot computers | `COMPUTER_SUPERVISOR_URL` → `server/src/computer/supervisor.ts` (ensure / stop / reset / list). Without it, every Bot shares `AGENT_COMPUTER_URL` ([`docs/deployment.md`](deployment.md)). |
| Chromium + `/workspace` | `agent-computer` (port 4100). Compose binds `127.0.0.1`. Helm sandbox / StatefulSet for a cluster. |
| Actor type | `ActionActor` on the computer gateway. Product path uses a real `users` row. |
| Human takeover | `computer.help_requested` / `control_taken` / `control_released`. Bot actions refused while a person drives. |
| Shared work queue | `work_items` + `select … for update skip locked` (`server/src/work/queue.ts`) for routines, handoffs, computer culler. |

This is what `/admin/computers`, `/bot`, and channel screens use. Bit Bot never calls it.

#### BitMind path (`openbot-private`) — **In progress (routes exist; tools still refused)**

- Optional `ComputerGateway` on the same product seam — not a second supervisor client.
- `isolated_computers` is true only while `provider.list()` succeeds.
- Observe / ensure / screenshot / control are served. Control stamps `bitmind:{id}`.
- Attestation still reports `tools: false` and `interrupts: false`. Run still refuses tools/resume.
- No live CDP `/stream` relay.

Landing public PR #5 is **sync of the tracking fork**, not the launch blocker, if the VPS already runs private. Launching from public `main` without that delta **is** a blocker.

`COMPUTER_PIDS_LIMIT` empty-string omission exists because rootless Docker + systemd cgroup refused `PidsLimit: 512` (bit-mind #20 enclave). Do not “fix” that on the OpenBot side by forcing a limit the host rejects.

---

### 3. Auth: what OpenBot will accept from a BitMind hop — **In progress for the service door; user handoff is not OpenBot’s job**

| Layer | Status | Evidence |
| --- | --- | --- |
| OpenBot app sign-in | **Done** | Better Auth: Google / Microsoft / Okta / runtime SAML+OIDC, or `OPENBOT_SINGLE_USER`. Own `users` table. [`README.md`](../README.md) Sign in; `server/src/auth/`. |
| BitMind **service** door | **Done** | Bearer `BITMIND_SERVICE_TOKEN` only. No cookie, no BA JWT. |
| Map site / BitMind human → OpenBot `users.id` | **Missing here; belongs to BitMind + site** | This gateway does not verify bit-bot-site sessions. Private control path treats the BitMind actor as foreign on purpose. |
| Site Better Auth (Contabo) | **External** | Live email/password is a **bit-bot-site** fact (Auth Phase 0). OpenBot must not grow a second password table or accept `VITE_*` computer URLs. |

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
| TARS / UI-TARS-2 / vision plugin | **Missing** | No matches in public or private trees. |
| Anti-pattern | **Documented elsewhere; OpenBot must not grow a bypass** | bit-bot-site `SPEC-bitbot-computer-use.md`: `bit-bot-site → TARS → desktop` is refused. Sequence is BitMind session → **this** CEL gateway → TARS on **that** coworker’s computer → audit-after. |
| CU-1…CU-3 | **External phase names** | Same SPEC. CU-1 is “TARS-1.5-7B as an OpenBot plugin on a lab computer.” That plugin would land **on the private clone**, not on Contabo. |

TARS strengthens OpenBot. It does not replace CEL or Chromium. Do not load TARS and Qwen in one process.

---

### 6. Multi-user / slots / queue — **In progress**

| Mechanism | Status | Evidence |
| --- | --- | --- |
| BitMind-door admission | **Done (one process)** | In-memory `Map`; `BITMIND_MAX_CONCURRENT_RUNS` default 2; 429. Matches the enclave “two computers” ceiling. |
| Product `work_items` | **Done** | Multi-replica safe (`server/src/work/queue.ts`). |
| `COMPUTER_MAX_SLOTS` / `COMPUTER_QUEUE_MAX` / 503 `queue_full` | **Missing** | Named on the computer-use SPEC for this plane (or BitMind’s worker). Not implemented in either tree. |
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
| Standalone + BitMind door (enclave) | **Code done on private; host not this review** | `OPENBOT_RUNTIME_MODE=standalone` + `BITMIND_*`. Loopback gateway. BitMind’s #20 is the **external** host/rootless-Docker ticket. |
| VPS clone `/home/dev/apps/openbot` | **Operator-stated; not inspected here** | Prefer this checkout = `openbot-private`. Confirm tip / `standalone` / supervisor / loopback on the box before calling computers live. |
| Public `openbot` `main` | **Tracking only** | Computer door unmerged (#5). Do not point BitMind at public `main` for isolation. |

OpenBot must not hold BitMind DB URLs or OIDC secrets. The enclave note in the BitMind repo is the **caller’s** activation gate; this repo’s job is to attest honestly and bind loopback.

---

### 8. Tests / CI / SPECs that define remaining phases — **In progress**

**Public this-repo CI** ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)): format / lint / types; `agent-computer` + `supervisor` typecheck; Helm render + refusals; Postgres integration tests; migration drift; image boot (PRs need `full-ci`). BitMind-door tests on public `main` pin `isolated_computers: false` and the second-port rule. Private’s computer-route tests live in that tree; they are not on public `main` until #5 lands.

**Phase map (sibling SPECs — cite, do not renumber; not implemented here):**

| Phase | What it asks of **OpenBot** |
| --- | --- |
| Auth 0–2 (bit-bot-site `SPEC-auth-production`) | Nothing on this door. Do not become the site IdP. Auth 0 (email/password) is already live on Contabo. |
| Qwen 0–4 (`SPEC-bitbot-qwen-scale`) | Do not run vLLM. Keep AG-UI Bots as the enclave prose backend until Qwen exists elsewhere. |
| CU-0 (`SPEC-bitbot-computer-use`) | Docs only today. |
| CU-1 | TARS plugin **on this computer**, behind CEL. No site→TARS. May overlap Qwen 1. |
| CU-2 | Frames/status BitMind can project; OpenBot remains the ledger. |
| CU-3 | UI-TARS-2 weights stay **on OpenBot**. |

There was no launch-readiness document in the public tree before this file.

---

## Dependency map (OpenBot-centric, private-preferred)

```
BitMind (EXTERNAL — other review)
        │  Bearer BITMIND_SERVICE_TOKEN
        │  POST /bitmind/v1/run   (AG-UI 0.0.57 + forwardedProps)
        │  GET  /bitmind/v1/attestation
        │  GET|POST /bitmind/v1/computer/{id}   (private only)
        ▼
OpenBot BitMind door   (loopback :4310)
        │
        ├─ openbot-private @ 1f2b986   ← launch path / VPS /home/dev/apps/openbot
        │         ComputerGateway.list() → isolated_computers
        │         /bitmind/v1/computer/{id}  ensure | screenshot | control
        │         tools / interrupts still refused
        │         docs/bitmind-gateway.md STALE (still says no computers)
        │
        ├─ public openbot main @ ac1b7d1   ← tracking fork / this PR
        │         prose relay only
        │         isolated_computers: false literal
        │         computer URLs 404; delta is PR #5
        │
        └─ product CEL path (both trees; not on the /run hop yet)
                  supervisor → agent-computer (Chromium + /workspace)
                  decide-before → audit-after
                  CU-1 later: TARS plugin on THAT computer
```

Hard rules (already written; do not “simplify” at launch):

1. Point BitMind at the **private** checkout, not public `main`.
2. The BitMind door stays off the published app port.
3. `isolated_computers` is true only when a computer provider is actually answering (private already derives this).
4. `tools: true` only after acting calls hit `server/src/computer/gateway.ts`.
5. No BitMind secrets, Docker socket, or site→TARS/VNC URL in this process.
6. Contabo never runs this image as the computer plane.

---

## P0 / P1 (OpenBot tickets)

### P0 — without these, BitMind cannot honestly enable computers

1. **Launch from `openbot-private`, not public `main`.** Confirm `/home/dev/apps/openbot` is that clone, standalone, loopback door, supervisor + Chromium. Do not flip `isolated_computers` by hand. Landing public #5 is tracking-fork sync, not the VPS launch gate.
2. **Keep `tools: false` until one governed click uses `ComputerGateway`.** Turning tools on while the relay is prose-only would bypass CEL.
3. **Enclave bind + standalone.** Loopback (or private) gateway, `OPENBOT_RUNTIME_MODE=standalone`, no Intelligence contract, no BitMind credentials in this process. Host/rootless-Docker is BitMind #20 (external).
4. **Do not put OpenBot on Contabo.** Kill switch is “unset `BITMIND_*` / don’t schedule this image there,” not a site flag.
5. **Fix private gateway docs** so `docs/bitmind-gateway.md` lists computer routes and derived isolation. Stale prose will make operators treat the door as prose-only.

### P1 — OpenBot follow-through after the door has computers

1. CU-1: TARS-1.5-7B as a plugin/sidecar **inside** a per-bot computer. Screenshot in, closed verbs out, CEL still in front.
2. Attest `tools: true` / `interrupts: true` only after those paths are real (`agent-langgraph` HITL is not there yet).
3. Durable admission if a second replica serves `/bitmind/v1` (replace the in-process `Map`).
4. `/internal/runs/tools` + run-assertion mint if BitMind still needs grant catalogues without sitting on the tool path.
5. Add `standalone` to the Helm CI matrix (public chart; same gap on private if it shares the chart).
6. `COMPUTER_MAX_SLOTS` / 503 `queue_full` on this plane (not Contabo).
7. Pin `@ag-ui/*` 0.0.57 until BitMind’s pin moves.
8. Merge public #5 when ready so the tracking fork matches the VPS.

### Not this repo

- BitMind threads, OIDC, worker leases, BA JWT exchange, Qwen GPU, Stripe grants, site `/chat` UI.
- Re-doing bit-bot-site Auth Phase 0.
- Inventing live VPS process state from this Cloud Agent (no SSH).

---

## Minimum launch slice (what OpenBot must present)

**ML-1 — private OpenBot enclave BitMind can point at:** `/home/dev/apps/openbot` = `openbot-private`, standalone server, loopback BitMind door, supervisor + one Chromium per coworker, CEL on the product gateway, computer routes, `isolated_computers` derived from reachability, `tools: false`, `BITMIND_MAX_CONCURRENT_RUNS=2`, LangGraph (or equivalent) as the prose agent. Screenshot + take/release are enough; no CDP pipe, no TARS, no Qwen. Gateway docs updated so operators are not reading the stale “no computers” page.

**Exit:** BitMind (external) can authenticate, start one prose run, ensure a computer, fetch a screenshot, and read an attestation that is true only while that supervisor is up. Every acting computer verb that exists still goes through CEL + audit. Tools that are not attested cannot be sent.

**Then ML-2 (OpenBot):** CU-1 TARS on that same computer. **ML-3:** `tools: true` after a click that originated on the BitMind hop is decide-before / audit-after proven.

---

## Sources (no secrets)

**Preferred tree:** `bitcloud-labs/openbot-private` `server/src/bitmind/gateway.ts` @ `1f2b986`; operator path `/home/dev/apps/openbot`. Private `docs/bitmind-gateway.md` @ `3de8a817` is **stale** vs that gateway.

**This public repo:** [`docs/bitmind-gateway.md`](bitmind-gateway.md), [`docs/architecture.md`](architecture.md), [`docs/deployment.md`](deployment.md), `server/src/bitmind/{gateway,config,mount}.ts`, `server/src/computer/{gateway,supervisor}.ts`, `server/src/work/queue.ts`, `server/src/config.ts`, `.github/workflows/ci.yml`, `charts/openbot/ci/standalone-values.yaml`, PRs #1–#5.

**External (contract citations only):** `bitcloud-labs/bit-mind` ADR-0002 / `openbot-single-host-enclave.md`; `bitcloud-labs/bit-bot-site` `SPEC-bitbot-qwen-scale.md`, `SPEC-bitbot-computer-use.md`.
