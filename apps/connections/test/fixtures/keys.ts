// Node keys for a test home: nothing is on record there, so a missing key is made. A composition root passes the
// records of the store it holds instead (round 3, points 2 and 9).
import { dirname } from "node:path";
import { NodeKeys } from "../../src/adapters/node-keys.ts";

export const NOTHING_ON_RECORD = (): boolean => false;
// The keys of the home a vault directory or an identity file sits in.
export const keysBeside = (path: string, uid?: number): NodeKeys => new NodeKeys(dirname(path), NOTHING_ON_RECORD, uid);
