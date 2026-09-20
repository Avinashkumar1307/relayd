import { Route } from 'react-router';
import { ProvidersPage } from './providers.js';
import { SendersPage } from './senders.js';
import { ConnectProviderPage } from './connect.js';

/**
 * Section E, provider connections and the sender identities built on them.
 *
 * /senders is a sibling path rather than a child of /providers because a
 * sender is chosen when a campaign is composed, long after anyone thinks
 * about which connection carries it.
 *
 * `/senders/:id` is the same list page with the E2b drawer open. The drawer
 * is a route rather than local state so the DNS records a customer is
 * halfway through pasting into their DNS host survive a reload and can be
 * sent to whoever administers the domain.
 */
export const providersRoutes = (
  <>
    <Route path="/providers" element={<ProvidersPage />} />
    <Route path="/providers/connect" element={<ConnectProviderPage />} />
    <Route path="/senders" element={<SendersPage />} />
    <Route path="/senders/:senderId" element={<SendersPage />} />
  </>
);
