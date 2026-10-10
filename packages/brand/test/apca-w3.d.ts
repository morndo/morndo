// The part of apca-w3 0.1.9 the tests use; the package ships no type declarations.
declare module "apca-w3" {
  export function sRGBtoY(rgb: [number, number, number]): number;
  export function APCAcontrast(txtY: number, bgY: number, places?: number): number | string;
}
