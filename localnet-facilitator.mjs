/**
 * A real x402 facilitator, pointed at LocalNet.
 *
 * Not a stub. Verification and settlement are `ExactAvmScheme` from
 * `@x402/avm/exact/facilitator` — the same code a public facilitator runs. What
 * this file supplies is the part that is genuinely deployment-specific: a
 * signer that knows one chain, and the three HTTP routes the protocol defines.
 *
 * It exists because `toFacilitatorAvmSigner` resolves networks through
 * `AlgorandClient.testNet()` / `.mainNet()`, so it can only ever reach a public
 * chain. LocalNet's CAIP-2 matches neither, and a facilitator that cannot be
 * pointed at a local node makes the whole settlement path untestable offline.
 *
 * The fee payer is the funder account: AVM x402 lets the facilitator cover fees
 * so a payer needs only the asset, and `settle` signs those transactions with
 * whatever `getAddresses()` returns.
 *
 *   node localnet-facilitator.mjs          # listens on 4020
 */
import express from "express";
import algosdk from "algosdk";
import fs from "node:fs";
import { configPath } from "./config-path.mjs";
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { ExactAvmScheme } from "@x402/avm/exact/facilitator";
import { ALGORAND_TESTNET_CAIP2 } from "@x402/avm";

const PORT = Number(process.env.FACILITATOR_PORT ?? 4020);
const ALGOD_URL = process.env.ALGOD_URL ?? "http://localhost";
const ALGOD_PORT = process.env.ALGOD_PORT ?? "4001";
const TOKEN = process.env.ALGOD_TOKEN ?? "a".repeat(64);
const CONFIG = configPath("localnet-e2e.json");

const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
const algod = new algosdk.Algodv2(TOKEN, ALGOD_URL, ALGOD_PORT);

/* The fee payer. Its key never leaves this process, and it signs only the
   fee-paying transactions the scheme hands it. */
const feePayer = algosdk.mnemonicToSecretKey(cfg.merchant.mnemonic);

const params = await algod.getTransactionParams().do();
const TRUE_CAIP2 =
  "algorand:" +
  Buffer.from(params.genesisHash).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").slice(0, 32);

/**
 * The id this facilitator advertises, and why it is not the one above.
 *
 * `@x402/avm`'s `normalizeAlgorandNetwork` accepts exactly four strings — the
 * MainNet and TestNet CAIP-2 ids and their full-hash forms — and throws
 * `Unsupported Algorand network` on anything else. A LocalNet genesis hash is
 * generated per container, so it can never be one of those four. Verification
 * therefore refuses every local payment before it looks at the signature.
 *
 * So this advertises the TestNet id. Nothing else is pretended: the signer
 * above holds one algod client and it points at the local node, so every
 * transaction is built, simulated, submitted and confirmed against LocalNet.
 * The network STRING is a label the library insists on; the chain underneath is
 * the local one, and TRUE_CAIP2 is printed at startup so the difference is
 * visible rather than buried.
 *
 * This is a limitation worth fixing upstream — normalizeAlgorandNetwork could
 * take a configured id — and until it is, local development of anything that
 * settles is impossible without this substitution.
 */
const CAIP2 = process.env.FACILITATOR_CAIP2 ?? ALGORAND_TESTNET_CAIP2;

/* algokit's AlgodClient, which is what the scheme expects back from the signer.
   Same node, wrapped in the type the library reaches for. */
const algorand = AlgorandClient.fromClients({ algod });

/** The one deployment-specific piece: a signer bound to a single local node. */
const signer = {
  getAddresses: () => [feePayer.addr.toString()],
  async signTransaction(txnBytes, senderAddress) {
    if (senderAddress !== feePayer.addr.toString()) {
      throw new Error(`asked to sign for ${senderAddress}, which this facilitator does not control`);
    }
    const txn = algosdk.decodeUnsignedTransaction(txnBytes);
    return txn.signTxn(feePayer.sk);
  },
  getAlgodClient: () => algorand.client.algod,
  async simulateTransactions(txns) {
    const stxns = txns.map((t) => algosdk.decodeMsgpack(t, algosdk.SignedTransaction));
    const req = new algosdk.modelsv2.SimulateRequest({
      txnGroups: [new algosdk.modelsv2.SimulateRequestTransactionGroup({ txns: stxns })],
      allowEmptySignatures: true,
    });
    return algod.simulateTransactions(req).do();
  },
  async sendTransactions(signedTxns) {
    const { txid } = await algod.sendRawTransaction(signedTxns).do();
    return txid;
  },
  waitForConfirmation: (txId, _network, waitRounds = 6) =>
    algosdk.waitForConfirmation(algod, txId, waitRounds),
};

const scheme = new ExactAvmScheme(signer);

const app = express();
app.use(express.json({ limit: "1mb" }));

/** What a resource server reads at boot to learn this facilitator's networks. */
app.get("/supported", (_req, res) => {
  res.json({
    kinds: [
      {
        x402Version: 2,
        scheme: "exact",
        network: CAIP2,
        extra: scheme.getExtra?.(CAIP2),
      },
    ],
  });
});

app.post("/verify", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body ?? {};
    const out = await scheme.verify(paymentPayload, paymentRequirements);
    // A local facilitator that refuses silently is the worst kind: the caller
    // sees a bare 402 and cannot tell a bad signature from a wrong asset.
    console.log(
      `  verify  ${out.isValid ? "ok" : `REFUSED ${out.invalidReason}: ${out.invalidMessage ?? ""}`}`
    );
    res.json(out);
  } catch (err) {
    // A facilitator that 500s on a malformed payment tells the caller nothing.
    // The protocol has a field for "this payment is not valid, and why".
    res.json({ isValid: false, invalidReason: String(err?.message ?? err).slice(0, 300) });
  }
});

app.post("/settle", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body ?? {};
    const out = await scheme.settle(paymentPayload, paymentRequirements);
    console.log(`  settle  ${out.success ? out.transaction : `FAILED ${out.errorReason ?? ""}`}`);
    res.json(out);
  } catch (err) {
    res.json({ success: false, errorReason: String(err?.message ?? err).slice(0, 300) });
  }
});

app.listen(PORT, () => {
  console.log(`  x402 facilitator on http://127.0.0.1:${PORT}`);
  console.log(`  chain    ${ALGOD_URL}:${ALGOD_PORT}`);
  console.log(`  network  ${CAIP2}  (advertised — the library accepts no other)`);
  console.log(`  chain id ${TRUE_CAIP2}  (what LocalNet actually is)`);
  console.log(`  feePayer ${feePayer.addr.toString().slice(0, 16)}…`);
});
