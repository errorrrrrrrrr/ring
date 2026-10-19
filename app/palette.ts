/* ── The stamp palette, in the bundle (spec 3.7, 13.1) ────────────────────────
 * lib/palette.js is ONE UMD file for the server and the composer: the same 56
 * faces, 4 styles, 30 nice, with no copy to drift: the bundle imports the
 * same file the server reads.
 * Typed by lib/palette.d.ts. Pure modules take the palette as a parameter
 * (app/wall.ts stampShelf), so node --test never loads this file.
 */
import P from '../lib/palette.js';

export const PALETTE = P;
