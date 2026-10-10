// The one place that picks the zod build (ADR-0008, A2). The schemas use only the functional API that "zod" and
// "zod/mini" share, so switching is this line; the choice and its measured bundle cost are recorded in the ADR.
export * from "zod/mini";
