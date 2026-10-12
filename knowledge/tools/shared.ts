// What the Knowledge commands (sop-check, models-dev) share, one copy each: an error as one line, and the name of a model
// snapshot in the cache directory.
export const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";
// A snapshot is <YYYY-MM-DD>.json, named for the day it was fetched; the date is the first group.
export const SNAPSHOT_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;
