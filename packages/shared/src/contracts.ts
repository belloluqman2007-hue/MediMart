import { z } from 'zod';
import { config } from 'zod/v4/core';
// Validation must also run in the native WebView under a no-unsafe-eval CSP.
config({ jitless: true });
import { roleCodes, type Permission, type RoleCode } from './permissions';
export const uuidSchema = z
  .uuid()
  .regex(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,
    'Use a non-nil RFC UUID.',
  )
  .toLowerCase();
export const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());
export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters.')
  .max(128, 'Use no more than 128 characters.');
export const changePasswordSchema = z
  .strictObject({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema })
  .refine((value) => value.currentPassword !== value.newPassword, 'Choose a different password.');
export const nameSchema = z.string().trim().min(2).max(120);
export const deviceProofSchema = z.strictObject({
  id: uuidSchema,
  secret: z.string().regex(/^[a-f0-9]{64}$/),
});
export const loginSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(128),
  device: deviceProofSchema.optional(),
});
export const ownerRegistrationSchema = z.strictObject({
  fullName: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  bootstrapToken: z.string().min(32).max(128),
});
export const staffRegistrationSchema = z.strictObject({
  fullName: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  roles: z
    .array(z.enum(roleCodes).exclude(['owner']))
    .min(1)
    .max(6)
    .refine((roles) => new Set(roles).size === roles.length, 'Duplicate roles are not allowed.'),
});
export const registerDeviceSchema = z.strictObject({
  id: uuidSchema,
  name: nameSchema,
  platform: z.enum(['android', 'desktop']),
  secret: z.string().regex(/^[a-f0-9]{64}$/),
});
export const approveDeviceSchema = z.strictObject({
  pairingCode: z.string().regex(/^\d{8}$/, 'Enter the eight-digit code shown on the device.'),
});
export const pairingStatusSchema = deviceProofSchema;
export const businessSettingsSchema = z.strictObject({
  businessName: nameSchema,
  shopAddress: z.string().trim().max(300).optional(),
  shopPhone: z
    .string()
    .trim()
    .max(40)
    .refine((value) => !value || /^[0-9+()\-.\s]{6,40}$/.test(value), 'Enter a valid phone number.')
    .optional(),
  shopEmail: z
    .union([z.string().trim().toLowerCase().max(254).pipe(z.email()), z.literal('')])
    .optional(),
  receiptFooter: z.string().trim().max(300).optional(),
});
export type ShopSettings = {
  businessName: string;
  shopAddress: string;
  shopPhone: string;
  shopEmail: string;
  receiptFooter: string;
};
/** Future money columns must be SQLite INTEGER values in kobo, never REAL/float. */
export const moneyKoboSchema = z.number().int().safe().brand<'Kobo'>();
export type MoneyKobo = z.infer<typeof moneyKoboSchema>;
export type UserProfile = {
  id: string;
  fullName: string;
  email: string;
  roles: RoleCode[];
  permissions: Permission[];
};
export type SessionResponse = {
  user: UserProfile;
  expiresAt: string;
  csrfToken?: string;
  token?: string;
};
export type HealthResponse = {
  status: 'ok';
  database: 'ready';
  phase: 6;
  sync: 'offline_capture';
};
export type BootstrapStatus = { required: boolean; enabled: boolean };
export type DeviceSummary = {
  id: string;
  name: string;
  platform: string;
  status: 'pending' | 'approved' | 'revoked';
  created_at: string;
  approved_at: string | null;
  pairing_expires_at: string | null;
};
export type ApiErrorBody = {
  error: { code: string; message: string; requestId: string; fields?: Record<string, string[]> };
};
