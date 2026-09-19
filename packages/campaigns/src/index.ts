// @relayd/campaigns — launch, snapshot, dispatch, state machine, rendering.
export { sanitiseTemplateHtml, filterStyle } from './templates/sanitise.js';
export type { SanitiseResult } from './templates/sanitise.js';
export {
  discoverMergeTags,
  renderMergeTags,
  escapeHtml,
  contactValues,
  unresolvableTags,
  CONTACT_FIELDS,
} from './templates/merge-tags.js';
export type { MergeTag, RenderContext, EscapeMode } from './templates/merge-tags.js';
export { compileTemplate, renderTemplate, htmlToText } from './templates/render.js';
export type { CompileInput, CompiledTemplate, RenderedMessage } from './templates/render.js';

export { launchCampaign, LAUNCHABLE_STATES } from './engine/launch.js';
export type { LaunchPort, LaunchableCampaign, LaunchResult, LaunchFailure } from './engine/launch.js';
export { sendOne, classifyForSend, messageIdFor } from './engine/send.js';
export type {
  SendPort,
  SendableRecipient,
  SendResult,
  SendOutcomeKind,
  ProviderCall,
  ProviderCallResult,
} from './engine/send.js';

export {
  dispatchCampaign,
  throttleDelay,
  DISPATCH_WINDOW,
  DISPATCH_PAGE,
} from './engine/dispatch.js';
export type {
  DispatchPort,
  DispatchOptions,
  DispatchResult,
  DispatchStop,
  DispatchableCampaign,
  ClaimedRecipient,
} from './engine/dispatch.js';

export {
  sweepOnce,
  STALE_QUEUED_MS,
  STALE_SENDING_MS,
  TRANSIENT_DEADLINE_MS,
  TRANSIENT_EXITS,
  SWEEP_BATCH,
  SWEEPABLE_CAMPAIGN_STATES,
} from './engine/sweeper.js';
export type {
  SweeperPort,
  SweepOptions,
  SweepResult,
  TransientState,
} from './engine/sweeper.js';

export {
  retryDelayMs,
  planRetry,
  manuallyRetryable,
  retryFailedRecipients,
  MAX_SEND_ATTEMPTS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  RETRY_RESET_COLUMNS,
} from './engine/retry.js';
export type { RetryDecision, RetryFailedPort, RetryFailedResult } from './engine/retry.js';

export {
  applyLifecycleAction,
  settleIfDrained,
  TRANSITIONS,
  TERMINAL_STATES,
  TRANSIENT_STATES,
} from './engine/lifecycle.js';
export type {
  CampaignState,
  LifecycleAction,
  LifecyclePort,
  LifecycleResult,
} from './engine/lifecycle.js';

export {
  selectSender,
  eligibleMembers,
  orderMembers,
  bucketKeysFor,
  sharedConnections,
  mayFailOver,
  MIN_HEALTH,
  MAX_DEFER_MS,
} from './engine/routing.js';
export type {
  PoolMember,
  PoolStrategy,
  RoutingPort,
  RateGrant,
  SenderSelection,
} from './engine/routing.js';

export {
  ingestEvent,
  dedupeKeyFor,
  wouldAdvance,
  isEngagement,
  isDeliveryState,
  DELIVERY_RANK,
  ENGAGEMENT_EVENTS,
  SUPPRESSING_STATES,
} from './engine/events.js';
export type {
  DeliveryState,
  EngagementEvent,
  EventIngestPort,
  IngestResult,
  NormalisedEvent,
} from './engine/events.js';

export {
  ageInDays,
  isInRamp,
  rampCapFor,
  excludedFromPoolRouting,
  sendGate,
  allowanceForBatch,
  autoLiftVerdict,
  quotaDay,
  RAMP_DAYS,
  RAMP_DAILY_CAP,
  AUTO_LIFT_MAX_COMPLAINT_RATE,
  AUTO_LIFT_MAX_BOUNCE_RATE,
  AUTO_LIFT_MIN_SENDS,
} from './abuse/ramp.js';
export type {
  WorkspaceTrust,
  RampSubject,
  SendGate,
  FirstWeekMetrics,
  AutoLiftVerdict,
} from './abuse/ramp.js';
