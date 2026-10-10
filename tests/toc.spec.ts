import { test, expect } from '@playwright/test';
import { firstBodyMatch, isTableOfContents } from '../src/toc';

const toc =
  '1 Scope 5 2 Normative references 5 3 Terms 6 4 Traffic shaping . . . . . . . . . . . . 12 4.1 General 12 5 Timing model . . . . . . . . . . . . 14 5.1 Overview 14 5.2 Clock 15 6 Annex A 20 ';
const filler =
  ' lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '.repeat(12);
const body = 'The sender shall apply traffic shaping to each RTP stream.';
const rx = /traffic shaping/i;

test('TOC text is detected, body text is not', () => {
  expect(isTableOfContents(toc)).toBe(true);
  expect(isTableOfContents(body)).toBe(false);
});

test('firstBodyMatch skips a TOC hit and returns the body hit', () => {
  const text = toc + filler + body;
  expect(text.search(rx)).toBeLessThan(toc.length);
  expect(firstBodyMatch(text, rx)).toBeGreaterThanOrEqual(toc.length + filler.length);
});

test('firstBodyMatch returns -1 when the only match is in the TOC', () => {
  expect(firstBodyMatch(toc, rx)).toBe(-1);
});

test('firstBodyMatch skips embedded base64 blobs', () => {
  const blob =
    'd6aad6aad6aad6aad6aad6aad6aad6aad6aad6aad6aad6aab' +
    'u//xhcp306f/fi/5hcp4dq/50af4d//ptp/e9u/wuj/nrp'.repeat(4);
  expect(firstBodyMatch(blob, /ptp/i)).toBe(-1);
  expect(
    firstBodyMatch(blob + ' ' + filler + body.replace('traffic shaping', 'ptp'), /ptp/i),
  ).toBeGreaterThan(blob.length);
});
