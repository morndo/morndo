// The part of opentype.js 2.0 the generator uses; the package ships no type declarations.
declare module "opentype.js" {
  interface BoundingBox { x1: number; y1: number; x2: number; y2: number }
  interface Path { getBoundingBox(): BoundingBox; toPathData(decimalPlaces?: number): string }
  interface Glyph { advanceWidth: number; getPath(x: number, y: number, fontSize: number): Path }
  interface VariationManager { getTransform(glyph: Glyph, coords: Record<string, number>): Glyph }
  interface Font { unitsPerEm: number; variation: VariationManager; charToGlyph(ch: string): Glyph }
  const opentype: { parse(buffer: ArrayBuffer): Font };
  export default opentype;
}
