import type { Express, RequestHandler } from 'express';
import { z } from 'zod';
import type { Database } from '@medimart/database';
import {
  batchListQuerySchema,
  categoryInputSchema,
  fefoQuerySchema,
  inventorySettingsSchema,
  movementListQuerySchema,
  productImportRequestSchema,
  productInputSchema,
  productListQuerySchema,
  stockAdjustmentSchema,
  stockReceiveSchema,
  supplierInputSchema,
  supplierListQuerySchema,
  unitInputSchema,
  uuidSchema,
} from '@medimart/shared';
import { requireAuth, requirePermission } from '../middleware/security';
import { audit } from '../services/audit';
import type { AuthService } from '../services/auth';
import {
  createProduct,
  getProductDetail,
  listProducts,
  listUnits,
  setProductStatus,
  updateProduct,
} from '../services/inventory/products';
import {
  createCategory,
  createSupplier,
  createUnit,
  deleteCategory,
  deleteUnit,
  getSupplierDetail,
  listCategories,
  listSuppliers,
  setSupplierStatus,
  updateCategory,
  updateSupplier,
  updateUnit,
} from '../services/inventory/catalog';
import {
  adjustStock,
  expiryAlertDays,
  fefoAllocation,
  getMovement,
  listBatches,
  listMovements,
  reconciliation,
  receiveStock,
  saveInventorySettings,
} from '../services/inventory/stock';
import { inventoryDashboard } from '../services/inventory/dashboard';
import { importProducts, listImportRuns, rebuildSearchText } from '../services/inventory/import';

const meta = (req: Parameters<RequestHandler>[0]) => ({
  auth: req.auth!,
  requestId: req.requestId,
});

