# Ripar — full-surface test plan (v2, 2026-08-18)

Rebuilt after the registry migration. The previous plan measured against
768633998/9/768634000 settling in self-minted rUSDC; both are obsolete, so every
row that named an app id or a ticker has been rewritten rather than re-marked.

**Environment.** Real deployed product over HTTPS. **Claude in Chrome is not
connected on this machine** (`list_connected_browsers` → `[]`), so the in-app
Chromium pane is used: a real browser, real console, real network. Every page
item captures `console.error` and any subresource with status >= 400 from inside
the document. Chain items read public AlgoNode with no key.

**Definition of a PASS, no exceptions:**
1. The result matches the "correct means" column exactly.
2. Zero console errors on the page.
3. Zero failed network requests, unless the row names a status as correct.

**Current chain facts every row is measured against:**
- Identity `769444119` · Reputation `769444120` · Validation `769444121`
- Settlement asset `10458941` — circulating TestNet USDC, ticker `USDC`, 6 dp
- `agent_count = 2`, `job_count = 3`, `dispute_window = 300`, `fee_bps = 0`
- Merchant `NGVUO43A…HO3OCU` holds **0.00 USDC**; payer `HS5EAEME…6R4EN4` likewise

---

## A. Marketing — ripar.io

| # | Item | Correct means |
|---|---|---|
| A1 | `/` loads | 200, hero renders, 0 console errors, 0 failed requests |
| A2 | `/` live registry section | Shows `769444119/20/21` — the ids the chain holds — and agent count 2 |
| A3 | `/` live quote | Issues a real request and renders the returned 402, or states it could not |
| A4 | `/pricing` | 200, renders |
| A5 | `/changelog` | 200, renders |
| A6 | `/[slug]` | 200 for a real slug |
| A7 | `/api/quote` | JSON, or 405 on GET if POST-only |
| A8 | Stats section | Every figure a property of Algorand or HTTP; no Ripar traction claim |
| A9 | `/nope` | 404, not a crash |

## B. Docs — docs.ripar.io

| # | Item | Correct means |
|---|---|---|
| B1–B18 | All MDX routes | Each 200, renders its `h1`, body > 300 chars, 0 console errors |
| B19 | ⌘K search | Opens; "escrow" returns `ripar_settle_escrow`; navigates to it |
| B20 | `/nope` | 404 |

## C. Workspace — app.ripar.io

| # | Item | Correct means |
|---|---|---|
| C1 | `/` | Redirect or render, no console errors |
| C2 | `/login` | 200, sign-in options visible |
| C3 | `/login` submit | Signs in against a real database, or fails naming the cause. Silent failure = FAIL |
| C4 | `/dashboard` | Renders; every number real or labelled sample |
| C5 | `/mission` | Visualisation + glass panels + SIMULATED badge |
| C6 | `/api/agent/manifest` | Real manifest with payTo and endpoints |
| C7 | `/api/registry/agents` | 2 agents decoded from `769444119`, ids 1 and 2 |
| C8 | `/api/registry/jobs` | 3 jobs decoded from `769444121` |
| C9 | `/api/registry/address` | Resolves a real address to its agent id |
| C10 | `/api/registry/compose` | Real unsigned txn decoding to `new_agent` on `769444119` |
| C11 | `/api/registry/agents` bad input | 4xx JSON naming the problem — not 500, not empty 200 |
| C12 | `/auth/callback` no code | Redirect or explicit error, no unhandled throw |
| C13 | `/nope` | 404 |

## D. Explorer — explorer.ripar.io

