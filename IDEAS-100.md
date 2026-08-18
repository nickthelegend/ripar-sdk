# 100 ideas, ranked

Scored **impact × feasibility × fit** (1–5 each, 125 max). Impact = would a judge
notice. Feasibility = buildable for real, no mocks, in the time available. Fit =
strengthens the pitch rather than cluttering it.

The ranking is driven by one fact from the README: *"No paid call has been served
in production yet"*, and the explorer is *"entirely sample"*. This project's
weakness is not features — it is that the impressive surfaces are not connected
to the chain underneath them. So anything that converts a sample surface into a
real one outranks any new surface.

## Tier 1 — converts a claim into a fact (build first)

| # | Idea | I | F | Fit | Score |
|---|---|---|---|---|---|
| 1 | Explorer reads the **live registries** instead of its bundled sample dataset | 5 | 5 | 5 | 125 |
| 2 | Serve the **first real paid call** end to end and keep the receipt | 5 | 4 | 5 | 100 |
| 3 | `/receipt/<txid>` — quote → signature → settlement → verification, from chain | 5 | 5 | 4 | 100 |
| 4 | Registry-backed agent directory with real scores | 5 | 5 | 4 | 100 |
| 5 | Atomic group visualiser — show the actual 3-txn x402 group | 5 | 4 | 5 | 100 |
| 6 | Live settlement ticker driven by the indexer | 4 | 5 | 5 | 100 |
| 7 | Escrow state machine view with a real dispute countdown | 4 | 5 | 5 | 100 |
| 8 | `x402 quote decoder` — paste any URL, decode its real 402 | 5 | 5 | 4 | 100 |
| 9 | Job board reading real `job_` boxes | 4 | 5 | 4 | 80 |
| 10 | Reputation leaderboard from real score boxes | 4 | 5 | 4 | 80 |

## Tier 2 — deeper protocol integration

| # | Idea | I | F | Fit | Score |
|---|---|---|---|---|---|
| 11 | Box storage explorer — raw box viewer with ARC-4 decoding | 4 | 5 | 4 | 80 |
| 12 | `algod simulate` preview before paying | 5 | 4 | 4 | 80 |
| 13 | Fee sponsorship — relayer pays the payer's fee | 4 | 3 | 4 | 48 |
| 14 | Facilitator failover across multiple facilitators | 4 | 4 | 4 | 64 |
| 15 | x402 v1 `X-PAYMENT` ↔ v2 `PAYMENT-SIGNATURE` shim | 4 | 5 | 4 | 80 |
| 16 | ASA-agnostic settlement, any asset not just USDC | 3 | 4 | 3 | 36 |
| 17 | NFD (Algorand name service) resolution for agent addresses | 3 | 3 | 3 | 27 |
| 18 | Contract source verification link per app id | 3 | 5 | 4 | 60 |
| 19 | Opcode budget profiler per contract method | 3 | 3 | 3 | 27 |
| 20 | Receipt minted as an ARC-3 NFT | 3 | 3 | 2 | 18 |
| 21 | LogicSig micropayment channel | 4 | 2 | 3 | 24 |
| 22 | Rekey-based delegated agent signing | 3 | 2 | 3 | 18 |
| 23 | Batch settlement — many calls, one group | 4 | 3 | 4 | 48 |
| 24 | Subscription endpoints (recurring x402) | 3 | 3 | 3 | 27 |
| 25 | Streaming pay-per-token for LLM endpoints | 4 | 2 | 4 | 32 |
| 26 | Spending caps enforced per agent | 3 | 4 | 3 | 36 |
| 27 | Multi-sig escrow release | 3 | 3 | 3 | 27 |
| 28 | State-proof / finality indicator | 3 | 4 | 3 | 36 |
| 29 | Indexer-backed full-text transaction search | 3 | 4 | 3 | 36 |
| 30 | CAIP-2 cross-network display | 2 | 5 | 3 | 30 |

## Tier 3 — core product surface

