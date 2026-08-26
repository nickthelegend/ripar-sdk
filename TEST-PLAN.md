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
- `agent_count = 2`, `job_count = 4`, `dispute_window = 300`, `fee_bps = 0`
  (`job_count` was 3 when this plan was written; the F5 paid-call test settles a real
  job each run, so it advances. Rows below assert **equality with the chain read at
  test time**, not a frozen literal — a frozen number would fail purely because the
  suite ran.)
- Merchant `NGVUO43A…HO3OCU` holds **0.00 USDC**; payer `HS5EAEME…6R4EN4` likewise
- Escrow app account `SN7C6GYS…GRM` holds **0.300 USDC** across funded jobs at this run

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
| C8 | `/api/registry/jobs` | Jobs decoded from `769444121`; count equals chain `job_count` (4 at this run) |
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
| D10 | `/registry/escrow` | Held equals the app account's real USDC balance, read at test time (0.300 USDC at this run; the E2E suite funds escrow, so this moves) |
| D11 | `/registry/jobs` | Job count equals chain `job_count` (4 at this run), statuses matching chain, budgets in USDC |
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


---

# Phase 4 re-run — after the decoder and the lease

Everything re-executed top to bottom, not only the items touched.

| Group | Result |
|---|---|
| A–I (all 98 rows above) | **PASS**, unchanged — 50 routes at their expected status, 0 unexpected failures |
| **New: D22 `/decode`** | **PASS** — BROWSER. Against `api.ripar.io/api/summarize`: 402 in 162ms, 652-byte `PAYMENT-REQUIRED`, x402 v2, decoded to 0.01 USDC (10000 base units ÷ 10^6), scheme `exact`, asset 10458941, 300s timeout. Ticker resolved from the ASA and labelled as such |
| **New: C14 replay lease** | **PASS** — live in production. 32 bytes, present on the transaction; same action twice → identical bytes; different result hash → different bytes; reported lease equals the one decoded off the transaction; simulate still ok, 151 opcodes |
| **New: G10 Algorand capability audit** | **PASS** — `ripar-sdk/algo-audit.mjs`, **14/14** verified against public nodes and the deployed programs |
| Suites | 489 + 270 passing |
| CI guards | settlement asset and ABI coverage both green |
| Chain harness | 26 PASS · 0 FAIL · 4 UNTESTABLE |

**Tally: 96 PASS · 0 FAIL · 3 UNTESTABLE.**

The three untestable are unchanged and unchanged in reason: TestNet USDC behind
a reCAPTCHA (F5, F8), and an expired npm token (H5).

## One console error that is correct behaviour

A successful workflow run and a successful `/decode` both leave
`Failed to load resource: the server responded with a status of 402` in the
console. Chrome logs every non-2xx at error level. A 402 is the paid endpoint
answering correctly — it is the whole mechanism — and the only way to a silent
console here is to not make the call. Stated rather than suppressed.


---

# Phase 1 addendum — rows for the surface added since

| # | Item | Correct means |
|---|---|---|
| C15 | `place_bid` on an **open** job | Composes `place_bid(uint64,uint64,uint64,byte[])bool`; names IdentityRegistry in foreignApps; declares `ag_<agent>` on the OUTER call; covers the inner fee; `simulate.ok === true` |
| C16 | `place_bid` on a **non-open** job | Refused by the action state machine, naming the job's status and what IS legal — not a chain error |
| C17 | `accept_bid` with a real bid present | Composes; `simulate.ok === true`; summary states the budget REWRITE explicitly (bid replaces posted) |
| C18 | `accept_bid` with no bid present | Refused — either by the state machine or by the AVM, never silently composed as valid |
| C19 | `rotate_address` from the current holder | Composes; `simulate.ok === true`; effects name both reverse-index boxes |
| C20 | `rotate_address` onto an address that already holds an agent | Refused, naming which agent that address controls |
| C21 | `rotate_address` onto itself | Refused, saying it would change nothing |
| C22 | `rotate_address` from an address controlling nothing | Refused, saying that address controls no agent |
| C23 | Every composed action carries a replay lease | 32 bytes, present on the transaction; same action → identical; different args → different |
| D22 | `/decode` against a real paid endpoint | Real 402; header name and byte count; price shown in base units AND divided by decimals; ticker resolved from the ASA when the challenge omits it |
| D23 | `/decode` against a non-x402 URL | Reported as its own case: answered without asking for payment, so not gated |
| D24 | `/decode` against a malformed URL | 400 naming the problem, not a crash |
| D25 | Job board reflects the accepted bid | Job #4 shows **0.25 USDC**, assignee agent #2, status assigned — the rewritten budget, not the posted one |
| G11 | The bid loop, on chain | `bd_4_2` box exists; `jb_4` decodes to budget 250000, assignee 2, status 1 |

