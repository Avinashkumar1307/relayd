import { Route } from 'react-router';
import { CampaignsPage } from './list.js';
import { CampaignDetailPage } from './detail.js';
import { CampaignWizardPage, CreateCampaignPage } from './wizard.js';

/**
 * Section G, campaigns.
 *
 * The wizard's step is a URL segment, not component state: docs/09 wants the
 * form linkable and refresh-safe, and "send me the link to the audience step"
 * is how two people work on one campaign.
 *
 * `/campaigns/new` and `/campaigns/:id/edit/:step` are the same page — the
 * first has no campaign behind it yet and creates one on the first save, so
 * opening the wizard and changing your mind leaves nothing behind.
 *
 * `/campaigns/:id/analytics` is deliberately not here — the campaign report
 * is owned by the analytics fragment, which is where the metric rendering and
 * confidence labelling live.
 */
export const campaignsRoutes = (
  <>
    <Route path="/campaigns" element={<CampaignsPage />} />
    <Route path="/campaigns/new" element={<CreateCampaignPage />} />
    <Route path="/campaigns/:id/edit" element={<CampaignWizardPage />} />
    <Route path="/campaigns/:id/edit/:step" element={<CampaignWizardPage />} />
    <Route path="/campaigns/:id" element={<CampaignDetailPage />} />
  </>
);
