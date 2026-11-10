import { Link } from 'react-router-dom';
import { LockKeyhole } from 'lucide-react';
import type { Permission } from '@medimart/shared';
import { useApp } from '../../lib/context';
import { PageHeading } from '../../components/ui';

export function SalesAccessGate({
  eyebrow,
  title,
  description,
  permission,
}: {
  eyebrow: string;
  title: string;
  description: string;
  permission: Permission;
}) {
  const { user, bootstrap } = useApp();
  return (
    <>
      <PageHeading eyebrow={eyebrow} title={title} description={description} />
      <section className="card inventory-card">
        <div className="inventory-empty">
          <span className="empty-icon">
            <LockKeyhole size={26} />
          </span>
          <h3>
            {user ? 'This space needs a different permission' : 'Sign in to open this workspace'}
          </h3>
          <p>
            {user
              ? `Your account needs ${permission}. Ask your owner or administrator about access — the API enforces this independently of this screen.`
              : 'Sales, receipts, and customer balances belong to your business. Sign in with your individual account to continue.'}
          </p>
          <Link
            className="button button-secondary"
            to={user ? '/' : bootstrap?.required ? '/register' : '/login'}
          >
            {user ? 'Back to dashboard' : bootstrap?.required ? 'Create owner account' : 'Sign in'}
          </Link>
        </div>
      </section>
    </>
  );
}
