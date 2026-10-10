// This machine as the hub's one node, "local" (fleet core §3.1, §10): the ports of application/ports.ts over node-ops'
// tmux adapter, Claude Code's session registry and its transcript files. The hub runs on these while MORNDO_FLEET_SOCKET
// is unset; they go with the legacy mode after the cutover (sub-project 4).
import { localTranscriptBytes, type SessionInfo, type Tmux as PaneTmux } from "@morndo/node-ops";
import type { RemoteFiles, Sessions, Tmux, TranscriptSource, UploadSink } from "../application/ports.ts";
import type { Files } from "./files.ts";

export const LOCAL_NODE = "local";

// Typing has no key store here: the hub's own `sends` table keeps a request from being typed twice (steering-service.ts).
// `typedAt` is taken as the typing starts, on this machine's clock, which its transcripts' times are on.
export function localTmux(tmux: PaneTmux): Tmux {
  return {
    async listWorkers() {
      return (await tmux.listWorkers()).map(w => ({ id: w.id as string, name: w.name, location: w.location, node: LOCAL_NODE, offline: false }));
    },
    capture: id => tmux.capture(id),
    async captureMany(ids) {
      const out = new Map<string, string | null>();
      for (const id of ids) out.set(id, await tmux.capture(id));
      return out;
    },
    async send(id, text) {
      const typedAt = Date.now();
      return { problem: await tmux.send(id, text), typedAt };
    },
  };
}

type Registry = { byPane(): Map<string, SessionInfo>; transcriptPath(sessionId: string): string | null };

export const localSessions = (registry: Pick<Registry, "byPane">): Sessions => ({ byPane: async () => registry.byPane() });

// A session's transcript by its id: the registry finds the file, node-ops reads its bytes. An unknown session, or a
// file that went away, answers null.
export function localTranscripts(registry: Pick<Registry, "transcriptPath">): TranscriptSource {
  const bytes = (sessionId: string) => {
    const path = registry.transcriptPath(sessionId);
    return path === null ? null : localTranscriptBytes(path);
  };
  return {
    size: async sessionId => (await bytes(sessionId)?.size()) ?? null,
    read: async (sessionId, offset, max) => (await bytes(sessionId)?.read(offset, max)) ?? null,
    locate: async (sessionId, needle) => (await bytes(sessionId)?.locate(needle)) ?? null,
  };
}

// An image the principal attached is already on this machine (uploads.ts wrote it to the inbox): its path is the one
// the note names.
export const localUploads = (): UploadSink => ({ stage: async upload => ({ ok: true, path: upload.path }) });

// A file a worker here names is on this machine: the hub's file store copies it (files.ts).
export const localFiles = (files: Pick<Files, "register">): RemoteFiles => ({ register: (_workerId, path) => files.register(path) });
