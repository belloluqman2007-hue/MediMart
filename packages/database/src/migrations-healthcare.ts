import type { Migration } from './migrations';
// Phase 4 is additive: released migrations and existing operational records are untouched.
const capabilities = [
  'patients.register',
  'patients.edit',
  'consultations.create',
  'vitals.record',
  'prescriptions.create',
  'prescriptions.authorize',
  'prescriptions.dispense',
  'prescriptions.cancel',
  'patients.reports',
];
const grants = capabilities.flatMap((code, index) => {
  const roles =
    code === 'prescriptions.dispense'
      ? ['owner', 'administrator', 'pharmacist']
      : ['owner', 'administrator', 'healthcare_professional'];
  return [
    `INSERT INTO permissions(id,code,description) VALUES ('40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}','${code}','Healthcare: ${code}')`,
    ...roles.map(
      (role, r) =>
        `INSERT INTO role_permissions(id,role_id,permission_id) SELECT '41000000-0000-4000-8000-${String(index * 10 + r + 1).padStart(12, '0')}',roles.id,permissions.id FROM roles,permissions WHERE roles.code='${role}' AND permissions.code='${code}'`,
    ),
  ];
});
export const healthcareMigrations: readonly Migration[] = [
  {
    version: 9,
    name: 'patients_consultations_prescriptions_dispensing',
    statements: [
      `ALTER TABLE products ADD COLUMN clinical_warning TEXT CHECK(clinical_warning IS NULL OR length(clinical_warning)<=4000)`,
      `CREATE TABLE patients (id TEXT PRIMARY KEY, patient_code TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL, phone TEXT NOT NULL, phone_normalized TEXT NOT NULL, date_of_birth TEXT, customer_id TEXT REFERENCES customers(id) ON DELETE RESTRICT, data_json TEXT NOT NULL CHECK(json_valid(data_json)), registered_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT`,
      `CREATE INDEX idx_patient_name ON patients(full_name COLLATE NOCASE)`,
      `CREATE INDEX idx_patient_phone ON patients(phone_normalized)`,
      `CREATE TABLE consultations (id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id), professional_id TEXT NOT NULL REFERENCES users(id), consulted_at TEXT NOT NULL, data_json TEXT NOT NULL CHECK(json_valid(data_json))) STRICT`,
      `CREATE INDEX idx_consultation_patient_date ON consultations(patient_id,consulted_at DESC)`,
      `CREATE TABLE patient_vitals (id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id), recorded_by TEXT NOT NULL REFERENCES users(id), measured_at TEXT NOT NULL, data_json TEXT NOT NULL CHECK(json_valid(data_json))) STRICT`,
      `CREATE INDEX idx_vitals_patient ON patient_vitals(patient_id,measured_at DESC)`,
      `CREATE TABLE prescriptions (id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id), consultation_id TEXT REFERENCES consultations(id), prescriber_id TEXT NOT NULL REFERENCES users(id), prescribed_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','authorized','partial','dispensed','cancelled')), authorized_by TEXT REFERENCES users(id), cancellation_reason TEXT, data_json TEXT NOT NULL CHECK(json_valid(data_json))) STRICT`,
      `CREATE INDEX idx_prescription_patient ON prescriptions(patient_id,prescribed_at DESC)`,
      `CREATE TABLE prescription_items (id TEXT PRIMARY KEY, prescription_id TEXT NOT NULL REFERENCES prescriptions(id), product_id TEXT NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL CHECK(quantity>0), dispensed INTEGER NOT NULL DEFAULT 0 CHECK(dispensed>=0 AND dispensed<=quantity), data_json TEXT NOT NULL CHECK(json_valid(data_json))) STRICT`,
      `CREATE TABLE prescription_dispensing (id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, sale_id TEXT UNIQUE REFERENCES sales(id), fingerprint TEXT NOT NULL, prescription_id TEXT NOT NULL REFERENCES prescriptions(id), patient_id TEXT NOT NULL REFERENCES patients(id), dispensed_by TEXT NOT NULL REFERENCES users(id), dispensed_at TEXT NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json))) STRICT`,
      `CREATE TABLE prescription_dispensing_allocations (id TEXT PRIMARY KEY, dispensing_id TEXT NOT NULL REFERENCES prescription_dispensing(id), item_id TEXT NOT NULL REFERENCES prescription_items(id), movement_id TEXT NOT NULL UNIQUE REFERENCES stock_movements(id), quantity INTEGER NOT NULL CHECK(quantity>0)) STRICT`,
      ...grants,
    ],
  },
];
