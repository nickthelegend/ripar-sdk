# Ripar — system map

**Ripar is the execution and payment layer for autonomous agents on Algorand.**
Deploy a paid HTTP endpoint, compose endpoints into a workflow, publish to an
open marketplace, or post a job and let agents bid for it. Every call settles in
USDC — MainNet ASA `31566704`, TestNet ASA `10458941` over [x402](https://docs.ripar.io/concepts/x402) — roughly
three-second finality, about `$0.001` in network fees, no keeper network to
babysit and no API keys.

This directory is the whole system. Each subdirectory is its own git repo with
its own remote and its own Vercel project; there is no monorepo tooling and no
workspace root.

> **Honest status.** Six surfaces are live, three registries are deployed and
> writable, every page that shows a number reads it from the chain — and **the
> first paid call has been served in production.** A real caller paid 0.01 USDC
> to `api.ripar.io/api/summarize`, the transfer settled on TestNet
> (`4OLRBUE3MERQUIXTW333XFQ22ZKY2MFTQ2REOWSDPRLDIHILL5SA`), and the
> ReputationRegistry credited agent 1: `jobs_paid` 0 → 1. Job #4's escrow holds
> 0.25 USDC in the contract's own account.
>
> That took longer than it should have, for a reason worth recording: TestNet
> USDC was treated as unobtainable because Circle's faucet is reCAPTCHA-gated.
> The faucet is the only *issuer*; it is not the only *source*. Tinyman's TestNet
> pool sells the same asset permissionlessly, and 2.893 free ALGO bought 23.16
> USDC.
>
> Still outstanding: `@ripar/sdk` is not published to npm (the token in
> `~/.npmrc` is expired), there is no wallet connect so browser writes are
> composed and signed out-of-band, production has no database
> (`NEXT_PUBLIC_SUPABASE_URL` is unset), and the Kubernetes data plane has never
> been deployed. Read the "Data" column below before quoting any number.

## Live domains

All on Vercel, scope `nicolas-projects-f497bb7f` (team
`team_gwapD8j8P5T3NxIU746NjNxe`), nameservers on `vercel-dns`. All five resolve.

| Domain | Serves | Vercel project |
|---|---|---|
| [ripar.io](https://ripar.io) | Marketing site | `ripar-landing-v2` |
| [docs.ripar.io](https://docs.ripar.io) | Documentation, 17 MDX pages | `ripar-docs` |
| [app.ripar.io](https://app.ripar.io) | The workspace | `ripar-app` |
| [analytics.ripar.io](https://analytics.ripar.io) | Live Algorand settlement measurement | `ripar-analytics` |
| [explorer.ripar.io](https://explorer.ripar.io) | Agents, jobs and settlements index | `ripar-explorer` |

## Repos

| Directory | GitHub remote | Deploys to | What it is | Data |
|---|---|---|---|---|
| [`ripar-sdk`](ripar-sdk) | `nickthelegend/ripar-sdk` | not published | `@ripar/sdk` — define a handler, set a price, `serve()` puts x402 in front. Plain TypeScript + vitest, Docker + configs for Railway/Render/Fly/Heroku | **Real.** Tests negotiate against the live GoPlausible facilitator |
| [`ripar-landing-v2`](ripar-landing-v2) | `nickthelegend/ripar-landing` | ripar.io | Marketing site, Next 16 + GSAP | **No data.** Only protocol constants; no traction claims |
| [`ripar-docs`](ripar-docs) | `nickthelegend/ripar-docs` | docs.ripar.io | MDX docs, Shiki, ⌘K search index built at build time | Prose. Specification of intent, not a report of deployed capability |
| [`ripar-app-x402`](ripar-app-x402) | `nickthelegend/ripar-app-x402` | app.ripar.io | The workspace: Overview, Chat, Endpoints, Workflows, Agents. Supabase behind it | **Real, with one gap.** Every section reads the chain or the deployed agent's own manifest — Directory decodes `ag_` boxes, Job board decodes `jb_` boxes, Receipts reads settled transfers, Endpoints reads the live manifest. The sample data layer is deleted. Auth/orgs/projects are real Supabase, but `NEXT_PUBLIC_SUPABASE_URL` is unset in production, so the deployed app runs signed-out |
| [`ripar-analytics`](ripar-analytics) | `nickthelegend/ripar-analytics` | analytics.ripar.io | Measures Algorand block times, fees and USDC movement live from the browser | **Real, live MainNet.** Ripar's own figures are `0` and say so |
| [`ripar-explorer`](ripar-explorer) | `nickthelegend/ripar-explorer` | explorer.ripar.io | Agents / jobs / transactions, sortable indexes and detail pages | **Entirely sample**, labelled as such on every page |
| [`ripar-infra`](ripar-infra) | `nickthelegend/ripar-infra` | not deployed | Kubernetes data plane: namespace-per-org agent runtimes, control-plane API + provisioner, Helm chart, k3s dev cluster script | n/a |

## What depends on what

Nothing here imports anything else here. The couplings are all at runtime, by
URL, which means they break quietly rather than at compile time.

```
ripar.io ──── links ────► app.ripar.io          NEXT_PUBLIC_APP_URL, else localhost:3002
    └──────── links ────► docs.ripar.io         hardcoded in lib/content.ts and lib/pages.ts

docs.ripar.io ─ documents ─► ripar-sdk          code samples are the SDK's real surface

app.ripar.io ─── needs ────► Supabase           optional; null-safe, demo mode without it
    └─────────── optional ─► ripar-infra API    NEXT_PUBLIC_RIPAR_API_URL; else runs simulate

ripar-sdk ────── calls ────► GoPlausible facilitator   resolved from /supported at boot
    └──────────  settles ──► Algorand TestNet, USDC 10458941

analytics.ripar.io ─ reads ─► AlgoNode public nodes    no key, no proxy, CORS open
explorer.ripar.io ── reads ─► registries 769444119/20/21 on /registry and /live;
                             its bundled sample dataset elsewhere, labelled as such
```

Three consequences worth holding on to:

1. **The brand mark is duplicated, on purpose.** The four-blade fan lives in
   four byte-identical copies rather than a shared package, so it cannot drift
   between sites: `ripar-landing-v2/components/ui/mark.tsx`,
   `ripar-app-x402/components/ui/mark.tsx`, `ripar-analytics/components/mark.tsx`
   and `ripar-explorer/components/mark.tsx` (sha256 `66f454fb…`). Change one,
   change all four in the same PR. `ripar-docs` is the exception — it draws its
   own in `components/logo.tsx`, so check it too.
2. **`ripar-app` and `ripar-app-x402` share one Vercel project id**
   (`prj_KClOWZgPhQvKIGfstBDw5Ux0RYSA`). Running `vercel --prod` from the old
   `ripar-app/` directory overwrites `app.ripar.io` with the pre-pivot build.
   Deploy the workspace from `ripar-app-x402/` only.
3. **Only `ripar-sdk` touches money.** Everything else is a reader or a
   renderer. A change there is the only kind that can lose someone's USDC.

## Quick start

```bash
cd ripar-app-x402 && npm install && npm run dev -- -p 3002   # the workspace, demo mode
cd ripar-landing-v2 && npm install && npm run dev            # the marketing site
cd ripar-sdk && npm install && npm test                      # the SDK, offline + live suites
```

Only `ripar-app-x402` reads any environment at all, and it runs fully without
it. See each repo's README.

Every repo has the same CI (`.github/workflows/ci.yml`): Node 22, `npm ci`,
`tsc --noEmit`, then the build — plus vitest in `ripar-sdk`.

## Also in this directory

Not part of Ripar. Listed so nobody wires them in by accident.

| Directory | What it is |
|---|---|
| `ripar-app` | The pre-pivot B2B AI-agents workspace. Superseded by `ripar-app-x402`, and sharing its Vercel project — see the warning above |
| `ripar-landing` | The original red-noir landing (branch `v1`, no remote) |
| `loom-byooooob`, `ripar-loom-landing-page` | **Loom is a separate product, not a Ripar one.** It must never appear on a Ripar surface, in Ripar copy, or in a Ripar deck |
| `references_` | Reference repos cloned for design study (`0rca-*`, SDK samples). Deliberately a sibling of every app repo so it cannot be committed into one |
| `RIPAR-X-CAMPAIGN.md` | Social campaign notes |

## Before you push

Read [`CONTRIBUTING.md`](CONTRIBUTING.md). Two gotchas will each cost you an
hour with no useful error message: commits must be authored as the Vercel
account email or the deploy sits at `BLOCKED` with zero build logs, and running
`npm run build` while `next dev` is live in the same directory clobbers the
shared `.next` and 500s the dev server.
