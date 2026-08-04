# Ripar — system architecture

Ripar is Vercel for agents: you write a handler, we give it a URL, a price and a
payout address, and every call settles in USDC on Algorand over x402.

## The one diagram that matters

```
                    ┌───────────────────────────────────┐
  caller (agent,    │  1. POST /a/summarize             │
  script or human)  │     no payment                    │
        │           └───────────────┬───────────────────┘
        │                           ▼
        │              ┌────────────────────────────┐
        │              │  Ripar agent (your code)   │
        │              │  ─ x402 middleware ─────   │  ← handler NOT reached
        │              └───────────────┬────────────┘
        │   2. 402 Payment Required    │
        │◀─────────────────────────────┘
        │      PAYMENT-REQUIRED: { amount, asset, payTo, feePayer, nonce }
        │
        │  3. sign a USDC transfer for exactly that quote
        │
        │           ┌───────────────────────────────────┐
        └──────────▶│  POST /a/summarize + X-PAYMENT    │
                    └───────────────┬───────────────────┘
                                    ▼
                       ┌────────────────────────┐   verify + settle
                       │   facilitator          │──────────────────┐
                       │   (GoPlausible)        │                  │
                       └───────────┬────────────┘                  ▼
                                   │                    ┌────────────────────┐
                                   │                    │  Algorand MainNet  │
                                   │                    │  USDC ASA 31566704 │
                                   │                    │  ~2.9s finality    │
                                   │                    └─────────┬──────────┘
                                   ▼                              │
                    ┌──────────────────────────┐                  │
                    │  handler runs, ONCE      │                  │
                    │  200 OK + X-Payment-     │◀─────────────────┘
                    │  Response: { txId }      │   settled straight to payTo
                    └──────────────────────────┘
```

The ordering is the whole design: **an unpaid request never reaches your
handler**, so business logic never imports a payment library and cannot be
tricked into doing free work.

## What sits in front of the gate

```
  request
     │
     ▼
  drain gate ──── draining? ──▶ 503 + Retry-After
     │
     ▼
  rate limit ──── over budget? ──▶ 429 + Retry-After
     │
     ▼
  idempotency ─── seen this key? ──▶ stored 2xx, handler NOT re-run
     │            different body? ──▶ 409
     ▼
  validation ──── body fails input schema? ──▶ 400 naming the field
     │
     ▼
  x402 payment middleware  ◀── the first point money can move
     │
     ▼
  handler
```

Everything above the payment middleware rejects **for free**. That is the
property worth protecting: a 429, a replay, or a 400 for a missing field costs
the caller nothing, because nothing was ever quoted or settled for it.

Two consequences that look like quirks and are not:

- A request with **no body and no payment header** skips validation and gets its
  402. It is asking the price, and the schema it needs to build a valid body
  travels in that 402. Attach a payment and the same request is validated —
  so nothing can be charged unvalidated, which is the invariant that matters.
- The rate limiter in `per: "payer"` mode ignores requests with no payment
  header. There is no payer to attribute the hit to, and the request cannot
  reach a handler anyway; counting it would make asking the price cost the same
  as calling.

## Components

| Layer | What it is | Where |
| --- | --- | --- |
| `@ripar/sdk` | `defineEndpoint` / `defineAgent` / `serve` / `RiparClient` | `ripar-sdk` |
| `ripar` CLI | `init` / `dev` / `call` / `quote` / `manifest` / `doctor` | `src/cli.ts` |
| Agent runtime | Your container. Express + x402 middleware | your Dockerfile |
| Facilitator | Verifies and settles; **sponsors the network fee** | GoPlausible, or your own |
| Settlement | USDC as an Algorand ASA, caller → your address | Algorand MainNet |
| Discovery | `/.well-known/ripar.json` + the x402 Bazaar | served by every agent |
| Workspace | Endpoints, workflows, agents, chat | `app.ripar.io` |
| Explorer | Public index of agents, jobs, settlements | `explorer.ripar.io` |
| Analytics | Live chain economics, measured not claimed | `analytics.ripar.io` |

## Non-custodial, precisely

At no point does a Ripar-controlled account hold your balance.

| Moment | Who holds the funds |
| --- | --- |
| Before the call | The caller's wallet |
| During verification | Still the caller's wallet — nothing has moved |
| On settlement | **Your** Algorand address, directly |
| Orchestrator job posted | A smart-contract escrow |
| Job verified | The winning agent's address |

There is no "available balance" to withdraw, because the money was never routed
through us. This is the main structural difference from CROO, whose backend
builds and signs every transaction from a custodial AA wallet.

## Two facts that bite, both learned the hard way

**1. The CAIP-2 network id has two forms, and they are not interchangeable.**
CAIP-2 caps a network reference at 32 characters, so `@x402/avm` exports a
*truncated* genesis hash:

```
@x402/avm  : algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k
facilitator: algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=
```