| # | Idea | I | F | Fit | Score |
|---|---|---|---|---|---|
| 31 | Wallet connect — Pera / Defly / Lute | 5 | 3 | 4 | 60 |
| 32 | Post a job from the UI, on chain | 4 | 3 | 4 | 48 |
| 33 | Bid on a job from the UI, on chain | 4 | 3 | 4 | 48 |
| 34 | Accept a bid from the UI | 4 | 3 | 4 | 48 |
| 35 | Agent health checks with real uptime | 3 | 4 | 3 | 36 |
| 36 | Endpoint price discovery — median by category | 3 | 3 | 3 | 27 |
| 37 | Agent discovery API, search by capability | 3 | 4 | 3 | 36 |
| 38 | A2A agent card auto-generated from endpoint defs | 4 | 4 | 4 | 64 |
| 39 | MCP server exposing Ripar as callable tools | 4 | 4 | 4 | 64 |
| 40 | `ripar dev` — local facilitator for offline dev | 4 | 4 | 4 | 64 |
| 41 | `ripar deploy` — one-command endpoint publish | 4 | 3 | 4 | 48 |
| 42 | Webhook fired on settlement | 3 | 4 | 3 | 36 |
| 43 | Workflow composition, one payment across endpoints | 4 | 2 | 4 | 32 |
| 44 | Refund / dispute flow in the UI | 3 | 3 | 3 | 27 |
| 45 | SLA — escrow penalty when latency is exceeded | 3 | 2 | 3 | 18 |
| 46 | Per-endpoint usage analytics | 3 | 3 | 3 | 27 |
| 47 | Rate limiting per payer | 2 | 4 | 2 | 16 |
| 48 | Job templates | 2 | 4 | 2 | 16 |
| 49 | Endpoint versioning | 2 | 3 | 2 | 12 |
| 50 | In-app TestNet faucet link with balance check | 3 | 5 | 3 | 45 |

## Tier 4 — design and motion

| # | Idea | I | F | Fit | Score |
|---|---|---|---|---|---|
| 51 | The 402 handshake animated as a real sequence | 5 | 4 | 5 | 100 |
| 52 | Settlement confirmation tuned to Algorand's ~3s finality | 4 | 5 | 4 | 80 |
| 53 | Number roll-up on stats, reduced-motion aware | 3 | 5 | 4 | 60 |
| 54 | Scroll-driven architecture diagram | 4 | 3 | 4 | 48 |
| 55 | Fan-mark motion signature | 3 | 4 | 4 | 48 |
| 56 | Skeletons that match the final layout exactly | 3 | 5 | 4 | 60 |
| 57 | Command palette across every surface | 4 | 4 | 4 | 64 |
| 58 | Route transition choreography | 3 | 3 | 3 | 27 |
| 59 | Terminal typing demo of the SDK | 4 | 4 | 4 | 64 |
| 60 | Copy-to-clipboard with real feedback | 2 | 5 | 3 | 30 |
| 61 | Empty states drawn, not "no data" | 3 | 5 | 4 | 60 |
| 62 | Chart entrance animation | 2 | 5 | 3 | 30 |
| 63 | Toast notifications | 2 | 5 | 3 | 30 |
| 64 | Sticky table headers | 2 | 5 | 3 | 30 |
| 65 | Hover states on agent cards | 2 | 5 | 3 | 30 |
| 66 | Keyboard shortcuts with a help sheet | 3 | 4 | 3 | 36 |
| 67 | Focus rings and full keyboard traversal | 3 | 5 | 4 | 60 |
| 68 | `prefers-reduced-motion` honoured everywhere | 3 | 5 | 4 | 60 |
| 69 | Mobile responsive pass | 4 | 4 | 4 | 64 |
| 70 | Dark/light via tokens, no flash | 3 | 4 | 3 | 36 |
| 71 | OG images per route | 3 | 4 | 3 | 36 |
| 72 | Loading progress bar on navigation | 2 | 4 | 2 | 16 |
| 73 | Print stylesheet for receipts | 2 | 4 | 2 | 16 |
| 74 | PWA manifest and favicons | 2 | 5 | 2 | 20 |
| 75 | Escrow state machine drawn as a diagram | 4 | 4 | 4 | 64 |
| 76 | Confetti on a first real payment | 2 | 5 | 2 | 20 |
| 77 | Syntax-highlighted code with copy buttons | 3 | 5 | 3 | 45 |
| 78 | 404 page with search | 2 | 5 | 3 | 30 |
| 79 | Error boundary that names the cause | 3 | 5 | 4 | 60 |
| 80 | Animated network topology of agents | 3 | 3 | 3 | 27 |

## Tier 5 — production readiness

