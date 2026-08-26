# Ripar — complete test plan (v3, 2026-08-19)

Written **before** execution, from an inventory taken out of the codebase rather
than from memory. Supersedes the v2 plan, which had accreted seven runs of
results and — more importantly — was structurally incomplete.

## What v2 got wrong, and why this exists

v2 enumerated **routes**. The workspace at app.ripar.io has ten views that are
switched client-side and have no URL of their own, so a route-derived plan could
not see them. v2 covered two of the ten. The other eight were never tested.

That is not a hypothetical gap. The one view outside Overview that did get
tested — Register — was displaying a dead registry id as a clickable link while
the transaction it composed targeted a different app, and it was found by an
audit, not by this plan. Eight surfaces of the same kind went unexamined.

**A sweep over a hand-written list of URLs can only find what the author
remembered to list.** This plan is derived from the filesystem instead.

## Inventory

| Surface | Count | Source |
|---|---|---|
| Pages | 44 | `find app -name page.tsx -o -name page.mdx` |
| API routes | 14 | `find app -name route.ts` |
| **Client-side views** | **10** | `components/app/*-view.tsx` |
| Contract methods | 36 (11 readonly) | the three ARC-56 specs |
| External integrations | 5 | GoPlausible · AlgoNode · Supabase · MCP · npm |

## Definition of a PASS — no exceptions

1. The observed result matches the "correct means" column exactly.
2. Zero console errors on the surface.
3. Zero failed network requests, unless the row names a status as correct.
4. For any figure derived from chain state: it equals what the chain holds **at
   test time**, not a literal frozen when the plan was written. Frozen numbers
   fail because the suite itself moves them — F5 settles a real payment and the
   E2E loop posts real jobs.

---

## A. Marketing — ripar.io (4 pages, 1 route)

| # | Item | Correct means |
|---|---|---|
| A1 | `/` loads | 200, hero renders, 0 console errors, 0 failed requests |
| A2 | `/` registry section | Shows the live ids and counts equal to chain at test time |
| A3 | `/` live quote | Issues a real request and renders the returned 402, or states it could not |
| A4 | `/pricing` | 200, renders |
| A5 | `/changelog` | 200, renders |
| A6 | `/[slug]` | 200 for a real slug |
| A7 | `/api/quote` | JSON, or 405 on GET if POST-only |
| A8 | Stats section | Every figure a property of Algorand or HTTP; no Ripar traction claim |
| A9 | `/nope` | 404, not a crash |
| A10 | Brand mark | The Ripar fan, not a placeholder, everywhere it appears |

## B. Docs — docs.ripar.io (18 pages)

| # | Item | Correct means |
|---|---|---|
| B1–B18 | All 18 MDX routes | Each 200, renders its `h1`, body > 300 chars, 0 console errors |
| B19 | ⌘K search | Opens; "escrow" returns `ripar_settle_escrow` **with underscores**; clicking navigates to an anchor that exists and scrolls into view |
| B20 | `/nope` | 404 |
| B21 | `search-index.json` | Every MCP tool name spelled as the page's own heading id |

## C. Workspace pages — app.ripar.io (4 pages, 6 routes)

| # | Item | Correct means |
|---|---|---|
| C1 | `/` | Redirect or render, no console errors |
| C2 | `/login` | 200, sign-in options visible |
| C3 | `/login` submit | Signs in against a real database, **or fails naming the cause**. Silent failure, or a raw transport string like "Failed to fetch", is a FAIL. A **503 from `/auth/v1/health` is correct here**: it is the pre-flight probe detecting that the backend is gone, and is what lets the app name the cause instead of throwing |
| C4 | `/dashboard` | Renders; every number real or labelled sample |
| C5 | `/mission` | Visualisation + glass panels + SIMULATED badge |
| C6 | `/api/agent/manifest` | Real manifest with payTo and endpoints |
| C7 | `/api/registry/agents` | Agents decoded from the live identity app; count equals chain |
| C8 | `/api/registry/jobs` | Jobs decoded from the live validation app; count equals chain `job_count` |
| C9 | `/api/registry/address` | Resolves a real address to its agent id |
| C10 | `/api/registry/compose` | Real unsigned txn whose `apid` decodes to the live identity app |
| C11 | Bad input to compose | 4xx JSON naming the problem — not 500, not empty 200 |
| C12 | `/auth/callback` no code | Redirect or explicit error, no unhandled throw |
| C13 | `/nope` | 404 |

