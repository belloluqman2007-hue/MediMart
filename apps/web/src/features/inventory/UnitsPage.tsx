import { useState, type FormEvent } from 'react';
import { Pencil, Plus, Ruler, Trash2 } from 'lucide-react';
import { hasPermission, type UnitSummary } from '@medimart/shared';
import { useApp } from '../../lib/context';
import { errorMessage } from '../../lib/api';
import { Button, FormError, Modal, PageHeading } from '../../components/ui';
import { useAsync } from './lib';
import { ConfirmDialog, ErrorBlock, Field, LoadingBlock } from './shared';

type Draft = { code: string; name: string; symbol: string };

export function UnitsPage() {
  const { api, user, notify } = useApp();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<UnitSummary | null>(null);
  const [deleting, setDeleting] = useState<UnitSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const units = useAsync(() => api.request<{ units: UnitSummary[] }>('/api/units'), []);
  const canManage = Boolean(user && hasPermission(user.permissions, 'units.manage'));

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    setError(null);
    setBusy(true);
    try {
      await api.request(
        editing ? `/api/units/${editing.id}` : '/api/units',
        editing ? 'PUT' : 'POST',
        draft,
      );
      notify(editing ? 'Unit updated.' : 'Unit created.', 'success');
      setDraft(null);
      setEditing(null);
      units.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.request(`/api/units/${deleting.id}`, 'DELETE');
      notify('Unit deleted.', 'success');
      setDeleting(null);
      units.reload();
    } catch (caught) {
      notify(errorMessage(caught), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeading
        eyebrow="Inventory"
        title="Units"
        description="Units describe how stock is counted. Product conversions are defined on each product."
        action={
          canManage ? (
            <Button
              onClick={() => {
                setEditing(null);
                setError(null);
                setDraft({ code: '', name: '', symbol: '' });
              }}
            >
              <Plus size={16} /> Add unit
            </Button>
          ) : undefined
        }
      />
      <section className="card inventory-card">
        {units.loading && !units.data ? (
          <LoadingBlock label="Loading units…" />
        ) : units.error ? (
          <ErrorBlock message={units.error} onRetry={units.reload} />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Unit</th>
                  <th>Code</th>
                  <th>Symbol</th>
                  <th>Type</th>
                  {canManage && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {(units.data?.units ?? []).map((unit) => (
                  <tr key={unit.id}>
                    <td>
                      <Ruler size={14} /> {unit.name}
                    </td>
                    <td className="muted">{unit.code}</td>
                    <td>{unit.symbol}</td>
                    <td className="muted">{unit.isSystem ? 'Built-in' : 'Custom'}</td>
                    {canManage && (
                      <td>
                        <div className="row-actions">
                          <button
                            className="icon-button"
                            aria-label={`Edit ${unit.name}`}
                            onClick={() => {
                              setEditing(unit);
                              setError(null);
                              setDraft({ code: unit.code, name: unit.name, symbol: unit.symbol });
                            }}
                          >
                            <Pencil size={15} />
                          </button>
                          {!unit.isSystem && (
                            <button
                              className="icon-button"
                              aria-label={`Delete ${unit.name}`}
                              onClick={() => setDeleting(unit)}
                            >
                              <Trash2 size={15} />
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="inventory-note">
        Example: with tablets as the base unit, a pack might convert at 10 tablets and a carton at
        120 tablets. Factors must be whole numbers so stock never becomes fractional.
      </p>

      <Modal
        open={Boolean(draft)}
        onClose={() => {
          setDraft(null);
          setEditing(null);
        }}
        title={editing ? 'Edit unit' : 'Add unit'}
      >
        {draft && (
          <form className="modal-form" onSubmit={(event) => void save(event)} noValidate>
            <Field
              label="Code"
              hint="Lowercase letters, numbers, and underscores. Cannot change for built-in units."
            >
              <input
                value={draft.code}
                onChange={(event) => setDraft({ ...draft, code: event.target.value })}
                maxLength={32}
                disabled={Boolean(editing?.isSystem)}
                required
              />
            </Field>
            <Field label="Name">
              <input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                maxLength={40}
                required
              />
            </Field>
            <Field label="Symbol">
              <input
                value={draft.symbol}
                onChange={(event) => setDraft({ ...draft, symbol: event.target.value })}
                maxLength={12}
                required
              />
            </Field>
            <FormError message={error} />
            <div className="form-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setDraft(null);
                  setEditing(null);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" busy={busy}>
                {editing ? 'Save changes' : 'Create unit'}
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete unit?"
        message="A unit can only be deleted when no product uses it as a base unit or conversion."
        confirmLabel="Delete"
        danger
        busy={busy}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void remove()}
      />
    </>
  );
}
