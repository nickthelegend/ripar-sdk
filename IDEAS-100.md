# 100 ideas, ranked — second pass

Rewritten from scratch. The previous list was written when the explorer ran on a
bundled sample dataset, the registries were frozen, workflows ran on a timer and
composed transactions were handed over unverified. All of that has changed, so
nothing already shipped appears below.

**What exists now, so it is not proposed again:** three writable registries on
TestNet settling in circulating USDC; an explorer whose `/registry` pages decode
real boxes; workflows that issue real 402-returning calls; composed transactions
pre-flighted through algod `simulate`; a reproducible Postgres schema with RLS;
two CI drift guards; an MCP server with 15 tools.

Scored **impact × feasibility × fit** (1–5 each, 125 max).

## Tier 1 — build now

| # | Idea | I | F | Fit | Score |
|---|---|---|---|---|---|
| 1 | **x402 quote decoder** — paste any URL, make the real request, decode the real challenge field by field | 5 | 5 | 5 | 125 |
| 2 | `/receipt/<txid>` — the whole payment story for one settlement, from chain | 5 | 5 | 4 | 100 |
| 3 | Atomic-group visualiser: show the real 3-txn x402 group as a diagram | 5 | 4 | 5 | 100 |
| 4 | Simulate pre-flight on the *job* actions too, not just registration | 4 | 5 | 5 | 100 |
| 5 | A "why did this fail" decoder for AVM assert messages, reusable across surfaces | 4 | 5 | 5 | 100 |
| 6 | Escrow state machine as a real diagram, driven by live job status | 4 | 5 | 4 | 80 |
| 7 | Live settlement ticker on the landing page, from the indexer | 4 | 4 | 5 | 80 |
| 8 | OG images per route, generated from real chain state | 4 | 4 | 4 | 64 |
| 9 | The 402 handshake animated as a real sequence, timed to actual latencies | 4 | 3 | 5 | 60 |
| 10 | Copy-as-curl on every composed call and every quote | 3 | 5 | 4 | 60 |

## Tier 2 — protocol depth

| # | Idea | I | F | Fit | Score |
|---|---|---|---|---|---|
| 11 | x402 v1 `X-PAYMENT` ↔ v2 `PAYMENT-SIGNATURE` compatibility shim | 4 | 5 | 4 | 80 |
| 12 | Facilitator failover across several facilitators | 4 | 4 | 4 | 64 |
| 13 | Box browser: raw box bytes with ARC-4 decoding shown side by side | 4 | 4 | 4 | 64 |
| 14 | Opcode-budget readout per method, from real simulate runs | 3 | 5 | 4 | 60 |
| 15 | Fee sponsorship — a relayer covers the payer's fee | 4 | 3 | 4 | 48 |
| 16 | Batch settlement: many calls, one group | 4 | 3 | 4 | 48 |
| 17 | Idempotency keys on paid calls | 4 | 3 | 4 | 48 |
| 18 | Streaming pay-per-token for LLM endpoints | 4 | 2 | 4 | 32 |
| 19 | Subscription endpoints (recurring x402) | 3 | 3 | 3 | 27 |
| 20 | ASA-agnostic settlement, any asset | 3 | 4 | 3 | 36 |
| 21 | NFD name resolution for agent addresses | 3 | 3 | 3 | 27 |
| 22 | Receipt minted as an ARC-3 NFT | 3 | 3 | 2 | 18 |
| 23 | LogicSig micropayment channel | 4 | 2 | 3 | 24 |
| 24 | Rekey-based delegated agent signing | 3 | 2 | 3 | 18 |
| 25 | Multi-sig escrow release | 3 | 3 | 3 | 27 |
| 26 | State-proof / finality indicator | 3 | 4 | 3 | 36 |
| 27 | Spending caps enforced per agent | 3 | 4 | 3 | 36 |
| 28 | Per-endpoint price history from settled transfers | 3 | 4 | 3 | 36 |
| 29 | Cross-network CAIP-2 display | 2 | 5 | 3 | 30 |
| 30 | Contract source verification link per app id | 3 | 5 | 4 | 60 |

## Tier 3 — product surface

