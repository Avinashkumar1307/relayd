import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@relayd/logger';
import { LoggingMailer } from '../src/mailers/logging.js';
import { Notifier, type TransactionalMailer } from '../src/notifier.js';
import { escapeHtml, workspaceInvitation } from '../src/templates.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function build() {
  const send = vi.fn<TransactionalMailer['send']>(async () => undefined);
  const notifier = new Notifier({
    mailer: { send },
    appBaseUrl: 'https://app.relayd.io',
  });
  return { notifier, send };
}

describe('links', () => {
  it('points at the app origin with the token as a query parameter', async () => {
    const { notifier, send } = build();
    await notifier.sendEmailVerification('aisha@example.com', 'tok-123');

    const message = send.mock.calls[0]?.[0];
    expect(message?.text).toContain('https://app.relayd.io/verify-email?token=tok-123');
  });

  it('does not double up the slash when the base URL has a trailing one', async () => {
    const send = vi.fn<TransactionalMailer['send']>(async () => undefined);
    const notifier = new Notifier({ mailer: { send }, appBaseUrl: 'https://app.relayd.io/' });
    await notifier.sendPasswordReset('aisha@example.com', 'tok');

    expect(send.mock.calls[0]?.[0].text).toContain('https://app.relayd.io/reset-password?token=tok');
  });

  it('percent-encodes the token', async () => {
    const { notifier, send } = build();
    await notifier.sendPasswordReset('aisha@example.com', 'a+b/c=d');
    expect(send.mock.calls[0]?.[0].text).toContain('token=a%2Bb%2Fc%3Dd');
  });

  it('uses a distinct path per flow', async () => {
    const { notifier, send } = build();
    await notifier.sendEmailVerification('a@example.com', 't');
    await notifier.sendPasswordReset('a@example.com', 't');
    await notifier.sendWorkspaceInvitation('a@example.com', 'Acme', 't');

    const paths = send.mock.calls.map(([m]) => /https:[^\s]*/u.exec(m.text)?.[0] ?? '');
    expect(paths[0]).toContain('/verify-email');
    expect(paths[1]).toContain('/reset-password');
    expect(paths[2]).toContain('/invitations/accept');
  });
});

describe('content', () => {
  it('sends both a text and an HTML part', async () => {
    const { notifier, send } = build();
    await notifier.sendEmailVerification('aisha@example.com', 'tok');

    const message = send.mock.calls[0]?.[0];
    expect(message?.text.length).toBeGreaterThan(0);
    expect(message?.html).toContain('<!doctype html>');
    expect(message?.subject).toBe('Confirm your email address');
  });

  it('names the workspace in an invitation', async () => {
    const { notifier, send } = build();
    await notifier.sendWorkspaceInvitation('aisha@example.com', 'Acme Corp', 'tok');
    expect(send.mock.calls[0]?.[0].subject).toContain('Acme Corp');
  });

  it('escapes a workspace name so it cannot inject markup', async () => {
    // Workspace names are user-controlled and land in an HTML inbox.
    const rendered = workspaceInvitation({
      workspaceName: '<script>alert(1)</script>',
      acceptUrl: 'https://app.relayd.io/x',
    });

    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });

  it('escapes the five characters that matter', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

describe('development mailer', () => {
  it('records messages instead of sending them', async () => {
    const mailer = new LoggingMailer(
      createLogger({ name: 'test', level: 'fatal', destination: { write: () => undefined } }),
    );
    const notifier = new Notifier({ mailer, appBaseUrl: 'http://localhost:5173' });

    await notifier.sendEmailVerification('aisha@example.com', 'tok');
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.lastTo('aisha@example.com')?.subject).toBe('Confirm your email address');
  });

  it('never writes the token to the log', async () => {
    // A link in a log file is a single-use credential anyone with log access
    // can redeem.
    const lines: string[] = [];
    const mailer = new LoggingMailer(
      createLogger({
        name: 'test',
        level: 'info',
        destination: { write: (line: string) => lines.push(line) },
      }),
    );
    await new Notifier({ mailer, appBaseUrl: 'http://localhost' }).sendPasswordReset(
      'aisha@example.com',
      'super-secret-token',
    );

    expect(lines.join('')).not.toContain('super-secret-token');
    expect(lines.join('')).toContain('aisha@example.com');
  });

  it('bounds what it retains', async () => {
    const mailer = new LoggingMailer(
      createLogger({ name: 't', level: 'fatal', destination: { write: () => undefined } }),
      3,
    );
    for (let i = 0; i < 10; i += 1) {
      await mailer.send({ to: `${i}@example.com`, subject: 's', text: 't', html: 'h' });
    }
    expect(mailer.sent).toHaveLength(3);
  });
});

/**
 * CLAUDE.md: product email is "kept separate from customer sending forever".
 *
 * Structural, because the failure it guards against is someone reaching for
 * the provider adapters already sitting in the monorepo to avoid writing a
 * second SES client. That would work perfectly in every test, bill customers
 * for verification emails, and lock a suspended customer out of resetting
 * their own password.
 */
describe('separation from customer sending', () => {
  it('imports nothing from the customer provider or campaign packages', async () => {
    const entries = await readdir(path.join(packageRoot, 'src'), {
      withFileTypes: true,
      recursive: true,
    });
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.ts'))
      .map((e) => path.join(e.parentPath, e.name));

    const forbidden = ['@relayd/email-providers', '@relayd/campaigns', '@relayd/billing'];
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const match of source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/gu)) {
        const specifier = match[1] ?? '';
        if (forbidden.some((f) => specifier === f || specifier.startsWith(`${f}/`))) {
          offenders.push(`${path.basename(file)} -> ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('declares no dependency on them either', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };

    const declared = Object.keys(manifest.dependencies ?? {});
    expect(declared).not.toContain('@relayd/email-providers');
    expect(declared).not.toContain('@relayd/campaigns');
  });
});
