// Shared presentation helpers for Relayd frames: tones, state maps, badge + segmented-bar styles.
export const fmt = (n) => (n == null ? '—' : n.toLocaleString('en-US'));

export const TONES = {
  neutral: { fg: 'var(--neutral-text)', bg: 'var(--neutral-soft)', dot: '#6B7280' },
  info: { fg: 'var(--info-text)', bg: 'var(--info-soft)', dot: '#0EA5E9' },
  brand: { fg: 'var(--brand)', bg: 'var(--brand-soft)', dot: 'var(--brand)' },
  warning: { fg: 'var(--warning-text)', bg: 'var(--warning-soft)', dot: '#F59E0B' },
  success: { fg: 'var(--success-text)', bg: 'var(--success-soft)', dot: '#10B981' },
  danger: { fg: 'var(--danger-text)', bg: 'var(--danger-soft)', dot: '#DC2626' },
  uncertain: { fg: 'var(--neutral-text)', bg: 'repeating-linear-gradient(135deg,rgba(100,116,139,.35) 0 2px,transparent 2px 5px)', dot: '#64748B', dashed: true },
  bot: { fg: 'var(--neutral-text)', bg: 'repeating-linear-gradient(135deg,rgba(156,163,175,.4) 0 2px,transparent 2px 5px)', dot: '#9CA3AF', dashed: true },
};

export const CAMPAIGN_STATES = {
  draft: { label: 'Draft', tone: 'neutral' },
  scheduled: { label: 'Scheduled', tone: 'info' },
  validating: { label: 'Validating', tone: 'info', pulse: true },
  queueing: { label: 'Queueing', tone: 'info', pulse: true },
  sending: { label: 'Sending', tone: 'brand', pulse: true },
  pausing: { label: 'Pausing', tone: 'warning' },
  paused: { label: 'Paused', tone: 'warning' },
  cancelling: { label: 'Cancelling', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  completed: { label: 'Completed', tone: 'success' },
  completed_with_errors: { label: 'Completed with errors', tone: 'success', outline: true, dot: 'warning' },
  held: { label: 'Held', tone: 'warning', lock: true },
  failed: { label: 'Failed', tone: 'danger' },
};

export const RECIPIENT_STATES = {
  pending: { label: 'Pending', tone: 'neutral' },
  queued: { label: 'Queued', tone: 'info' },
  sending: { label: 'Sending', tone: 'brand', pulse: true },
  sent: { label: 'Sent', tone: 'info' },
  delivered: { label: 'Delivered', tone: 'success' },
  soft_bounced: { label: 'Soft bounced', tone: 'warning' },
  hard_bounced: { label: 'Hard bounced', tone: 'danger' },
  complained: { label: 'Complained', tone: 'danger' },
  suppressed: { label: 'Suppressed', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
  delivery_uncertain: { label: 'Delivery uncertain', tone: 'uncertain' },
};

export const CONTACT_STATES = {
  subscribed: { label: 'Subscribed', tone: 'success' },
  unsubscribed: { label: 'Unsubscribed', tone: 'neutral' },
  bounced: { label: 'Bounced', tone: 'danger' },
  complained: { label: 'Complained', tone: 'danger' },
};

export const HEALTH = { healthy: ['Healthy', 'success'], degraded: ['Degraded', 'warning'], failed: ['Failed', 'danger'] };

export const badge = (tone, o = {}) => {
  const t = TONES[tone] || TONES.neutral;
  return {
    badgeStyle: { display: 'inline-flex', alignItems: 'center', gap: 6, height: 22, padding: '0 8px', borderRadius: 6, fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', color: t.fg, background: o.outline ? 'transparent' : t.bg, border: t.dashed ? '1px dashed ' + t.dot : '1px solid ' + (o.outline ? t.dot : 'transparent') },
    dotStyle: { width: 6, height: 6, borderRadius: 3, flex: 'none', background: o.dot ? TONES[o.dot].dot : t.dot, animation: o.pulse ? 'rl-pulse 1.2s ease-in-out infinite' : 'none' },
  };
};

export const stateBadge = (map, key) => { const s = map[key] || { label: key, tone: 'neutral' }; return { key, stateLabel: s.label, lock: !!s.lock, ...badge(s.tone, s) }; };

export const SEG_LEGEND = [
  { key: 'delivered', label: 'Delivered', color: '#10B981' },
  { key: 'pending', label: 'Pending / queued', color: 'var(--seg-pending)' },
  { key: 'sending', label: 'Sending', color: 'var(--brand)' },
  { key: 'soft', label: 'Soft bounce', color: '#F59E0B' },
  { key: 'danger', label: 'Hard bounce / complaint / failed', color: '#DC2626' },
  { key: 'uncertain', label: 'Delivery uncertain', color: 'hatch' },
];
export const HATCH = 'repeating-linear-gradient(135deg,#64748B 0 2px,transparent 2px 5px)';
export const swatchStyle = (color) => color === 'hatch'
  ? { width: 10, height: 10, borderRadius: 2, flex: 'none', background: 'repeating-linear-gradient(135deg,#64748B 0 1.5px,transparent 1.5px 4px)', outline: '1px dashed #64748B', outlineOffset: '-1px' }
  : { width: 10, height: 10, borderRadius: 2, flex: 'none', background: color };

// Segments in brief order: delivered, pending/queued, sending, soft, hard+complaint+failed, uncertain
export const segments = (c) => {
  const k = c.counts || {}, total = c.recipients || 0; if (!total) return [];
  const vals = { delivered: k.delivered, pending: (k.pending || 0) + (k.queued || 0), sending: k.sending, soft: k.soft, danger: (k.hard || 0) + (k.complaint || 0) + (k.failed || 0), uncertain: k.uncertain };
  return SEG_LEGEND.filter((l) => vals[l.key] > 0).map((l) => ({ key: l.key, label: l.label, count: vals[l.key], countLabel: fmt(vals[l.key]), title: `${l.label}: ${fmt(vals[l.key])}`, swatch: swatchStyle(l.color),
    style: l.color === 'hatch'
      ? { width: (vals[l.key] / total * 100) + '%', minWidth: 4, flex: 'none', background: HATCH, outline: '1px dashed #64748B', outlineOffset: '-1px' }
      : { width: (vals[l.key] / total * 100) + '%', minWidth: 3, flex: 'none', background: l.color } }));
};

export const clickRate = (c) => { const d = (c.counts || {}).delivered || 0; return c.clicks != null && d ? (c.clicks / d * 100).toFixed(1) + '%' : '—'; };

export const BTN = {
  primary: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, height: 34, padding: '0 12px', border: '1px solid transparent', borderRadius: 8, background: 'var(--brand)', color: 'var(--on-brand)', fontFamily: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap' },
  secondary: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, height: 34, padding: '0 12px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface)', color: 'var(--text)', fontFamily: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap' },
  ghost: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, height: 34, padding: '0 10px', border: '1px solid transparent', borderRadius: 8, background: 'transparent', color: 'var(--text-2)', fontFamily: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap' },
  danger: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, height: 34, padding: '0 12px', border: '1px solid transparent', borderRadius: 8, background: '#DC2626', color: '#FFFFFF', fontFamily: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap' },
  disabled: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, height: 34, padding: '0 12px', border: '1px solid transparent', borderRadius: 8, background: 'var(--neutral-soft)', color: 'var(--text-3)', fontFamily: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'not-allowed', whiteSpace: 'nowrap' },
};
