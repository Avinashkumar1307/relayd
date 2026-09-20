import { Route } from 'react-router';
import { TemplatesPage } from './list.js';
import { TemplateEditorPage } from './editor.js';

/**
 * Section F, templates.
 *
 * Two routes: the card grid (F1) and the editor (F2). Creating a template is
 * a dialog on the grid rather than a page of its own — F1's "New template"
 * links straight to the editor, and everything the editor needs beyond a
 * name is written in it.
 */
export const templatesRoutes = (
  <>
    <Route path="/templates" element={<TemplatesPage />} />
    <Route path="/templates/:id" element={<TemplateEditorPage />} />
  </>
);
