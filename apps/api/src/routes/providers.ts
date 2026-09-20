import { Router, type Request, type Response } from 'express';
import type { GlobalMembershipRepository } from '@relayd/db';
import type { ProviderConnectionId, SenderAccountId } from '@relayd/types';
import {
  connectProviderSchema,
  createSenderSchema,
  renameConnectionSchema,
  rotateCredentialsSchema,
  testSendSchema,
  updateSenderSchema,
} from '@relayd/validation';
import { requireScope } from '../context.js';
import { authenticate, requirePermission, requireWorkspace } from '../middleware/authorize.js';
import type { ApiKeyAuthOptions } from '../middleware/api-key-auth.js';
import { validateBody } from '../middleware/validate.js';
import type { ProviderService } from '../services/providers.js';
import type { TokenService } from '../services/tokens.js';

/**
 * Provider connections and senders.
 *
 * Reads take `provider:read`; every write takes `provider:write`, which
 * docs/06 grants to owners and admins only. Connecting a provider is how a
 * workspace starts spending someone else's sending reputation, and rotating a
 * credential is how someone locks the workspace out of its own provider —
 * neither belongs to an editor.
 */

export interface ProviderRouterOptions {
  providers: ProviderService;
  tokens: TokenService;
  /**
   * Accepts API keys as well as session tokens when wired.
   *
   * Absent in a deployment or a test that has no key store, and then a
   * key-shaped credential falls through to JWT verification and is refused
   * there — never accepted slowly.
   */
  apiKeys?: ApiKeyAuthOptions;
  memberships: GlobalMembershipRepository;
}

