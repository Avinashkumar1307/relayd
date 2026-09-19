// @relayd/validation — Zod schemas shared by api and web.
export {
  passwordSchema,
  emailSchema,
  workspaceSlugSchema,
  registerSchema,
  loginSchema,
  verifyEmailSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from './auth.js';
export type { RegisterRequest, LoginRequest, ResetPasswordRequest } from './auth.js';
export {
  contactAttributesSchema,
  consentSchema,
  createContactSchema,
  updateContactSchema,
  listContactsQuerySchema,
  bulkTagSchema,
  listMembershipSchema,
  createListSchema,
  createTagSchema,
  createSegmentSchema,
  createSuppressionSchema,
  bulkSuppressionSchema,
  createImportSchema,
  importMappingSchema,
} from './audience.js';
export type {
  CreateContactRequest,
  UpdateContactRequest,
  CreateImportRequest,
  ImportMappingRequest,
} from './audience.js';
export {
  providerTypeSchema,
  providerCredentialsSchema,
  connectProviderSchema,
  rotateCredentialsSchema,
  renameConnectionSchema,
  createSenderSchema,
  updateSenderSchema,
  testSendSchema,
} from './providers.js';
export type {
  ConnectProviderRequest,
  CreateSenderRequest,
  TestSendRequest,
} from './providers.js';
export {
  createTemplateSchema,
  saveTemplateVersionSchema,
  renameTemplateSchema,
  previewTemplateSchema,
} from './templates.js';
export type { CreateTemplateRequest, SaveTemplateVersionRequest } from './templates.js';
export {
  createCampaignSchema,
  updateCampaignSchema,
  scheduleCampaignSchema,
  launchCampaignSchema,
  consentAttestationSchema,
  CONSENT_SOURCE_VALUES,
  testSendSchema as testSendCampaignSchema,
  cloneCampaignSchema,
  listCampaignsSchema,
  listRecipientsSchema,
  audienceSchema,
  createPoolSchema,
  updatePoolSchema,
  addPoolMemberSchema,
} from './campaigns.js';
export type {
  CreateCampaignInput,
  UpdateCampaignInput,
  ScheduleCampaignInput,
  ListCampaignsInput,
  ListRecipientsInput,
  CreatePoolInput,
  AddPoolMemberInput,
} from './campaigns.js';