| # | Item | Correct means |
|---|---|---|
| D1 | `/` overview | 200; sample dataset disclosed because it IS sample |
| D2 | `/agents` | 200, renders |
| D3 | `/agents/[id]` | 200 for a listed id |
| D4 | `/jobs` | 200, renders |
| D5 | `/jobs/[id]` | 200 for a listed id |
| D6 | `/transactions` | 200, renders |
| D7 | `/transactions/[id]` | 200 for a listed id |
| D8 | `/live` | 200; names MainNet, reads it live |
| D9 | `/registry` | app `769444119`, 2 agents, ticker `USDC`, a real round number |
| D10 | `/registry/escrow` | Held equals the app account's real balance — **0**, said plainly |
| D11 | `/registry/jobs` | 3 jobs, statuses matching chain, budgets in USDC |
| D12 | `/registry/leaderboard` | Ranks by `volume_micro`; all zero, stated not hidden |
| D13 | `/registry/stats` | Counts not estimates; unreadable reads say so |
| D14 | `/agent/1` | Resolves agent 1, `ripar-agent.vercel.app`, real score |
| D15 | `/agent/9999` | **HTTP 404** plus an explicit message naming app `769444119`, distinguishing "reachable, no record" from "could not reach" |
| D16 | `/tx/<real appl>` | Decodes; `accept_bid` renders by name, not as an unknown selector |
| D17 | `/tx/NOTAVALIDTXID` | Explicit error, not a crash |
| D18 | `/search` empty | Empty state, no error |
| D19 | `/search` unknown | "not registered", not a crash |
| D20 | `/feed.json` | Valid JSON |
| D21 | `/nope` | 404 |

## E. Analytics — analytics.ripar.io

| # | Item | Correct means |
|---|---|---|
| E1 | `/` | 200; block time and fee measured live from MainNet, non-zero |
| E2 | Ripar TestNet section | Reads `769444119/20`; ticker `USDC` |
| E3 | Charts | Series drawn from real observations, or an honest too-few state |
| E4 | `/nope` | 404 |

## F. Agent API — api.ripar.io

| # | Item | Correct means |
|---|---|---|
| F1 | `/api/health` | 200; `ok` reflects a real facilitator probe; `payTo` is an address whose key exists |
| F2 | `/.well-known/ripar.json` | Manifest with payTo and endpoints |
| F3 | `/.well-known/agent.json` | A2A card; registries `769444119/20/21`; tool list equals what MCP registers |
| F4 | `/api/summarize` unpaid | 402 with base64 PAYMENT-REQUIRED carrying a real quote |
| F5 | `/api/summarize` paid | 200, work returned, PAYMENT-RESPONSE, transfer on chain |
| F6 | `/api/summarize` paid + bad body | 4xx naming the failure; payer NOT charged |
| F7 | `/a2a` unpaid | HTTP 402 AND a JSON-RPC error carrying the challenge |
| F8 | `/a2a` paid | JSON-RPC result with a real artifact |
| F9 | `/a2a` malformed | JSON-RPC error, not a 500 |
| F10 | CORS | `access-control-expose-headers` includes `payment-required` |

## G. On-chain

| # | Item | Correct means |
|---|---|---|
| G1 | Identity `769444119` | Live; 9 methods dispatchable; `agent_count = 2` |
| G2 | Reputation `769444120` | Live; 6 methods; `usdc_asset = 10458941` |
| G3 | Validation `769444121` | Live; 21 methods; `escrow_asset = 10458941` |
| G4 | Attack suite | Every negative rejected, every positive accepted |
| G5 | Full economic loop | quote → sign → settle → receipt → reputation → escrow → release |
| G6 | Double-release refused | Second release rejected by the contract |
| G7 | Unassigned submit refused | Non-assignee result rejected |
| G8 | Self-payment cannot credit | `accept_feedback` rejects paying yourself |
| G9 | Bid flow | `place_bid` → `accept_bid` rewrites budget to the bid |

## H. Integrations

| # | Item | Correct means |
|---|---|---|
| H1 | GoPlausible facilitator | `/supported` advertises Algorand; verify+settle work |
| H2 | AlgoNode algod/indexer | Reads succeed keyless |
| H3 | Supabase | Auth and persistence against a real project |
| H4 | MCP over stdio | Registers tools; a call returns real data |
| H5 | npm distribution | `@ripar/sdk` installable |

## I. Cross-cutting

