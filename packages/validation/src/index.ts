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
