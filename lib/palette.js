/* ── The stamp palette (spec 3.7, 13.1) ───────────────────────────────────────
 * THE fixed reaction vocabulary: faces, not likes (decision 4). Four styles,
 * 56 faces, 30 in `nice` groups: any signed-in member may press a nice face;
 * the full palette is for confirmed friends and ring-mates (enforced in P2).
 *
 * One UMD file for the server and the composer bundle (P3), so the two can never
 * drift. Pure data.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RingPalette = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STAMP_STYLES = [
    { style: 'kaomoji', label: 'Kaomoji', groups: [
      { group: 'warm',     nice: true,  faces: ['(´ ▽ ` )', '(⌒‿⌒)', '( ˘ ³˘)♥', '(っ˘ω˘ς )'] },
      { group: 'cheering', nice: true,  faces: ['＼(^o^)／', '(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧', 'ᕕ( ᐛ )ᕗ', '(ง •̀_•́)ง'] },
      { group: 'wow',      nice: false, faces: ['(⊙_⊙)', 'Σ(°△°)', '(o_O)!', '✧(≖ ◡ ≖)'] },
      { group: 'quiet',    nice: false, faces: ['( ˘ω˘ )', '(._.)', '(⌐■_■)', '…φ(．．)'] },
    ] },
    { style: 'emoji', label: 'Emoji', groups: [
      { group: 'sunny', nice: true,  faces: ['🌞', '✨', '🎉', '🌱', '🌊', '🫶', '🥹', '⭐'] },
      { group: 'loud',  nice: false, faces: ['👀', '🔥', '😭', '🖤', '💫', '🧿'] },
    ] },
    { style: 'ascii', label: 'ASCII', groups: [
      { group: 'classic', nice: true,  faces: [':-)', ':D', '^_^', '<3', '\\o/', '=^.^='] },
      { group: 'wry',     nice: false, faces: [';-)', ':P', 'B-)', ':-O', 'o_O', 'x_x'] },
    ] },
    { style: 'symbols', label: 'Symbols', groups: [
      { group: 'garden', nice: true,  faces: ['✿', '❀', '☼', '♥', '♪', '✧', '✶', '☾'] },
      { group: 'charge', nice: false, faces: ['⚡', '∞', '◎', '☄', '⌘', '♠'] },
    ] },
  ];

  var ALL = [];
  var NICE = [];
  var i, j, k, g;
  for (i = 0; i < STAMP_STYLES.length; i++) {
    for (j = 0; j < STAMP_STYLES[i].groups.length; j++) {
      g = STAMP_STYLES[i].groups[j];
      for (k = 0; k < g.faces.length; k++) {
        ALL.push(g.faces[k]);
        if (g.nice) NICE.push(g.faces[k]);
      }
    }
  }

  return {
    STAMP_STYLES: STAMP_STYLES,
    FACES: ALL,
    NICE_FACES: NICE,
    /* The face every unmappable inbound reaction lands as (spec 4.8). */
    FALLBACK_FACE: '♥',
  };
});
