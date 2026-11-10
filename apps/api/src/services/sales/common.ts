import type { SqlExecutor } from '@medimart/database';
import { readSetting, writeSetting } from '@medimart/database';
import { canonicalJson, sha256, type ShopSettings } from '@medimart/shared';
import type { z } from 'zod';
import type { businessSettingsSchema } from '@medimart/shared';
import { ApiError } from '../../errors';
import { todayIso, type ProductRow } from '../inventory/common';

export const DEFAULT_RECEIPT_FOOTER = 'Thank you for shopping with us.';

export async function readShopSettings(tx: SqlExecutor): Promise<ShopSettings> {
  const [businessName, shopAddress, shopPhone, shopEmail, receiptFooter] = await Promise.all([
    readSetting<string>(tx, 'business_name'),
    readSetting<string>(tx, 'shop_address'),
    readSetting<string>(tx, 'shop_phone'),
    readSetting<string>(tx, 'shop_email'),
    readSetting<string>(tx, 'receipt_footer'),
  ]);
  return {
    businessName: businessName || 'MediMart',
    shopAddress: shopAddress ?? '',
    shopPhone: shopPhone ?? '',
    shopEmail: shopEmail ?? '',
    receiptFooter: receiptFooter ?? DEFAULT_RECEIPT_FOOTER,
  };
}

export async function writeShopSettings(
  tx: SqlExecutor,
  input: z.infer<typeof businessSettingsSchema>,
  actorId: string,
): Promise<{ settings: ShopSettings; keys: string[] }> {
  const keys = ['business_name'];
  await writeSetting(tx, 'business_name', input.businessName, { actorId });
  if (input.shopAddress !== undefined) {
    await writeSetting(tx, 'shop_address', input.shopAddress, { actorId });
    keys.push('shop_address');
  }
  if (input.shopPhone !== undefined) {
    await writeSetting(tx, 'shop_phone', input.shopPhone, { actorId });
    keys.push('shop_phone');
  }
  if (input.shopEmail !== undefined) {
    await writeSetting(tx, 'shop_email', input.shopEmail, { actorId });
    keys.push('shop_email');
  }
  if (input.receiptFooter !== undefined) {
    await writeSetting(tx, 'receipt_footer', input.receiptFooter, { actorId });
    keys.push('receipt_footer');
  }
  return { settings: await readShopSettings(tx), keys };
}

/**
 * Generates an atomic, gap-free sequence code inside the caller's SQLite transaction.
 * Example outputs: `MM-20261110-0001`, `REV-20261110-0001`, `DP-20261110-0001`, `CUST-0001`.
 */
export async function nextSequenceCode(
  tx: SqlExecutor,
  prefix: 'MM' | 'REV' | 'DP' | 'CUST' | 'PO' | 'GRN' | 'SP' | 'EXP',
  counterDate: string = todayIso(),
  padLength = 4,
): Promise<string> {
  const now = new Date().toISOString();
  await tx.run(
    `INSERT INTO receipt_counters (prefix, counter_date, last_number, updated_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT (prefix, counter_date) DO UPDATE SET
      last_number = receipt_counters.last_number + 1,
      updated_at = excluded.updated_at`,
    [prefix, counterDate, now],
  );
  const row = (
    await tx.all<{ last_number: number }>(
      'SELECT last_number FROM receipt_counters WHERE prefix = ? AND counter_date = ?',
      [prefix, counterDate],
    )
  )[0]!;
  const seq = String(Number(row.last_number)).padStart(padLength, '0');
  if (counterDate === 'GLOBAL') return `${prefix}-${seq}`;
  return `${prefix}-${counterDate.replaceAll('-', '')}-${seq}`;
}

export async function operationHash(tag: string, payload: unknown): Promise<string> {
  return sha256(canonicalJson({ tag, payload }));
}

export type ResolvedUnit = {
  unitId: string;
  unitName: string;
  unitSymbol: string;
  factor: number;
  baseQuantity: number;
};

export async function resolveSellingUnit(
  tx: SqlExecutor,
  product: Pick<ProductRow, 'id' | 'base_unit_id' | 'base_unit_name' | 'base_unit_symbol'>,
  unitId: string,
  quantity: number,
): Promise<ResolvedUnit> {
  if (unitId === product.base_unit_id) {
    return {
      unitId: product.base_unit_id,
      unitName: product.base_unit_name,
      unitSymbol: product.base_unit_symbol,
      factor: 1,
      baseQuantity: quantity,
    };
  }
  const row = (
    await tx.all<{ unit_id: string; name: string; symbol: string; factor: number }>(
      `SELECT pu.unit_id, u.name, u.symbol, pu.factor
      FROM product_units pu JOIN units u ON u.id = pu.unit_id
      WHERE pu.product_id = ? AND pu.unit_id = ?`,
      [product.id, unitId],
    )
  )[0];
  if (!row) {
    throw new ApiError(
      400,
      'UNIT_NOT_CONFIGURED',
      'This selling unit is not configured for the selected product.',
    );
  }
  const factor = Number(row.factor);
  const baseQuantity = quantity * factor;
  if (!Number.isSafeInteger(baseQuantity) || baseQuantity <= 0) {
    throw new ApiError(400, 'QUANTITY_INVALID', 'The converted quantity is not valid.');
  }
  return {
    unitId: row.unit_id,
    unitName: row.name,
    unitSymbol: row.symbol,
    factor,
    baseQuantity,
  };
}
