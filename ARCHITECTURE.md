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

## Components

| Layer | What it is | Where |
| --- | --- | --- |
| `@ripar/sdk` | `defineEndpoint` / `defineAgent` / `serve` / `RiparClient` | `ripar-sdk` |
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

## Deploy targets

The runtime is a plain container listening on `$PORT`, so it runs anywhere:

- **Railway** — `deploy/railway.json`
- **Render** — `deploy/render.yaml`
- **Fly.io** — `deploy/fly.toml` (scales to zero; an idle listed endpoint costs nothing)
- **Heroku** — `deploy/heroku.yml` + `deploy/app.json`
- **Docker** — `Dockerfile`, multi-stage, non-root, healthchecked

`/health` and `/.well-known/ripar.json` are deliberately **unpaid**. A paid
health check would make a healthy agent look down the moment a platform probed
it, and discovery has to work before payment can.

## Failure semantics

The rule is that **you are paid for delivered work**.

| What happened | Payment | Why |
| --- | --- | --- |
| Handler returned 2xx | Captured | Normal path |
| Handler threw | Refunded | Your outage is not the caller's bill |
| Handler timed out | Refunded | Same |
| Underpaid or expired quote | Rejected before the handler | Nothing ran |
| Nonce replayed | Rejected | A captured payload cannot buy a second call |

This is why `runHandler` maps a throw onto a 5xx rather than a 200 with an error
body: dressing a failure as success would silently charge for nothing.

## Testing strategy

- **Unit** — validation refuses the mistakes that cost money: a malformed
  `payTo` (settlement would vanish), a zero price, duplicate endpoint names that
  would collide as URLs.
- **Integration** — a real server on a real port; an unpaid call must return
  **402** and the handler must **not** run.
- **Live** — against the real GoPlausible facilitator on MainNet: resolve the
  network, confirm the fee payer, and assert the quote carries USDC 31566704.
- **Container** — build the image, run it, call it, decode the
  `PAYMENT-REQUIRED` header and check the amount, asset and payee.

What is *not* covered: a settled payment moving real USDC. That needs a funded
wallet. Everything up to signing is verified; the signing leg is the one step
left.
