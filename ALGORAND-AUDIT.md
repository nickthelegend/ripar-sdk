# Is Algorand actually used here?

**Yes, load-bearing, not a checkbox.** Verified by `ripar-sdk/algo-audit.mjs`,
which makes real requests to public nodes and reads the deployed programs —
14/14 capabilities confirmed live, not inferred from imports.

## What the platform offers, and what this project touches

### GENUINELY USED — verified live, with evidence

| Capability | Where | Evidence from the live audit |
|---|---|---|
| algod REST, suggested params | every composer, `lib/registry-compose.ts` | firstValid 66,425,567, minFee 1000 |
| Application global state | `explorer /registry`, `analytics/lib/registry.ts` | 7 keys on app 769444121 |
| Box storage, listing | explorer job board | 4 `jb_`/`es_` boxes on 769444121 |
| **Box storage, ARC-4 struct decode** | `explorer/lib/erc8004.ts:31`, `analytics/lib/registry.ts:22` | decoded agent #1 = `ripar-agent.vercel.app` from raw bytes |
| **ARC-4 dispatch** | `explorer/lib/tx-decode.ts`, `check-abi-coverage.mjs` | 21 selectors read out of the deployed approval program |
| **algod `simulate`** | `app-x402/lib/registry-compose.ts` | `submit_result` → ok, 151 opcodes, round 66,425,568 |
| Atomic transaction groups | `fund_job` composer, x402 settlement | real group id assigned over a 2-txn group |
| ASA parameters | explorer ticker, `/decode` | 10458941 = USDC, 6 dp — read from the ASA, not a table |
| ASA opt-in state | `await-funding.mjs`, e2e | merchant opted into 10458941 |
| Indexer transaction history | `explorer /tx`, analytics | 3 txns for the merchant |
| **Application account custody** | `fund_job`, escrow page | `SN7C6GYS7Q…` (app 769444121's own account) holds 1.050 ALGO |
| **Inner transactions** | `release_escrow`, `accept_feedback` | 8 `itxn_begin` sites in the deployed program |
| Address checksum validation | compose route input guard | rejects malformed, accepts real |
| **x402 `exact` on AVM** | `api.ripar.io` paywall | 402, scheme `exact`, `algorand:SGO1GKSz…`, asset 10458941 |

The three in bold are the ones a judge should care about, because they are not
"an SDK was imported":

- **The contracts are the product.** Three ERC-8004 registries written in
  Algorand Python, compiled to TEAL, deployed at 769444119 / 769444120 /
  769444121, with 9 / 6 / 21 dispatchable methods. `accept_feedback` takes the
  settling `axfer` **as a transaction in its own group** and reads the amount off
  something consensus already validated — a design that only exists because
  Algorand has atomic groups and transaction-typed ABI arguments.
- **Escrow is real custody by an application account**, released by inner
  transaction. There is no keeper and no multisig ceremony.
- **`simulate` is in the signing path.** Every composed transaction is run
  against the real AVM before a user is invited to sign it.

### IMPORTED BUT UNUSED

None found. `ripar-landing-v2` has no Algorand dependency at all and talks to
algod over plain `fetch`, which is correct for four read-only tiles.

### FAKED

None on any tested path. The two that existed earlier this session are gone:
`app-data.ts` carried `USDC_ASSET_ID = "31566704"` and
`X402_NETWORK = "algorand-mainnet"` in a TestNet app (deleted), and
`exercise-registries.mjs` credited reputation from `crypto.randomBytes(32)` as a
payment id (deleted).

### MISSING — offered by Algorand, untouched here

State proofs · LogicSig / smart signatures · rekeying · KMD · multisig ·
asset freeze / clawback / reserve · ASA minting from the app · ARC-3 / 19 / 69
NFT metadata · ARC-56 typed clients in the app (used only in `ripar-contracts`) ·
atomic asset-for-asset swaps · application **local** state and opt-in (only
global + boxes are used) · the **lease** field · `RekeyTo` · close-remainder-to ·
ARC-2 structured note fields · fee pooling · opcode-budget pooling · groups
larger than two · heartbeat transactions · participation keys and governance.

## Where deeper integration genuinely fits — and where it would be forced

**Fits organically.** The escrow contract already holds funds and releases by
inner transaction, so anything about *how money is held and released* belongs
here: milestones, partial release, deadline expiry, refund paths. The identity
registry already binds an address to an agent, so anything about *key lifecycle*
belongs here too — rekeying is the obvious one, and the docs already promise
`rotate_address`. And a payment layer with no replay protection has an obvious
hole that Algorand fills natively with the lease field.

**Would be forced, so I am not proposing it.** Minting an NFT per receipt looks
like Algorand usage and is really a database row with extra steps — the receipt
is already provable from the transaction id. Governance and participation keys
have nothing to do with paying an agent. Asset freeze/clawback on a settlement
token would make the payment layer custodial, which is the opposite of the pitch.
State proofs only matter with a second chain to prove *to*, and there is not one.

---

# 50 features that use Algorand for real

Ranked by how **load-bearing** Algorand is: the top could not be built on another
chain or off-chain at all without losing the property that makes them work; the
bottom would work anywhere and Algorand is incidental.

## Tier A — impossible without an Algorand-specific primitive

| # | Feature | Capability it rests on | Depth | Why a judge notices |
|---|---|---|---|---|
| 1 | **Replay-proof paid calls** — put the x402 payment id in the transaction's `lease`, so the same quote can never settle twice | **Lease field** (network-enforced, per sender, for the txn's validity window) | Core | Every other payment rail solves double-spend of a *quote* with a database. Algorand does it in consensus. This is the single most Algorand-native thing this product could do |
| 2 | **Sub-cent metered calls over a LogicSig channel** — open once, sign off-chain increments, settle on close | **LogicSig / smart signatures** | Core | Makes per-token LLM billing viable at $0.0001 without a transaction per token |
| 3 | **Agent key rotation that keeps the identity** — `rotate_address` plus account-level `RekeyTo` | **Rekeying** + IdentityRegistry | Core | A lost key today is fatal — this project has two dead registries proving it. Rekeying is an Algorand account primitive with no EVM equivalent |
| 4 | **One group settles many agents** — a workflow paying six agents commits atomically or not at all | **Atomic groups (16) + fee pooling** | Core | Partial payment across a multi-agent workflow is the failure mode; Algorand makes it structurally impossible |
| 5 | **Opcode-budget pooling for batch verification** — verify N results in one app call by pooling budget across group members | **Budget pooling** | Core | A real AVM constraint solved the AVM way, not by looping off-chain |
| 6 | **Non-transferable reputation as a frozen ASA** — one unit per agent, `DefaultFrozen`, clawback held by the registry | **ASA freeze/clawback** | Core | Soulbound without a token standard argument — it is an asset parameter |
| 7 | **Escrow deadline expiry enforced on chain** — `expire_job` refunds when a round passes with nothing delivered | **Round-based validity + app account custody** | Core | Time is a first-class chain fact here, not an oracle |
| 8 | **Milestone escrow** — release part, keep the rest held | `release_partial` + inner transactions | Core | Already deployed and unexercised; a demo of partial custody is rare |
| 9 | **Structured receipts in the note field** — ARC-2 encoded x402 metadata on the settling transfer | **Note field / ARC-2** | Core | Makes every settlement self-describing to any indexer, not just ours |
| 10 | **Bid book in boxes** — one box per bid, iterated on chain | **Box storage + pagination** | Core | Boxes are Algorand's answer to unbounded state; using them for an order book shows you know why they exist |

