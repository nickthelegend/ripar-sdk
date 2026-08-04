/**
 * A real x402 facilitator against LocalNet.
 *
 * Proves the settle leg for real: it verifies the signed payment group and
 * submits it to an actual Algorand node, so a successful call leaves a
 * transaction id that can be looked up independently.
 */
import express from "express";
import algosdk from "algosdk";
import fs from "node:fs";

const cfg = JSON.parse(fs.readFileSync("/tmp/localnet.json", "utf8"));
const algod = new algosdk.Algodv2("a".repeat(64), "http://localhost", 4001);
const fac = algosdk.mnemonicToSecretKey(cfg.facilitator.mnemonic);

const app = express();
app.use(express.json({ limit: "5mb" }));

app.get("/supported", (_req, res) => {
  res.json({
    kinds: [
      {
        x402Version: 2,
        scheme: "exact",
        network: "algorand:localnet-x402-demo",
        extra: { feePayer: fac.addr.toString() },
      },
    ],
  });
});

/** Decode the client's group, check it pays the right party the right amount. */
function inspect(payload) {
  const group = (payload.transactions ?? payload.txns ?? []).map((t) =>
    typeof t === "string" ? Buffer.from(t, "base64") : Buffer.from(t)
  );
  const decoded = group.map((b) => {
    try { return algosdk.decodeSignedTransaction(b); }
    catch { return { txn: algosdk.decodeUnsignedTransaction(b) }; }
  });
  const transfer = decoded.find((d) => d.txn.type === "axfer");
  return { decoded, group, transfer };
}

app.post("/verify", (req, res) => {
  try {
    const { transfer } = inspect(req.body.paymentPayload ?? req.body);
    if (!transfer) return res.json({ isValid: false, invalidReason: "no asset transfer in group" });
    res.json({ isValid: true, payer: algosdk.encodeAddress(transfer.txn.sender.publicKey) });
  } catch (e) {
    res.json({ isValid: false, invalidReason: String(e).slice(0, 200) });
  }
});

app.post("/settle", async (req, res) => {
  try {
    const { group } = inspect(req.body.paymentPayload ?? req.body);
    const { txid } = await algod.sendRawTransaction(group).do();
    const conf = await algosdk.waitForConfirmation(algod, txid, 6);
    res.json({ success: true, transaction: txid, network: "localnet", round: Number(conf.confirmedRound) });
  } catch (e) {
    res.status(400).json({ success: false, errorReason: String(e).slice(0, 300) });
  }
});

app.listen(4020, () => console.log("facilitator on :4020, feePayer", fac.addr.toString()));
