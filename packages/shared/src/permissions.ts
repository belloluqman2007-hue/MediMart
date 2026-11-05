/** Capabilities are enforced at API boundaries; navigation is only a convenience. */
export const permissions = [
  'dashboard.view',
  'pos.access',
  'pharmacy.view',
  'minimart.view',
  'inventory.view',
  'purchases.view',
  'suppliers.view',
  'customers.view',
  'patients.view',
  'consultations.view',
  'prescriptions.view',
  'expenses.view',
  'cash_register.view',
  'debts.view',
  'reports.view',
  'staff.view',
  'staff.manage',
  'permissions.view',
  'permissions.manage',
  'audit.view',
  'sync.view',
  'sync.manage',
  'settings.view',
  'settings.manage',
  'devices.manage',
] as const;
export type Permission = (typeof permissions)[number];
export const roleCodes = [
  'owner',
  'administrator',
  'manager',
  'pharmacist',
  'healthcare_professional',
  'cashier',
  'storekeeper',
] as const;
export type RoleCode = (typeof roleCodes)[number];
export const roleLabels: Record<RoleCode, string> = {
  owner: 'Owner',
  administrator: 'Administrator',
  manager: 'Manager',
  pharmacist: 'Pharmacist',
  healthcare_professional: 'Healthcare Professional',
  cashier: 'Cashier',
  storekeeper: 'Storekeeper',
};
const basic: Permission[] = ['dashboard.view', 'settings.view'];
export const rolePermissions: Record<RoleCode, readonly Permission[]> = {
  owner: permissions,
  administrator: permissions.filter((p) => p !== 'permissions.manage'),
  manager: [
    ...basic,
    'pos.access',
    'pharmacy.view',
    'minimart.view',
    'inventory.view',
    'purchases.view',
    'suppliers.view',
    'customers.view',
    'expenses.view',
    'cash_register.view',
    'debts.view',
    'reports.view',
    'staff.view',
    'sync.view',
  ],
  pharmacist: [
    ...basic,
    'pos.access',
    'pharmacy.view',
    'inventory.view',
    'customers.view',
    'patients.view',
    'prescriptions.view',
  ],
  healthcare_professional: [...basic, 'patients.view', 'consultations.view', 'prescriptions.view'],
  cashier: [...basic, 'pos.access', 'minimart.view', 'customers.view', 'cash_register.view'],
  storekeeper: [...basic, 'inventory.view', 'purchases.view', 'suppliers.view', 'minimart.view'],
};
export function hasPermission(granted: readonly string[], permission: Permission): boolean {
  return granted.includes(permission);
}