## Tier B — Algorand does it distinctly better

| # | Feature | Capability | Depth | Why it lands |
|---|---|---|---|---|
| 11 | Pre-flight every user action through `simulate` before signing | algod simulate | Core | *Already built this session* — extend to the wallet path |
| 12 | Fee sponsorship — a relayer covers the payer's fee inside the group | Fee pooling | Core | New users pay in USDC without holding ALGO |
| 13 | Multisig escrow release for high-value jobs | Native multisig | Core | Threshold signing is an account type, not a contract |
| 14 | Local-state opt-in as per-agent subscription tracking | Application local state | Core | The one storage tier this project does not use |
| 15 | Deadline reminders driven by round height, not wall-clock | Round-based time | Deep | Chain time is trustless; `Date.now()` is not |
| 16 | Atomic asset-for-asset settlement (pay in any ASA, agent receives USDC) | Atomic swap in one group | Core | No DEX dependency, no slippage window |
| 17 | Close-remainder-to for one-shot agent wallets that sweep themselves | `CloseRemainderTo` | Core | Ephemeral payer accounts with no dust left behind |
| 18 | ARC-56 typed client generated into the app, not hand-rolled composers | ARC-56 | Deep | Removes an entire class of selector/box-name bug |
| 19 | Group-size-aware quotes — the 402 states how many txns settlement needs | Group semantics | Deep | Callers can budget fees correctly |
| 20 | On-chain dispute window enforced by `dispute_window` global state | Global state + rounds | Core | Already deployed at 300s; unexercised |
| 21 | Per-agent spending caps enforced in the contract, not the client | Box state + assert | Core | A cap the client cannot lift |
| 22 | Inner-transaction fan-out: one call pays agent, treasury and validator | Inner transactions | Core | Three payments, one signature, one fee |
| 23 | Box MBR accounting shown honestly in the UI | Minimum balance requirement | Deep | MBR is the thing everyone forgets; showing it is a flex |
| 24 | Rekey-based delegated signing for an agent's automation key | Rekeying | Core | Delegate without handing over the identity |
| 25 | Asset-level decimals honoured everywhere, read from the ASA | ASA params | Deep | *Partly built* — the decoder does this |

