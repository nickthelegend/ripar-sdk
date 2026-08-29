# @ripar/sdk

Ship a paid HTTP endpoint on Algorand. Write a handler, set a price, and every
call settles in USDC over [x402](https://docs.ripar.io/concepts/x402).

```bash
npm install @ripar/sdk
```

Published as `@ripar/sdk@0.1.0`. Installing it puts a `ripar` command on your
path — `ripar quote <url>` reads a live price for free, no wallet and no
account, which is the fastest way to see what this does.

## Start from a template

```bash
ripar init my-agent --template basic    # one echo endpoint, the smallest paid thing
ripar init my-agent --template llm      # prompt completion, priced per token budget
ripar init my-agent --template oracle   # price quotes signed with an Algorand key
cd my-agent && npm install && ripar dev
```

| Command | What it does |
| --- | --- |
| `ripar init <name>` | Scaffold from a template |
| `ripar dev [entry]` | Run an agent locally — no build step, node strips the types |
| `ripar quote <url>` | Read a price. Free, no wallet, no funds |
| `ripar call <url>` | Pay for and invoke an endpoint |
| `ripar manifest <url>` | Print an agent's published manifest |
| `ripar doctor` | Check node, facilitator, network and payout address before you advertise a URL |

`ripar call` reads the wallet from `RIPAR_MNEMONIC`. There is deliberately no
`--mnemonic` flag: it would land in your shell history and in `ps`.

## The whole thing

```ts
import { defineAgent, defineEndpoint, serve } from "@ripar/sdk";

const summarize = defineEndpoint({
  name: "summarize",
  price: "$0.01",
  input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  handler: ({ body }) => ({ summary: body.text.slice(0, 280) }),
});

await serve(defineAgent({
  name: "Text Tools",
  handle: "text-tools",
  description: "Small, cheap text utilities priced per call.",
  payTo: process.env.RIPAR_PAY_TO!,   // settlement lands here directly
  endpoints: [summarize],
}));
```

There is no payment code in that file, and that is the point. `serve()` puts
x402 in front, so an unpaid request never reaches your handler.

## Three things that happen before payment

```ts
await serve(agent, {
  rateLimit:   { perMinute: 60, per: "payer" },   // 429 + Retry-After
  idempotency: { windowMs: 10 * 60_000 },         // honour Idempotency-Key
});
```

The order is `rate limit → idempotency → input validation → payment → handler`,
and the position is the feature. **A request rejected by any of them has not
been charged**, because the payment middleware was never reached.

- **Input validation** — the body is checked against the same `input` schema
  discovery publishes. A missing field is a `400` naming the field, not a
  settled payment for a call that could never have worked.
- **Rate limiting** — keyed on the Algorand address inside the payment header,
  so a caller cannot get a fresh budget by changing IP. Off unless you pass
  `rateLimit`, in-process (two replicas allow two windows), and in `per: "payer"`
  mode it does not limit unpaid traffic at all — an unpaid request has no payer
  to charge the hit to. Note the header is not signature-checked before the
  limiter reads it, so the payer key is a claim rather than proof; see the
  KNOWN GAP note in `src/identity.ts` before relying on it to protect a caller.
- **Idempotency** — a caller who did not receive an answer retries with the same
  `Idempotency-Key` and gets the stored response instead of paying again. A
  `402` is never cached, or the paid retry would be answered with the quote it
  was replying to; nor is a `5xx`, because that response refunded the caller.

  The guarantee is exactly "a **completed 2xx** is replayed, not re-run". It is
  not "a dropped connection can never be charged twice": a request that settled
  and then lost its socket *before writing a response* releases its claim, and
  the retry does reach the payment middleware and settle again. In-process, so
  the store is per-replica too — two instances keep two stores.

## Pricing per request

`price` can be a function. It runs before the 402 is written, so the caller
signs for the amount their own request implies:

```ts
defineEndpoint({
  name: "complete",
  price: ({ body }) => `$${(0.002 + 0.0004 * Math.ceil(body.maxTokens / 100)).toFixed(4)}`,
  priceHint: "$0.0024–$0.0100 (by maxTokens)",   // what discovery shows
  handler: …,
});
```

It has to be cheap (every unpaid probe pays its cost) and deterministic for a
given body (the caller quotes, signs, and sends again — a price that moved in
between rejects a payment they built correctly).

## Calling one

```ts
import { RiparClient } from "@ripar/sdk";

const ripar = new RiparClient({
  mnemonic: process.env.WALLET_MNEMONIC,
  maxPrice: "$0.05",    // refuse anything dearer, whatever the quote says
  maxPerDay: "$5",      // and stop entirely once the day's budget is gone
  retry: { attempts: 3 },
});

const res = await ripar.call("https://api.example.com/summarize", { text: "…" });
res.data;            // { summary: "…" }
res.payment?.txId;   // the Algorand transaction that settled it
res.payment?.usd;    // what it cost, converted from atomic units
```

`quote()` needs no wallet and no funds, so price discovery is free.

Retries use exponential backoff with full jitter, on **5xx and transport
failures only**. A 4xx is never retried: a 402 is the handshake, a 400 will be
wrong again, and repeating either can pay twice for the same mistake. Both caps
are checked against the quote *before* anything is signed, and a quote the
client cannot read is refused rather than paid blind.

## Watching it

| Route | Unpaid | What it is |
| --- | --- | --- |
| `GET /health` | yes | Platform probes |
| `GET /.well-known/ripar.json` | yes | Discovery: price, input schema, asset |
| `GET /metrics` | yes | Prometheus: requests by endpoint+status, in-flight gauge, duration histogram, total settled |
| `GET /_ripar/runs` | yes | The last N calls: id, endpoint, status, ms, txId |

`/_ripar/runs` is a ring buffer, not a log. It carries no request bodies and no
payer addresses — it is world-readable, so it holds only what an operator needs
to answer "is it working and did it settle".

## Announcing it

```ts
import { registerWithBazaar } from "@ripar/sdk";

const result = await registerWithBazaar("https://my-agent.fly.dev/.well-known/ripar.json");
if (!result.ok) console.warn("not listed:", result.error);
```

It never throws. Being listed brings callers; not being listed costs reach and
nothing else — an agent that crashed on boot because a registry was down would
take a working paid endpoint offline over a directory entry.

## Deploy it anywhere

`Dockerfile` plus ready configs in `deploy/` for **Railway**, **Render**,
**Fly.io** and **Heroku**. `/health` is deliberately unpaid so a platform probe
does not read a healthy agent as down.

SIGTERM drains: the server stops accepting work, lets in-flight calls finish,
and only then exits, with a hard timeout so an orchestrator's SIGKILL never
lands mid-write. A paid call killed in flight has already settled — the caller
paid and got a dropped connection.

```bash
docker build -t my-agent .
docker run -p 4021:4021 -e RIPAR_PAY_TO=YOUR_ALGORAND_ADDRESS my-agent
```

## Tests

```bash
npm test
```

Unit tests cover the validation that stops expensive mistakes. Integration tests
run a real server and assert an unpaid call gets a 402 **and the handler never
runs**. `test/mainnet.test.ts` hits the live facilitator and checks the quote
carries USDC `31566704`.

| Suite | What it pins down |
| --- | --- |
| `test/sdk.test.ts` | Definition-time validation, the 402 gate, the manifest |
| `test/guards.test.ts` | 400 before payment, per-request pricing, 429, replay-not-recharge |
| `test/observability.test.ts` | Header decoding, metrics, the run buffer, draining |
| `test/client.test.ts` | Retry policy, spend caps, bazaar tolerance |
| `test/cli.test.ts` | Every command, every template, the oracle's signature |
| `test/mainnet.test.ts` | Live facilitator negotiation on MainNet |

CI splits those two groups on purpose. `.github/workflows/ci.yml` runs
typecheck, build and the offline suite as the gate, and runs
`test/mainnet.test.ts` as a second, advisory job — it talks to GoPlausible over
the public internet, and a third-party outage should be loud without being a
merge blocker. It still goes red, and red still means go and look.

To reproduce the split locally:

```bash
npx vitest run --exclude '**/node_modules/**' --exclude '**/dist/**' --exclude 'test/mainnet.test.ts'
npx vitest run test/mainnet.test.ts
```

The two default excludes are restated because `--exclude` on the CLI *replaces*
the config's list instead of adding to it, and dropping them lets vitest wander
into `node_modules`.

## Gotchas worth knowing

**The CAIP-2 network id has two forms.** `@x402/avm` exports a *truncated*
genesis hash, while facilitators advertise the full one. Hardcoding either
breaks against the other, with an error that reads like an outage. This SDK
resolves the id from the facilitator's `/supported` at boot.

**The x402 headers are base64, and the amounts are atomic.**
`PAYMENT-REQUIRED` and `X-PAYMENT-RESPONSE` carry base64 JSON — `JSON.parse` on
the raw value throws, and code that swallows that throw reads every quote as
"unknown", which is how a price cap ends up never firing while looking like it
is on. Inside, `amount` is in the asset's atomic units: `102000` is $0.102 of
USDC, not $102000. `src/headers.ts` decodes both and refuses to guess the
decimals of an asset it does not know.

See [ARCHITECTURE.md](./ARCHITECTURE.md).

MIT.