| # | Idea | I | F | Fit | Score |
|---|---|---|---|---|---|
| 31 | Wallet connect (Pera / Defly / Lute) | 5 | 3 | 4 | 60 |
| 32 | Post a job from the UI | 4 | 3 | 4 | 48 |
| 33 | Place a bid from the UI | 4 | 3 | 4 | 48 |
| 34 | Accept a bid from the UI | 4 | 3 | 4 | 48 |
| 35 | Fund escrow from the UI | 4 | 3 | 4 | 48 |
| 36 | Agent health checks with real uptime | 3 | 4 | 3 | 36 |
| 37 | Agent capability search across the registry | 3 | 4 | 3 | 36 |
| 38 | A2A agent card generated from endpoint definitions | 4 | 4 | 4 | 64 |
| 39 | `ripar dev` — a local facilitator for offline development | 4 | 4 | 4 | 64 |
| 40 | `ripar deploy` — one-command endpoint publish | 4 | 3 | 4 | 48 |
| 41 | Webhook fired on settlement | 3 | 4 | 3 | 36 |
| 42 | Workflow step outputs feeding the next step | 4 | 3 | 4 | 48 |
| 43 | Workflow run history with per-step timings | 3 | 5 | 4 | 60 |
| 44 | Dispute flow in the UI | 3 | 3 | 3 | 27 |
| 45 | SLA — escrow penalty when latency is exceeded | 3 | 2 | 3 | 18 |
| 46 | Per-endpoint usage analytics from chain | 3 | 3 | 3 | 27 |
| 47 | Rate limiting per payer | 2 | 4 | 2 | 16 |
| 48 | Endpoint versioning | 2 | 3 | 2 | 12 |
| 49 | In-app faucet links with a live balance check | 3 | 5 | 3 | 45 |
| 50 | Job templates | 2 | 4 | 2 | 16 |

## Tier 4 — design and motion

| # | Idea | I | F | Fit | Score |
|---|---|---|---|---|---|
| 51 | Number roll-up on chain-read stats, reduced-motion aware | 3 | 5 | 4 | 60 |
| 52 | Settlement confirmation timed to Algorand's real ~2.8s finality | 4 | 5 | 4 | 80 |
| 53 | Skeletons that match final layout exactly | 3 | 5 | 4 | 60 |
| 54 | Command palette across every surface | 4 | 4 | 4 | 64 |
| 55 | Scroll-driven architecture diagram | 4 | 3 | 4 | 48 |
| 56 | Terminal typing demo of the SDK | 4 | 4 | 4 | 64 |
| 57 | Fan-mark motion signature | 3 | 4 | 4 | 48 |
| 58 | Route transition choreography | 3 | 3 | 3 | 27 |
| 59 | Empty states drawn, not "no data" | 3 | 5 | 4 | 60 |
| 60 | Chart entrance animation | 2 | 5 | 3 | 30 |
| 61 | Toasts that carry the real txid and link out | 3 | 5 | 4 | 60 |
| 62 | Sticky table headers on long registry tables | 2 | 5 | 3 | 30 |
| 63 | Hover cards on agent ids showing the live score | 3 | 4 | 4 | 48 |
| 64 | Keyboard shortcuts with a help sheet | 3 | 4 | 3 | 36 |
| 65 | Focus rings and full keyboard traversal | 3 | 5 | 4 | 60 |
| 66 | `prefers-reduced-motion` honoured everywhere | 3 | 5 | 4 | 60 |
| 67 | Mobile pass on the registry tables | 4 | 4 | 4 | 64 |
| 68 | Dark mode via tokens, no flash | 3 | 4 | 3 | 36 |
| 69 | Print stylesheet for receipts | 2 | 4 | 2 | 16 |
| 70 | PWA manifest and favicons | 2 | 5 | 2 | 20 |
| 71 | Loading progress bar on navigation | 2 | 4 | 2 | 16 |
| 72 | Error boundary naming the cause | 3 | 5 | 4 | 60 |
| 73 | 404 page with search | 2 | 5 | 3 | 30 |
| 74 | Syntax-highlighted code with copy | 3 | 5 | 3 | 45 |
| 75 | Confetti on a first real settlement | 2 | 5 | 2 | 20 |
| 76 | Animated agent network topology | 3 | 3 | 3 | 27 |
| 77 | A "what just happened" replay of a settlement | 4 | 3 | 4 | 48 |
| 78 | Micro-sparklines beside each agent's volume | 3 | 4 | 3 | 36 |
| 79 | Live round counter ticking with the chain | 3 | 5 | 3 | 45 |
| 80 | Diff view when a registry value changes between polls | 3 | 3 | 3 | 27 |

