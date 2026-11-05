import { NavLink, Outlet } from 'react-router-dom';
import {
  Boxes,
  ClipboardList,
  FolderTree,
  Gauge,
  Layers3,
  PackagePlus,
  PackageSearch,
  Ruler,
  Scale,
  Truck,
} from 'lucide-react';
import { hasPermission, type Permission } from '@medimart/shared';
import { useApp } from '../../lib/context';

const sections: Array<{
  to: string;
  label: string;
  icon: typeof Gauge;
  permission: Permission;
  end?: boolean;
}> = [
  { to: '/inventory', label: 'Overview', icon: Gauge, permission: 'inventory.view', end: true },
  { to: '/inventory/products', label: 'Products', icon: Boxes, permission: 'inventory.view' },
  {
    to: '/inventory/batches',
    label: 'Batches & expiry',
    icon: Layers3,
    permission: 'batches.view',
  },
  {
    to: '/inventory/receive',
    label: 'Receive stock',
    icon: PackagePlus,
    permission: 'stock.receive',
  },
  {
    to: '/inventory/adjustments',
    label: 'Adjust stock',
    icon: Scale,
    permission: 'stock.adjust',
  },
  {
    to: '/inventory/movements',
    label: 'Movement history',
    icon: ClipboardList,
    permission: 'stock.view',
  },
  {
    to: '/inventory/categories',
    label: 'Categories',
    icon: FolderTree,
    permission: 'inventory.view',
  },
  { to: '/inventory/suppliers', label: 'Suppliers', icon: Truck, permission: 'suppliers.view' },
  { to: '/inventory/units', label: 'Units', icon: Ruler, permission: 'inventory.view' },
  {
    to: '/inventory/reconciliation',
    label: 'Reconciliation',
    icon: PackageSearch,
    permission: 'inventory.reports.view',
  },
];

export function InventoryLayout() {
  const { user } = useApp();
  const visible = sections.filter(
    (section) => !user || hasPermission(user.permissions, section.permission),
  );
  return (
    <div className="inventory-workspace">
      <nav className="inventory-tabs" aria-label="Inventory sections">
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
