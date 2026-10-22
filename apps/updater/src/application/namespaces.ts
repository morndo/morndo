// The three namespaces the signed documents are signed under (design §9.6, PROTOCOL.sshsig): a signature made for
// one document never verifies for another. The application names the namespaces, so they live beside it, not in the
// verifier; scripts/release/sign.ts signs the release and feed documents with the same two strings.
export const KEYS_NAMESPACE = "keys@morndo.github.io";
export const RELEASE_NAMESPACE = "release@morndo.github.io";
export const FEED_NAMESPACE = "feed@morndo.github.io";
