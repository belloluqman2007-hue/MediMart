import { z } from 'zod';
const text = z.string().trim().max(4000).default('');
const date = z.iso.date();
export const patientSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120),
    dateOfBirth: date.nullable().default(null),
    age: z.number().int().min(0).max(130).nullable().default(null),
    gender: z.enum(['female', 'male', 'other', 'unspecified']),
    phone: z.string().trim().max(40).default(''),
    address: text,
    emergencyContact: text,
    medicalHistory: text,
    allergies: text,
    conditions: text,
    notes: text,
    customerId: z.uuid().nullable().default(null),
    duplicateReason: z.string().trim().max(500).default(''),
  })
  .strict()
  .refine((v) => v.dateOfBirth !== null || v.age !== null, 'Enter date of birth or age.')
  .refine(
    (v) => !v.dateOfBirth || v.dateOfBirth <= new Date().toISOString().slice(0, 10),
    'Birth date cannot be in the future.',
  );
export type PatientInput = z.infer<typeof patientSchema>;
export type Patient = PatientInput & {
  id: string;
  patientCode: string;
  registeredAt: string;
  updatedAt: string;
};
const measurement = (min: number, max: number) =>
  z.number().min(min).max(max).nullable().default(null);
export const vitalsSchema = z
  .object({
    measuredAt: z.iso.datetime(),
    systolic: measurement(20, 350),
    diastolic: measurement(10, 250),
    temperature: measurement(25, 45),
    pulse: measurement(10, 300),
    respiratoryRate: measurement(1, 100),
    oxygenSaturation: measurement(0, 100),
    weight: measurement(0.1, 500),
    height: measurement(10, 260),
  })
  .strict()
  .refine(
    (v) => (v.systolic === null) === (v.diastolic === null),
    'Record both blood-pressure measurements.',
  )
  .refine(
    (v) => Object.entries(v).some(([k, v]) => k !== 'measuredAt' && v !== null),
    'Record at least one measurement.',
  );
export type VitalsInput = z.infer<typeof vitalsSchema>;
export type VitalRecord = VitalsInput & {
  id: string;
  patientId: string;
  bmi: number | null;
  recordedBy: string;
};
export const consultationSchema = z
  .object({
    patientId: z.uuid(),
    consultedAt: z.iso.datetime(),
    complaints: z.string().trim().min(1).max(4000),
    presentingHistory: text,
    medicalHistory: text,
    examination: text,
    impression: text,
    treatmentPlan: text,
    followUp: text,
    notes: text,
  })
  .strict();
export type Consultation = z.infer<typeof consultationSchema> & {
  id: string;
  professionalId: string;
  professionalName: string;
};
export const prescriptionItemSchema = z
  .object({
    productId: z.uuid(),
    strength: z.string().trim().min(1).max(120),
    dosage: z.string().trim().min(1).max(200),
    route: z.string().trim().min(1).max(100),
    frequency: z.string().trim().min(1).max(200),
    duration: z.string().trim().min(1).max(200),
    quantity: z.number().int().positive().max(1000000),
    instructions: text,
  })
  .strict();
export const prescriptionSchema = z
  .object({
    patientId: z.uuid(),
    consultationId: z.uuid().nullable().default(null),
    prescribedAt: z.iso.datetime(),
    items: z
      .array(prescriptionItemSchema)
      .min(1)
      .max(30)
      .refine(
        (items) => new Set(items.map((i) => i.productId)).size === items.length,
        'Use one prescription line per medicine.',
      ),
  })
  .strict();
export type PrescriptionInput = z.infer<typeof prescriptionSchema>;
export type Prescription = Omit<PrescriptionInput, 'items'> & {
  id: string;
  prescriberId: string;
  prescriberName: string;
  status: 'draft' | 'authorized' | 'partial' | 'dispensed' | 'cancelled';
  authorizedBy: string | null;
  cancellationReason: string | null;
  items: (PrescriptionInput['items'][number] & {
    id: string;
    medicineName: string;
    dispensed: number;
  })[];
};
export const healthcareQuerySchema = z.object({
  search: z.string().trim().max(120).default(''),
  patientId: z.uuid().optional(),
  from: date.optional(),
  to: date.optional(),
  status: z
    .enum(['draft', 'authorized', 'partial', 'dispensed', 'cancelled', 'outstanding'])
    .optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
});
export type PatientProfile = {
  patient: Patient;
  consultations?: Consultation[];
  vitals?: VitalRecord[];
  prescriptions?: Prescription[];
};
export type MedicineOption = {
  id: string;
  name: string;
  generic_name: string | null;
  strength: string | null;
  warnings: string | null;
  available: number;
  batches: {
    id: string;
    batch_number: string;
    expiry_date: string | null;
    quantity_remaining: number;
  }[];
};
