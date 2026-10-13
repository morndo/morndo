// install.sh in the repository has no version. The release job stamps the version it is signing,
// so the bootstrap fetches that Release's Manifest and not whatever "latest" happens to be.
export const UNSTAMPED_VERSION = "0.0.0-unstamped";

const LINE = `MORNDO_RELEASE_VERSION='${UNSTAMPED_VERSION}'`;

export function stampVersion(source: string, version: string): string {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`refusing to stamp ${version}`);
  }
  const count = source.split(LINE).length - 1;
  if (count !== 1) throw new Error("install.sh must contain the unstamped version line once");
  return source.replace(LINE, `MORNDO_RELEASE_VERSION='${version}'`);
}
