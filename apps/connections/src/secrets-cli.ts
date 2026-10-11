// morndo-secrets: the machine commands for the node's Secrets (ADR-0022; design §5.2, §6, §14). Not built yet.
export type SecretsIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  // The value's bytes when stdin is piped; null when it is a terminal.
  stdin: Uint8Array | null;
  // A line typed at the terminal after `prompt`, or null with no terminal to ask at.
  confirm: (prompt: string) => Promise<string | null>;
};

export async function runSecrets(_argv: readonly string[], _env: NodeJS.ProcessEnv, _io: SecretsIo): Promise<number> {
  return 1;
}
