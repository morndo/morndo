// Opening a chat watches that lane's screen. Closing it stops the watch, so the hub does not keep streaming a chat he left.
export function bindWatch(feed: { watch(worker: string | null): void }, id: string): () => void {
  feed.watch(id);
  return () => feed.watch(null);
}

// The screen follows new output while he is at the bottom. Scrolling up holds the place.
export function pinnedToEnd(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight < 60;
}
