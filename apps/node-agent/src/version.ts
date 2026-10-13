// What this agent tells the fleet about itself: the product Version (the root package.json) and the agent-channel
// protocol versions it speaks, the current and the previous one (spec §5.2; plan Contracts: FLEET_PROTO).
import { FLEET_PROTO } from "@morndo/protocol";
import { productVersion } from "@morndo/service-kit";

export const AGENT_VERSION: string = productVersion();
export const PROTO_VERSIONS: number[] = [FLEET_PROTO - 1, FLEET_PROTO].filter(v => v >= 1);
