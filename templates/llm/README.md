# {{name}}

A prompt completion endpoint that bills per request, scaffolded with
`ripar init --template llm`.

```bash
npm install
cp .env.example .env      # then put your Algorand address in RIPAR_PAY_TO
npm run dev
```

**`model.ts` is a stub.** Until you wire a provider it returns text labelled
`[SAMPLE OUTPUT]` and sets `"stub": true` in the response. That is deliberate —
a placeholder that returns convincing prose is one you ship by accident and then
charge USDC for.

## Dynamic pricing

`price` is a function, so the quote follows the request:

```ts
price: ({ body }) => `$${(0.002 + 0.0004 * Math.ceil(clampTokens(body?.maxTokens) / 100)).toFixed(4)}`
```

| `maxTokens` | Quote |
| --- | --- |
| 100 | `$0.0024` |
| 500 | `$0.0040` |
| 2000 | `$0.0100` |

Ask for the price of a specific request — free, no wallet:

```bash
ripar quote http://localhost:4021/complete --body '{"prompt":"hi","maxTokens":2000}'
```

Two rules the function has to keep:

- **Cheap.** It runs on every unpaid probe as well as every paid call.
- **Deterministic for a given body.** The caller quotes, signs, then sends
  again. A price that moved in between rejects a payment they built correctly.

Discovery cannot serialise a function, so `priceHint` is what a browsing agent
sees. It is a range, not an invented number.

## Failure is a refund

A throw or a timeout becomes a 5xx, and a 5xx refunds the caller. Never catch a
provider outage and return 200 with an apology in the body — that bills for
nothing delivered.

## Idempotency matters more here

Generations are slow, so a caller's connection is much more likely to drop after
they have paid. With `Idempotency-Key` set, their retry is answered from the
stored response instead of running — and paying for — the generation twice.

```bash
curl -X POST http://localhost:4021/complete \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: 4f9c1e0a-2b7d-4c3e-9a11-6e2f8d0b5a73' \
  -d '{"prompt":"hello","maxTokens":100}'
```
