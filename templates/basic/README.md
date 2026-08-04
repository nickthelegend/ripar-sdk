# {{name}}

A paid HTTP endpoint on Algorand, scaffolded with `ripar init --template basic`.

```bash
npm install
cp .env.example .env      # then put your Algorand address in RIPAR_PAY_TO
npm run dev
```

## Try it

```bash
# free: the price, with no wallet and no funds
ripar quote http://localhost:4021/echo

# free: everything a stranger's agent needs to build a valid call
curl http://localhost:4021/.well-known/ripar.json

# 402 — an unpaid call never reaches the handler
curl -X POST http://localhost:4021/echo -H 'content-type: application/json' -d '{"text":"hello"}'

# 400 before payment — a malformed call costs the caller nothing
curl -X POST http://localhost:4021/echo -H 'content-type: application/json' -d '{}'
```

## Paying for it

```bash
export RIPAR_MNEMONIC="your twenty five word mnemonic ..."
ripar call http://localhost:4021/echo --body '{"text":"hello"}' --max-price '$0.01'
```

## Unpaid routes

| Route | What it is for |
| --- | --- |
| `GET /health` | Platform probes. A paid one would read a healthy agent as down. |
| `GET /.well-known/ripar.json` | Discovery. It has to work before payment can. |
| `GET /metrics` | Prometheus: requests by endpoint and status, in-flight, duration, settled. |
| `GET /_ripar/runs` | The last 100 calls: id, endpoint, status, ms, txId. No request bodies. |

## Before you go to MainNet

- `RIPAR_PAY_TO` must be **your** address. Settlement goes straight there, so a
  wrong one loses the money — `defineAgent` checks the shape, not the owner.
- Set `RIPAR_NETWORK=mainnet` and run `ripar doctor` to confirm the facilitator
  agrees before you advertise the URL.
