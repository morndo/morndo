// The passkey check again (AC7): Face ID or Touch ID, then the hub marks the session as freshly verified.
import { startAuthentication } from "@simplewebauthn/browser";
import { api, ApiError } from "./api.ts";

export async function stepUp(): Promise<number> {
  const { flowId, options } = await api.post<{ flowId: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>("/api/stepup/options");
  const response = await startAuthentication({ optionsJSON: options });
  await api.post("/api/stepup/verify", { flowId, response });
  return Date.now();
}

// Runs a command; if the hub asks for a fresh passkey check first, does it and runs the command once more.
export async function withStepUp<T>(run: () => Promise<T>, onVerified: (at: number) => void): Promise<T> {
  try { return await run(); }
  catch (e) {
    if (!(e instanceof ApiError && e.code === "step_up")) throw e;
    onVerified(await stepUp());
    return await run();
  }
}