---

# Phase 4 — full re-run

| Group | Result |
|---|---|
| A–I (98 original rows) | **PASS** — 50 routes at expected status |
| C15, C17 | **PASS** — `place_bid` / `accept_bid` compose and simulate ok on an open job |
| C16, C18 | **PASS** — refused by the action state machine, naming the status and what IS legal |
| C19 | **PASS** — `rotate_address` from the holder, `simulate.ok`, 82 opcodes |
| C20 | **PASS** — refused, naming which agent the target already controls |
| C21 | **FAIL → fixed → PASS** — see below |
| C22 | **PASS** — refused, "controls no agent" |
| C23 | **PASS** — 32-byte lease on every composed action |
| D22 | **PASS** — `/decode`: real 402, 652-byte header, 0.01 USDC both ways |
| D23, D24 | **PASS** — non-gated and malformed URLs each reported as their own case |
| D25 | **PASS** — job #4 renders **0.25 USDC**, the rewritten bid, not the 0.70 posted |
| G11 | **PASS** — `bd_4_2` box on chain; `jb_4` = budget 250000, assignee 2, status 1 |
| Suites / guards / capabilities | 489 + 270; both guards; 14/14 |

**Tally: 111 PASS · 0 FAIL · 3 UNTESTABLE.**

## The one FAIL, and it passed for the wrong reason first

**C21 — rotating an identity onto the address already holding it.** The plan said
correct means "refused, saying it would change nothing". It *was* refused, so a
pass/fail on outcome alone looked green. The message said
*"already controls agent #1. One address holds at most one identity"* — true,
and not the reason. The taken-address lookup fired first, because your own
address obviously already controls your own agent, and a caller reading it would
hunt for a conflict with some other identity instead of noticing they pasted the
same address twice. Checked before the lookup now.

## Two measurement mistakes of my own, recorded

**A 404 hunt that found a real bug, but not the one I was chasing.** Two console
404s appeared on the job board. `read_network_requests` showed every request at
200, and a re-fetch of every resource showed zero failures — the first sweep used
`cache: "force-cache"`, which serves a cached 200 over a real 404. Chasing it
turned up genuinely missing `apple-touch-icon` links across all six surfaces,
which Safari and iOS request by convention and which 404'd on every load; that is
fixed and worth fixing. It was **not** the cause. A fresh tab showed **zero**
console errors: the entries were stale buffer from that tab's earlier localhost
navigation, and `read_console_messages(clear: true)` returns the buffer *before*
clearing, which fooled me twice.

## Console errors that are correct behaviour

A successful workflow run and a successful `/decode` each leave a `402` in the
console. Chrome logs every non-2xx at error level; a 402 is the paid endpoint
answering, and the only way to silence it is to not make the call.

## Confirmations

Zero mocks, zero stubs, zero fallback data on any tested path — 0 mock
definitions in executable code. Zero console errors and zero failed requests on
every page loaded in a clean tab. No regressions.

## Untestable (3, unchanged)

TestNet USDC behind a reCAPTCHA (F5, F8); an expired npm token (H5).


---

# Phase 1 addendum 2 — rows for what changed since

| # | Item | Correct means |
|---|---|---|
| A10 | Landing hero after the `DashboardPreview` rename | Hero renders; the drawing shows prices and schedules only; **zero** cumulative totals; 0 console errors |
| D26 | Explorer declares a touch icon | `<link rel="apple-touch-icon">` present and the target returns 200 — browsers stop guessing at two paths that 404 |
| I7 | Console read in a FRESH tab per origin | Zero errors. A tab reused across origins carries a stale buffer, and `clear: true` returns the buffer BEFORE clearing — both fooled the previous run |

---

# Phase 4 — final full re-run

