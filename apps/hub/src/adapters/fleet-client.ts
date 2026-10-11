// The fleet client moved to packages/fleet-client (fleet clients, Task 3). This module re-exports it for one release, for
// code that still imports it from here; the hub's own code imports "@morndo/fleet-client".
export * from "@morndo/fleet-client";
