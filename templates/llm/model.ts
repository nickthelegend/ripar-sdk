/**
 * THIS IS A STUB. Replace `callModel` with a real provider call.
 *
 * It returns obviously-fake text and sets `stub: true` in the response, because
 * a placeholder that returns plausible prose is a placeholder somebody ships by
 * accident — and then charges USDC for. Failing loudly beats billing quietly.
 */
export type ModelRequest = { prompt: string; system?: string; maxTokens: number };
export type ModelResult = { text: string; model: string; stub: boolean };

export async function callModel(req: ModelRequest): Promise<ModelResult> {
  const provider = process.env.MODEL_PROVIDER;
  if (!provider) {
    return {
      text: `[SAMPLE OUTPUT — no model wired up] Received ${req.prompt.length} characters and a ${req.maxTokens}-token budget. Edit model.ts to call your provider.`,
      model: "stub",
      stub: true,
    };
  }

  /*
   * Wire your provider here. The shape that matters to the rest of the agent:
   *
   *   const res = await fetch(`${process.env.MODEL_BASE_URL}/v1/messages`, {
   *     method: "POST",
   *     headers: {
   *       "content-type": "application/json",
   *       "x-api-key": process.env.MODEL_API_KEY!,
   *     },
   *     body: JSON.stringify({ model, max_tokens: req.maxTokens, ... }),
   *   });
   *   if (!res.ok) throw new Error(`model returned ${res.status}`);
   *
   * Throwing on a bad status is deliberate: `serve()` maps a throw to a 5xx,
   * and a 5xx refunds the caller.
   */
  throw new Error(
    `MODEL_PROVIDER is set to "${provider}" but model.ts has no implementation for it. Wire the provider call, or unset MODEL_PROVIDER to run the stub.`
  );
}