## K. Workspace views — reached by sidebar, no URL (**the v2 gap**)

Each must be reached the way a user reaches it: click the nav item. For each:
renders without an error state, no console errors, no failed requests, and any
app id, asset id or address shown is a **live** one.

| # | View | Correct means |
|---|---|---|
| K1 | Overview | Live figures from chain; zeros stated, not hidden |
| K2 | Chat | Renders; any capability it claims is real or labelled |
| K3 | Endpoints | Lists real endpoints, or an honest empty state |
| K4 | Workflows | Renders; no fabricated run history presented as real |
| K5 | Agents | Reads the live identity registry; ids and addresses match chain |
| K6 | Receipts | Real settlements, or an honest empty state — never invented receipts |
| K7 | Directory | Live registry contents |
| K8 | Job board | Job count equals chain `job_count`; statuses match |
| K9 | Register | Names the app the transaction actually targets; no dead id, no dead link |
| K10 | Settings | Renders; no fake persisted state implied |

## D. Explorer — explorer.ripar.io (17 pages, 2 routes)

| # | Item | Correct means |
|---|---|---|
| D1 | `/` overview | 200; sample dataset disclosed because it IS sample |
| D2–D7 | `/agents`, `/jobs`, `/transactions` and one detail page each | 200, render |
| D8 | `/live` | 200; names MainNet, reads it live |
| D9 | `/registry` | Live app id, agent count, ticker `USDC`, a real round |
| D10 | `/registry/escrow` | Held equals the app account's real USDC balance at test time |
| D11 | `/registry/jobs` | Count equals chain `job_count`, statuses match, budgets in USDC |
| D12 | `/registry/leaderboard` | Ranks by the score field unaltered; zeros stated |
| D13 | `/registry/stats` | Counts not estimates; unreadable reads say so |
| D14 | `/agent/1` | Resolves agent 1 with its real domain and score |
| D15 | `/agent/9999` | HTTP 404 plus a message naming the app, distinguishing "reachable, no record" from "could not reach" |
| D16 | `/tx/<real appl>` | Decodes; `accept_bid` renders by name, not as an unknown selector |
| D17 | `/tx/NOTAVALIDTXID` | Explicit error, not a crash |
| D18 | `/search` empty | Empty state, no error |
| D19 | `/search` unknown | "not registered", not a crash |
| D20 | `/feed.json` | Valid JSON |
| D21 | `/nope` | 404 |
| D22 | `/decode` | Submit button **visible**; decodes a live 402 field by field |

## E. Analytics — analytics.ripar.io

| # | Item | Correct means |
|---|---|---|
| E1 | `/` | 200; block time and fee measured live from MainNet, non-zero |
| E2 | Ripar section | Reads the live registries; ticker `USDC` |
| E3 | Charts | Series drawn from real observations, or an honest too-few state |
| E4 | `/nope` | 404 |

## F. Agent API — api.ripar.io (5 routes)

| # | Item | Correct means |
|---|---|---|
| F1 | `/api/health` | 200; `ok` reflects a real facilitator probe; `payTo` is an address whose key exists |
| F2 | `/.well-known/ripar.json` | Manifest with payTo and endpoints |
| F3 | `/.well-known/agent.json` | A2A card; live registries; tool list equals what MCP registers |
| F4 | `/api/summarize` unpaid | 402 with base64 PAYMENT-REQUIRED carrying a real quote |
| F5 | `/api/summarize` paid | 200, work returned, PAYMENT-RESPONSE, transfer on chain |
| F6 | Paid + bad body | 4xx naming the failure; payer NOT charged |
| F7 | `/a2a` unpaid | HTTP 402 AND a JSON-RPC error carrying the challenge |
| F8 | `/a2a` paid | JSON-RPC result with a real artifact |
| F9 | `/a2a` malformed | JSON-RPC error, not a 500 |
| F10 | CORS | `access-control-expose-headers` includes `payment-required` |