/** Registers every Phase 2 inventory endpoint. Permissions are enforced per route. */
export function registerInventoryRoutes(app: Express, db: Database, auth: AuthService) {
  const authenticated = requireAuth(auth);
  const guard = (permission: Parameters<typeof requirePermission>[0]) => [
    authenticated,
    requirePermission(permission),
  ];

  // --- Dashboard, alerts, settings, reconciliation -------------------------------
  app.get('/api/inventory/dashboard', ...guard('inventory.view'), async (_req, res) => {
    res.json(await inventoryDashboard(db, await expiryAlertDays(db)));
  });
  app.get('/api/inventory/alerts', ...guard('inventory.view'), async (req, res) => {
    const days = await expiryAlertDays(db);
    const { limit } = z
      .strictObject({ limit: z.coerce.number().int().min(1).max(50).default(10) })
      .parse(req.query);
    res.json({
      expiryAlertDays: days,
      expired: await listBatches(db, { filter: 'expired', page: 1, pageSize: limit }),
      expiring: await listBatches(db, { filter: 'expiring', page: 1, pageSize: limit }),
    });
  });
  app.get('/api/inventory/settings', ...guard('inventory.view'), async (_req, res) => {
    res.json({ expiryAlertDays: await expiryAlertDays(db) });
  });
  app.put('/api/inventory/settings', ...guard('inventory.settings.manage'), async (req, res) => {
    const input = inventorySettingsSchema.parse(req.body);
    res.json(await saveInventorySettings(db, req.auth!, req.requestId, input.expiryAlertDays));
  });
  app.get(
    '/api/inventory/reconciliation',
    ...guard('inventory.reports.view'),
    async (_req, res) => {
      res.json(await reconciliation(db));
    },
  );

  // --- Products ------------------------------------------------------------------
  app.get('/api/products', ...guard('inventory.view'), async (req, res) => {
    res.json(await listProducts(db, productListQuerySchema.parse(req.query)));
  });
  app.post('/api/products', ...guard('products.create'), async (req, res) => {
    const input = productInputSchema.parse(req.body);
    const { auth: context, requestId } = meta(req);
    res.status(201).json(await createProduct(db, context, requestId, input));
  });
  app.get('/api/products/:id', ...guard('inventory.view'), async (req, res) => {
    res.json(await getProductDetail(db, uuidSchema.parse(req.params.id)));
  });
  app.put('/api/products/:id', ...guard('products.edit'), async (req, res) => {
    const input = productInputSchema.parse(req.body);
    const { auth: context, requestId } = meta(req);
    res.json(await updateProduct(db, context, requestId, uuidSchema.parse(req.params.id), input));
  });
  for (const status of ['active', 'inactive'] as const) {
    app.post(
      `/api/products/:id/${status === 'active' ? 'activate' : 'deactivate'}`,
      ...guard('products.deactivate'),
      async (req, res) => {
        const { auth: context, requestId } = meta(req);
        res.json(
          await setProductStatus(db, context, requestId, uuidSchema.parse(req.params.id), status),
        );
      },
    );
  }
  /**
   * Bulk catalogue onboarding. A preview and a real import share one evaluation, so the shopkeeper
   * sees exactly what will happen before anything is written.
   */
  app.post('/api/products/import', ...guard('products.import'), async (req, res) => {
    const input = productImportRequestSchema.parse(req.body);
    const { auth: context, requestId } = meta(req);
    res.json(await importProducts(db, context, requestId, input));
  });
  app.get('/api/products/import/runs', ...guard('products.import'), async (_req, res) => {
    res.json({ runs: await listImportRuns(db) });
  });
  /**
   * Rebuild the derived search column. Safe and idempotent: it writes only `search_text`, never a
   * business field, so it can be run after a restore or by an administrator investigating search.
   */
  app.post(
    '/api/products/search-index/rebuild',
    ...guard('inventory.settings.manage'),
    async (req, res) => {
      const { auth: context, requestId } = meta(req);
      res.json(
        await db.transaction(async (tx) => {
          const count = await rebuildSearchText(tx);
          await audit(tx, {
            action: 'product.search_index_rebuilt',
            actorId: context.user.id,
            deviceId: context.deviceId,
            requestId,
            metadata: { products: count },
          });
          return { products: count };
        }),
      );
    },
  );
  app.get('/api/products/:id/batches', ...guard('batches.view'), async (req, res) => {
    res.json({
      batches: (
        await listBatches(db, {
          productId: uuidSchema.parse(req.params.id),
          filter: 'all',
          page: 1,
          pageSize: 100,
        })
      ).items,
    });
  });
  app.get('/api/products/:id/fefo', ...guard('stock.view'), async (req, res) => {
    const query = fefoQuerySchema.parse(req.query);
    res.json(await fefoAllocation(db, uuidSchema.parse(req.params.id), query.quantity, query.asOf));
  });

  // --- Categories ----------------------------------------------------------------
  app.get('/api/categories', ...guard('inventory.view'), async (req, res) => {
    const { search } = z
      .strictObject({ search: z.string().trim().max(80).optional() })
      .parse(req.query);
    res.json({ categories: await listCategories(db, search) });
  });
  app.post('/api/categories', ...guard('categories.manage'), async (req, res) => {
    const input = categoryInputSchema.parse(req.body);
    const { auth: context, requestId } = meta(req);
    res.status(201).json(await createCategory(db, context, requestId, input));
  });
  app.put('/api/categories/:id', ...guard('categories.manage'), async (req, res) => {
    const input = categoryInputSchema.parse(req.body);
    const { auth: context, requestId } = meta(req);
    res.json(await updateCategory(db, context, requestId, uuidSchema.parse(req.params.id), input));
  });
  app.delete('/api/categories/:id', ...guard('categories.manage'), async (req, res) => {
    const { auth: context, requestId } = meta(req);
    await deleteCategory(db, context, requestId, uuidSchema.parse(req.params.id));
    res.status(204).end();
  });

  // --- Units ---------------------------------------------------------------------
  app.get('/api/units', ...guard('inventory.view'), async (_req, res) => {
    res.json({ units: await listUnits(db) });
  });
  app.post('/api/units', ...guard('units.manage'), async (req, res) => {
    const input = unitInputSchema.parse(req.body);
    const { auth: context, requestId } = meta(req);
    res.status(201).json(await createUnit(db, context, requestId, input));
  });
  app.put('/api/units/:id', ...guard('units.manage'), async (req, res) => {
    const input = unitInputSchema.parse(req.body);
    const { auth: context, requestId } = meta(req);
    res.json(await updateUnit(db, context, requestId, uuidSchema.parse(req.params.id), input));
  });
  app.delete('/api/units/:id', ...guard('units.manage'), async (req, res) => {
    const { auth: context, requestId } = meta(req);
    await deleteUnit(db, context, requestId, uuidSchema.parse(req.params.id));
    res.status(204).end();
  });

  // --- Batches -------------------------------------------------------------------
  app.get('/api/batches', ...guard('batches.view'), async (req, res) => {
    res.json(await listBatches(db, batchListQuerySchema.parse(req.query)));
  });

  // --- Stock ledger ---------------------------------------------------------------
  app.get('/api/stock/movements', ...guard('stock.view'), async (req, res) => {
    res.json(await listMovements(db, movementListQuerySchema.parse(req.query)));
  });
  app.get('/api/stock/movements/:id', ...guard('stock.view'), async (req, res) => {
    res.json(await getMovement(db, uuidSchema.parse(req.params.id)));
  });
  app.post('/api/stock/receive', ...guard('stock.receive'), async (req, res) => {
    const input = stockReceiveSchema.parse(req.body);
    const { auth: context, requestId } = meta(req);
    res.status(201).json(await receiveStock(db, context, requestId, input));
  });
  app.post('/api/stock/adjust', ...guard('stock.adjust'), async (req, res) => {
    // Write-offs additionally need stock.write_off; the service rechecks that grant in-transaction.
    const input = stockAdjustmentSchema.parse(req.body);
    const { auth: context, requestId } = meta(req);
    res.status(201).json(await adjustStock(db, context, requestId, input));
  });
  app.get('/api/stock/fefo/:productId', ...guard('stock.view'), async (req, res) => {
    const query = fefoQuerySchema.parse(req.query);
    res.json(
      await fefoAllocation(db, uuidSchema.parse(req.params.productId), query.quantity, query.asOf),
    );
  });

  // --- Suppliers ------------------------------------------------------------------
  app.get('/api/suppliers', ...guard('suppliers.view'), async (req, res) => {
    res.json(await listSuppliers(db, supplierListQuerySchema.parse(req.query)));
  });
  app.post('/api/suppliers', ...guard('suppliers.manage'), async (req, res) => {
    const input = supplierInputSchema.parse(req.body);
    const { auth: context, requestId } = meta(req);
    res.status(201).json(await createSupplier(db, context, requestId, input));
  });
  app.get('/api/suppliers/:id', ...guard('suppliers.view'), async (req, res) => {
    res.json(await getSupplierDetail(db, uuidSchema.parse(req.params.id)));
  });
  app.put('/api/suppliers/:id', ...guard('suppliers.manage'), async (req, res) => {
    const input = supplierInputSchema.parse(req.body);
    const { auth: context, requestId } = meta(req);
    res.json(await updateSupplier(db, context, requestId, uuidSchema.parse(req.params.id), input));
  });
  for (const status of ['active', 'inactive'] as const) {
    app.post(
      `/api/suppliers/:id/${status === 'active' ? 'activate' : 'deactivate'}`,
      ...guard('suppliers.manage'),
      async (req, res) => {
        const { auth: context, requestId } = meta(req);
        res.json(
          await setSupplierStatus(db, context, requestId, uuidSchema.parse(req.params.id), status),
        );
      },
    );
  }
}
