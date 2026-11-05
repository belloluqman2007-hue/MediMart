import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { FolderTree, Pencil, Plus, Trash2 } from 'lucide-react';
import { hasPermission, type CategorySummary } from '@medimart/shared';
import { useApp } from '../../lib/context';
import { errorMessage } from '../../lib/api';
import { Button, FormError, Modal, PageHeading } from '../../components/ui';
import { useAsync } from './lib';
import { ConfirmDialog, EmptyState, ErrorBlock, Field, LoadingBlock, SearchField } from './shared';

type Draft = {
  name: string;
  parentId: string;
  kind: 'pharmacy' | 'mini_mart' | 'general';
  description: string;
};
const emptyDraft: Draft = { name: '', parentId: '', kind: 'general', description: '' };

export function CategoriesPage() {
  const { api, user, notify } = useApp();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<CategorySummary | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<CategorySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const categories = useAsync(
    () => api.request<{ categories: CategorySummary[] }>('/api/categories'),
    [],
  );
  const canManage = Boolean(user && hasPermission(user.permissions, 'categories.manage'));
  const all = useMemo(() => categories.data?.categories ?? [], [categories.data]);
  const filtered = useMemo(
    () =>
      all.filter((category) =>
        `${category.name} ${category.parentName ?? ''}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [all, search],
  );

  function openCreate(parent?: CategorySummary) {
    setEditing(null);
    setError(null);
    setDraft({
      ...emptyDraft,
      parentId: parent?.id ?? '',
      kind: parent?.kind ?? 'general',
    });
  }
  function openEdit(category: CategorySummary) {
    setEditing(category);
    setError(null);
    setDraft({
      name: category.name,
      parentId: category.parentId ?? '',
      kind: category.kind,
      description: category.description ?? '',
    });
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    setError(null);
    if (draft.name.trim().length < 2) {
      setError('Give the category a name of at least two characters.');
      return;
    }
    setBusy(true);
    try {
      const path = editing ? `/api/categories/${editing.id}` : '/api/categories';
      await api.request(path, editing ? 'PUT' : 'POST', {
        name: draft.name,
        parentId: draft.parentId || null,
        kind: draft.kind,
        description: draft.description,
      });
      notify(editing ? 'Category updated.' : 'Category created.', 'success');
      setDraft(null);
      setEditing(null);
      categories.reload();
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
      await api.request(`/api/categories/${deleting.id}`, 'DELETE');
      notify('Category deleted.', 'success');
      setDeleting(null);
      categories.reload();
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
        title="Categories"
        description="Group products for the pharmacy and mini-mart. Categories can have child categories."
        action={
          canManage ? (
            <Button onClick={() => openCreate()}>
              <Plus size={16} /> Add category
            </Button>
          ) : undefined
        }
      />
      <section className="card inventory-card">
        <div className="inventory-filters">
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder="Search categories…"
            label="Search categories"
          />
        </div>
        {categories.loading && !categories.data ? (
          <LoadingBlock label="Loading categories…" />
        ) : categories.error ? (
          <ErrorBlock message={categories.error} onRetry={categories.reload} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<FolderTree size={27} />}
            title={search ? 'No categories match' : 'No categories yet'}
            message={
              search
                ? 'Try a different search term.'
                : 'Create categories such as Antibiotics, Drinks, or Personal Care.'
            }
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Parent</th>
                  <th>Group</th>
                  <th className="numeric">Products</th>
                  <th className="numeric">Children</th>
                  {canManage && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {filtered.map((category) => (
                  <tr key={category.id}>
                    <td>
                      <strong>{category.name}</strong>
                      {category.description && (
                        <small className="block muted">{category.description}</small>
                      )}
                    </td>
                    <td>{category.parentName || '—'}</td>
                    <td className="muted">
                      {category.kind === 'mini_mart'
                        ? 'Mini-Mart'
                        : category.kind === 'pharmacy'
                          ? 'Pharmacy'
                          : 'General'}
                    </td>
                    <td className="numeric">
                      <Link to={`/inventory/products?categoryId=${category.id}`}>
                        {category.productCount}
                      </Link>
                    </td>
                    <td className="numeric">{category.childCount}</td>
                    {canManage && (
                      <td>
                        <div className="row-actions">
                          <button
                            className="icon-button"
                            aria-label={`Edit ${category.name}`}
                            onClick={() => openEdit(category)}
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            className="icon-button"
                            aria-label={`Add child to ${category.name}`}
                            onClick={() => openCreate(category)}
                          >
                            <Plus size={15} />
                          </button>
                          <button
                            className="icon-button"
                            aria-label={`Delete ${category.name}`}
                            onClick={() => setDeleting(category)}
                          >
                            <Trash2 size={15} />
                          </button>
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

      <Modal
        open={Boolean(draft)}
        onClose={() => {
          setDraft(null);
          setEditing(null);
        }}
        title={editing ? 'Edit category' : 'Add category'}
      >
        {draft && (
          <form className="modal-form" onSubmit={(event) => void save(event)} noValidate>
            <Field label="Category name">
              <input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                maxLength={80}
                required
              />
            </Field>
            <Field label="Parent category" hint="Leave empty for a top-level category.">
              <select
                value={draft.parentId}
                onChange={(event) => {
                  const parent = all.find((entry) => entry.id === event.target.value);
                  setDraft({
                    ...draft,
                    parentId: event.target.value,
                    kind: parent ? parent.kind : draft.kind,
                  });
                }}
              >
                <option value="">No parent</option>
                {all
                  .filter((entry) => entry.id !== editing?.id)
                  .map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Group" hint="Child categories inherit their parent's group.">
              <select
                value={draft.kind}
                onChange={(event) =>
                  setDraft({ ...draft, kind: event.target.value as Draft['kind'] })
                }
                disabled={Boolean(draft.parentId)}
              >
                <option value="general">General</option>
                <option value="pharmacy">Pharmacy</option>
                <option value="mini_mart">Mini-Mart</option>
              </select>
            </Field>
            <Field label="Description">
              <textarea
                className="inventory-textarea"
                rows={2}
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                maxLength={400}
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
                {editing ? 'Save changes' : 'Create category'}
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete category?"
        message={`${
          deleting?.name ?? 'This category'
        } can only be deleted when it has no products and no child categories.`}
        confirmLabel="Delete"
        danger
        busy={busy}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void remove()}
      />
    </>
  );
}
