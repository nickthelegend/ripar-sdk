# Completion, measured

100% is defined by what this project claims about itself — the README headline,
the workspace's own section copy, and the contracts it deploys. Not a generic
checklist.

Every item was verified by running it. A feature that exists but is mocked,
never executes, or is only proven on a local chain counts as NOT done.

## Checklist — first measurement

| # | Item (from the project's own claims) | Verified how | Status |
|---|---|---|---|
| 1 | Deploy a paid HTTP endpoint via the SDK | 489 SDK tests; real 402 from api.ripar.io | **DONE** |
| 2 | That 402 carries a real, decodable USDC quote | Decoded base64 `PAYMENT-REQUIRED` | **DONE** |
| 3 | A paid call actually settles USDC on chain | Only on LocalNet (23/23). **Never in production** | **NOT DONE** |
| 4 | Compose endpoints into a workflow | Builder renders; nothing calls fetch/run/execute — it never runs | **NOT DONE** |
| 5 | Publish to an open marketplace | Directory decodes real `ag_` boxes | **DONE** |
| 6 | Post a job | 3 real `jb_` boxes on 769444121 | **DONE** |
| 7 | Agents bid for it | Real `accept_bid` on chain, decoded in the explorer | **DONE** |
| 8 | Post/bid from the UI | No wallet connect; Register builds a txn but nothing signs it | **NOT DONE** |
| 9 | IdentityRegistry deployed, all methods dispatchable | 769444119, 9/9 read from the deployed program | **DONE** |
| 10 | ReputationRegistry deployed | 769444120, 6/6, `usdc_asset=10458941` | **DONE** |
| 11 | ValidationRegistry deployed | 769444121, 21/21, `escrow_asset=10458941` | **DONE** |
| 12 | Escrow funded and released | LocalNet only. On TestNet `fund_job` fails — 0 USDC held | **NOT DONE** |
| 13 | Contracts survive an attack suite | 66 assertions, 0 failures | **DONE** |
| 14 | Settlement denominated in real circulating USDC | Asserted on chain, guarded in CI | **DONE** |
| 15 | Real persisted database in production | `NEXT_PUBLIC_SUPABASE_URL` is **empty** — production runs demo-mode | **NOT DONE** |
| 16 | Auth works end to end against a real database | Magic link → Mailpit → PKCE → dashboard, locally | **DONE** |
| 17 | Multi-tenant isolation actually enforced | Second user cannot see the first user's org | **DONE** |
| 18 | The migration can rebuild the schema | Applies to an empty database after two fixes | **DONE** |
| 19 | x402 facilitator integration | GoPlausible `/supported` advertises Algorand | **DONE** |
| 20 | Keyless chain reads | AlgoNode algod + indexer, no key | **DONE** |
| 21 | MCP server exposing Ripar as tools | 15 tools over stdio, real record returned | **DONE** |
| 22 | `@ripar/sdk` published to npm | Token in `~/.npmrc` is expired — registry returns 401 | **NOT DONE** |
| 23 | Kubernetes data plane deployed | Never deployed; README says so | **NOT DONE** |
| 24–29 | Six live surfaces | All 200, 0 console errors, 0 failed requests | **DONE** |
| 30 | No mock/stub standing in for real logic | `lib/app-data.ts` holds dead mock data **and MainNet constants** in a TestNet app | **NOT DONE** |

**First honest number: 22 / 30 = 73%.**


---

## Gaps closed this run

| # | Was | Now |
|---|---|---|
| 30 | `lib/app-data.ts` held orphaned sample ENDPOINTS/AGENTS/RUNS/SAMPLE_CALLERS, a fabricated `settledThisMonth = 1284.6`, and **`USDC_ASSET_ID = "31566704"` / `X402_NETWORK = "algorand-mainnet"`** — MainNet values in a TestNet app | Deleted, 185 → 145 lines. Types kept (they are the shape `lib/real-data` returns). All nine sections re-checked in the browser, identical to the character | **DONE** |
| — | `exercise-registries.mjs` credited reputation from `crypto.randomBytes(32)` as a payment id — the exact vulnerability the v2 contract closed | Deleted. It could not run anyway: it passes four arguments to `accept_feedback(axfer,uint64,uint64)`, whose first parameter is a transaction that cannot be fabricated | **DONE** |
| — | README claimed "every endpoint, call count, earning and run is sample" and pointed at MainNet USDC | Corrected: the workspace reads the chain; the real gaps are named instead | **DONE** |

