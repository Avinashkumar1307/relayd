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
