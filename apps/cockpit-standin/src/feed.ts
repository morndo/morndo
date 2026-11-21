import { validate, type Event, type FeedEvent, type FeedResetSignal } from "@morndo/cockpit-api";
import type { WebSocket } from "ws";
import type { World } from "./world.ts";

type Subscription = { world: () => World; viewer: () => string; named: boolean };
type Entry = { world: World; frame: FeedEvent; audience: Set<string> };
type Delivery = {
  caller?: string;
  audience?: (event: Event) => Set<string>;
  privateTo?: (event: Event) => string | undefined;
  beforeSend?: (frames: FeedEvent[]) => void;
};

export class Feed {
  private seq = 0;
  private readonly buffer: Entry[] = [];
  private readonly clients = new Map<WebSocket, Subscription>();

  publish(world: World, events: readonly Event[], at: string, delivery: Delivery = {}): FeedEvent[] {
    const entries = events.map((event, index): Entry => {
      const frame = this.frame(event, at, this.seq + index + 1);
      const reader = delivery.privateTo?.(event);
      return { world, frame, audience: reader ? new Set([reader]) : delivery.audience?.(event) ?? world.readers(event) };
    });
    const frames = entries.filter(entry => !delivery.caller || this.canRead(entry, delivery.caller)).map(entry => entry.frame);
    delivery.beforeSend?.(frames);
    this.seq += entries.length;
    this.buffer.push(...entries);
    if (this.buffer.length > 1000) this.buffer.splice(0, this.buffer.length - 1000);
    for (const entry of entries) {
      for (const [client, subscription] of this.clients) {
        if (this.visible(entry, subscription)) this.send(client, entry.frame);
      }
    }
    return frames;
  }

  subscribe(client: WebSocket, subscription: Subscription, after: number | null): void {
    this.clients.set(client, subscription);
    client.once("close", () => this.clients.delete(client));
    client.on("error", () => client.terminate());
    if (after === null) return;
    const first = this.buffer[0]?.frame.seq ?? this.seq + 1;
    if (after > this.seq || after < first - 1) {
      this.reset(client);
      return;
    }
    for (const entry of this.buffer) {
      if (entry.frame.seq > after && this.visible(entry, subscription)) this.send(client, entry.frame);
    }
  }

  moduleSwitched(): void {
    for (const [client, subscription] of this.clients) {
      if (!subscription.named) continue;
      this.reset(client);
      client.close(1012, "Reconnect to the active module");
    }
  }

  private reset(client: WebSocket): void {
    const reset: FeedResetSignal = { type: "feed.reset" };
    if (!validate("FeedResetSignal", reset).ok) throw new Error("Invalid feed reset");
    this.send(client, reset);
  }

  ping(): void {
    for (const client of this.clients.keys()) {
      if (client.readyState === client.OPEN) client.ping();
    }
  }

  close(): void {
    for (const client of this.clients.keys()) client.terminate();
    this.clients.clear();
  }

  private visible(entry: Entry, subscription: Subscription): boolean {
    return entry.world === subscription.world() && this.canRead(entry, subscription.viewer());
  }

  private canRead(entry: Entry, id: string): boolean {
    return entry.audience.has(id) && entry.world.canReceive(entry.frame, id);
  }

  private frame(event: Event, at: string, seq: number): FeedEvent {
    const frame: FeedEvent = { ...structuredClone(event), seq, at };
    const check = validate("FeedEvent", frame);
    if (!check.ok) throw new Error(`Invalid feed event ${event.type}: ${check.errors.join(", ")}`);
    return frame;
  }

  private send(client: WebSocket, frame: FeedEvent | FeedResetSignal): void {
    if (client.readyState !== client.OPEN) return;
    if (client.bufferedAmount > 1024 * 1024) {
      client.close(1013, "Reconnect to resume");
      return;
    }
    client.send(JSON.stringify(frame));
  }
}
