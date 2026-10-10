// The code on a Node filesystem error, or "" when the value has none. One place, so a catch does not invent its own cast.
export const errno = (e: unknown): string => {
  if (typeof e !== "object" || e === null || !("code" in e)) return "";
  const code = e.code;
  return typeof code === "string" ? code : "";
};