| # | Idea | I | F | Fit | Score |
|---|---|---|---|---|---|
| 81 | Real error handling on every chain fetch | 4 | 5 | 4 | 80 |
| 82 | Timeouts on every network call | 3 | 5 | 4 | 60 |
| 83 | Retry with backoff where it is safe | 3 | 5 | 3 | 45 |
| 84 | Graceful degradation when algod is unreachable | 4 | 5 | 4 | 80 |
| 85 | Structured errors (RFC 7807) | 3 | 4 | 3 | 36 |
| 86 | Idempotency keys on paid calls | 4 | 3 | 4 | 48 |
| 87 | Input validation on every route | 4 | 5 | 4 | 80 |
| 88 | Security headers / CSP | 3 | 4 | 3 | 36 |
| 89 | CORS correctness for x402 headers | 4 | 5 | 4 | 80 |
| 90 | Health endpoint with real dependency checks | 3 | 5 | 3 | 45 |
| 91 | Rate limit headers surfaced to callers | 2 | 4 | 2 | 16 |
| 92 | Request/response logging with redaction | 3 | 4 | 3 | 36 |
| 93 | CI: contract invariant tests | 4 | 4 | 4 | 64 |
| 94 | CI: end-to-end payment test | 5 | 4 | 4 | 80 |
| 95 | robots.txt + sitemap per surface | 2 | 5 | 2 | 20 |
| 96 | Cookieless analytics | 2 | 4 | 2 | 16 |
| 97 | Uptime monitoring of the deployed agent | 3 | 3 | 3 | 27 |
| 98 | Changelog generated from commits | 2 | 4 | 2 | 16 |
| 99 | Quickstart in docs that actually runs verbatim | 4 | 4 | 4 | 64 |
| 100 | Drift guard: deployed app ids must match the docs | 4 | 5 | 4 | 80 |

## Build order

Tier 1 in full, then the highest-scoring items from every other tier — 51, 100,
81, 84, 87, 89, 94, 15, 11, 12 — because a judge who clicks one thing clicks the
explorer, and a judge who clicks two clicks a receipt.

---

# What was actually built

Session of 2026-08-18, after 10 TestNet ALGO arrived. Built, run and verified —
not "compiles".

| # | Idea | Status | Verified by |
|---|---|---|---|
| — | Redeploy the registries from a key that still exists | **BUILT** | 769444119/120/121 live; `agent_count=2`, `job_count=3` read from global state |
| — | Migrate settlement from self-minted rUSDC to circulating USDC | **BUILT** | `escrow_asset = 10458941` and `usdc_asset = 10458941` on chain |
| 1 | Explorer reads the live registries | **BUILT** | `/registry` at TestNet round 66,423,106: 2 agents decoded from `ag_` boxes, 2 validated / 0 disputed, 0 console errors |
| 9 | Job board reading real `job_` boxes | **BUILT** | 3 jobs with live status, budgets, spec hashes, "who may act next" |
| 100 | Drift guard: what we print equals what the chain asserts | **BUILT** | `check-settlement-asset.mjs` failed the half-done migration exactly as designed |
| — | ABI coverage guard, both directions | **BUILT** | `check-abi-coverage.mjs`, mutation-tested; 9 / 6 / 21 methods |
| — | Fix `accept_bid` rendering as an unknown selector | **BUILT** | `/tx/Y25C5BYL…` now decodes `accept_bid(uint64,uint64)bool`, args 3 and 2 |
| 84 | Graceful degradation when the chain is unreachable | **VERIFIED EXISTING** | With LocalNet down: "Application 1328 did not answer: 404" rather than stale data |

## Blocked, honestly

| # | Idea | Blocked on |
|---|---|---|
| 2 | Serve the first real paid call | **TestNet USDC.** Both accounts are opted in and hold 0. Escrow, `fund_job`, `release_escrow` and every settled-payment figure stay at zero until Circle's faucet is used. |
| 3, 5, 51 | Receipt page, atomic group visualiser, 402 handshake animation | Downstream of 2 — each renders a settlement, and no settlement exists yet |
| 31–34 | Wallet connect, post/bid/accept from the UI | Not started; needs 2 first to be worth demoing |
| 6, 7, 10 | Settlement ticker, escrow countdown, leaderboard | Pages exist and read real chain; all correctly show zero |

Everything else on the list of 100 is **not started**. A shorter honest list.