## Tier C — real, but Algorand is a good default rather than essential

| # | Feature | Capability | Depth |
|---|---|---|---|
| 26 | Transaction-level receipt permalink `/receipt/<txid>` | Indexer | Surface |
| 27 | Atomic-group visualiser for the real 3-txn x402 group | Indexer group read | Deep |
| 28 | Live settlement ticker from the indexer | Indexer | Surface |
| 29 | Block-time and fee measurement shown live | algod block headers | Deep |
| 30 | Finality indicator tuned to real observed round time | Round cadence | Surface |
| 31 | Agent directory from `ag_` boxes with reverse indexes | Box storage | Core |
| 32 | Domain → agent resolution via `dm_` boxes | Box storage | Core |
| 33 | Address → agent resolution via `ad_` boxes | Box storage | Core |
| 34 | Leaderboard ordered by `volume_micro` from score boxes | Box storage | Core |
| 35 | Escrow page listing every `es_` box, exhaustive by construction | Box storage | Core |
| 36 | Raw box viewer with ARC-4 decoding side by side | ARC-4 | Deep |
| 37 | Opcode budget readout per method | simulate | Deep |
| 38 | AVM failure messages decoded into English | simulate + TEAL | Deep |
| 39 | Contract source verification link per app id | Program bytes | Surface |
| 40 | Method coverage guard: we can name every dispatched selector | Program disassembly | Deep |
| 41 | Settlement-asset drift guard against the registry's own assertion | Global state | Deep |
| 42 | Wallet connect (Pera / Defly / Lute) | ARC-0001 signing | Core |
| 43 | KMD-backed local signing for LocalNet development | KMD | Deep |
| 44 | NFD name resolution for agent addresses | NFD (ecosystem) | Surface |
| 45 | Pera explorer deep links on every id | — | Surface |

## Tier D — swappable; Algorand is incidental

| # | Feature | Why it ranks last |
|---|---|---|
| 46 | Endpoint uptime monitoring | HTTP, not chain |
| 47 | Webhook on settlement | Any event source would do |
| 48 | Usage analytics per endpoint | Aggregation, not chain |
| 49 | Rate limiting per payer | Middleware |
| 50 | Cookieless page analytics | Nothing to do with Algorand |

## If I were building three of these

**#1 (lease-based replay protection)**, **#3 (rekey-based recovery)** and
**#7 (deadline expiry)**. Each is a primitive Algorand has and most chains do
not; each fixes a real hole this product has today — a quote that could settle
twice, a lost key that kills an identity, and an escrow with no way out if the
agent vanishes; and none of them is a feature bolted on to qualify for a track.