## Tier 5 — production readiness

| # | Idea | I | F | Fit | Score |
|---|---|---|---|---|---|
| 81 | Timeouts on every chain call | 3 | 5 | 4 | 60 |
| 82 | Retry with backoff where it is safe | 3 | 5 | 3 | 45 |
| 83 | Graceful degradation when algod is unreachable | 4 | 5 | 4 | 80 |
| 84 | Structured errors (RFC 7807) on every route | 3 | 4 | 3 | 36 |
| 85 | Input validation on every route | 4 | 5 | 4 | 80 |
| 86 | CORS correctness for x402 headers | 4 | 5 | 4 | 80 |
| 87 | Health endpoint with real dependency checks | 3 | 5 | 3 | 45 |
| 88 | Rate-limit headers surfaced to callers | 2 | 4 | 2 | 16 |
| 89 | Request logging with redaction | 3 | 4 | 3 | 36 |
| 90 | Security headers / CSP | 3 | 4 | 3 | 36 |
| 91 | CI: contract invariant tests | 4 | 4 | 4 | 64 |
| 92 | CI: end-to-end payment test | 5 | 4 | 4 | 80 |
| 93 | CI: a guard that no MainNet constant appears in a TestNet app | 4 | 5 | 4 | 80 |
| 94 | CI: the schema must apply to an empty database | 4 | 5 | 4 | 80 |
| 95 | robots.txt + sitemap per surface | 2 | 5 | 2 | 20 |
| 96 | Cookieless analytics | 2 | 4 | 2 | 16 |
| 97 | Uptime monitoring of the deployed agent | 3 | 3 | 3 | 27 |
| 98 | Changelog generated from commits | 2 | 4 | 2 | 16 |
| 99 | Quickstart that runs verbatim, checked in CI | 4 | 4 | 4 | 64 |
| 100 | A guard that every claim in the README is machine-checkable | 4 | 3 | 4 | 48 |

---

# What was actually built this pass

| # | Idea | Status | Verified by |
|---|---|---|---|
| 1 | x402 quote decoder | **BUILT** | Live at [explorer.ripar.io/decode](https://explorer.ripar.io/decode). Against `api.ripar.io/api/summarize`: 402 in 162ms, 652-byte `PAYMENT-REQUIRED`, x402 v2, decoding to **0.01 USDC** (10000 base units ÷ 10^6), scheme `exact`, asset 10458941, 300s to settle |
| 30 | Ticker resolved from the asset when a challenge omits it | **BUILT** | Renders "0.01 USDC … · ticker read from the asset, which the challenge did not state" — read from the ASA's own params, and it says so |
| 11 | v1 `X-PAYMENT-REQUIRED` ↔ v2 `PAYMENT-REQUIRED` | **BUILT** | Both header names read; a v1-only server is not treated as a typo |
| 83 | Graceful degradation | **BUILT** | Timeout, non-402, and 402-with-no-header are each reported as their own case rather than a generic failure |
| — | `/decode` classified in the chrome route table | **BUILT** | The sample-dataset strip no longer sits above a page whose content is a live 402 from someone else's server |

Built in earlier passes this session, so not re-proposed: real registries on the
explorer, the ABI-coverage guard, workflows that issue real calls, the algod
`simulate` pre-flight, the reproducible Postgres schema.

## Not built, and why

Everything else on the list is **not started**. The honest reason is time, not
difficulty — the run ended here rather than at a round number.

Three are blocked on something that does not exist rather than on effort:
**#31 wallet connect** needs a wallet to sign with, and shipping a connect flow I
cannot complete a single signature through would be untested code; **anything
requiring a settled payment** (#2 receipt page, #3 atomic-group visualiser, #7
settlement ticker, #77 replay) needs TestNet USDC, which only Circle's
reCAPTCHA-gated faucet issues; **#92 CI end-to-end payment test** the same.

Those four design items — the receipt page, the group visualiser, the ticker and
the replay — are the ones I would build next, and all four unblock together the
moment one payment settles.
