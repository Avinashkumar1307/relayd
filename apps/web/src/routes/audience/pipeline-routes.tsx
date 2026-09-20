import { Route } from 'react-router';
import { ImportRunPage, ImportsPage } from './imports.js';
import { SegmentBuilderPage, SegmentsPage } from './segments.js';

/**
 * Section D, the audience pipeline: work that runs over an audience rather
 * than storing one — segments (D5) and imports (D6).
 *
 * `/audience/segments/new` is declared before `/audience/segments/:id` so
 * the literal wins; React Router ranks it that way regardless, and the order
 * here says what is intended rather than relying on it.
 */
export const audiencePipelineRoutes = (
  <>
    <Route path="/audience/segments" element={<SegmentsPage />} />
    <Route path="/audience/segments/new" element={<SegmentBuilderPage />} />
    <Route path="/audience/segments/:id" element={<SegmentBuilderPage />} />
    <Route path="/audience/imports" element={<ImportsPage />} />
    <Route path="/audience/imports/:id" element={<ImportRunPage />} />
  </>
);
