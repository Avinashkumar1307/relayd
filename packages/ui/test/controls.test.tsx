// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Badge, Button, CAMPAIGN_STATES, Field, PasswordField, StateBadge } from '../src/index.js';

/**
 * Buttons, fields and badges (design/00 Design System.dc.html).
 *
 * The rules under test are the sheet's own sentences: a disabled button
 * keeps its label and explains why; errors are inline, in danger, with an
 * icon; the badge word is always present so colour is never the only signal.
 */

afterEach(cleanup);

describe('Button', () => {
  it('is a button, not a submit, unless asked', () => {
    // A stray Enter in a form must not fire a "Delete workspace" button
    // that happened to be inside it.
    render(<Button>Save</Button>);
    expect(screen.getByRole('button').getAttribute('type')).toBe('button');
  });

  it('keeps its label and carries the reason when disabled', () => {
    render(
      <Button disabled title="Viewers cannot create campaigns">
        Create campaign
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Create campaign' });

    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('title')).toBe('Viewers cannot create campaigns');
  });

  it('blocks a second click while pending', async () => {
    let clicks = 0;
    render(
      <Button pending onClick={() => (clicks += 1)}>
        Sign in
      </Button>,
    );
    const button = screen.getByRole('button');

    expect(button.getAttribute('aria-busy')).toBe('true');
    await userEvent.click(button);
    expect(clicks).toBe(0);
  });

  it('has two heights: 34 in the app, 40 on the auth pages', () => {
    render(
      <>
        <Button size="md">App</Button>
        <Button size="lg">Auth</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'App' }).className).toContain('h-[34px]');
    expect(screen.getByRole('button', { name: 'Auth' }).className).toContain('h-10');
  });
});

describe('Field', () => {
  it('labels the input', () => {
    render(<Field label="Email" type="email" />);
    expect(screen.getByLabelText('Email')).toBeTruthy();
  });

  it('shows help below, and swaps it for an inline error', () => {
    const { rerender } = render(<Field label="From email" help="Enter a full address" />);
    expect(screen.getByText('Enter a full address')).toBeTruthy();

    rerender(<Field label="From email" help="Enter a full address" error="Enter a valid address" />);
    expect(screen.queryByText('Enter a full address')).toBeNull();

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Enter a valid address');
    expect(alert.querySelector('svg')).not.toBeNull();
  });

  it('marks the input invalid for assistive tech', () => {
    render(<Field label="Email" error="Required" />);
    const input = screen.getByLabelText('Email');

    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('puts the aside on the label row', () => {
    // B1: "Password" on the left, "Forgot password?" on the right.
    render(<Field label="Password" labelAside={<a href="/forgot-password">Forgot password?</a>} />);
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toBeTruthy();
  });
});

describe('PasswordField', () => {
  it('hides the value until the eye is pressed, then shows it', async () => {
    render(<PasswordField label="Password" defaultValue="s3cret" />);
    const input = screen.getByLabelText('Password') as HTMLInputElement;

    expect(input.type).toBe('password');
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input.type).toBe('text');
    expect(screen.getByRole('button', { name: 'Hide password' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Badge', () => {
  it('always shows the word', () => {
    render(<Badge tone="danger">Failed</Badge>);
    expect(screen.getByText('Failed')).toBeTruthy();
  });

  it('renders a state from the map with its label', () => {
    render(<StateBadge states={CAMPAIGN_STATES} state="completed_with_errors" />);
    expect(screen.getByText('Completed with errors')).toBeTruthy();
  });

  it('shows the raw key beside the label when asked', () => {
    render(<StateBadge states={CAMPAIGN_STATES} state="held" code />);
    expect(screen.getByText('Held')).toBeTruthy();
    expect(screen.getByText('held')).toBeTruthy();
  });

  it('shows an unknown state rather than hiding it', () => {
    render(<StateBadge states={CAMPAIGN_STATES} state="mystery" />);
    expect(screen.getByText('mystery')).toBeTruthy();
  });

  it('adds the lock for a held campaign', () => {
    const { container } = render(<StateBadge states={CAMPAIGN_STATES} state="held" />);
    expect(container.querySelectorAll('svg')).toHaveLength(1);
  });
});