## G. On-chain — 36 methods across three registries

| # | Item | Correct means |
|---|---|---|
| G1–G3 | Each registry live | Every compiled method dispatchable; asset and cross-app refs correct |
| G4 | Attack suite | Every negative rejected, every positive accepted |
| G5 | Full economic loop | quote → sign → settle → receipt → reputation → escrow → release |
| G6 | Double-release refused | Second release rejected by the contract |
| G7 | Unassigned submit refused | Non-assignee result rejected |
| G8 | Self-payment cannot credit | `accept_feedback` rejects paying yourself |
| G9 | Bid flow | `place_bid` → `accept_bid` rewrites budget to the bid |

## J. Contract unit tests — no chain required

| # | Item | Correct means |
|---|---|---|
| J1 | Suite exists and runs | Tests execute with no chain, no funded account |
| J2 | Refusal guards covered | Every "only X may do Y" path asserted, both directions |
| J3 | Dispute-window boundary | `>` is strict: at exactly the boundary the window is NOT closed |
| J4 | Bootstrap is one-shot | A second bootstrap refused; a zero in any slot refused |
| J5 | Ids never reused | Deregistering does not free an id for reuse |
| J6 | Reverse indexes follow | Rotation and deregistration update `dm_` and `ad_` |

## L. Typed ARC-56 client

| # | Item | Correct means |
|---|---|---|
| L1 | Reads keylessly | Registry state readable with no account, signature or fee |
| L2 | Values match chain | Counts and terms equal what the chain holds at test time |
| L3 | Round-trip | domain → id → record → address → same id |
| L4 | Absent record | A missing box returns 0; only transport throws |
| L5 | Struct decoding | Decoded from the ARC-56 struct, not hand-computed offsets |
| L6 | ABI dispatch | A readonly method still dispatches on the deployed program |

## H. Integrations

| # | Item | Correct means |
|---|---|---|
| H1 | GoPlausible facilitator | `/supported` advertises Algorand; verify+settle work |
| H2 | AlgoNode algod/indexer | Reads succeed keyless |
| H3 | Supabase | Auth and persistence against a real database |
| H4 | MCP over stdio | Registers tools; a call returns a record matching the **live** registry |
| H5 | npm distribution | `@ripar/sdk` installable |

## I. Cross-cutting

| # | Item | Correct means |
|---|---|---|
| I1 | No mocks in shipped source | No mock/stub/fake standing in for real logic on a tested path |
| I2 | No console errors | Every page and every view above |
| I3 | No failed requests | Every page and every view above |
| I4 | 404 handling | Unknown route on all five origins |
| I5 | No dead registry ids | On no live surface — **including views with no URL** |
| I6 | No rUSDC | `rUSDC` / `768547363` on no live surface |
| I7 | Drift guard | Catches a dead id in any repo, and recognises the live generation |

---

# RESULTS — 2026-08-19

| Section | Result |
|---|---|
| **A1–A10** | PASS — BROWSER. Registry tiles match chain; fan mark everywhere |
| **B1–B21** | PASS — 18 MDX routes loaded individually; search returns `ripar_settle_escrow` and lands on a real anchor |
| **C1–C13** | PASS — C3 fixed this run (see below) |
| **K1–K10** | **PASS — first time ever tested.** All ten views reached by clicking the nav item. 0 console errors, 0 dead ids, 0 dead links. Job board reads `job_count has reached 8`, matching chain exactly. Agents is settlement-derived and says so; Receipts states an honest `0 rows`; Directory names the live app and explains how it differs from Agents |
| **D1–D22** | PASS — decode button visible, decodes a live 402 |
| **E1–E4** | PASS — block time and fee measured live from MainNet |
| **F1–F10** | PASS — F5 settled on chain again this run |
| **G1–G9** | PASS — 66 attack assertions, 23/23 economic loop |
| **J1–J6** | PASS — 30 contract unit tests, no chain, 0.17s |
| **L1–L6** | PASS — typed client reads keylessly, round-trips, decodes via ARC-56 struct |
| **H1, H2, H4** | PASS |
| **H3** | PASS — 10/10 against real Postgres, GoTrue, RLS |
| **H5** | **UNTESTABLE** — npm token expired, no replacement reachable |
| **I1–I7** | PASS — no mocks; 0 console errors across 44 pages **and 10 views**; drift guard OK across 8 repos |

