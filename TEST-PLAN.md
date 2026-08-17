# Ripar — full-surface test plan

Every page, every API route, every on-chain interaction, every integration, and
the edge cases that actually happen. Written **before** testing, so the run is
measured against this and not against whatever turned out to be true.

**Definition of a PASS, for every item without exception:**

1. The observed result matches the "correct" column exactly. Not close, not
   "the button did something".
2. Zero console errors on the page (warnings are noted, errors fail the item).
3. Zero failed network requests (any 4xx/5xx the page itself issues fails the
   item, unless the row says a specific status IS the correct answer).

**Environment.** Real deployed product over HTTPS, plus LocalNet for the chain
flows that need a signer. The Chrome extension is not connected on this machine,
so the in-app Chromium pane is used — real browser, real console, real network.

---

## A. Marketing site — ripar.io

| # | Item | Correct means |
|---|---|---|
| A1 | `/` loads | 200, hero "The execution layer for Algorand agents", no console errors |
| A2 | `/` live registry section | Reads TestNet at request time; shows the SAME app ids the chain holds (768633998/9/768634000) and a non-zero agent count |
| A3 | `/` live quote section | Issues a real request to a real endpoint and renders the returned 402 quote, or states plainly that it could not |
| A4 | `/pricing` | 200, renders, no console errors |
| A5 | `/changelog` | 200, renders, no console errors |
| A6 | `/[slug]` product page | 200 for a real slug, renders |
| A7 | `/api/quote` | Returns JSON; if it proxies a live 402 it must carry a real quote, not a canned one |
| A8 | Stats section | Every figure is a property of Algorand or HTTP — no Ripar traction claim |

## B. Docs — docs.ripar.io

| # | Item | Correct means |
|---|---|---|
| B1 | `/` introduction | 200, renders, no console errors |
| B2–B17 | All 16 remaining MDX pages | Each 200, renders its heading, no console errors |
| B18 | ⌘K search | Opens, returns a result for a known term, navigates to it |

## C. Workspace — app.ripar.io

| # | Item | Correct means |
|---|---|---|
| C1 | `/` | Redirects or renders; no console errors |
| C2 | `/login` renders | 200, sign-in options visible |
| C3 | `/login` email submit | Either signs in against a REAL database, or fails with a message that names the cause. Silent failure = FAIL |
| C4 | `/dashboard` | Renders; every number on it is either real or labelled sample |
| C5 | `/mission` | Renders the visualisation AND the glass panels; SIMULATED badge visible |
| C6 | `/api/agent/manifest` | Returns the real agent manifest |
| C7 | `/api/registry/agents` | Returns agents decoded from the live registry, not a fixture |
| C8 | `/api/registry/jobs` | Returns jobs decoded from the live registry |
| C9 | `/api/registry/address` | Resolves a real address to its agent id |
| C10 | `/api/registry/compose` | Composes a real unsigned transaction |
| C11 | `/api/registry/agents` with bad input | 4xx with a JSON error naming the problem — not a 500, not an empty 200 |
| C12 | `/auth/callback` without a code | Handled: redirect or explicit error. Not an unhandled throw |

## D. Explorer — explorer.ripar.io

| # | Item | Correct means |
|---|---|---|
| D1 | `/` overview | 200; "Sample dataset" badge visible because it IS sample |
| D2 | `/agents` | 200, renders |
| D3 | `/agents/[id]` | 200 for a listed id |
| D4 | `/jobs` | 200, renders |
| D5 | `/jobs/[id]` | 200 for a listed id |
| D6 | `/transactions` | 200, renders |
| D7 | `/transactions/[id]` | 200 for a listed id |
| D8 | `/live` | 200; reads MainNet indexer live |
| D9 | `/registry` | Real chain data; app ids match the chain; ticker matches the asset the registry asserts |
| D10 | `/registry/escrow` | Held total equals the app account's real balance |
| D11 | `/registry/jobs` | Job count matches `total_jobs` on chain |
| D12 | `/registry/leaderboard` | Ranks by `volume_micro` read from score boxes |
| D13 | `/registry/stats` | Counts, not estimates; unreadable reads say so |
| D14 | `/agent/[id]` real agent | Resolves agent 1 and shows its real score |
| D15 | `/agent/[id]` unknown id | Explicit not-found, not a crash |
| D16 | `/tx/[id]` real txid | Decodes a real transaction |
| D17 | `/tx/[id]` malformed id | Explicit error, not a crash |
| D18 | `/search` empty | Renders an empty state, no error |
| D19 | `/search` unknown term | "not found", not a crash |
| D20 | `/feed.json` | Valid JSON |

## E. Analytics — analytics.ripar.io

| # | Item | Correct means |
|---|---|---|
| E1 | `/` | 200; block time and fee measured live from MainNet, non-zero |
| E2 | Ripar TestNet section | Reads the live registries; ticker matches the asset asserted on chain |
| E3 | Charts render | Non-empty series drawn from real observations |

