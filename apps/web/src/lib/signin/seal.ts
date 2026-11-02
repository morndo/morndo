// Seals the one-time code to this sign-in's own age recipient before it leaves the browser (ADR-0039, FL14).
const RECIPIENT = /^age1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/;

export async function sealCode(recipient: string, code: string): Promise<string> {
  if (!RECIPIENT.test(recipient)) throw new Error("bad recipient");
  const trimmed = code.trim();
  if (!trimmed) throw new Error("empty code");
  const { Encrypter } = await import("age-encryption");
  const enc = new Encrypter();
  enc.addRecipient(recipient);
  const bytes = await enc.encrypt(trimmed);
  let b64 = "";
  for (let i = 0; i < bytes.length; i++) b64 += String.fromCharCode(bytes[i]!);
  return btoa(b64);
}
