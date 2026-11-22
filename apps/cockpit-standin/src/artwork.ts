import { readFileSync } from "node:fs";
import type { Artwork } from "@morndo/cockpit-api";
import { BASE, missing } from "./protocol.ts";

const design = new URL("../../../docs/design/cockpit/src/", import.meta.url);
const catalog = JSON.parse(readFileSync(new URL("heroes.json", design), "utf8")) as (Pick<Artwork, "title" | "manner" | "alt"> & { file: string })[];

function artAt(index: number) {
  const hero = Number.isInteger(index) && index > 0 ? catalog[index - 1] : undefined;
  if (!hero) throw missing("artwork");
  return hero;
}

export function artwork(index: number): Artwork {
  const { title, manner, alt } = artAt(index);
  const path = `${BASE}/brief/artwork/${index}`;
  return {
    index, total: catalog.length, title, manner, alt,
    credit: `Generated for Morndo, in the manner of ${manner}`,
    src: `${path}/image`, glass: `${path}/glass`, position: "center",
  };
}

export function image(index: number, variant: string): Buffer {
  const hero = artAt(index);
  if (variant !== "image" && variant !== "glass") throw missing("artwork");
  const folder = variant === "glass" ? "glass" : "heroes";
  return readFileSync(new URL(`${folder}/${hero.file}.webp`, design));
}