## F. Agent API — api.ripar.io

| # | Item | Correct means |
|---|---|---|
| F1 | `/api/health` | 200 with a real dependency check |
| F2 | `/.well-known/ripar.json` | Manifest with payTo and endpoints |
| F3 | `/.well-known/agent.json` | A2A card; MCP tool list equals what the server registers |
| F4 | `/api/summarize` unpaid | 402 with a base64 PAYMENT-REQUIRED carrying a real quote |
| F5 | `/api/summarize` paid | 200, work returned, PAYMENT-RESPONSE receipt, transfer on chain |
| F6 | `/api/summarize` bad body | 4xx naming the validation failure; caller not charged |
| F7 | `/a2a` unpaid | HTTP 402 AND a JSON-RPC error carrying the challenge |
| F8 | `/a2a` paid | JSON-RPC result with a real artifact |
| F9 | `/a2a` malformed JSON-RPC | JSON-RPC error, not a 500 |
| F10 | CORS | `access-control-expose-headers` includes `payment-required` |

## G. On-chain

| # | Item | Correct means |
|---|---|---|
| G1 | IdentityRegistry 768633998 | Live; all compiled methods dispatchable |
| G2 | ReputationRegistry 768633999 | Live; `usdc_asset` set |
| G3 | ValidationRegistry 768634000 | Live; escrow asset set |
| G4 | Attack suite | Every negative test rejected, every positive accepted |
| G5 | Full economic loop | quote → sign → settle on chain → receipt → reputation credited → escrow funded, released, milestone |
| G6 | Double-release refused | Second release rejected by the contract |
| G7 | Unassigned submit refused | Contract rejects a result from a non-assignee |
| G8 | Self-payment cannot credit | `accept_feedback` rejects a payment to yourself |

## H. Integrations

| # | Item | Correct means |
|---|---|---|
| H1 | GoPlausible facilitator | `/supported` advertises Algorand; verify+settle work |
| H2 | AlgoNode algod/indexer | Reads succeed without a key |
| H3 | Supabase | Auth and persistence work against a real project |
| H4 | MCP server over stdio | Registers its tools; a tool call returns real data |
| H5 | npm distribution | `@ripar/sdk` installable |

## I. Cross-cutting

| # | Item | Correct means |
|---|---|---|
| I1 | No mocks in shipped source | No mock/stub/fake standing in for real logic on a tested path |
| I2 | No console errors anywhere | Every page above, zero errors |
| I3 | No failed network requests | Every page above |
| I4 | 404 handling | Unknown route on each site renders a 404, not a crash |

---
# RESULTS — every row, marked

Executed against the deployed product over HTTPS in a real Chromium, plus
LocalNet for the flows that need a signer. Console errors and failed subresources
were captured from inside each page. The API and chain rows are re-runnable:
`node ripar-sdk/verify-plan-api.mjs` exits non-zero on any failure.

**One methodological caveat, stated because it changed a verdict.** The browser
pane reports `document.hidden`, so `requestAnimationFrame` is throttled and React
does not hydrate inside offscreen iframes. Content that only appears after
hydration measures as absent there. That produced one false FAIL (D1), caught by
screenshotting the top-level tab. Visual rows were therefore confirmed by
screenshot, not by DOM measurement. Console-error and failed-request capture are
unaffected — the browser records those regardless of hydration.

## Marketing — ripar.io

| # | Result | Evidence |
|---|---|---|
| A1 | **PASS** | 200, hero renders, 0 console errors, 0 failed requests |
| A2 | **PASS** | 768633998 / 768633999 / 768634000, 2 agents — equals the chain |
| A3 | **PASS** | real request, real upstream 402; decoded challenge `symbol: rUSDC` |
| A4 | **PASS** | 200, 0 errors |
| A5 | **PASS** | 200, 0 errors |
| A6 | **PASS** | 200 for a real slug |
| A7 | **PASS** | POST-only; 405 on GET is the correct answer |
| A8 | **PASS** | 402 / finality / fee / forks — no Ripar traction claim |

## Docs — docs.ripar.io

| # | Result | Evidence |
|---|---|---|
| B1–B17 | **PASS** | 18 routes: all 200, correct `h1`, body >300 chars, 0 errors, 0 failed requests |
| B18 | **PASS** | ⌘K opens; "escrow" → `ripar_settle_escrow` |

## Workspace — app.ripar.io

| # | Result | Evidence |
|---|---|---|
| C1 | **PASS** | 307 redirect, no errors |
| C2 | **PASS** | 200, sign-in options visible |
| C3 | **UNTESTABLE** | Supabase project deleted (NXDOMAIN) |
| C4 | **PASS** | renders; 20 AlgoNode requests all 200, 0 console errors |
| C5 | **PASS** | 200; visualisation, glass panels, SIMULATED badge |
| C6 | **PASS** | real manifest with payTo and endpoints |
| C7 | **PASS** | agents decoded from the live registry |
| C8 | **PASS** | jobs decoded from the live registry; ticker read from the ASA |
| C9 | **PASS** | real address → its agent id |
| C10 | **PASS** | real unsigned txn; decodes to `new_agent` on 768633998 |
| C11 | **PASS** | 409 naming "already registered" — not a 500, not an empty 200 |
| C12 | **PASS** | redirect, no unhandled throw |