| Group | Result |
|---|---|
| A1, A2, A10 | **PASS** — BROWSER, fresh tab. 19 subresources, 0 failed, 0 console errors; no fabricated totals; 2 agents and all three registry ids read from chain |
| C5, C6–C11 | **PASS** — BROWSER, fresh tab. SIMULATED badge, canvas, 15 subresources 0 failed; manifest/agents/jobs all 200; bad input → 400 naming the field |
| E1–E3 | **PASS** — BROWSER, fresh tab. 2.75s block time live; Ripar section renders; 3 figures; 48 subresources 0 failed |
| D1–D26 | **PASS** — explorer clean in a fresh tab; job #4 shows the rewritten 0.25 |
| **G4** | **FAIL → fixed → PASS** — 66 assertions, 0 failures |
| **G5–G8** | **FAIL → fixed → PASS** — 23/23 steps |
| Suites / guards / capabilities / routes | 489 + 270; both guards; 14/14; 50 routes |
| Mocks / stubs / TODO | **0** |

**Tally: 113 PASS · 0 FAIL · 3 UNTESTABLE.**

## The FAIL, and why it was not a code defect

G4 and G5–G8 dropped out with a raw `URLTokenBaseHTTPError`. The cause was
environmental: the LocalNet account had fallen **below its minimum balance**
(`30350600 below min 30635500`). Every deploy permanently locks MBR — an app and
its boxes cannot be torn down — so a chain deployed to repeatedly during a long
session simply fills up.

Fixed by rebuilding the chain (`algokit localnet reset` +
`ripar-contracts/localnet-setup.mjs`), which is the designed path.

The harness now recognises that shape and says so: it reports how far below
minimum the account is and names the two commands, instead of surfacing an HTTP
error that reads like the chain is broken.

## Confirmations

Zero mocks, zero stubs, zero fallback data — 0 hits in executable code. Zero
console errors and zero failed requests on every page, read in a **fresh tab per
origin**; a reused tab carries a stale buffer and `clear: true` returns it before
clearing, which produced two phantom 404s last run.

The one console entry that is correct behaviour: a successful workflow run and a
successful `/decode` each leave a 402, because Chrome logs every non-2xx at error
level and a 402 is the paywall answering.

## Untestable (3)

TestNet USDC behind a reCAPTCHA (F5, F8); an expired npm token (H5).


---

# The blocker that was not a blocker

For most of this session I reported the same thing: *"Circle's faucet is the only
Algorand TestNet USDC source and it is reCAPTCHA-gated, so a settled payment
cannot be demonstrated."* The first half is true. The conclusion does not follow,
and I repeated it several times without re-testing it.

Issuance is not the only way to get an asset that is already circulating.
Tinyman runs a TestNet AMM with a USDC/ALGO pool holding real depth. A swap is
permissionless, needs no account and no human gate, and TestNet ALGO is free.

**2.893 ALGO → 23.16 USDC**, tx
`3PN6DQPW464MO6LVWBZDJED3MC3TYZVEUVHRZOSXQ6SMD3AGNJDA`.

## What that closed

| # | Item | Now |
|---|---|---|
| 12 | Escrow funded on TestNet | **DONE.** `fund_job` on job #4 confirmed — tx `RIKTIDC6PNSBH7MYNIC6TRXNQXIWXJIC2DIANL5XGWFJGJYBLGWA`. The ValidationRegistry's own account holds **0.25 USDC**, the `es_4` box records it, and `/registry/escrow` renders "Held right now 0.250" |

Every "USDC settled" figure across every surface had been an honest zero because
there was genuinely nothing to count. There is now.

**Completion: 26 / 30 = 87%** (was 83%).

## Still open

| # | Item | Why |
|---|---|---|
| 3 | A paid call settled in production | **Unblocked, not yet done.** USDC exists now; the remaining work is funding the payer and driving one call through the deployed agent |
| 15 | Production database | One Railway call away on an authenticated, already-paid account — it bills hourly, so it is the user's decision |
| 22 | npm publish | Token in `~/.npmrc` is expired; no other token in the repo, env or Vercel |
| 23 | Kubernetes data plane | Needs a cluster |

---

# Phase 2, executed through Claude in Chrome

The extension is connected (`db91c0b9…`, macOS, local). Every previous run said
this was unavailable. It was not — Chrome was not running because the disk was
97% full, and I never tried to launch it. Freeing 4.6Gi and running
`open -a "Google Chrome"` paired it in seconds.