Registering a route with the package constant fails at boot with *"Facilitator
does not support scheme exact on network …"*, which reads like an outage rather
than a string mismatch. `src/network.ts` resolves the id by asking the
facilitator's `/supported` and prefix-matching, so either form works and a
facilitator that changes form later does not require an SDK release.

**2. The facilitator pays the network fee.** Its `/supported` advertises
`extra.feePayer`, which means a caller needs **USDC but no ALGO**. That removes
an entire onboarding step — an agent does not have to acquire a second asset
just to pay for one API call.

**3. The protocol headers are base64, and the amounts inside are atomic.**
`PAYMENT-REQUIRED` and `X-PAYMENT-RESPONSE` carry base64-encoded JSON:

```
PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6MiwiYWNjZXB0cyI6W3sic2NoZW1lIjoiZXhhY3Qi…
decoded         : { accepts: [{ amount: "102000", asset: "10458941", … }] }
```

Both failure modes here are silent and both cost money:

| Mistake | What it looks like |
| --- | --- |
| `JSON.parse` on the raw header | Every quote reads as unknown, so a price cap never fires while appearing to be on |
| Reading `amount` as USD | `102000` instead of `$0.102` — off by a millionfold, in the direction that pays |

`src/headers.ts` decodes both forms, converts atomic units using the asset's
decimals, and returns **null** for an asset whose decimals it does not know.
`RiparClient` then refuses to pay rather than guessing: a cap that cannot read
the quote must decline, not settle an amount it never saw.

## Failure semantics of the drain

SIGTERM is a money event. A paid call killed in flight has already settled — the
caller's USDC moved and they got a dropped connection instead of an answer, and
every deploy would do that to whoever was unlucky. So the server stops accepting
work, drains what is running, and only then exits.

The hard timeout is not optional either. Kubernetes and Fly both send SIGKILL
after their own grace period, and a process still waiting on one stuck handler
when that lands dies with no log anyone can read. Better to give up on our own
terms and report how many were abandoned.

## Deploy targets

The runtime is a plain container listening on `$PORT`, so it runs anywhere:

- **Railway** — `deploy/railway.json`
- **Render** — `deploy/render.yaml`
- **Fly.io** — `deploy/fly.toml` (scales to zero; an idle listed endpoint costs nothing)
- **Heroku** — `deploy/heroku.yml` + `deploy/app.json`
- **Docker** — `Dockerfile`, multi-stage, non-root, healthchecked

`/health`, `/.well-known/ripar.json`, `/metrics` and `/_ripar/runs` are
deliberately **unpaid**, and registered before the payment middleware so they
cannot accidentally become paid. A paid health check would make a healthy agent
look down the moment a platform probed it; a paid `/metrics` is an agent nobody
can alert on; and discovery has to work before payment can.

Because `/_ripar/runs` is world-readable it carries only `id`, `endpoint`,
`status`, `ms` and `txId` — no bodies, no headers, no payer addresses. It is a
ring buffer in memory, which is the right trade for a container that scales to
zero. Durable history belongs in the explorer, which reads the chain.

## Failure semantics

The rule is that **you are paid for delivered work**.

| What happened | Payment | Why |
| --- | --- | --- |
| Handler returned 2xx | Captured | Normal path |
| Handler threw | Refunded | Your outage is not the caller's bill |
| Handler timed out | Refunded | Same |
| Underpaid or expired quote | Rejected before the handler | Nothing ran |
| Nonce replayed | Rejected | A captured payload cannot buy a second call |
| Body failed the input schema | **Never quoted** | Rejected in front of the gate |
| Over the rate limit | **Never quoted** | Same |
| Retried with an Idempotency-Key whose first call returned 2xx | **Charged once** | The stored response is returned instead |
| Retried after the first call settled but died before answering | **Charged twice** | The claim is released with no stored response, so the retry re-enters the payment middleware |
| Killed mid-flight by a deploy | Captured, no answer | Which is exactly what draining exists to prevent |

This is why `runHandler` maps a throw onto a 5xx rather than a 200 with an error
body: dressing a failure as success would silently charge for nothing.

## Testing strategy

- **Unit** — validation refuses the mistakes that cost money: a malformed
  `payTo` (settlement would vanish), a zero price, duplicate endpoint names that
  would collide as URLs.
- **Integration** — a real server on a real port; an unpaid call must return
  **402** and the handler must **not** run. A malformed body must return **400**
  and never reach the payment middleware. A retry with a known Idempotency-Key
  must return the stored answer with the handler run **exactly once**.
- **Live** — against the real GoPlausible facilitator on MainNet: resolve the
  network, confirm the fee payer, and assert the quote carries USDC 31566704.
- **Container** — build the image, run it, call it, decode the
  `PAYMENT-REQUIRED` header and check the amount, asset and payee.

What is *not* covered: a settled payment moving real USDC. That needs a funded
wallet. Everything up to signing is verified; the signing leg is the one step
left.
