// The document shape and URLs every slice agrees on. Pure: the browser bundles it.

export type SearchDoc = {
  id: number; // also the index in the docs array, so docs[d.parent] is the parent (docs[-1] is undefined)
  slug: string;
  title: string;
  name: string;
  designator: string;
  cat: string;
  parent: number;
  children: number[];
  versions: number;
};

export const BASE = 'https://pub.smpte.org';
export const docUrl = (slug: string) => `${BASE}/doc/${encodeURIComponent(slug)}/`;
