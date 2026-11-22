/** Rephrase owner-relative system copy for a reader of shared work. */
export function readerCopy(text: string, owner: string): string;
export function readerCopy(text: string | null, owner: string): string | null;
export function readerCopy(text: string | null, owner: string): string | null {
  return text
    ?.replace(/\byour own\b/gi, `${owner}'s own`)
    .replace(/\byour\b/gi, `${owner}'s`)
    .replace(/\b(?:yours)\b/gi, `${owner}'s`)
    .replace(/\byou are\b/gi, `${owner} is`)
    .replace(/\byou have\b/gi, `${owner} has`)
    .replace(/\byou do\b/gi, `${owner} does`)
    .replace(/\byou (decide|hear|lead|talk)\b/gi, (_, verb: string) => `${owner} ${verb.toLowerCase()}s`)
    .replace(/\byou\b/gi, owner) ?? null;
}
