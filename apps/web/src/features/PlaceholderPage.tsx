import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Blocks, Check, LockKeyhole, ShieldCheck } from 'lucide-react';
import { hasPermission } from '@medimart/shared';
import type { NavigationItem } from '../lib/navigation';
import { useApp } from '../lib/context';
import { Badge, PageHeading } from '../components/ui';
export function PlaceholderPage({ item }: { item: NavigationItem }) {
  const { user } = useApp();
  const permitted = !user || hasPermission(user.permissions, item.permission);
  return (
    <>
      <PageHeading
        eyebrow={item.group}
        title={item.label}
        description={item.description}
        action={<Badge>FOUNDATION · PHASE 01</Badge>}
      />
      {!permitted ? (
        <section className="card empty-state module-placeholder">
          <div className="empty-icon">
            <LockKeyhole size={34} />
          </div>
          <h2>This space needs a different permission</h2>
          <p>
            Your current roles do not include <strong>{item.permission}</strong>. Ask your owner or
            administrator about access. The API enforces these permissions independently of this
            screen.
          </p>
          <Link to="/" className="button button-secondary">
            <ArrowLeft size={16} />
            Back to dashboard
          </Link>
        </section>
      ) : (
        <>
          <section className="card empty-state module-placeholder">
            <div className="placeholder-decoration" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div className="large-module-icon">
              <item.icon size={42} strokeWidth={1.4} />
            </div>
            <Badge tone="green">A space for what comes next</Badge>
            <h2>{item.label}, with a strong foundation.</h2>
            <p>
              This module has its place in your workspace. Its business features will be introduced
              in a later phase, after the foundation is reviewed and approved.
            </p>
            <div className="placeholder-checks">
              <span>
                <Check size={15} />
                Navigation ready
              </span>
              <span>
                <Check size={15} />
                Permission defined
              </span>
              <span>
                <Check size={15} />
                No demo transactions
              </span>
            </div>
            <div className="placeholder-actions">
              <Link to="/" className="button button-secondary">
                <ArrowLeft size={16} />
                Back to dashboard
              </Link>
              {['/staff', '/permissions', '/backup-sync'].includes(item.path) && (
                <Link
                  to={`/settings?tab=${item.path === '/staff' ? 'team' : item.path === '/backup-sync' ? 'connection' : 'general'}`}
                  className="button button-primary"
                >
                  View foundation settings
                  <ArrowRight size={16} />
                </Link>
              )}
            </div>
          </section>
          <div className="placeholder-info-grid">
            <section className="card placeholder-info">
              <ShieldCheck size={22} />
              <div>
                <h3>Access with intention</h3>
                <p>
                  {user
                    ? `Your account has ${item.permission}. Operational features remain disabled until implemented.`
                    : 'This is a read-only preview. Real records will always require an authenticated, authorized account.'}
                </p>
              </div>
            </section>
            <section className="card placeholder-info">
              <Blocks size={22} />
              <div>
                <h3>Built one careful phase at a time</h3>
                <p>
                  {item.path === '/backup-sync'
                    ? 'SQLite outbox, receipts, and conflict tables are prepared. Backup jobs and synchronization workers are not running.'
                    : 'Phase 1 covers identity, security, local storage, and the application shell — not business operations.'}
                </p>
              </div>
            </section>
          </div>
        </>
      )}
    </>
  );
}
