import { Route, Routes } from 'react-router';

/**
 * The empty shell. Real routes arrive with the phases that own them: auth and
 * settings in Phase 1, audience in Phase 2, providers and senders in Phase 3,
 * templates in Phase 4, campaigns in Phase 6, dashboards in Phase 7, billing
 * in Phase 8.
 */
function Shell(): JSX.Element {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Relayd</h1>
      <p className="mt-2 text-sm text-slate-600">
        Bring-your-own-provider email campaign orchestration.
      </p>
    </main>
  );
}

export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<Shell />} />
    </Routes>
  );
}
