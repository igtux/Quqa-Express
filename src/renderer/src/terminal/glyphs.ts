/**
 * xterm's WebGL addon keeps one glyph atlas per font, size and colour
 * scheme and shares it between every terminal that uses them. Each terminal
 * also caches, per cell, where its glyph sits in that atlas. So clearing the
 * atlas for one terminal (a font finished loading) moved the glyphs under
 * every other terminal's feet: they kept drawing from the old positions and
 * showed scattered letters and blocks until their cells changed (the
 * 0.1.0-beta.9 "second local tab breaks the first" bug).
 *
 * Every atlas clear therefore goes through `GlyphAtlas.invalidate()`, which
 * asks all terminals to drop their glyph caches in the same task, before any
 * of them draws again. Hidden terminals draw on the next show.
 */
export interface GlyphUser {
  /** Clear the atlas and this terminal's cached glyph positions, then redraw. */
  redrawGlyphs(): void;
}

export class GlyphAtlas {
  private readonly users = new Set<GlyphUser>();
  private scheduled = false;

  constructor(private readonly defer: (run: () => void) => void = queueMicrotask) {}

  add(user: GlyphUser): void {
    this.users.add(user);
  }

  delete(user: GlyphUser): void {
    this.users.delete(user);
  }

  get size(): number {
    return this.users.size;
  }

  /** All terminals redraw their glyphs once, however often this is called in a task. */
  invalidate(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.defer(() => {
      this.scheduled = false;
      for (const user of [...this.users]) user.redrawGlyphs();
    });
  }
}

/** The one atlas registry of this window. */
export const glyphAtlas = new GlyphAtlas();

let fontsWatched = false;

/**
 * Once per window: when the bundled Georgian fonts (or any later font) finish
 * loading, every terminal redraws glyphs that were cached from a fallback.
 */
export function watchFonts(load: () => Promise<void>): void {
  if (fontsWatched || typeof document === 'undefined' || !('fonts' in document)) return;
  fontsWatched = true;
  document.fonts.addEventListener('loadingdone', () => glyphAtlas.invalidate());
  void load().then(() => glyphAtlas.invalidate());
}
