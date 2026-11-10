import { NavLink, Outlet } from 'react-router-dom';
import { ChartNoAxesCombined, HandCoins, History, ShoppingBag, Users } from 'lucide-react';
import { hasPermission, type Permission } from '@medimart/shared';
import { useApp } from '../../lib/context';

const sections: Array<{
  to: string;
  label: string;
  icon: typeof ShoppingBag;
  permission: Permission;
  end?: boolean;
}> = [
  {
    to: '/pos',
    label: 'Checkout terminal',
    icon: ShoppingBag,
    permission: 'pos.access',
    end: true,
  },
  { to: '/pos/sales', label: 'Sales history', icon: History, permission: 'sales.view' },
  { to: '/customers', label: 'Customers', icon: Users, permission: 'customers.view' },
  { to: '/debts', label: 'Debts', icon: HandCoins, permission: 'debts.view' },
  {
    to: '/reports',
    label: 'Financial reports',
    icon: ChartNoAxesCombined,
    permission: 'reports.view',
  },
];

export function PosLayout() {
  const { user } = useApp();
  const visible = sections.filter(
    (section) => !user || hasPermission(user.permissions, section.permission),
  );
  return (
    <div className="inventory-workspace pos-workspace">
      <nav className="inventory-tabs no-print" aria-label="Point of sale sections">
        {visible.map((section) => (
          <NavLink
            key={section.to}
            to={section.to}
            end={section.end}
            className={({ isActive }) => `inventory-tab ${isActive ? 'active' : ''}`}
          >
            <section.icon size={16} strokeWidth={1.8} />
            <span>{section.label}</span>
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
