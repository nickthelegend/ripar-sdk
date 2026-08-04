# {{name}}

An oracle that sells **signed** price quotes, scaffolded with
`ripar init --template oracle`.

```bash
npm install
cp .env.example .env      # RIPAR_PAY_TO and ORACLE_MNEMONIC
npm run dev
```

**`oracle.ts` ships sample data.** `readPrice` returns fixed constants and every
response carries `"source": "sample"`. Replace it with a real feed before anyone
settles anything against it.

## Why the signature is the product

Anyone can serve a number over HTTPS. What a consumer needs — especially a smart
contract — is a number they can prove *this* oracle said, at that time, without
trusting the transport or any proxy in between.

```json
{
  "quote": {
    "decimals": 6,
    "expiresAt": "2026-01-01T00:01:00.000Z",
    "issuedAt": "2026-01-01T00:00:00.000Z",
    "pair": "ALGO/USD",
    "price": "0.180000",
    "source": "sample"
  },
  "signature": "base64 ed25519 signature",
  "signer": "ORACLE_ALGORAND_ADDRESS...",
  "algorithm": "ed25519"
}
```

Verifying, with the same canonicalisation the signer used:

```ts
import { canonical, verifyQuote } from "./oracle.js";

const ok = verifyQuote(res.quote, res.signature, res.signer);
if (!ok) throw new Error("quote signature does not verify");
if (new Date(res.quote.expiresAt) < new Date()) throw new Error("quote expired");
```

Both checks matter. A valid signature on an expired quote is still an old price.

## Two keys, on purpose

| Key | Role |
| --- | --- |
| `RIPAR_PAY_TO` | Receives settlement. Only ever receives. |
| `ORACLE_MNEMONIC` | Signs every quote. Hotter, and worth rotating separately. |

The signing key needs no balance — it never sends a transaction, it only signs
bytes. Publish its address so consumers can pin it.

## Idempotency window is short here

`idempotency: { windowMs: 5_000 }` — shorter than the shortest TTL a caller can
ask for. A longer window would replay a stale quote to someone who paid for a
fresh one.
