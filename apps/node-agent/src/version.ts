// What this agent tells the fleet about itself: its own version (from its package.json) and the agent-channel protocol
// versions it speaks, the current and the previous one (spec §5.2; plan Contracts: FLEET_PROTO).
import { readFileSync } from "node:fs";
import { FLEET_PROTO } from "@morndo/protocol";

export const AGENT_VERSION: string = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
export const PROTO_VERSIONS: number[] = [FLEET_PROTO - 1, FLEET_PROTO].filter(v => v >= 1);
