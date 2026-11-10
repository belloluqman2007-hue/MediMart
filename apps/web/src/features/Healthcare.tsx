import { SalesAccessGate } from './sales/SalesAccessGate';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useLocation } from 'react-router-dom';
import {
  type Permission,
  type Patient,
  type PatientProfile,
  type Consultation,
  type Prescription,
  type PrescriptionInput,
  type MedicineOption,
  type VitalsInput,
  patientSchema,
  consultationSchema,
  prescriptionSchema,
} from '@medimart/shared';
import { useApp } from '../lib/context';
import { errorMessage } from '../lib/api';
import { Button, PageHeading } from '../components/ui';
import { useAsync } from './inventory/lib';
import { ErrorBlock, LoadingBlock } from './inventory/shared';
const now = () => new Date().toISOString();
const localDateTime = (iso: string) => {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="health-field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function TextFields({
  names,
  value,
  onChange,
}: {
  names: Record<string, string>;
  value: Record<string, unknown>;
  onChange: (name: string, value: string) => void;
}) {
  return (
    <>
      {Object.entries(names).map(([key, label]) => (
        <Field key={key} label={label}>
          <textarea
            value={String(value[key] ?? '')}
            onChange={(e) => onChange(key, e.target.value)}
            rows={3}
          />
        </Field>
      ))}
    </>
  );
}
const nav: [string, string, Permission][] = [
  ['/patients', 'Patients', 'patients.view'],
  ['/patients/new', 'Register Patient', 'patients.register'],
  ['/consultations', 'Consultations', 'consultations.view'],
  ['/consultations/new', 'New Consultation', 'consultations.create'],
  ['/prescriptions', 'Prescriptions', 'prescriptions.view'],
  ['/dispensing', 'Dispensing', 'prescriptions.dispense'],
  ['/patient-reports', 'Patient Reports', 'patients.reports'],
];
export function HealthcarePage() {
  const { user } = useApp();
  const location = useLocation();
  const { id } = useParams();
  const path = location.pathname;
  const permission: Permission =
    path === '/patients/new'
      ? 'patients.register'
      : path.endsWith('/edit')
        ? 'patients.edit'
        : path.startsWith('/patients')
          ? 'patients.view'
          : path === '/consultations/new'
            ? 'consultations.create'
            : path.startsWith('/consultations')
              ? 'consultations.view'
              : path === '/dispensing'
                ? 'prescriptions.dispense'
                : path === '/patient-reports'
                  ? 'patients.reports'
                  : 'prescriptions.view';
  if (!user?.permissions.includes(permission))
    return (
      <SalesAccessGate
        eyebrow="Healthcare"
        title={
          path.startsWith('/prescriptions')
            ? 'Prescriptions'
            : path.startsWith('/consultations')
              ? 'Consultations'
              : path.startsWith('/patients')
                ? 'Patients'
                : 'Healthcare'
        }
        description="Confidential patient records require individual authenticated access."
        permission={permission}
      />
    );
  return (
    <div className="healthcare">
      <nav className="health-nav" aria-label="Healthcare">
        {nav
          .filter(([, , p]) => user.permissions.includes(p))
          .map(([url, label]) => (
            <Link key={url} to={url} className={path === url ? 'active' : ''}>
              {label}
            </Link>
          ))}
      </nav>
      {path === '/patients/new' ? (
        <PatientForm />
      ) : path.endsWith('/edit') ? (
        <PatientEditor id={id!} />
      ) : path.startsWith('/patients/') ? (
        <Profile id={id!} />
      ) : path === '/patients' ? (
        <Directory />
      ) : path === '/consultations/new' ? (
        <ConsultationForm />
      ) : path === '/consultations' ? (
        <RecordList kind="consultations" />
      ) : path === '/prescriptions/new' ? (
        <PrescriptionForm />
      ) : path.startsWith('/prescriptions/') ? (
        <PrescriptionDetail id={id!} />
      ) : path === '/patient-reports' ? (
        <PatientReports />
      ) : (
        <RecordList kind="prescriptions" dispensing={path === '/dispensing'} />
      )}
    </div>
  );
}
function PatientPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { api } = useApp();
  const [search, setSearch] = useState('');
  const patients = useAsync(
    () => api.request<{ items: Patient[] }>(`/api/patients?search=${encodeURIComponent(search)}`),
    [search],
  );
  return (
    <>
      <Field label="Find patient by name, phone or ID">
        <input value={search} onChange={(e) => setSearch(e.target.value)} />
      </Field>
      <Field label="Patient">
        <select required value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Select patient</option>
          {patients.data?.items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.fullName} · {p.patientCode}
            </option>
          ))}
        </select>
      </Field>
      {patients.error && <ErrorBlock message={patients.error} />}
    </>
  );
}
function Directory() {
  const { api } = useApp();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const patients = useAsync(
    () =>
      api.request<{ items: Patient[] }>(
        `/api/patients?search=${encodeURIComponent(search)}&page=${page}`,
      ),
    [search, page],
  );
  return (
    <>
      <PageHeading
        eyebrow="Healthcare"
        title="Patients"
        description="Patient identity is separate from customer payment accounts."
      />
      <Field label="Search patients by name, phone or patient ID">
        <input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </Field>
      {patients.error && <ErrorBlock message={patients.error} />}
      <div className="health-cards">
        {patients.data?.items.map((p) => (
          <Link className="health-card" key={p.id} to={`/patients/${p.id}`}>
            <h3>{p.fullName}</h3>
            <p>{p.patientCode}</p>
            <p>{p.phone || 'No phone recorded'}</p>
            <small>Registered {new Date(p.registeredAt).toLocaleDateString()}</small>
          </Link>
        ))}
      </div>
      {patients.loading && <LoadingBlock />}
      {patients.data?.items.length === 0 && <p>No patients found.</p>}
      <Pager page={page} setPage={setPage} more={patients.data?.items.length === 50} />
    </>
  );
}
function Pager({
  page,
  setPage,
  more,
}: {
  page: number;
  setPage: (n: number) => void;
  more: boolean;
}) {
  return (
    <div className="health-actions">
      <Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>
        Previous
      </Button>
      <span>Page {page}</span>
      <Button variant="secondary" disabled={!more} onClick={() => setPage(page + 1)}>
        Next
      </Button>
    </div>
  );
}
const patientNotes = {
  address: 'Address',
  emergencyContact: 'Emergency contact (name, relationship and phone)',
  medicalHistory: 'Relevant medical history',
  allergies: 'Known allergies (record unknown or none known explicitly)',
  conditions: 'Existing medical conditions',
  notes: 'Relevant notes',
  duplicateReason: 'Reason this is a distinct patient (only if duplicate warning)',
};
function PatientEditor({ id }: { id: string }) {
  const { api } = useApp();
  const data = useAsync(() => api.request<PatientProfile>(`/api/patients/${id}`), [id]);
  return data.data ? (
    <PatientForm initial={data.data.patient} />
  ) : data.error ? (
    <ErrorBlock message={data.error} />
  ) : (
    <LoadingBlock />
  );
}
function PatientForm({ initial }: { initial?: Patient }) {
  const { api, notify } = useApp();
  const navigate = useNavigate();
  const [value, setValue] = useState(
    initial ?? {
      fullName: '',
      dateOfBirth: null,
      age: null,
      gender: 'unspecified',
      phone: '',
      address: '',
      emergencyContact: '',
      medicalHistory: '',
      allergies: '',
      conditions: '',
      notes: '',
      customerId: null,
      duplicateReason: '',
    },
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const change = (key: string, v: unknown) => setValue((old) => ({ ...old, [key]: v }));
  const [customerSearch, setCustomerSearch] = useState('');
  const { user } = useApp();
  const customers = useAsync(
    () =>
      userCanCustomers()
        ? api.request<{ items: { id: string; fullName: string }[] }>(
            `/api/customers?search=${encodeURIComponent(customerSearch)}`,
          )
        : Promise.resolve({ items: [] }),
    [customerSearch],
  );
  function userCanCustomers() {
    return user?.permissions.includes('customers.view');
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const input = patientSchema.parse(
        Object.fromEntries(
          Object.entries(value).filter(
            ([key]) => !['id', 'patientCode', 'registeredAt', 'updatedAt'].includes(key),
          ),
        ),
      );
      const p = await api.request<Patient>(
        initial ? `/api/patients/${initial.id}` : '/api/patients',
        initial ? 'PUT' : 'POST',
        input,
      );
      notify('Patient record saved');
      navigate(`/patients/${p.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="Healthcare"
        title={initial ? 'Edit Patient' : 'Register Patient'}
        description="Confidential information. Check existing records before registering."
      />
      <form className="health-form" onSubmit={save}>
        <Field label="Full name">
          <input
            required
            value={value.fullName}
            onChange={(e) => change('fullName', e.target.value)}
          />
        </Field>
        <Field label="Date of birth">
          <input
            type="date"
            value={value.dateOfBirth ?? ''}
            onChange={(e) => change('dateOfBirth', e.target.value || null)}
          />
        </Field>
        <Field label="Age (if birth date unknown)">
          <input
            type="number"
            min="0"
            max="130"
            value={value.age ?? ''}
            onChange={(e) => change('age', e.target.value === '' ? null : Number(e.target.value))}
          />
        </Field>
        <Field label="Gender">
          <select value={value.gender} onChange={(e) => change('gender', e.target.value)}>
            {['unspecified', 'female', 'male', 'other'].map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        </Field>
        <Field label="Phone number">
          <input type="tel" value={value.phone} onChange={(e) => change('phone', e.target.value)} />
        </Field>
        <TextFields names={patientNotes} value={value} onChange={change} />
        {userCanCustomers() && (
          <>
            <Field label="Search customer payment accounts (optional)">
              <input value={customerSearch} onChange={(e) => setCustomerSearch(e.target.value)} />
            </Field>
            <Field label="Linked customer payment account">
              <select
                value={value.customerId ?? ''}
                onChange={(e) => change('customerId', e.target.value || null)}
              >
                <option value="">No linked payment account</option>
                {customers.data?.items.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.fullName}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
        {error && <ErrorBlock message={error} />}
        <Button type="submit" disabled={busy}>
          Save patient
        </Button>
      </form>
    </>
  );
}
function Profile({ id }: { id: string }) {
  const { api, user } = useApp();
  const data = useAsync(() => api.request<PatientProfile>(`/api/patients/${id}`), [id]);
  if (!data.data) return data.error ? <ErrorBlock message={data.error} /> : <LoadingBlock />;
  const { patient: p, consultations, vitals, prescriptions } = data.data;
  return (
    <>
      <PageHeading
        eyebrow={p.patientCode}
        title={p.fullName}
        description={`Registered ${new Date(p.registeredAt).toLocaleDateString()}`}
      />
      <div className="health-actions">
        {user?.permissions.includes('patients.edit') && (
          <Link className="button button-secondary" to={`/patients/${id}/edit`}>
            Edit patient
          </Link>
        )}
        {user?.permissions.includes('consultations.create') && (
          <Link className="button button-primary" to={`/consultations/new?patientId=${id}`}>
            New consultation
          </Link>
        )}
        {user?.permissions.includes('prescriptions.create') && (
          <Link className="button button-secondary" to={`/prescriptions/new?patientId=${id}`}>
            Create prescription
          </Link>
        )}
      </div>
      <section className="health-card">
        <h2>Personal information</h2>
        <p>
          {p.gender} · {p.dateOfBirth ?? `Age ${p.age}`} · {p.phone || 'No phone recorded'}
        </p>
        <p>{p.address}</p>
        <p>Emergency contact: {p.emergencyContact || 'Not recorded'}</p>
        <p>Customer payment account: {p.customerId ?? 'Not linked'}</p>
        <h3>Allergies</h3>
        <p className="health-warning">
          {p.allergies || 'Not recorded — verify before prescribing or dispensing'}
        </p>
        <h3>Medical history</h3>
        <p>{p.medicalHistory || 'Not recorded'}</p>
        <h3>Existing conditions</h3>
        <p>{p.conditions || 'Not recorded'}</p>
        <p>{p.notes}</p>
      </section>
      {user?.permissions.includes('vitals.record') && (
        <VitalsForm patientId={id} onSave={data.reload} />
      )}
      <h2>Patient timeline · Latest first</h2>
      {[
        ...(consultations ?? []).map((c) => ({
          date: c.consultedAt,
          key: c.id,
          node: <ConsultationCard c={c} />,
        })),
        ...(vitals ?? []).map((v) => ({
          date: v.measuredAt,
          key: v.id,
          node: (
            <div>
              <h3>Vital signs</h3>
              <p>{new Date(v.measuredAt).toLocaleString()}</p>
              <div className="health-vitals">
                {Object.entries(vitalLabels).map(
                  ([k, label]) =>
                    v[k as keyof VitalsInput] !== null && (
                      <span key={k}>
                        {label}: {String(v[k as keyof VitalsInput])}
                      </span>
                    ),
                )}
                {v.bmi !== null && (
                  <span>BMI: {v.bmi} kg/m² (interpret for age and clinical context)</span>
                )}
              </div>
            </div>
          ),
        })),
        ...(prescriptions ?? []).map((r) => ({
          date: r.prescribedAt,
          key: r.id,
          node: <RxCard rx={r} />,
        })),
      ]
        .sort((a, b) => b.date.localeCompare(a.date))
        .map((i) => (
          <section className="health-card" key={i.key}>
            {i.node}
          </section>
        ))}
      {!consultations && <p>Consultation history is restricted to authorized clinical staff.</p>}
    </>
  );
}
const vitalLabels = {
  systolic: 'Systolic BP (mmHg)',
  diastolic: 'Diastolic BP (mmHg)',
  temperature: 'Temperature (°C)',
  pulse: 'Pulse (beats/min)',
  respiratoryRate: 'Respiratory rate (breaths/min)',
  oxygenSaturation: 'Oxygen saturation (%)',
  weight: 'Weight (kg)',
  height: 'Height (cm)',
};
function VitalsForm({ patientId, onSave }: { patientId: string; onSave: () => void }) {
  const { api } = useApp();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.request(`/api/patients/${patientId}/vitals`, 'POST', {
        measuredAt: values.measuredAt ? new Date(values.measuredAt).toISOString() : now(),
        ...Object.fromEntries(
          Object.keys(vitalLabels).map((k) => [k, values[k] ? Number(values[k]) : null]),
        ),
      });
      setValues({});
      setError('');
      onSave();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="health-card">
      <summary>Record vital signs</summary>
      <form className="health-form" onSubmit={save}>
        <Field label="Measurement date and time">
          <input
            type="datetime-local"
            value={values.measuredAt ?? ''}
            onChange={(e) => setValues({ ...values, measuredAt: e.target.value })}
          />
        </Field>
        {Object.entries(vitalLabels).map(([key, label]) => (
          <Field key={key} label={label}>
            <input
              type="number"
              step="any"
              value={values[key] ?? ''}
              onChange={(e) => setValues({ ...values, [key]: e.target.value })}
            />
          </Field>
        ))}
        <p>Leave unmeasured values blank. No value will be invented.</p>
        {error && <ErrorBlock message={error} />}
        <Button disabled={busy} type="submit">
          Save vital signs
        </Button>
      </form>
    </details>
  );
}
const consultationLabels = {
  complaints: 'Presenting complaints',
  presentingHistory: 'History of presenting complaints',
  medicalHistory: 'Relevant medical history',
  examination: 'Examination findings',
  impression: 'Assessment / documented clinical impression',
  treatmentPlan: 'Treatment plan',
  followUp: 'Follow-up instructions',
  notes: 'Relevant notes',
};
function ConsultationCard({ c }: { c: Consultation }) {
  return (
    <div>
      <h3>Consultation · {new Date(c.consultedAt).toLocaleString()}</h3>
      <p>Responsible professional: {c.professionalName}</p>
      {Object.entries(consultationLabels).map(([k, label]) => (
        <div key={k}>
          <strong>{label}</strong>
          <p>{c[k as keyof Consultation] || 'Not recorded'}</p>
        </div>
      ))}
      <Link to={`/patients/${c.patientId}`}>Patient profile</Link>
      <br />
      <Link to={`/prescriptions/new?patientId=${c.patientId}&consultationId=${c.id}`}>
        Create prescription for this consultation
      </Link>
    </div>
  );
}
function ConsultationForm() {
  const { api, user } = useApp();
  const navigate = useNavigate();
  const [value, setValue] = useState({
    patientId: new URLSearchParams(useLocation().search).get('patientId') ?? '',
    consultedAt: now(),
    complaints: '',
    presentingHistory: '',
    medicalHistory: '',
    examination: '',
    impression: '',
    treatmentPlan: '',
    followUp: '',
    notes: '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const c = await api.request<Consultation>(
        '/api/consultations',
        'POST',
        consultationSchema.parse(value),
      );
      navigate(`/patients/${c.patientId}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="Healthcare"
        title="New Consultation"
        description="Document professional judgement. MediMart does not generate diagnoses or treatment recommendations."
      />
      <p>Responsible professional: {user?.fullName}</p>
      <form className="health-form" onSubmit={save}>
        <PatientPicker
          value={value.patientId}
          onChange={(patientId) => setValue({ ...value, patientId })}
        />
        <Field label="Consultation date and time">
          <input
            required
            type="datetime-local"
            value={localDateTime(value.consultedAt)}
            onChange={(e) =>
              setValue({
                ...value,
                consultedAt: e.target.value
                  ? new Date(e.target.value).toISOString()
                  : value.consultedAt,
              })
            }
          />
        </Field>
        <TextFields
          names={consultationLabels}
          value={value}
          onChange={(key, v) => setValue({ ...value, [key]: v })}
        />
        {error && <ErrorBlock message={error} />}
        <Button disabled={busy} type="submit">
          Save consultation
        </Button>
      </form>
    </>
  );
}
function RxCard({ rx }: { rx: Prescription }) {
  return (
    <div>
      <h3>Prescription · {rx.status}</h3>
      <p>
        {new Date(rx.prescribedAt).toLocaleString()} · {rx.prescriberName}
      </p>
      <p>
        {rx.items
          .map((i) => `${i.medicineName}: ${i.dispensed}/${i.quantity} dispensed`)
          .join(' · ')}
      </p>
      <Link to={`/prescriptions/${rx.id}`}>View prescription</Link>
    </div>
  );
}
function RecordList({
  kind,
  dispensing = false,
}: {
  kind: 'consultations' | 'prescriptions';
  dispensing?: boolean;
}) {
  const { api, user } = useApp();
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState(dispensing ? 'outstanding' : '');
  const [page, setPage] = useState(1);
  const data = useAsync(
    () =>
      api.request<{ items: (Consultation | Prescription)[] }>(
        `/api/${kind}?search=${encodeURIComponent(search)}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}${status ? `&status=${status}` : ''}&page=${page}`,
      ),
    [kind, search, from, to, status, page],
  );
  return (
    <>
      <PageHeading
        eyebrow="Healthcare"
        title={
          dispensing ? 'Dispensing' : kind === 'consultations' ? 'Consultations' : 'Prescriptions'
        }
        description="Search patient records and filter the clinical history."
      />
      {kind === 'prescriptions' && user?.permissions.includes('prescriptions.create') && (
        <Link className="button button-primary" to="/prescriptions/new">
          Create prescription
        </Link>
      )}
      <div className="health-filters">
        <Field label="Patient name or ID">
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </Field>
        <Field label="From date">
          <input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
        </Field>
        <Field label="To date">
          <input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
        </Field>
        {kind === 'prescriptions' && (
          <Field label="Prescription status">
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              {['', 'draft', 'authorized', 'partial', 'dispensed', 'cancelled', 'outstanding'].map(
                (s) => (
                  <option key={s} value={s}>
                    {s || 'All statuses'}
                  </option>
                ),
              )}
            </select>
          </Field>
        )}
      </div>
      {data.error && <ErrorBlock message={data.error} />}
      <div>
        {data.data?.items.map((r) => (
          <section className="health-card" key={r.id}>
            {kind === 'consultations' ? (
              <ConsultationCard c={r as Consultation} />
            ) : (
              <RxCard rx={r as Prescription} />
            )}
          </section>
        ))}
      </div>
      {data.data?.items.length === 0 && <p>No records found.</p>}
      <Pager page={page} setPage={setPage} more={data.data?.items.length === 50} />
    </>
  );
}
function PrescriptionForm({ initial, onSave }: { initial?: Prescription; onSave?: () => void }) {
  const { api } = useApp();
  const navigate = useNavigate();
  const query = new URLSearchParams(useLocation().search);
  const [value, setValue] = useState<PrescriptionInput>(
    initial ?? {
      patientId: query.get('patientId') ?? '',
      consultationId: query.get('consultationId'),
      prescribedAt: now(),
      items: [],
    },
  );
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const medicines = useAsync(
    () =>
      api.request<{ items: MedicineOption[] }>(
        `/api/healthcare/medicines?search=${encodeURIComponent(search)}`,
      ),
    [search],
  );
  const profile = useAsync(
    () =>
      value.patientId
        ? api.request<PatientProfile>(`/api/patients/${value.patientId}`)
        : Promise.resolve(null),
    [value.patientId],
  );
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const payload = prescriptionSchema.parse({
        patientId: value.patientId,
        consultationId: value.consultationId,
        prescribedAt: value.prescribedAt,
        items: value.items.map(
          ({
            productId,
            strength,
            dosage,
            route,
            frequency,
            duration,
            quantity,
            instructions,
          }) => ({
            productId,
            strength,
            dosage,
            route,
            frequency,
            duration,
            quantity,
            instructions,
          }),
        ),
      });
      const result = await api.request<{ prescription: Prescription }>(
        initial ? `/api/prescriptions/${initial.id}` : '/api/prescriptions',
        initial ? 'PUT' : 'POST',
        payload,
      );
      if (onSave) onSave();
      else navigate(`/prescriptions/${result.prescription.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="Professional prescribing"
        title={initial ? 'Edit prescription draft' : 'Create prescription'}
        description="Drafts do not deduct stock. Only qualified professionals may authorize prescriptions."
      />
      <form className="health-form" onSubmit={save}>
        <PatientPicker
          value={value.patientId}
          onChange={(patientId) => setValue({ ...value, patientId, consultationId: null })}
        />
        {profile.data && (
          <div className="health-warning">
            Allergies: {profile.data.patient.allergies || 'Not recorded — verify'}
            <br />
            Conditions: {profile.data.patient.conditions || 'Not recorded'}
          </div>
        )}
        <Field label="Consultation reference (optional)">
          <select
            value={value.consultationId ?? ''}
            onChange={(e) => setValue({ ...value, consultationId: e.target.value || null })}
          >
            <option value="">No consultation reference</option>
            {profile.data?.consultations?.map((c) => (
              <option key={c.id} value={c.id}>
                {new Date(c.consultedAt).toLocaleString()} · {c.complaints}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Prescription date and time">
          <input
            type="datetime-local"
            required
            value={localDateTime(value.prescribedAt)}
            onChange={(e) =>
              setValue({
                ...value,
                prescribedAt: e.target.value
                  ? new Date(e.target.value).toISOString()
                  : value.prescribedAt,
              })
            }
          />
        </Field>
        <Field label="Search medicine catalogue">
          <input value={search} onChange={(e) => setSearch(e.target.value)} />
        </Field>
        <Field label="Add medicine">
          <select
            value=""
            onChange={(e) => {
              if (e.target.value)
                setValue({
                  ...value,
                  items: [
                    ...value.items,
                    {
                      productId: e.target.value,
                      strength: '',
                      dosage: '',
                      route: '',
                      frequency: '',
                      duration: '',
                      quantity: 1,
                      instructions: '',
                    },
                  ],
                });
            }}
          >
            <option value="">Select medicine</option>
            {medicines.data?.items.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · {m.available} available base units
              </option>
            ))}
          </select>
        </Field>
        {value.items.map((item, index) => (
          <fieldset className="health-card" key={index}>
            <legend>
              {medicines.data?.items.find((m) => m.id === item.productId)?.name ??
                'Selected medicine'}
            </legend>
            <MedicineWarningEditor
              key={`${item.productId}:${medicines.data?.items.find((m) => m.id === item.productId)?.warnings ?? ''}`}
              productId={item.productId}
              initial={medicines.data?.items.find((m) => m.id === item.productId)?.warnings ?? ''}
            />
            {Object.entries({
              strength: 'Strength',
              dosage: 'Dosage',
              route: 'Route of administration',
              frequency: 'Frequency',
              duration: 'Duration',
              instructions: 'Instructions',
            }).map(([key, label]) => (
              <Field key={key} label={label}>
                <input
                  required={key !== 'instructions'}
                  value={String(item[key as keyof typeof item])}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      items: value.items.map((i, n) =>
                        n === index ? { ...i, [key]: e.target.value } : i,
                      ),
                    })
                  }
                />
              </Field>
            ))}
            <Field label="Quantity prescribed (base units)">
              <input
                required
                min="1"
                type="number"
                value={item.quantity}
                onChange={(e) =>
                  setValue({
                    ...value,
                    items: value.items.map((i, n) =>
                      n === index ? { ...i, quantity: Number(e.target.value) } : i,
                    ),
                  })
                }
              />
            </Field>
            <Button
              variant="secondary"
              onClick={() =>
                setValue({ ...value, items: value.items.filter((_, n) => n !== index) })
              }
            >
              Remove medicine
            </Button>
          </fieldset>
        ))}
        {error && <ErrorBlock message={error} />}
        <Button type="submit" disabled={busy || !value.items.length}>
          Save prescription draft
        </Button>
      </form>
    </>
  );
}
type RxDetail = {
  prescription: Prescription;
  patient: Pick<Patient, 'id' | 'fullName' | 'patientCode' | 'dateOfBirth' | 'age'>;
  warnings: {
    allergies: string;
    conditions: string;
    medicalHistory: string;
    medicineWarnings: { name: string; description: string | null }[];
    notice: string;
  };
  dispensing: { id: string; dispensed_at: string; dispensed_by: string }[];
};
function PrescriptionDetail({ id }: { id: string }) {
  const { api, user } = useApp();
  const data = useAsync(() => api.request<RxDetail>(`/api/prescriptions/${id}`), [id]);
  const [error, setError] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [reason, setReason] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [operationId, setOperationId] = useState(crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const medicines = useAsync(
    () =>
      user?.permissions.includes('prescriptions.dispense')
        ? api.request<{ items: MedicineOption[] }>(`/api/healthcare/medicines?prescriptionId=${id}`)
        : Promise.resolve(null),
    [user?.id],
  );
  if (!data.data) return data.error ? <ErrorBlock message={data.error} /> : <LoadingBlock />;
  const { prescription: rx, warnings: w, dispensing } = data.data;
  const can = (p: Permission) => user?.permissions.includes(p);
  const isPrescriber =
    rx.prescriberId === user?.id && user?.roles.includes('healthcare_professional');
  async function act(action: string) {
    setBusy(true);
    setError('');
    try {
      await api.request(
        `/api/prescriptions/${id}/${action}`,
        'POST',
        action === 'authorize'
          ? { reviewedWarnings: reviewed }
          : action === 'cancel'
            ? { reason }
            : {
                operationId,
                reviewedWarnings: reviewed,
                items: rx.items
                  .filter((i) => Number(quantities[i.id]) > 0)
                  .map((i) => ({ itemId: i.id, quantity: Number(quantities[i.id]) })),
              },
      );
      if (action === 'dispense') {
        setOperationId(crypto.randomUUID());
        setQuantities({});
      }
      data.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (editing)
    return (
      <PrescriptionForm
        initial={rx}
        onSave={() => {
          setEditing(false);
          data.reload();
        }}
      />
    );
  return (
    <>
      <PageHeading
        eyebrow="Healthcare"
        title="Prescription"
        description={`${rx.status} · ${new Date(rx.prescribedAt).toLocaleString()}`}
      />
      <div className="print-prescription">
        <h2>MediMart · Prescription</h2>
        <p>Reference: {rx.id}</p>
        <p>
          Patient: {data.data.patient.fullName} · {data.data.patient.patientCode} ·{' '}
          {data.data.patient.dateOfBirth ?? `Age ${data.data.patient.age}`} ·{' '}
          <Link to={`/patients/${rx.patientId}`}>Patient profile</Link>
        </p>
        <p>Prescriber: {rx.prescriberName}</p>
        <p>Consultation: {rx.consultationId ?? 'Not linked'}</p>
        <p>Status: {rx.status}</p>
        {rx.items.map((i) => (
          <section className="health-card" key={i.id}>
            <h3>
              {i.medicineName} · {i.strength}
            </h3>
            <p>
              {i.dosage} · {i.route} · {i.frequency} · {i.duration}
            </p>
            <p>
              Quantity prescribed: {i.quantity} base units · Dispensed: {i.dispensed} · Remaining:{' '}
              {i.quantity - i.dispensed}
            </p>
            <p>{i.instructions}</p>
          </section>
        ))}
      </div>
      <div className="health-warning">
        <h3>Professional safety review</h3>
        <p>Allergies: {w.allergies || 'Not recorded — verify with patient'}</p>
        <p>Conditions: {w.conditions || 'Not recorded'}</p>
        <p>History: {w.medicalHistory || 'Not recorded'}</p>
        {w.medicineWarnings.map((m, i) => (
          <p key={i}>
            {m.name} ·{' '}
            {m.description ||
              'No catalogue warning recorded. Check professional medicine references.'}
          </p>
        ))}
        <p>{w.notice}</p>
      </div>
      <div className="health-actions">
        <Button variant="secondary" onClick={() => window.print()}>
          Print prescription
        </Button>
        {rx.status === 'draft' && isPrescriber && can('prescriptions.create') && (
          <Button onClick={() => setEditing(true)}>Edit draft</Button>
        )}
      </div>
      {['draft', 'authorized', 'partial'].includes(rx.status) && (
        <Field label="I have reviewed current allergies, conditions and medicine warnings">
          <input
            type="checkbox"
            checked={reviewed}
            onChange={(e) => setReviewed(e.target.checked)}
          />
        </Field>
      )}
      {rx.status === 'draft' && isPrescriber && can('prescriptions.authorize') && (
        <Button disabled={busy || !reviewed} onClick={() => act('authorize')}>
          Authorize prescription
        </Button>
      )}
      {['draft', 'authorized', 'partial'].includes(rx.status) &&
        can('prescriptions.cancel') &&
        user?.roles.includes('healthcare_professional') && (
          <div className="health-card">
            <Field label="Cancellation reason">
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <Button
              variant="secondary"
              disabled={busy || reason.trim().length < 5}
              onClick={() => act('cancel')}
            >
              Cancel prescription
            </Button>
          </div>
        )}
      {rx.cancellationReason && <p>Cancellation reason: {rx.cancellationReason}</p>}
      {['authorized', 'partial'].includes(rx.status) && can('prescriptions.dispense') && (
        <section className="health-card">
          <h2>Complete dispensing</h2>
          {can('sales.create') && (
            <Link className="button button-primary" to={`/pos?prescriptionId=${rx.id}`}>
              Dispense and pay through POS
            </Link>
          )}
          <p>
            FEFO selects non-expired batches. Stock is deducted only after confirmation. Use POS
            checkout above if payment is required. Confirm dispensing below only for a stock-only
            issue; do not create a second sale for units already dispensed.
          </p>
          {rx.items
            .filter((i) => i.dispensed < i.quantity)
            .map((i) => {
              const m = medicines.data?.items.find((m) => m.id === i.productId);
              return (
                <div key={i.id}>
                  <Field label={`${i.medicineName} — quantity to dispense (base units)`}>
                    <input
                      type="number"
                      min="0"
                      max={i.quantity - i.dispensed}
                      value={quantities[i.id] ?? ''}
                      onChange={(e) => {
                        setQuantities({ ...quantities, [i.id]: e.target.value });
                        setOperationId(crypto.randomUUID());
                      }}
                    />
                  </Field>
                  <p>Available non-expired stock: {m?.available ?? 'Check catalogue'}</p>
                  {m?.batches.map((b) => (
                    <p key={b.id}>
                      Batch {b.batch_number} · Expiry {b.expiry_date ?? 'Not recorded'} ·{' '}
                      {b.quantity_remaining} units{' '}
                      {b.expiry_date && b.expiry_date < new Date().toISOString().slice(0, 10)
                        ? '· EXPIRED — blocked'
                        : ''}
                    </p>
                  ))}
                </div>
              );
            })}
          <Button disabled={busy || !reviewed} onClick={() => act('dispense')}>
            Confirm dispensing
          </Button>
        </section>
      )}
      {error && <ErrorBlock message={error} />}
      <h2>Dispensing history</h2>
      {dispensing.map((d) => (
        <p key={d.id}>
          {new Date(d.dispensed_at).toLocaleString()} · Staff {d.dispensed_by} · {d.id}
        </p>
      ))}
    </>
  );
}
function PatientReports() {
  const { api } = useApp();
  const [patientId, setPatientId] = useState('');
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const data = useAsync(
    () =>
      api.request<Record<string, number>>(
        `/api/healthcare/reports?${new URLSearchParams({ ...(patientId ? { patientId } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) })}`,
      ),
    [patientId, from, to],
  );
  return (
    <>
      <PageHeading
        eyebrow="Healthcare"
        title="Patient Reports"
        description="Counts use registration, consultation or prescription issue date. Default: today."
      />
      <div className="health-filters">
        <PatientPicker value={patientId} onChange={setPatientId} />
        <Field label="From date">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To date">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      {data.error && <ErrorBlock message={data.error} />}
      <div className="health-cards">
        {Object.entries(data.data ?? {}).map(([key, count]) => (
          <div className="health-card" key={key}>
            <h3>
              {
                (
                  {
                    registeredPatients: 'Registered patients',
                    consultations: 'Consultations',
                    prescriptionsIssued: 'Prescriptions issued',
                    dispensed: 'Fully dispensed prescriptions',
                    partial: 'Partially dispensed prescriptions',
                    outstanding: 'Outstanding prescriptions',
                  } as Record<string, string>
                )[key]
              }
            </h3>
            <strong>{count}</strong>
          </div>
        ))}
      </div>
      <p>
        <Link to="/consultations">Consultation history</Link> ·{' '}
        <Link to="/prescriptions">Prescription history and status filters</Link>
      </p>
    </>
  );
}

function MedicineWarningEditor({ productId, initial }: { productId: string; initial: string }) {
  const { api } = useApp();
  const [warning, setWarning] = useState(initial);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="health-warning">
      <Field label="Medicine clinical warning (catalogue-wide professional note)">
        <textarea value={warning} onChange={(e) => setWarning(e.target.value)} />
      </Field>
      <Button
        variant="secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api.request(`/api/healthcare/medicines/${productId}/warning`, 'PUT', { warning });
            setMessage('Medicine warning saved.');
          } catch (e) {
            setMessage(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Save medicine warning
      </Button>
      <p role="status">{message}</p>
    </div>
  );
}