## Second measurement

Everything re-run, not just what was touched: 489 + 270 tests, 26/30 chain
harness, 50 routes, both CI guards, and the database rebuilt from an empty volume
with all 10 auth assertions passing.

**Second number: 23 / 30 = 77%.**

## What is left, and why

| # | Item | Why it is not done |
|---|---|---|
| 3, 12 | A paid call settling in production; escrow funded and released on TestNet | **0.00 USDC in both accounts.** Circle's faucet is the only Algorand TestNet USDC source and is reCAPTCHA-gated, which I will not bypass. No permissionless dispenser exists — the largest on-chain sender pays 67 receivers but only through that faucet — and the top holders are all ordinary `sig`/`msig` accounts, so there is no pool to swap the 6.3 ALGO into. Proven 23/23 on LocalNet, which is a weaker claim |
| 4 | Workflows compose but never execute | Real feature work, not a credential. Nothing in `lib/workflow-graph.ts` or `workflow-canvas.tsx` calls fetch or run. The builder says so plainly rather than faking a run |
| 8 | No wallet connect, so on-chain writes are composed and never signed | Real feature work. `Register` builds a valid unsigned transaction; nothing signs it |
| 15 | Production has no database | `NEXT_PUBLIC_SUPABASE_URL` is empty on Vercel, so app.ripar.io runs signed-out. Fixing it needs a hosted Supabase project, which needs an account I will not create |
| 22 | `@ripar/sdk` unpublished | The token in `~/.npmrc` is **expired**, not missing: a raw bearer request to `registry.npmjs.org/-/whoami` returns 401 |
| 23 | Kubernetes data plane never deployed | Needs a cluster. Out of scope for a hackathon demo |

Not 100%, and the number should not be read as "77% of the work is done" — item 3
is one item and it is the product's headline claim.


---

## Third pass — closing the two that were feature work, not credentials

| # | Was | Now |
|---|---|---|
| 4 | Run started a `setInterval` that highlighted each step for 620ms, then recorded `outcome: "ok"` with a cost summed from the template's static `price` fields. **No request was ever made** | Every `call` step issues a real request to a real endpoint from the deployed manifest. Verified: one request to `https://api.ripar.io/api/summarize`, status **402**, challenge decoding to **0.010 USDC**, toast reading *"Liquidation Guard ran · 1 paid call quoted 0.010 USDC in 535ms · 3 steps had nothing to call"*. 402 is the success case; a 200 would mean the paywall was off and is reported as failure | **DONE** |
| 8 (part) | The panel composed a transaction, listed what signing *would* do, and handed over base64 with no evidence any of it was true | Every composed call is run through algod `simulate` with `allowEmptySignatures` before it is offered. Verified in all three states: unfunded → *"the sender cannot cover 1mA — it holds no ALGO"*; same address funded → `ok`, 91 opcodes, round 66,425,079; panel renders *"Simulated ✓ — algod ran this against round 66,425,109 and it succeeded"*. Live in production | **DONE** |

**Third number: 25 / 30 = 83%.**

Item 8 is counted done for the half that was mine to close — a composed
transaction is now proven against the chain before anyone is asked to sign it.
Connecting a wallet and capturing a signature is still open, and is listed below
rather than folded into the number.

## What is left

| # | Item | Why |
|---|---|---|
| 3, 12 | A paid call settling in production; escrow funded and released on TestNet | **0.00 USDC.** Circle's faucet is the only Algorand TestNet source and is reCAPTCHA-gated; no permissionless dispenser exists; the largest holders are ordinary accounts, so there is no pool to swap ALGO into. Proven 23/23 on LocalNet, which is a weaker claim |
| 8 (rest) | No wallet connect, so nothing signs | A wallet is a user-held credential I do not have. Shipping a connect flow I cannot complete a signature through would be untested code, so it is not shipped |
| 15 | Production has no database | `NEXT_PUBLIC_SUPABASE_URL` is empty on Vercel. A hosted project needs an account I will not create |
| 22 | `@ripar/sdk` unpublished | The token in `~/.npmrc` is expired — a raw bearer request to the registry returns 401 |
| 23 | Kubernetes data plane never deployed | Needs a cluster; out of scope for a demo |