export function providerRoutes(options: ProviderRouterOptions): Router {
  const router = Router();
  const { providers } = options;

  const auth = authenticate(options.tokens, options.apiKeys);
  const workspace = requireWorkspace({ memberships: options.memberships });
  const chain = [auth, workspace] as const;

  const read = requirePermission('provider:read');
  const write = requirePermission('provider:write');

  // ------------------------------------------------------------ connections

  router.get('/providers', ...chain, read, async (_req, res: Response) => {
    res.json({ data: await providers.listConnections(requireScope()) });
  });

  router.get('/providers/:id', ...chain, read, async (req: Request, res: Response) => {
    const connection = await providers.getConnection(
      requireScope(),
      req.params['id'] as ProviderConnectionId,
    );
    res.json({ data: connection });
  });

  /**
   * Connect a provider.
   *
   * The response carries the ingest URL, and this is the only place it is
   * ever returned. The endpoint token in it is a bearer credential for
   * writing events into this workspace (F4), so there is no route that reads
   * it back — losing it means rotating the connection, which is the correct
   * trade.
   */
  router.post(
    '/providers',
    ...chain,
    write,
    validateBody(connectProviderSchema),
    async (req: Request, res: Response) => {
      const result = await providers.connect(
        requireScope(),
        req.body as Parameters<ProviderService['connect']>[1],
      );

      res.status(201).json({
        data: {
          ...result.connection,
          ingestUrl: result.ingestUrl,
          // Told once, plainly: a sandboxed SES account or a key without
          // mail.send fails invisibly otherwise.
          warnings: result.warnings,
        },
        meta: { ingestUrlShownOnce: true },
      });
    },
  );

  router.patch(
    '/providers/:id',
    ...chain,
    write,
    validateBody(renameConnectionSchema),
    async (req: Request, res: Response) => {
      const { name } = req.body as { name: string };
      const connection = await providers.rename(
        requireScope(),
        req.params['id'] as ProviderConnectionId,
        name,
      );
      res.json({ data: connection });
    },
  );

  router.post(
    '/providers/:id/verify',
    ...chain,
    write,
    validateBody(rotateCredentialsSchema),
    async (req: Request, res: Response) => {
      const { credentials } = req.body as Parameters<ProviderService['verify']>[2] extends never
        ? never
        : { credentials: Parameters<ProviderService['verify']>[2] };

      const connection = await providers.verify(
        requireScope(),
        req.params['id'] as ProviderConnectionId,
        credentials,
      );
      res.json({ data: connection });
    },
  );

  router.post(
    '/providers/:id/rotate',
    ...chain,
    write,
    validateBody(rotateCredentialsSchema),
    async (req: Request, res: Response) => {
      const { credentials } = req.body as { credentials: Parameters<ProviderService['rotate']>[2] };

      const connection = await providers.rotate(
        requireScope(),
        req.params['id'] as ProviderConnectionId,
        credentials,
      );
      res.json({ data: connection });
    },
  );

  router.delete('/providers/:id', ...chain, write, async (req: Request, res: Response) => {
    await providers.disconnect(requireScope(), req.params['id'] as ProviderConnectionId);
    res.status(204).send();
  });

  /**
   * E1d's "Send test event": prove the inbound webhook path works.
   *
   * `provider:write` rather than `provider:read`. It writes a synthetic row
   * into the workspace's own ingest inbox and leaves an audit trail, and a
   * viewer who can look at a connection has no business putting events into
   * it.
   */
  router.post(
    '/providers/:id/ingest/test',
    ...chain,
    write,
    async (req: Request, res: Response) => {
      const result = await providers.sendIngestTestEvent(
        requireScope(),
        req.params['id'] as ProviderConnectionId,
      );
      res.json({ data: result });
    },
  );

  // ------------------------------------------------------------- identities

  router.get('/providers/:id/identities', ...chain, read, async (req: Request, res: Response) => {
    const identities = await providers.listIdentities(
      requireScope(),
      req.params['id'] as ProviderConnectionId,
    );
    res.json({ data: identities });
  });

  router.post(
    '/providers/:id/identities/sync',
    ...chain,
    write,
    validateBody(rotateCredentialsSchema),
    async (req: Request, res: Response) => {
      const { credentials } = req.body as {
        credentials: Parameters<ProviderService['syncIdentities']>[2];
      };

      const result = await providers.syncIdentities(
        requireScope(),
        req.params['id'] as ProviderConnectionId,
        credentials,
      );
      res.json({ data: result });
    },
  );

  // ---------------------------------------------------------------- senders

  router.get('/senders', ...chain, read, async (req: Request, res: Response) => {
    const providerId = req.query['providerId'];
    const senders = await providers.listSenders(
      requireScope(),
      typeof providerId === 'string' ? (providerId as ProviderConnectionId) : undefined,
    );
    res.json({ data: senders });
  });

  router.post(
    '/senders',
    ...chain,
    write,
    validateBody(createSenderSchema),
    async (req: Request, res: Response) => {
      const sender = await providers.createSender(
        requireScope(),
        req.body as Parameters<ProviderService['createSender']>[1],
      );
      res.status(201).json({ data: sender });
    },
  );

  router.patch(
    '/senders/:id',
    ...chain,
    write,
    validateBody(updateSenderSchema),
    async (req: Request, res: Response) => {
      const sender = await providers.updateSender(
        requireScope(),
        req.params['id'] as SenderAccountId,
        req.body as Parameters<ProviderService['updateSender']>[2],
      );
      res.json({ data: sender });
    },
  );

  router.delete('/senders/:id', ...chain, write, async (req: Request, res: Response) => {
    await providers.removeSender(requireScope(), req.params['id'] as SenderAccountId);
    res.status(204).send();
  });

  /**
   * A test send.
   *
   * Capped at five recipients by the schema. It bypasses campaigns, which is
   * the point — it exists to prove a connection works before anyone commits a
   * campaign to it — and that is exactly why it is capped, audited and behind
   * provider:write.
   */
  /**
   * The SPF / DKIM / DMARC records behind a sender (E2b).
   *
   * `provider:read`: it reports state and reveals nothing a viewer of the
   * connection cannot already see. DNS records are public by construction —
   * the whole point of them is that every receiving mail server can read
   * them.
   */
  router.get('/senders/:id/dns', ...chain, read, async (req: Request, res: Response) => {
    res.json({ data: await providers.senderDns(requireScope(), req.params['id'] as SenderAccountId) });
  });

  /**
   * E2b's "Check DNS now".
   *
   * `provider:write`, because it queues work against the provider on the
   * customer's behalf, and POST rather than GET because it is not safe to
   * repeat without consequence — a GET that enqueues a job is a job a
   * prefetching browser can start.
   */
  router.post(
    '/senders/:id/dns/check',
    ...chain,
    write,
    async (req: Request, res: Response) => {
      res.json({
        data: await providers.checkSenderDns(requireScope(), req.params['id'] as SenderAccountId),
      });
    },
  );

  router.post(
    '/senders/:id/test',
    ...chain,
    write,
    validateBody(testSendSchema),
    async (req: Request, res: Response) => {
      const result = await providers.testSend(requireScope(), {
        ...(req.body as Parameters<ProviderService['testSend']>[1]),
        senderId: req.params['id'] as SenderAccountId,
      });
      res.json({ data: result });
    },
  );

  return router;
}
