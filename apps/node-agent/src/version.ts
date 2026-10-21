// What this agent tells the fleet about itself: the product Version (the root package.json) and the agent-channel
// protocol versions it speaks, the current and the previous one (spec §5.2; plan Contracts: FLEET_PROTO).
import { FLEET_PROTO } from "@morndo/protocol";
import { productBuild } from "@morndo/service-kit";

export const AGENT_VERSION: string = productBuild().version;
// The commit this agent runs, in the hello; absent when the tree has neither a stamp nor a git HEAD.
export const AGENT_COMMIT: string | null = productBuild().commit;
export const PROTO_VERSIONS: number[] = [FLEET_PROTO - 1, FLEET_PROTO].filter(v => v >= 1);