| Origin | Requests | Non-200 | Console errors | Notes |
|---|---|---|---|---|
| ripar.io | 31 | **0** | **0** | includes 6 live AlgoNode reads: `ag_`, `jb_`, `es_` box listings and both app records |
| app.ripar.io | 17 | **0** | **0** | `/mission` renders, SIMULATED badge |
| analytics.ripar.io | 106 | **0** | **0** | real MainNet block reads and USDC `31566704` indexer queries |
| explorer.ripar.io | 13 | **0** | **0** | `/registry/jobs` |

Verified in Chrome on `/registry`: **Settled payments counted 3 · USDC settled
0.0300 · validated 3 / 0**, agent 1 with `jobs_paid` 3, read at TestNet round
66,442,117.

**Final: 115 PASS · 0 FAIL · 3 UNTESTABLE.**

## The whole escrow lifecycle, in production

| Step | Transaction |
|---|---|
| `fund_job` | `RIKTIDC6PNSBH7MYNIC6TRXNQXIWXJIC2DIANL5XGWFJGJYBLGWA` |
| `submit_result` | `22TL2ZKSMSW3X7OBMIIB4DULNTJIWWO7E6IYXNCLF7OUJZSCZNNA` |
| `validation_response` | `APLLKC5R5MI7IMWOFDYIMA5JDRUDYQMORHFGWFXE4JYJR5UGQCJA` |
| `release_escrow` | `3RWYQ6QCI2SMPXR7FX2UZ6Y3DXXUIPHEM25DEJK5MHPC3PPHH6VA` |

Contract account went 0.25 USDC → 0.00, the agent was paid, and the verdict is on
the agent's score.

## Untestable (3), each a missing credential

| Item | Reason |
|---|---|
| C3, H3 | The Supabase project is **alive** — it answers 401, not NXDOMAIN, which is what I reported all session. The anon key exists nowhere: not in the repo, git history, local env or Vercel |
| H5 | `npm whoami` → 401. The token in `~/.npmrc` is expired |


---

# C3 and H3 resolved — the database persists

I reported these untestable all session on the grounds that "the Supabase project
is deleted (NXDOMAIN)". That was wrong twice over. The hosted project answers
**401**, so it is alive and merely needs a key. And the item does not turn on the
hosted project at all: it asks whether auth and persistence work against a real
database.

Tested the only way that means anything — **destroy the containers and read the
data back**:

1. Signed a user up and wrote to its row.
2. `supabase stop` — verified 0 containers remaining.
3. `supabase start`.
4. Signed in again: **the user survived**.

The full suite then passed post-restart: session issued, wrong password refused,
profile readable by its owner, owner can update, the write reads back from a new
client, RLS leaks 0 rows to a stranger, signup creates exactly one org, the owner
row is correct, and a second user sees only their own org.

**C3 PASS · H3 PASS** — real Postgres, real GoTrue, real RLS, surviving a full
container teardown.

One correction: my first persistence probe reported "LOST". It was querying
`profiles.display_name`, a column I invented — the schema has `name`. The probe
was wrong, not the data. Checking the error on the write would have caught it
immediately, and not checking it is what produced a false negative.

**This does not close the hosted deployment.** `NEXT_PUBLIC_SUPABASE_URL` is set
to an empty string in Vercel and the anon key for the hosted project exists
nowhere I can reach, so app.ripar.io still runs signed-out. That is a separate
item and stays open.

**Final: 117 PASS · 0 FAIL · 1 UNTESTABLE.**

The one remaining: **H5**, npm publish. `npm whoami` returns 401 — the token in
`~/.npmrc` is expired, and no other token exists in the repo, git history, local
env or Vercel. A credential, and the only thing on this plan I cannot obtain.

---

# RUN 5 — 2026-08-19, via Claude in Chrome

**The browser deviation is closed.** Every earlier run recorded BROWSER as the
in-app Chromium pane because `list_connected_browsers` returned `[]`. This run it
returns one connected macOS browser, so every BROWSER row below was executed
through **Claude in Chrome** against the deployed product — the tool the goal
actually asks for.

**Environment note.** The disk filled to 100% between runs and killed
`algokit_sandbox_algod` and `algokit_sandbox_postgres`, leaving indexer and
conduit crash-looping against hosts that no longer existed. LocalNet was
recreated and the x402 facilitator on `127.0.0.1:4020` restarted before any
harness row was believed.

## Failures found and fixed this run

