import { QueryClient } from '@tanstack/react-query';

/**
 * TanStack Query is the only server-state mechanism in this app. No Redux,
 * no second cache, no hand-rolled fetch state (CLAUDE.md section 2).
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // Retrying a 4xx just delays showing the user what is wrong. Server
        // and network failures are worth one retry.
        retry: (failureCount, error) => {
          const status = (error as { status?: number }).status;
          if (status !== undefined && status >= 400 && status < 500) return false;
          return failureCount < 1;
        },
        refetchOnWindowFocus: false,
      },
    },
  });
}
