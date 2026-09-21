import type { Route, Row } from '../state.js';
import { collection, find, id, nowIso } from '../state.js';
import { CONNECTIONS, POOL_SEEDS, eligibleSenders } from '../data/pools.js';

/**
 * Section H demo routes: sending pools.
 *
 * DEMO ONLY. The derived columns H1a draws — the member chips, the combined
 * rate, the combined headroom and the campaigns using a pool — are computed
 * here from the connection table, the way the API will compute them, rather
 * than written down per pool. That keeps the preview honest when a member is
 * added in the drawer: tick a second SES sender into the newsletter pool and
 * the headroom stays at 8,800, because the connection is counted once.
 *
 * `GET /pools/senders` is the one endpoint here that does not exist yet
 * (BACKEND PENDING); everything else mirrors apps/api/src/routes/pools.ts.
 */

interface Membership {
  id: string;
  poolId: string;
  senderAccountId: string;
}

/** `{ id, name, strategy, ... }`, in the shape `GET /pools` answers. */
const pools = (): Row[] =>
  collection('pools', () =>
    POOL_SEEDS.map((seed) => ({
      id: seed.id,
      name: seed.name,
      strategy: seed.strategy,
      isDefault: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      note: seed.note,
      usedBy: seed.usedBy,
    })),
  );

const members = (): Row[] =>
  collection('poolMembers', () =>
    POOL_SEEDS.flatMap((seed) =>
      seed.memberIds.map((senderAccountId) => ({
        id: `${seed.id}:${senderAccountId}`,
        poolId: seed.id,
        senderAccountId,
      })),
    ),
  );

const memberIdsOf = (poolId: string): string[] =>
  (members() as unknown as Membership[])
    .filter((row) => row.poolId === poolId)
    .map((row) => row.senderAccountId);

const senderOf = (senderId: string) => eligibleSenders.find((row) => row.id === senderId);

/** The distinct connections a set of senders draws on. Counted once each. */
const connectionsOf = (senderIds: readonly string[]) => {
  const ids = new Set<string>();
  for (const senderId of senderIds) {
    const sender = senderOf(senderId);
    if (sender !== undefined) ids.add(sender.connection);
  }

  return [...ids].map((connectionId) => CONNECTIONS[connectionId]).filter((c) => c !== undefined);
};

/** One `GET /pools` row, with the derived columns H1a draws. */
function withDerived(row: Row): Row {
  const senderIds = memberIdsOf(row.id);
  const connections = connectionsOf(senderIds);

  return {
    ...row,
    members: senderIds.flatMap((senderId) => {
      const sender = senderOf(senderId);
      if (sender === undefined) return [];

      const connection = CONNECTIONS[sender.connection];
      return [
        {
          senderAccountId: sender.id,
          email: sender.email,
          monogram: connection?.monogram ?? '—',
        },
      ];
    }),
    combinedPerSecond: connections.reduce((total, c) => total + c.perSecond, 0),
    headroom: {
      remaining: connections.reduce((total, c) => total + c.remainingToday, 0),
      total: connections.reduce((total, c) => total + c.dailyLimit, 0),
      note: row['note'] ?? '',
    },
  };
}

