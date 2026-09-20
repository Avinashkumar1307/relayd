/// <reference types="vite/client" />

/**
 * The build-time environment, declared rather than indexed.
 *
 * This exists for one specific reason. Vite replaces `import.meta.env.FOO`
 * textually at build time, which is what lets Rollup see `undefined === '1'`,
 * fold the branch away and drop the code behind it. It cannot do that for
 * `import.meta.env['FOO']`, so the bracket form leaves a live condition and
 * the preview backend — a fake `fetch` and 100 kB of fixtures — is emitted as
 * a real chunk in a production build. It would never be fetched, but it would
 * ship, and the one thing the preview must never do is reach a deployment.
 *
 * The repository sets `noPropertyAccessFromIndexSignature`, which forbids dot
 * access on `ImportMetaEnv`'s index signature. Declaring the variable here
 * makes it a property rather than an index lookup, so the dot form is legal
 * and the replacement works.
 *
 * Anything added here has to be a `VITE_`-prefixed build-time flag, never a
 * secret: everything in this object is compiled into the bundle and is public.
 */
interface ImportMetaEnv {
  /** `'1'` turns on the preview backend. Development and CI only. */
  readonly VITE_DEMO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