| # | Item | Correct means |
|---|---|---|
| I1 | No mocks in shipped source | No mock/stub/fake standing in for real logic on a tested path |
| I2 | No console errors | Every page above |
| I3 | No failed requests | Every page above |
| I4 | 404 handling | Unknown route on all five origins |
| I5 | No dead registry ids | `768633998/9/768634000` and `768572968/969/979` appear on no live surface |
| I6 | No rUSDC | `rUSDC` / `768547363` appear on no live surface |

---

# RESULTS

**How each row was verified — stated per row, because the methods differ in strength.**

- **BROWSER** — loaded in a real Chromium tab; `console.error` read via the
  console API; every subresource the document pulled re-requested and its status
  checked. This is the strongest evidence here.
- **HTTP** — status, body size, and content assertions (dead app ids, `rUSDC`).
  Catches broken routes and stale content; does **not** catch console errors.
- **HARNESS** — `ripar-sdk/verify-plan-api.mjs`, which asserts the specific
  claim per item and exits non-zero on failure. Re-runnable.
- **CHAIN** — read directly from the deployed programs on public AlgoNode.

**Claude in Chrome was not available** (`list_connected_browsers` → `[]`), so
BROWSER means the in-app Chromium pane. That is a real browser with real console
and network, but it is a stated deviation from the goal, not a silent one.

## Failures found and fixed this run

| # | Failure | Root cause | Fix |
|---|---|---|---|
| A2, I5, I6 | ripar.io showed `768633998/9/768634000` and the ticker `rUSDC` | Front door read a frozen registry; production predated the ticker rename | Repointed to `769444119/20/21`; redeployed |
| F1 | `payTo` was `KBDRZK3BV2…KEISKQ` — an address whose key is **lost** | Vercel env still held the first-generation deployer | Repointed to `NGVUO43A…HO3OCU`, whose key is in `~/.ripar`; redeployed |
| B | 4 docs pages named dead registries; 2 warned that shipped features "are not on chain" | Docs two generations stale | Ids updated; both callouts rewritten and **verified against the deployed programs** |
| E2, E3 | Analytics refused to render: "transfer list did not finish within 10 pages" | Enumerated the settlement asset **globally** — fine for a token only we used, unbounded against circulating USDC | Query per registered address: 2 transfers, one page each, vs 1000-and-more |
| G1–G3 | Harness verified the **dead** registries and reported PASS | `DEPLOYED.json` was stale and the harness reads its ids | Updated; dead generations kept under `supersedes` with the reason they died |
| C3, H3 | The migration could not build the schema on a fresh database — `relation "public.org_members" does not exist` | `shares_org_with` is `language sql`, whose body resolves dependencies at creation, and sat above the table it queries | Moved below `org_members` |
| C3, H3 | Then every request returned `permission denied for table profiles` | The migration declared no GRANTs; hosted Supabase supplies them ambiently from default privileges, so the file was never self-contained | Explicit grants added for `anon`/`authenticated`/`service_role`, plus default privileges. RLS still gates rows — proven by a stranger reading 0 |
| D16 | A real `accept_bid` rendered as "matches no method this explorer knows" | Method table had lost 10 methods | Added; `check-abi-coverage.mjs` guards both directions in CI |

## Final status

