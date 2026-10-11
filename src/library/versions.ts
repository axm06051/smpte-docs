// The /versions/<slug> route: the dated editions listed under a document.
import { pdfUrls, versions } from '../catalog';
import { versionItems } from '../views/versions';
import { docFragment } from './fragment';

export const versionsRoute = (req: Request, u: URL) =>
  docFragment(req, u, '/versions/', (d) => versionItems(d, versions[d.slug] || [], pdfUrls));
