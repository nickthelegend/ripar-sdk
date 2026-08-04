import algosdk from "algosdk";
const ALGOD = "https://testnet-api.algonode.cloud";
const enc = new TextEncoder();

async function box(appId, name) {
  const b64 = Buffer.from(name).toString("base64");
  const r = await fetch(`${ALGOD}/v2/applications/${appId}/box?name=b64:${encodeURIComponent(b64)}`);
  if (!r.ok) return null;
  const j = await r.json();
  return Buffer.from(j.value, "base64");
}

// AgentInfo: (uint64, string, address, uint64, uint64)
const agentT = algosdk.ABIType.from("(uint64,string,address,uint64,uint64)");
const agName = new Uint8Array([...enc.encode("ag_"), ...algosdk.encodeUint64(1)]);
const raw = await box(768547159, agName);
const a = agentT.decode(raw);
console.log("  AGENT 1");
console.log("    id        :", a[0].toString());
console.log("    domain    :", a[1]);
console.log("    address   :", a[2]);
console.log("    registered:", new Date(Number(a[3]) * 1000).toISOString());

// Score: (uint64 x6) — agent_id, jobs_paid, volume, validated, disputed, first, last
const scoreT = algosdk.ABIType.from("(uint64,uint64,uint64,uint64,uint64,uint64,uint64)");
const scName = new Uint8Array([...enc.encode("sc_"), ...algosdk.encodeUint64(1)]);
const s = scoreT.decode(await box(768547170, scName));
console.log("  REPUTATION for agent 1");
console.log("    jobs paid :", s[1].toString());
console.log("    volume    :", Number(s[2]) / 1e6, "USDC");
console.log("    validated :", s[3].toString(), "| disputed:", s[4].toString());

// Job: (uint64, address, uint64, uint64, uint64, byte[], byte[], uint64, uint64, uint64)
const jobT = algosdk.ABIType.from("(uint64,address,uint64,uint64,uint64,byte[],byte[],uint64,uint64,uint64)");
const jbName = new Uint8Array([...enc.encode("jb_"), ...algosdk.encodeUint64(1)]);
const j = jobT.decode(await box(768547172, jbName));
const STATUS = ["open","assigned","submitted","validated","disputed","cancelled"];
console.log("  JOB 1");
console.log("    client    :", j[1]);
console.log("    assignee  : agent", j[2].toString());
console.log("    budget    :", Number(j[4]) / 1e6, "USDC");
console.log("    status    :", STATUS[Number(j[7])]);
