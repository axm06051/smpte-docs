// Text that matches almost any term but carries no information. Shared by the web UI (server.ts)
// and the MCP tools (mcp.ts) so both skip these hits the same way.
//
// This module must stay free of logger imports (logger.ts needs the Bun runtime, and the tests
// import this file under Node). Callers that want visibility pass an `onSkip` callback instead.

export const NOISE_CONFIG = {
  // Share of whitespace-separated tokens that are bare numbers/dots before a window counts as a TOC.
  tocNumericRatio: 0.12,
  // Dot leaders: ". . . ." collapse to long dot runs, or a literal run of this many dots.
  tocDotRun: 10,
  // A run of non-space characters this long is binary data (base64 etc.), not prose.
  blobRun: 100,
  // Characters inspected either side of a match.
  window: 200,
} as const;

export type NoiseReason = 'toc' | 'blob';

// Table of contents: dot leaders or a run of section numbers.
export const isTableOfContents = (chunk: string) => {
  if (new RegExp(`\\.{${NOISE_CONFIG.tocDotRun},}`).test(chunk)) return true;
  const words = chunk.split(/\s+/).filter(Boolean);
  return (
    words.filter((w) => /^[\d.]+$/.test(w)).length / (words.length || 1) >
    NOISE_CONFIG.tocNumericRatio
  );
};

// Embedded binary (base64 images etc.) extracted as text: very long runs with no whitespace.
export const isBlob = (chunk: string) => new RegExp(`\\S{${NOISE_CONFIG.blobRun},}`).test(chunk);

export const noiseReason = (chunk: string): NoiseReason | null =>
  isTableOfContents(chunk) ? 'toc' : isBlob(chunk) ? 'blob' : null;

export const isNoise = (chunk: string) => noiseReason(chunk) !== null;

/**
 * Index of the first match of `rx` in `text` that is NOT in a TOC or binary blob, or -1.
 * `onSkip` is called once per match that was rejected, so callers can log or count them.
 */
export function firstBodyMatch(
  text: string,
  rx: RegExp,
  onSkip?: (reason: NoiseReason, index: number) => void,
  window: number = NOISE_CONFIG.window,
): number {
  const g = new RegExp(rx.source, rx.flags.includes('g') ? rx.flags : rx.flags + 'g');
  for (const m of text.matchAll(g)) {
    const i = m.index ?? 0;
    const reason = noiseReason(text.slice(Math.max(0, i - window), i + window));
    if (!reason) return i;
    onSkip?.(reason, i);
  }
  return -1;
}
