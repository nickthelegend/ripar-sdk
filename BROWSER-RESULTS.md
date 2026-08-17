# Browser-executed items — method and results

## Method, and its one real limitation

Pages were loaded for real in a Chromium pane. For each: HTTP status, the
server-rendered DOM, `console.error` / `error` / `unhandledrejection` captured
from inside the document, and every subresource with status >= 400 read back
from that document's Performance API.

**The limitation, stated because it changes how one item was judged.** This pane
reports `document.hidden`, so `requestAnimationFrame` is throttled to zero and
React never hydrates inside offscreen iframes. Anything rendered only after
hydration therefore measures as absent. That produced one false FAIL — D1, the
"Sample dataset" badge — which a screenshot then showed rendering correctly at
the top level. Visual items were confirmed by screenshot rather than by DOM
measurement for exactly this reason.

Console-error and failed-request capture are unaffected: both are recorded by
the browser regardless of hydration.

## Results

| Item | Result | Evidence |
|---|---|---|
| A1 | PASS | hero copy present, 0 console errors, 0 failed requests |
| A2 | PASS | apps 768633998/768633999/768634000, 2 agents — matches chain |
| A3 | PASS | button issues a real request; upstream 402; decoded challenge reads `symbol: rUSDC` |
| A4 | PASS | `/pricing` renders |
| A5 | PASS | `/changelog` renders |
| A6 | PASS | `/agents` slug renders |
| A8 | PASS | stats are 402 / finality / fee / forks — no Ripar usage claim |
| B1–B17b | PASS | all 18 docs routes: 200, correct `h1`, body > 300 chars, 0 console errors, 0 failed requests |
| B18 | PASS | ⌘K opens; "escrow" returns `ripar_settle_escrow` under MCP server |
| C1 | PASS | `/` redirects (307), no errors |
| C2 | PASS | `/login` renders sign-in options |
| C4 | PASS | dashboard renders; 20 AlgoNode requests, all 200, 0 console errors (fresh tab) |
| C5 | PASS | `/mission` 200, SIMULATED badge, panels and canvas present, 0 errors |
| D1 | PASS | Sample dataset strip visible (screenshot); prose disclosure also visible |
| D2, D4, D6 | PASS | listings render, 0 errors |
| D3, D5, D7 | PASS | detail routes render real sample records |
| D8 | PASS | `/live` names MainNet, badged real chain data |
| D9–D13 | PASS | registry pages: correct app ids, ticker `rUSDC` matches the asset the registry asserts |
| D14 | PASS | agent 1 resolves with its real score |
| D15 | PASS | `/agent/9999` → "No ag_ box holds that id" |
| D16 | PASS | `/tx/<real>` decodes |
| D17 | PASS | `/tx/NOTAVALIDTXID` → "Could not read that" |
| D18, D19 | PASS | `/search` empty state; unknown term → "Not registered" |
| E1 | PASS | 2.75s block time, 0.0012 ALGO fee, measured live; 44 requests all 200 |
| E2 | PASS | Ripar TestNet section reads the live registries; ticker `rUSDC` |
| E3 | PASS | chart renders; 0 console errors after the SVG height fix |
| I2 | PASS | 0 console errors on every page above |
| I3 | PASS | 0 failed requests on every page above |
| I4 | PASS | unknown route returns HTTP 404 on all five origins |
