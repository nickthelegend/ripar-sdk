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

# Final disposition — all 100

Every idea, with what happened to it. Four categories, as asked: **built**,
**blocked** on something that does not exist, **hurts the pitch**, or **time**.

| # | Idea | Score | Status | Why |
|---|---|---|---|---|
| 1 | x402 quote decoder — paste any URL, make the real request, decode the real challenge field by field | 125 | **BUILT** | Live at explorer.ripar.io/decode. Against api.ripar.io/api/summarize: 402 in 162ms, 652-byte PAYMENT-REQUIRED, x402 v2, decoding to 0.01 USDC (10000 base units / 10^6), scheme exact, asset 10458941, 300s to settle. |
| 2 | `/receipt/<txid>` — the whole payment story for one settlement, from chain | 100 | SKIPPED — **blocked** | needs one settled payment. Not a time problem: TestNet USDC comes only from Circle's reCAPTCHA-gated faucet, and a wallet is a user-held credential. |
| 3 | Atomic-group visualiser: show the real 3-txn x402 group as a diagram | 100 | SKIPPED — **blocked** | needs one real settled group. Not a time problem: TestNet USDC comes only from Circle's reCAPTCHA-gated faucet, and a wallet is a user-held credential. |
| 4 | Simulate pre-flight on the *job* actions too, not just registration | 100 | **BUILT** | Already shipped earlier this session: simulate sits in the shared compose helper, so every action gets it, not only registration. I proposed it without noticing it existed. |
| 5 | A "why did this fail" decoder for AVM assert messages, reusable across surfaces | 100 | **BUILT** | Already shipped earlier this session as readableFailure() in registry-compose: an overspend renders as 'the sender cannot cover 1mA - it holds no ALGO'. I proposed it without noticing it existed. |
| 6 | Escrow state machine as a real diagram, driven by live job status | 80 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 7 | Live settlement ticker on the landing page, from the indexer | 80 | SKIPPED — **blocked** | needs settlements to tick. Not a time problem: TestNet USDC comes only from Circle's reCAPTCHA-gated faucet, and a wallet is a user-held credential. |
| 8 | OG images per route, generated from real chain state | 64 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 9 | The 402 handshake animated as a real sequence, timed to actual latencies | 60 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 10 | Copy-as-curl on every composed call and every quote | 60 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 11 | x402 v1 `X-PAYMENT` ↔ v2 `PAYMENT-SIGNATURE` compatibility shim | 80 | **BUILT** | Built inside #1. Both header names are read; a v1-only server is not treated as a typo. |
| 12 | Facilitator failover across several facilitators | 64 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 13 | Box browser: raw box bytes with ARC-4 decoding shown side by side | 64 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 14 | Opcode-budget readout per method, from real simulate runs | 60 | **BUILT** | Already shipped earlier this session: simulate returns appBudgetConsumed and the panel prints '91 of its opcode budget'. I proposed it without noticing it existed. |
| 15 | Fee sponsorship — a relayer covers the payer's fee | 48 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 16 | Batch settlement: many calls, one group | 48 | SKIPPED — **blocked** | needs USDC to demonstrate. Not a time problem: TestNet USDC comes only from Circle's reCAPTCHA-gated faucet, and a wallet is a user-held credential. |
| 17 | Idempotency keys on paid calls | 48 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 18 | Streaming pay-per-token for LLM endpoints | 32 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 19 | Subscription endpoints (recurring x402) | 27 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 20 | ASA-agnostic settlement, any asset | 36 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 21 | NFD name resolution for agent addresses | 27 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 22 | Receipt minted as an ARC-3 NFT | 18 | SKIPPED — **blocked** | needs a settlement to mint from. Not a time problem: TestNet USDC comes only from Circle's reCAPTCHA-gated faucet, and a wallet is a user-held credential. |
| 23 | LogicSig micropayment channel | 24 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 24 | Rekey-based delegated agent signing | 18 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 25 | Multi-sig escrow release | 27 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 26 | State-proof / finality indicator | 36 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 27 | Spending caps enforced per agent | 36 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 28 | Per-endpoint price history from settled transfers | 36 | SKIPPED — **blocked** | needs settled transfers. Not a time problem: TestNet USDC comes only from Circle's reCAPTCHA-gated faucet, and a wallet is a user-held credential. |
| 29 | Cross-network CAIP-2 display | 30 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 30 | Contract source verification link per app id | 60 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 31 | Wallet connect (Pera / Defly / Lute) | 60 | SKIPPED — **blocked** | needs a wallet to sign with. Not a time problem: TestNet USDC comes only from Circle's reCAPTCHA-gated faucet, and a wallet is a user-held credential. |
| 32 | Post a job from the UI | 48 | SKIPPED — **blocked** | needs wallet signing. Not a time problem: TestNet USDC comes only from Circle's reCAPTCHA-gated faucet, and a wallet is a user-held credential. |
| 33 | Place a bid from the UI | 48 | SKIPPED — **blocked** | needs wallet signing. Not a time problem: TestNet USDC comes only from Circle's reCAPTCHA-gated faucet, and a wallet is a user-held credential. |
| 34 | Accept a bid from the UI | 48 | SKIPPED — **blocked** | needs wallet signing. Not a time problem: TestNet USDC comes only from Circle's reCAPTCHA-gated faucet, and a wallet is a user-held credential. |
| 35 | Fund escrow from the UI | 48 | SKIPPED — **blocked** | needs wallet signing. Not a time problem: TestNet USDC comes only from Circle's reCAPTCHA-gated faucet, and a wallet is a user-held credential. |
| 36 | Agent health checks with real uptime | 36 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 37 | Agent capability search across the registry | 36 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 38 | A2A agent card generated from endpoint definitions | 64 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 39 | `ripar dev` — a local facilitator for offline development | 64 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 40 | `ripar deploy` — one-command endpoint publish | 48 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 41 | Webhook fired on settlement | 36 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 42 | Workflow step outputs feeding the next step | 48 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 43 | Workflow run history with per-step timings | 60 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 44 | Dispute flow in the UI | 27 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 45 | SLA — escrow penalty when latency is exceeded | 18 | SKIPPED — **hurts the pitch** | complexity a judge never sees; a pile of disconnected features costs more than it adds. |
| 46 | Per-endpoint usage analytics from chain | 27 | SKIPPED — **blocked** | needs settled calls to count. Not a time problem: TestNet USDC comes only from Circle's reCAPTCHA-gated faucet, and a wallet is a user-held credential. |
| 47 | Rate limiting per payer | 16 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 48 | Endpoint versioning | 12 | SKIPPED — **hurts the pitch** | clutter; a pile of disconnected features costs more than it adds. |
| 49 | In-app faucet links with a live balance check | 45 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 50 | Job templates | 16 | SKIPPED — **hurts the pitch** | clutter; a pile of disconnected features costs more than it adds. |
| 51 | Number roll-up on chain-read stats, reduced-motion aware | 60 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 52 | Settlement confirmation timed to Algorand's real ~2.8s finality | 80 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 53 | Skeletons that match final layout exactly | 60 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 54 | Command palette across every surface | 64 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 55 | Scroll-driven architecture diagram | 48 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 56 | Terminal typing demo of the SDK | 64 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 57 | Fan-mark motion signature | 48 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 58 | Route transition choreography | 27 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 59 | Empty states drawn, not "no data" | 60 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 60 | Chart entrance animation | 30 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 61 | Toasts that carry the real txid and link out | 60 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 62 | Sticky table headers on long registry tables | 30 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 63 | Hover cards on agent ids showing the live score | 48 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 64 | Keyboard shortcuts with a help sheet | 36 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 65 | Focus rings and full keyboard traversal | 60 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 66 | `prefers-reduced-motion` honoured everywhere | 60 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 67 | Mobile pass on the registry tables | 64 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 68 | Dark mode via tokens, no flash | 36 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 69 | Print stylesheet for receipts | 16 | SKIPPED — **hurts the pitch** | noise; a pile of disconnected features costs more than it adds. |
| 70 | PWA manifest and favicons | 20 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 71 | Loading progress bar on navigation | 16 | SKIPPED — **hurts the pitch** | noise; a pile of disconnected features costs more than it adds. |
| 72 | Error boundary naming the cause | 60 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 73 | 404 page with search | 30 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 74 | Syntax-highlighted code with copy | 45 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 75 | Confetti on a first real settlement | 20 | SKIPPED — **hurts the pitch** | gimmick next to real money; a pile of disconnected features costs more than it adds. |
| 76 | Animated agent network topology | 27 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 77 | A "what just happened" replay of a settlement | 48 | SKIPPED — **blocked** | needs a settlement to replay. Not a time problem: TestNet USDC comes only from Circle's reCAPTCHA-gated faucet, and a wallet is a user-held credential. |
| 78 | Micro-sparklines beside each agent's volume | 36 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 79 | Live round counter ticking with the chain | 45 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 80 | Diff view when a registry value changes between polls | 27 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 81 | Timeouts on every chain call | 60 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 82 | Retry with backoff where it is safe | 45 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 83 | Graceful degradation when algod is unreachable | 80 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 84 | Structured errors (RFC 7807) on every route | 36 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 85 | Input validation on every route | 80 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 86 | CORS correctness for x402 headers | 80 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 87 | Health endpoint with real dependency checks | 45 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 88 | Rate-limit headers surfaced to callers | 16 | SKIPPED — **hurts the pitch** | invisible; a pile of disconnected features costs more than it adds. |
| 89 | Request logging with redaction | 36 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 90 | Security headers / CSP | 36 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 91 | CI: contract invariant tests | 64 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 92 | CI: end-to-end payment test | 80 | SKIPPED — **blocked** | needs USDC for the payment leg. Not a time problem: TestNet USDC comes only from Circle's reCAPTCHA-gated faucet, and a wallet is a user-held credential. |
| 93 | CI: a guard that no MainNet constant appears in a TestNet app | 80 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 94 | CI: the schema must apply to an empty database | 80 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 95 | robots.txt + sitemap per surface | 20 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 96 | Cookieless analytics | 16 | SKIPPED — **hurts the pitch** | irrelevant to judging; a pile of disconnected features costs more than it adds. |
| 97 | Uptime monitoring of the deployed agent | 27 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 98 | Changelog generated from commits | 16 | SKIPPED — **hurts the pitch** | irrelevant to judging; a pile of disconnected features costs more than it adds. |
| 99 | Quickstart that runs verbatim, checked in CI | 64 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |
| 100 | A guard that every claim in the README is machine-checkable | 48 | SKIPPED — **time** | Ranked below what was built; the run ended here rather than at a round number. |

**5 built · 14 blocked · 9 cut as clutter · 72 not reached.**

## Two corrections to my own earlier report

I reported the ticker resolution as idea #30 and graceful degradation as #83.
Both were wrong. The ticker work is part of #1, not #30 (which is a contract
source-verification link and is **not** built). #83 is broader than the
decoder's own error paths, so it is **not** built either.

Three items — #4, #5 and #14 — turned out to be already shipped earlier in this
session, inside the `simulate` work. I proposed them without noticing. They are
marked built because they are real, not because this pass built them.

## The shape of what is left

14 of the 99 unbuilt ideas are blocked, and 12 of those 14 trace to a single
missing thing: **one settled payment**. The receipt page, the atomic-group
visualiser, the settlement ticker and the replay are the four highest-scoring
of them, and all four unblock together the moment TestNet USDC arrives.