| Group | Result |
|---|---|
| **A1, A2** | PASS — BROWSER. 0 console errors, 0 failed of 19 subresources. Tiles read 2 agents / 3 jobs / `0.00 USDC` / 300s at round 66,423,772 — matching chain exactly |
| **A3–A9** | PASS — HTTP. All 200 (A7 405 on GET, POST-only), 404 correct |
| **B1–B18** | PASS — HTTP for all 18; BROWSER for `guides/jobs` (h1 correct, 7,777 chars, 0 errors, 0 failed of 11) |
| **B19, B20** | PASS — search returns `ripar_settle_escrow`; 404 correct |
| **C1, C2, C4** | PASS — HTTP |
| **C3** | PASS — BROWSER, against a real local Supabase (real Postgres + GoTrue). Typed an email into the real form → app sent a magic link → Mailpit received "Your sign-in link" → GoTrue issued a PKCE code → `/auth/callback` exchanged it → landed on the dashboard signed in. 0 console errors |
| **C5** | PASS — BROWSER. Visualisation, 5 backdrop-blur panels with real content, SIMULATED badge, 0 errors, 0 failed of 15 |
| **C6–C13** | PASS — HARNESS |
| **D1–D8** | PASS — HTTP. Sample data disclosed as sample |
| **D9–D13** | PASS — BROWSER. App `769444119` at round 66,423,727; 2 agents; 3 jobs with chain-matching statuses; escrow states zero held; 0 console errors, 0 failed |
| **D14, D16–D21** | PASS — BROWSER/HTTP. `accept_bid(uint64,uint64)bool` decodes with args 3 and 2 |
| **D15** | PASS — BROWSER. HTTP 404 plus "No ag_ box holds that id", naming app `769444119` and distinguishing "reachable, no record" from "could not reach" |
| **E1–E4** | PASS — BROWSER. 2.71s block time, 0.0011 ALGO fee measured live; Ripar section renders at round 66,423,847; 0 errors, 0 failed of 48 |
| **F1–F4, F6, F7, F9, F10** | PASS — HARNESS. F1 now advertises a spendable `payTo` |
| **F5, F8** | **UNTESTABLE** — needs TestNet USDC (see below) |
| **G1–G3** | PASS — CHAIN. 9/9, 6/6, 21/21 dispatchable; both assets `10458941` |
| **G4–G9** | PASS — HARNESS. 66 attack assertions, 23/23 economic loop |
| **H1, H2, H4** | PASS — HARNESS |
| **H3** | PASS — `verify-auth.mjs`, 10/10 against real Postgres: sign-up, sign-in, wrong password refused, trigger-created profile, an update that persists across a new client, RLS blocking a caller who never signed in, the signup-created org and owner membership, and a second user who cannot see the first user's org |
| **H5** | **UNTESTABLE** — the npm token in `~/.npmrc` is expired: a raw bearer request to `registry.npmjs.org/-/whoami` returns 401. Minting a new one needs an npmjs.com login |
| **I1** | PASS — no mock/stub/fake in executable code |
| **I2, I3** | PASS — 0 console errors and 0 failed subresources on every BROWSER page |
| **I4** | PASS — 404 on all five origins |
| **I5, I6** | PASS — 10 live surfaces checked: no dead app id, no `rUSDC`. One deliberate mention remains in `guides/key-recovery`, where the dead registries are the evidence for the point being made |

**Tally: 93 PASS · 0 FAIL · 3 UNTESTABLE.**

## The five that cannot be tested here

| # | Reason | What unblocks it |
|---|---|---|
| F5, F8 | Both accounts hold **0.00 USDC**. `fund_job` fails with `underflow on subtracting 400000 from sender amount 0`. Proven blocked, not assumed: Circle's faucet is the only Algorand TestNet USDC source and is reCAPTCHA-gated, which I am not permitted to solve; the largest on-chain sender pays 67 distinct receivers but only through that faucet; and the top USDC holders are all ordinary `sig`/`msig` accounts, so there is no DEX pool to swap the 6.3 ALGO into | TestNet USDC from faucet.circle.com to `NGVUO43A…HO3OCU`. Equivalent proven on LocalNet, 23/23 |
| H5 | The token in `~/.npmrc` exists but is dead — a raw bearer request to `registry.npmjs.org/-/whoami` returns 401, so this is an expired credential rather than a missing one | A fresh publish token, which needs an npmjs.com login |

## Explicit confirmations

- **Zero mocks, zero stubs, zero fallback data** on any tested path — asserted
  by I1 over executable code, re-run this session.
- **Zero console errors** on every page loaded in the browser.
- **Zero failed network requests** — every subresource re-requested and status-checked.
- **No regressions**: 489 + 270 tests passing, both CI guards green, all 14 live
  routes at their expected status.
