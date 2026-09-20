import { Navigate, Route } from 'react-router';
import { ContactsPage } from './contacts.js';
import { ListsPage } from './lists.js';
import { TagsPage } from './tags.js';
import { SuppressionsPage } from './suppressions.js';

/**
 * Section D, the audience collections: the things a contact belongs to.
 *
 * Split from the pipeline fragment next door because the two halves are
 * built by different people — collections are CRUD over stored rows, the
 * pipeline is long-running work — and one file per team is what keeps them
 * out of each other's diffs.
 *
 * `/audience/contacts/:id` renders the contacts page with the drawer open
 * (D2a, D2b) rather than a page of its own: the frames draw the table
 * underneath, the URL makes a contact something you can send someone, and
 * the back button closes the panel.
 *
 * /audience itself has no page of its own, so it redirects to the list a
 * person almost always wants.
 */
export const audienceCollectionsRoutes = (
  <>
    <Route path="/audience/contacts" element={<ContactsPage />} />
    <Route path="/audience/contacts/:id" element={<ContactsPage />} />
    <Route path="/audience/lists" element={<ListsPage />} />
    <Route path="/audience/tags" element={<TagsPage />} />
    <Route path="/audience/suppressions" element={<SuppressionsPage />} />
    <Route path="/audience" element={<Navigate to="/audience/contacts" replace />} />
  </>
);
