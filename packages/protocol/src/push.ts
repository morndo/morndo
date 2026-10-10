// What a push carries (ADR-0008 phase F; N1 in docs/domain.md, the product lane's amendment 4): numbers only. The
// kind as its number (0 a Decision waits, 1 a worker needs you, 2 a device was linked), then the counts. No name, no
// text: push services sit outside the machine. Strict: any other field is refused.
import * as z from "./z.ts";

const count = () => z.int().check(z.gte(0), z.lte(10_000));
export const PushPayload = z.strictObject({ kind: z.int().check(z.gte(0), z.lte(2)), decisions: count(), workers: count(), linked: count() });
export type PushPayload = z.output<typeof PushPayload>;

// The subscription a browser hands over (PushSubscription.toJSON()), checked for shape and size before the hub keeps it.
export const PushSubscriptionBody = z.object({
  endpoint: z.string().check(z.maxLength(1000)),
  keys: z.object({ p256dh: z.string().check(z.maxLength(200)), auth: z.string().check(z.maxLength(64)) }),
});
