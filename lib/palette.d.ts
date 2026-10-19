export interface StampGroup { group: string; nice: boolean; faces: string[] }
export interface StampStyle { style: string; label: string; groups: StampGroup[] }
export const STAMP_STYLES: StampStyle[];
export const FACES: string[];
export const NICE_FACES: string[];
export const FALLBACK_FACE: string;
declare const palette: { STAMP_STYLES: StampStyle[]; FACES: string[]; NICE_FACES: string[]; FALLBACK_FACE: string };
export default palette;