export const routes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/pools$/u,
    handler: () => pools().map(withDerived),
  },

  // BACKEND PENDING: GET /pools/senders. Declared before /pools/:id so the
  // literal segment wins.
  {
    method: 'GET',
    pattern: /^\/pools\/senders$/u,
    handler: () =>
      eligibleSenders.flatMap((sender) => {
        const connection = CONNECTIONS[sender.connection];
        if (connection === undefined) return [];

        return [
          {
            id: sender.id,
            email: sender.email,
            monogram: connection.monogram,
            providerConnectionId: connection.id,
            connectionLabel: connection.label,
            perSecond: connection.perSecond,
            remainingToday: connection.remainingToday,
            blockedReason: sender.blockedReason,
          },
        ];
      }),
  },

  {
    method: 'POST',
    pattern: /^\/pools$/u,
    handler: (_match, body) => {
      const input = body as { name: string; strategy: string };
      const row: Row = {
        id: id('pool_'),
        name: input.name,
        strategy: input.strategy,
        isDefault: false,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        note: '',
        usedBy: [],
      };
      pools().push(row);
      return withDerived(row);
    },
  },

  {
    method: 'GET',
    pattern: /^\/pools\/([^/]+)\/health$/u,
    handler: (match) => {
      const poolId = match[1] ?? '';
      const senderIds = memberIdsOf(poolId);

      return {
        pool: find(pools(), poolId) ?? null,
        members: senderIds.map((senderAccountId) => ({
          poolId,
          senderAccountId,
          providerConnectionId: senderOf(senderAccountId)?.connection ?? '',
          weight: 1,
          priority: 0,
          enabled: true,
          status: 'active',
          healthScore: 98,
          cooldownUntil: null,
        })),
        healthyCount: senderIds.length,
        sharedProviderAccounts: [],
        wouldHold: senderIds.length === 0,
      };
    },
  },

  {
    method: 'POST',
    pattern: /^\/pools\/([^/]+)\/members$/u,
    handler: (match, body) => {
      const poolId = match[1] ?? '';
      const input = body as { senderAccountId: string };
      const row: Row = {
        id: `${poolId}:${input.senderAccountId}`,
        poolId,
        senderAccountId: input.senderAccountId,
      };

      if (find(members(), row.id) === undefined) members().push(row);

      // The real route answers with the pool's whole membership and the
      // connections two members now share, not with the row just written
      // (apps/api/src/services/pools.ts `addMember`).
      return {
        members: memberIdsOf(poolId).map((senderAccountId) => ({
          poolId,
          senderAccountId,
          providerConnectionId: senderOf(senderAccountId)?.connection ?? '',
          weight: 1,
          priority: 0,
          enabled: true,
          status: 'active',
          healthScore: 100,
          cooldownUntil: null,
        })),
        sharedProviderAccounts: [],
      };
    },
  },

  {
    method: 'DELETE',
    pattern: /^\/pools\/([^/]+)\/members\/([^/]+)$/u,
    handler: (match) => {
      const rows = members();
      const index = rows.findIndex((row) => row.id === `${match[1] ?? ''}:${match[2] ?? ''}`);
      if (index >= 0) rows.splice(index, 1);
      return {};
    },
  },

  {
    method: 'PATCH',
    pattern: /^\/pools\/([^/]+)$/u,
    handler: (match, body) => {
      const row = find(pools(), match[1] ?? '');
      if (row !== undefined) Object.assign(row, body as object, { updatedAt: nowIso() });
      return row === undefined ? {} : withDerived(row);
    },
  },

  {
    method: 'DELETE',
    pattern: /^\/pools\/([^/]+)$/u,
    handler: (match) => {
      const rows = pools();
      const index = rows.findIndex((row) => row.id === match[1]);
      if (index >= 0) rows.splice(index, 1);
      return {};
    },
  },

  {
    method: 'GET',
    pattern: /^\/pools\/([^/]+)$/u,
    handler: (match) => {
      const poolId = match[1] ?? '';
      const row = find(pools(), poolId);

      return {
        pool: row === undefined ? null : withDerived(row),
        members: memberIdsOf(poolId).map((senderAccountId) => ({
          poolId,
          senderAccountId,
          providerConnectionId: senderOf(senderAccountId)?.connection ?? '',
          weight: 1,
          priority: 0,
          enabled: true,
          status: 'active',
          healthScore: 98,
          cooldownUntil: null,
        })),
      };
    },
  },
];

/** SPA paths the demo smoke test walks for this section. */
export const previewPaths: string[] = ['/pools', '/pools/new', '/pools/pool_eu_mkt'];