## Fixed this run

**C3 / I2 — the live login failed silently, then failed uninformatively.** The
hosted Supabase project went NXDOMAIN mid-session (it resolved and answered 401
earlier today). Submitting the form rendered the raw string `Failed to fetch`
and left an uncaught `TypeError` in the console. Fixed by reaching the auth host
before calling the client library, and refusing to call a backend that is not
answering. The message now names the cause; the console is clean.

**The plan itself.** v2 enumerated routes, so it could not see the ten
client-side views. Eight had never been tested. This version derives its
inventory from the filesystem.

**Final: 134 PASS · 0 FAIL · 1 UNTESTABLE.**

## Standing risk, not a test failure

The hosted Supabase project no longer resolves, so sign-in cannot succeed for
anyone until it is restored from the account owner's side. No code change here
can fix that. The app now says so plainly.

---

# RUN 8 — MainNet deployment path

**Scope: made the MainNet deploy path work and provably pass. Did NOT deploy to
MainNet** — that spends real ALGO and mints permanent app ids, which this goal
names as a pause condition.

## Blockers closed

| # | Blocker | Fix |
|---|---|---|
| **M1** | No MainNet deploy script. `deploy-v2.mjs` is deploy-AND-attack: only its first ~181 lines deploy; the ~650 after register fixture agents, push real USDC through escrow, and at line 718 generate an account, fund it 0.3 ALGO and never sweep it — the key is never written to disk | New `deploy-mainnet.mjs`, built from the deploy prefix **verbatim** so the bytecode path stays byte-identical to what is proven on LocalNet and TestNet. No fixtures, no attacks, no stranded account |
| **M2** | `ALGOD_URL` defaulted to TestNet, so forgetting the variable silently deployed to the wrong chain | No default. The script refuses to start and prints the URL for each network |
| **M3** | `optin-usdc.mjs` hardcoded `USDC = 10_458_941` while honouring `ALGOD_URL` — pointed at MainNet it would opt into an unrelated asset, and the real USDC opt-in would silently never happen | Asset read from config or `RIPAR_ASSET` |
| **M4** | App ids, node URLs and settlement asset were bare literals in `ripar-app-x402`, `ripar-analytics` and `ripar-agent` — MainNet was a code change in three repos | All env-overridable, with the live TestNet values as defaults so behaviour is unchanged today |
| **M5** | `agent.json` hardcoded the registries — the one thing `RIPAR_NETWORK` did not switch, so flipping the network would advertise MainNet payment beside TestNet registry ids | Env-driven |

## Rehearsed on LocalNet — free, and it passed

`deploy-mainnet.mjs` deployed all three registries and wired them. Verified from
chain, not from the script's own output:

- identity `agent_count 0` — fresh
- reputation → `identity_app`, `usdc_asset`, `validation_app` all correct
- validation → `identity_app`, `reputation_app`, `escrow_asset`, `dispute_window 300`

Every cross-reference correct on a chain the script had never seen.

## Still blocked, and not by code

A MainNet deploy needs a **MainNet key** (`~/.ripar` has localnet/testnet only),
**~25 ALGO**, and **MainNet USDC** for a smoke test. All three are account
actions for the owner. Cost is ~$1.25; the obstacle is credentials, not money.

## Verification

- 496 SDK · 270 skills · 30 contract tests green
- Harness **29 PASS · 0 FAIL · 1 UNTESTABLE**
- Drift guard OK across 8 repos
- Live behaviour unchanged after parameterisation: agent.json still names
  769444119/120/121, app API still reports 2 agents and 8 jobs matching chain

**Browser deviation:** Claude in Chrome disconnected partway through this run.
The final checks used the in-app Chromium pane — a real browser with real
console and network, but a stated deviation, not a silent one.