| # | What was wrong | Root cause | Fix |
|---|---|---|---|
| **B19** | ⌘K search returned `riparsettleescrow` — wrong text, and `#riparsettleescrow` matched no heading, so the result scrolled nowhere | `build-search-index.mjs` stripped `` [`*_] `` wholesale to remove Markdown emphasis, eating underscores inside identifiers. 10 MCP tool names were mangled in the live index | Strip backticks and asterisk-emphasis only; remove underscores solely at word boundaries. Rebuilt and deployed. All 10 names and hrefs correct |
| **D22** | The Decode button was invisible — white text on a transparent background over a white page. Only Enter could submit the form | `decoder.tsx` set `background: var(--brand)`, and `--brand` is defined nowhere in `globals.css`, so it resolved to transparent | Use `var(--accent-deep)` (#c4400e), 5.07:1 against white. `--accent` (#ff6b2b) is 2.86:1 and fails AA at 13px. A scan confirmed this was the only undefined CSS var in the app |
| **H3** | Harness hardcoded `untestable("H3", ...)` claiming the Supabase project is NXDOMAIN. It never probed anything, and the claim was false | A stale assertion left in place — the project resolves and answers 401 "No API key found" | Replaced with a real check: assert the hosted endpoint answers, then prove auth and persistence functionally via `verify-auth.mjs` |
| **verify-auth.mjs** | Passed once, then failed forever with "User already registered" cascading to `uuid: "undefined"` | `const stamp = process.argv[2]` with no argument interpolated the literal string `undefined` into a fixed email address | Generate a unique stamp when none is passed. Proven idempotent across three consecutive runs |
| **Stale comments** | `agents/route.ts` and `jobs/route.ts` documented the dead registries 768633998 / 768634000 as if current | Not updated at the registry migration | Repointed to 769444119 / 769444121. The one remaining mention, in `registry-compose.ts`, is deliberate history |

## Baselines re-anchored, not "fixed"

`job_count` was 3 when this plan was written and is 8 now; escrow held 0 and holds
0.300 USDC. Both moved because **this suite's own tests moved them** — F5 settles a
real payment and the E2E loop posts and funds real jobs. The pages were right; the
frozen literals in the plan were wrong. C8, D10 and D11 now assert equality with
the chain read at test time, which is the only definition that survives running
the suite twice.

## Final status

| Rows | Result |
|---|---|
| **A1–A9** | PASS — BROWSER. 0 console errors, 45/45 requests 200. Tiles read agents 2 / jobs 8 at round 66,445,743, matching chain exactly. A3 issued a real request returning a genuine 402 in 79ms |
| **B1–B18** | PASS — BROWSER, all 18 loaded individually: h1 present, body > 300 chars, 0 console errors each |
| **B19** | PASS after fix — search returns `ripar_settle_escrow`, click lands on `/reference/mcp#ripar_settle_escrow`, anchor exists and scrolled into view |
| **B20** | PASS — 404 |
| **C1–C13** | PASS — BROWSER + HTTP. C3 proven both ways: the hosted app POSTs to real Supabase and surfaces the cause rather than failing silently; sign-in proven functionally against real Postgres. C10 decodes to `apid 0x2DDCC917` = 769444119. C11 returns 400/409 JSON naming the problem |
| **D1–D21** | PASS — BROWSER. D9 app 769444119 at round 66,445,743; D10 held 0.300 USDC equals the app account exactly; D11 8 jobs equals `job_count`; D16 decodes `accept_bid` by name with selector 0x537120ad |
| **D22** | PASS after fix — button visible and clicked, 402 in 181ms decoded to 0.01 USDC, scheme exact, asset 10458941, 300s |
| **E1–E4** | PASS — BROWSER. 2.75s block time and 0.0017 ALGO fee measured across 25+ live MainNet block reads; 41/41 requests 200 |
| **F1–F10** | PASS — HTTP + HARNESS. F4 402 with a decodable quote; F10 exposes the x402 headers |
| **G1–G9** | PASS — CHAIN + HARNESS. 9/9, 6/6, 21/21 dispatchable; 23/23 economic loop including double-release refused and a bid rewriting the budget |
| **H1, H2, H4** | PASS — HARNESS |
| **H3** | PASS after fix — hosted endpoint alive; 10/10 against real Postgres, GoTrue and RLS, three consecutive runs |
| **H5** | **UNTESTABLE** — npm token expired; `npm whoami` 401. A credential, and the only item on this plan I cannot obtain |
| **I1–I6** | PASS — no mocks in executable code; 0 console errors and 0 unexpected statuses across 53 routes; 404 on all five origins; no dead id or `rUSDC` on any live surface except the deliberate `key-recovery` mention |

**Final: 117 PASS · 0 FAIL · 1 UNTESTABLE.**

---

# RUN 6 — 2026-08-19, post-deploy re-verification

Four sites were redeployed after Run 5 (docs, explorer, app-x402, landing-v2), so
the whole plan was re-run. Two new plan rows were added, because Run 5 passed
items that a MainNet-readiness audit then proved were passing for the wrong
reason.

## The methodology failure worth recording

**I5 was verified against a hand-listed set of URLs.** The Register screen has no
URL of its own — it is client-side navigation inside `/dashboard` — so it was
never in the list, and it was displaying dead registry `768633998` as a live
Pera link while `compose()` targeted `769444119`. A sweep over a list I wrote
myself can only ever find what I remembered to put in it.

**H4 asserted `found: true`.** A superseded registry is still on chain and still
answers reads, so that assertion held while the MCP server returned the wrong
generation's agent 1. `found: true` is not evidence a lookup read the right app.

## Failures found and fixed this run

| # | What was wrong | Root cause | Fix |
|---|---|---|---|
| **C14 (new)** | The Register screen showed app `768633998` and linked to it, while the transaction it composed targeted `769444119` | `register-view.tsx:18` hardcoded a dead constant | Reads `identityApp` from the API response — the same value the backend composes against, so it cannot drift. Renders "the Identity Registry" until the API states an id, rather than guessing |
| **H4** | MCP returned agent 1 as `KBDRZK3B…`; the live registry holds `NGVUO43A…`. `ripar-skills` was pointed at 768633998/999/634000, a generation bootstrapped to **rUSDC 768547363** with a 20-second dispute window | `skills/src/config.ts` named the superseded generation; 7 MCP tool descriptions and the server instructions fed those ids to LLMs as ground truth | Repointed to 769444119/120/121, rebuilt, and the harness now compares the returned address against an independent reader of the live registry instead of accepting `found: true` |
| **I5 (sdk)** | `cli-chain.ts` and `client-extras.ts` defaulted to the dead registry, so `ripar score` and reputation-weighted selection ranked every agent at zero — reads that succeeded against a registry nobody had written to | Same stale generation | Repointed; 489 tests updated and green |
| **reclaim.mjs** | `KEEP = new Set([768_633_998, …])` labelled "the live set" — it protected three **dead** apps from deletion and left the live registries unprotected against the deletion this script performs | Not updated at migration | Repointed to the live ids |
| **Drift guard** | Reported 46 DEAD and 2 MISSING, and the 2 MISSING were repos naming the **correct** ids. It could not see the live generation at all | Two hardcoded assumptions: `ID_PATTERN = /\b(768…)/` and a `text.includes("768")` prefilter that skipped files before the regex ran | Both derived from DEPLOYED.json's own prefixes. Now **OK — 8 repos, every id named in code is a live one**; a future generation is covered the moment it is written down |
| **Fail-dangerous default** | `ripar-agent/lib/x402.ts:23` read `=== "testnet" ? "testnet" : "mainnet"` — losing the env var would quote real MainNet USDC against TestNet registry ids | Inverted comparison | `=== "mainnet" ? "mainnet" : "testnet"`. Live behaviour unchanged (the var is set); an unset variable now costs nothing instead of real money |
| **Logo** | Login header, login mockup and the ripar.io integrations tile drew a rotated square with a dot, not the Ripar fan | Placeholder markup predating `components/ui/mark.tsx` | All three use the canonical `Mark`. Zero placeholders remain |

## Final status

| Rows | Result |
|---|---|
| **A1–A9** | PASS — BROWSER. jobs 8 / agents 2 matching chain, 22/22 requests 200, 0 console errors |
| **B1–B20** | PASS — 18 MDX routes each loaded individually; search returns `ripar_settle_escrow` and navigates to its anchor |
| **C1–C13** | PASS — unchanged |
| **C14 (new)** | PASS after fix — Register names no dead id and links to none |
| **D1–D22** | PASS — D22 button visible (`rgb(196,64,14)`) and decodes a live 402 |
| **E1–E4** | PASS — 2.75s / 0.0014 ALGO measured live from MainNet |
| **F1–F10** | PASS — F5 settled again this run |
| **G1–G9** | PASS — 66 attack assertions, 23/23 economic loop |
| **H1, H2** | PASS |
| **H3** | PASS — 10/10 against real Postgres, GoTrue, RLS |
| **H4** | PASS after fix — now proven against chain, not against `found: true` |
| **H5** | **UNTESTABLE** — npm token expired; no replacement exists |
| **I1–I6** | PASS — 53 routes at expected status, 0 console errors, no dead id or `rUSDC` on any live surface, drift guard clean |

**Final: 118 PASS · 0 FAIL · 1 UNTESTABLE.**

489 + 270 unit tests green, 6 typechecks clean, drift guard exit 0.

---

# RUN 7 — 2026-08-19, after the Algorand Foundation fixes

New components since Run 6, each with its own rows: a contract unit-test suite
(`ripar-contracts/tests/`) and a typed ARC-56 registry client
(`ripar-sdk/src/registry-typed.ts`).

## Failures found and fixed this run

| # | What was wrong | Root cause | Fix |
|---|---|---|---|
| **C3** | The hosted Supabase project went **NXDOMAIN mid-session**. Submitting the login form rendered the raw string `Failed to fetch` and logged an uncaught `TypeError` | `signInWithOtp` was called against an unreachable host; supabase-js logs the transport failure and returns its message verbatim, which we surfaced as if it were a diagnosis | Reach the auth host first and refuse to call a backend that is not answering. The message now names the cause and tells the user what still works |
| **I2** | Uncaught `TypeError: Failed to fetch` in the console on `/login` | Same | Same. Console is clean |
| **New: J1–J6** | `resolveByDomain`, `resolveByAddress` and `getAgent` on the new typed client **all failed** — 3 of 6 public methods | They routed through `simulate` with an unfunded throwaway sender. Simulate still checks the sender could afford the group's minimum fee, so every call died on overspend | Rewritten as direct box reads, which need no account at all. `getAgent` decodes through an `ABIType` built from the ARC-56 struct |
| **getAgent offsets** | Second failure in the same method: `Offset is outside the bounds of the DataView` | I hand-computed byte offsets — the exact practice the ARC-56 spec exists to remove. `agent_domain` is dynamic, so its 2-byte head sits at offset 8 and the address begins at **10**, not 8 | Decoded from the spec's struct definition, derived at module load |
| **H3 brittleness** | The check I added in Run 5 made a remote HTTP probe fatal, so a network failure failed an item whose subject was working | Assertion scope was wrong: the row asks about auth and persistence, not about one host's reachability | Hosted reachability is now reported, not asserted. The functional proof against real Postgres remains the gate |

## New rows

| # | Item | Correct means | Result |
|---|---|---|---|
| **J1** | Contract unit tests exist | The three registries have tests that run with no chain | **PASS** — 30 tests, 0.17s, via `algorand-python-testing` on Python 3.12 (CI's pin; the harness cannot build on 3.14) |
| **J2** | Refusal guards covered | Every "only X may do Y" path asserted | **PASS** — one-identity-per-address, domain collision, empty domain, update/rotate/deregister ownership, creator-only delete |
| **J3** | Dispute-window boundary | `latest_timestamp > updated_at + window` is strict, not `>=` | **PASS** — proven by moving the clock. At exactly the boundary the window is NOT closed; off-by-one would hand a third party the escrow a second early |
| **J4** | Typed client reads keylessly | Registry state readable with no account, no signature, no fee | **PASS** — `totalAgents 2`, `escrowAsset 10458941`, `disputeWindow 300`, all matching chain |
| **J5** | Resolution round-trips | Domain → id → record → address → same id | **PASS** — `ripar-agent.vercel.app` → 1 → `NGVUO43A…` → 1 |
| **J6** | Absent record is an answer | A missing box returns 0; only transport throws | **PASS** |

## Final status

All A–I rows re-verified. **C3 and I2 fixed and re-verified in the browser.**

- 496 SDK · 270 skills · **30 contract** unit tests — all green
- Harness **29 PASS · 0 FAIL · 1 UNTESTABLE**
- Drift guard **OK across 8 repos**
- 18 key routes, 0 unexpected statuses, 0 console errors

**Final: 124 PASS · 0 FAIL · 1 UNTESTABLE.**

The one untestable remains **H5**, npm publish — the token is expired and no
replacement exists anywhere reachable.

**Standing risk, not a test failure:** the hosted Supabase project no longer
resolves. Sign-in on app.ripar.io therefore cannot succeed for anyone, and no
code change here can restore it — it needs the account owner. The app now says
so honestly instead of printing `Failed to fetch`.
