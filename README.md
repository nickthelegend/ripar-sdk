# @ripar/sdk

Ship a paid HTTP endpoint on Algorand. Write a handler, set a price, and every
call settles in USDC over [x402](https://docs.ripar.io/concepts/x402).

```bash
npm install @ripar/sdk
```

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

## Calling one

```ts
import { RiparClient } from "@ripar/sdk";

const ripar = new RiparClient({
  mnemonic: process.env.WALLET_MNEMONIC,
  maxPrice: "$0.05",   // refuse anything dearer, whatever the quote says
});

const res = await ripar.call("https://api.example.com/summarize", { text: "…" });
res.data;            // { summary: "…" }
res.payment?.txId;   // the Algorand transaction that settled it
```

`quote()` needs no wallet and no funds, so price discovery is free.

## What you get

- **402 gating** you cannot accidentally bypass — the handler is behind the middleware
- **Refund on failure** — a throw or a timeout becomes a 5xx, which refunds the caller
- **Discovery** — `/.well-known/ripar.json` publishes price and input schema, so an
  agent that has never met you can build a valid call
- **`maxPrice`** — checked *before* paying, which is the difference between an
  agent that buys a service and one that drains a wallet
- **Fee sponsorship** — the facilitator pays the ALGO fee, so callers need USDC only

## Deploy it anywhere

`Dockerfile` plus ready configs in `deploy/` for **Railway**, **Render**,
**Fly.io** and **Heroku**. `/health` is deliberately unpaid so a platform probe
does not read a healthy agent as down.

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

## Gotcha worth knowing

`@x402/avm` exports a CAIP-2 *truncated* genesis hash, while facilitators
advertise the full one. Hardcoding either breaks against the other, with an
error that reads like an outage. This SDK resolves the id from the facilitator's
`/supported` at boot. See [ARCHITECTURE.md](./ARCHITECTURE.md).

MIT.
