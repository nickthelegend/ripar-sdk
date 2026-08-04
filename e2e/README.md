# End-to-end settlement, for real

These three scripts prove the complete x402 loop against a **live Algorand
node** — not a mock, not a stub. Money moves and the transaction is
independently verifiable.

```
request → 402 with a quote → sign a payment → facilitator settles → 200
```

## Why LocalNet

MainNet would need real USDC. TestNet's dispenser now sits behind an
interactive login. LocalNet is a genuine Algorand node with a genuine indexer
and pre-funded genesis accounts, so every leg of the protocol is exercised for
real — the only thing that differs is which chain the block lands on.

## Run it

```bash
algokit localnet start
node e2e/setup-localnet.mjs          # accounts + a 6-decimal USDC-equivalent ASA
node e2e/facilitator-localnet.mjs &  # a real facilitator: verifies, then submits
node e2e/e2e-localnet.mjs            # the paid call, start to finish
```

## What a passing run looks like

```
before   payer 100 USDC    merchant 0 USDC
  1. unpaid request        → 402, quoted 0.01 USDC
  2. signed the payment
  3. retry with X-PAYMENT  → 200
  4. confirmed on chain
after    payer 99.99 USDC  merchant 0.01 USDC
```

The balances are the assertion. If the handler ran without settling, the
merchant would still be at zero.
