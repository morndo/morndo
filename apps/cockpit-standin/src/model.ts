/** Result of one stand-in read or command. View, command, event, and message types come from `@morndo/cockpit-api`. */
export interface Outcome {
  status: number;
  definition: string;
  body: unknown;
}