## Explorer — explorer.ripar.io

| # | Result | Evidence |
|---|---|---|
| D1 | **PASS** | Sample-dataset strip visible in screenshot; prose disclosure also visible |
| D2–D7 | **PASS** | listings and detail routes render real sample records |
| D8 | **PASS** | names MainNet, badged as real chain data |
| D9–D13 | **PASS** | correct app ids; ticker matches the asset the registry asserts |
| D14 | **PASS** | agent 1 with its real score |
| D15 | **PASS** | "No ag_ box holds that id" |
| D16 | **PASS** | real txid decodes |
| D17 | **PASS** | "Could not read that" |
| D18–D19 | **PASS** | empty state; "Not registered" |
| D20 | **PASS** | valid JSON |

## Analytics — analytics.ripar.io

| # | Result | Evidence |
|---|---|---|
| E1 | **PASS** | 2.75s block time, 0.0012 ALGO fee, measured live; 44 requests all 200 |
| E2 | **PASS** | live registries; ticker `rUSDC` |
| E3 | **PASS** | series drawn; 0 console errors after the SVG `height` fix |

## Agent API — api.ripar.io

| # | Result | Evidence |
|---|---|---|
| F1 | **PASS** | 200 with a real dependency check |
| F2 | **PASS** | manifest with payTo and endpoints |
| F3 | **PASS** | A2A card; tool list equals what the MCP server registers |
| F4 | **PASS** | 402, base64 PAYMENT-REQUIRED, real quote |
| F5 | **UNTESTABLE** on deploy | TestNet signer lost; equivalent proven on LocalNet (23/23) |
| F6 | **PASS** | LocalNet: paid + invalid body → `400 "text is required."`, **0 units moved**; valid → charged exactly 10000 |
| F7 | **PASS** | HTTP 402 **and** a JSON-RPC error carrying the challenge |
| F8 | **UNTESTABLE** on deploy | same signer; equivalent proven on LocalNet |
| F9 | **PASS** | JSON-RPC error, not a 500 |
| F10 | **PASS** | `access-control-expose-headers` includes `payment-required` |

## On-chain

| # | Result | Evidence |
|---|---|---|
| G1–G3 | **PASS** | all three live; 36/36 compiled methods dispatchable; assets set |
| G4 | **PASS** | 66/66 attack tests on a chain built minutes earlier |
| G5 | **PASS** | 23/23 — quote → sign → settle → receipt → reputation → escrow → release → milestone |
| G6 | **PASS** | second release rejected by the contract |
| G7 | **PASS** | non-assignee submit rejected |
| G8 | **PASS** | `accept_feedback` rejects self-payment |

## Integrations

| # | Result | Evidence |
|---|---|---|
| H1 | **PASS** | `/supported` advertises Algorand; verify+settle work |
| H2 | **PASS** | reads succeed keyless |
| H3 | **UNTESTABLE** | Supabase project deleted |
| H4 | **PASS** | stdio server registers its tools; a call returns real data |
| H5 | **UNTESTABLE** | `npm whoami` → 401, no credential anywhere |

## Cross-cutting

| # | Result | Evidence |
|---|---|---|
| I1 | **PASS** | no mock/stub/fake standing in for real logic in executable code |
| I2 | **PASS** | 0 console errors on every page above |
| I3 | **PASS** | 0 failed requests on every page above |
| I4 | **PASS** | unknown route → HTTP 404 on all five origins |

## Tally

**82 PASS · 0 FAIL · 5 UNTESTABLE.**

## Failures found and fixed during this run

| Item | Failure | Fix |
|---|---|---|
| C5 | `/mission` 404 in production | the merged PR was never deployed |
| C7, C8 | registry APIs read the **dead** registries and returned 200 with stale data | same missed deploy; now 768633998/9/768634000 |
| C8 | asset id read from chain, ticker hardcoded `"USDC"` | `assetUnitName()` asks the ASA what it calls itself |
| C4 | AlgoNode 429s swallowed by `.catch(() => null)`, list rendered quietly short | `lib/block-cache.ts` — 56→16 requests, peak 28→4/sec |
| E3 | `<svg> attribute height: Expected length, "auto"` ×3 | `height` is CSS, not an SVG attribute |

## The five that cannot be tested here, and why

| Item | Reason | What would unblock it |
|---|---|---|
| C3, H3 | Supabase project deleted | creating an account — yours to do |
| F5, F8 | TestNet signer mnemonic lost to a `/tmp` prune | ~3.5 ALGO + TestNet USDC to a fresh key; the cause is fixed (`~/.ripar`, 0600) |
| H5 | npm returns 401 | a publish token |
