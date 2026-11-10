import type { Express, RequestHandler } from 'express';
import { z } from 'zod';
import type { Database } from '@medimart/database';
import {
  customerInputSchema,
  customerListQuerySchema,
  customerRepaymentSchema,
  debtListQuerySchema,
  debtRepaymentSchema,
  hasPermission,
  posCatalogQuerySchema,
  posLookupQuerySchema,
  saleCreateSchema,
  saleListQuerySchema,
  saleRefundSchema,
  salesReportQuerySchema,
  saleVoidSchema,
  uuidSchema,
} from '@medimart/shared';
import { requireAuth, requirePermission } from '../middleware/security';
import type { AuthService } from '../services/auth';
import { listPosProducts, lookupPosProductByCode, posBootstrap } from '../services/sales/catalog';
import {
  createCustomer,
  getCustomerDetail,
  listCustomers,
  updateCustomer,
} from '../services/sales/customers';
import {
  getDebtDetail,
  getDebtReport,
  listDebts,
  recordCustomerRepayment,
  recordDebtRepayment,
} from '../services/sales/debts';
import { salesDashboardSummary, salesFinancialReport } from '../services/sales/reports';
import {
  createSale,
  getSaleByReceiptNumber,
  getSaleDetail,
  listSales,
  refundSale,
  voidSale,
} from '../services/sales/transactions';

const meta = (req: Parameters<RequestHandler>[0]) => ({
  auth: req.auth!,
  requestId: req.requestId,
});

const receiptNumberParamSchema = z
  .string()
  .trim()
  .min(4)
  .max(40)
  .regex(/^[A-Za-z0-9-]+$/, 'Invalid receipt number.');

/** Registers every Phase 3 POS, sales, customer, debt, and sales-report endpoint. */
export function registerSalesRoutes(app: Express, db: Database, auth: AuthService) {
  const authenticated = requireAuth(auth);
  const guard = (permission: Parameters<typeof requirePermission>[0]) => [
    authenticated,
    requirePermission(permission),
  ];

  // --- POS Terminal Catalog (cashier-safe; does not expose purchase cost) --------
  app.get('/api/pos/bootstrap', ...guard('pos.access'), async (_req, res) => {
    res.json(await posBootstrap(db));
  });
  app.get('/api/pos/products', ...guard('pos.access'), async (req, res) => {
    res.json(await listPosProducts(db, posCatalogQuerySchema.parse(req.query)));
  });
  app.get('/api/pos/lookup', ...guard('pos.access'), async (req, res) => {
    const { code } = posLookupQuerySchema.parse(req.query);
    res.json({ product: await lookupPosProductByCode(db, code) });
  });

  // --- Sales & Receipts ----------------------------------------------------------
  app.get('/api/sales/summary', ...guard('sales.view'), async (req, res) => {
    const includeProfit = hasPermission(req.auth!.user.permissions, 'reports.view');
    res.json(await salesDashboardSummary(db, includeProfit));
  });
  app.get('/api/sales', ...guard('sales.view'), async (req, res) => {
    res.json(await listSales(db, saleListQuerySchema.parse(req.query)));
  });
  app.post('/api/sales', ...guard('sales.create'), async (req, res) => {
    const input = saleCreateSchema.parse(req.body);
    const { auth: context, requestId } = meta(req);
    const result = await createSale(db, auth, context, requestId, input);
    res.status(201).json(result.sale);
  });
  app.get('/api/sales/receipt/:receiptNumber', ...guard('sales.view'), async (req, res) => {
    const receiptNumber = receiptNumberParamSchema.parse(req.params.receiptNumber);
    res.json(await getSaleByReceiptNumber(db, receiptNumber));
  });
  app.get('/api/sales/:id', ...guard('sales.view'), async (req, res) => {
    res.json(await getSaleDetail(db, uuidSchema.parse(req.params.id)));
  });
  app.post('/api/sales/:id/void', ...guard('sales.void'), async (req, res) => {
    const input = saleVoidSchema.parse(req.body);
    const { auth: context, requestId } = meta(req);
    const result = await voidSale(db, context, requestId, uuidSchema.parse(req.params.id), input);
    res.json(result.sale);
  });
  app.post('/api/sales/:id/refund', ...guard('sales.refund'), async (req, res) => {
    const input = saleRefundSchema.parse(req.body);
    const { auth: context, requestId } = meta(req);
    const result = await refundSale(db, context, requestId, uuidSchema.parse(req.params.id), input);
    res.json(result.sale);
  });

  // --- Customers -----------------------------------------------------------------
  app.get('/api/customers', ...guard('customers.view'), async (req, res) => {
    res.json(await listCustomers(db, customerListQuerySchema.parse(req.query)));
  });
  app.post('/api/customers', ...guard('customers.manage'), async (req, res) => {
    const input = customerInputSchema.parse(req.body);
    const { auth: context, requestId } = meta(req);
    res.status(201).json(await createCustomer(db, context, requestId, input));
  });
  app.get('/api/customers/:id', ...guard('customers.view'), async (req, res) => {
    res.json(await getCustomerDetail(db, uuidSchema.parse(req.params.id)));
  });
  app.put('/api/customers/:id', ...guard('customers.manage'), async (req, res) => {
    const input = customerInputSchema.parse(req.body);
    const { auth: context, requestId } = meta(req);
    res.json(await updateCustomer(db, context, requestId, uuidSchema.parse(req.params.id), input));
  });
  app.post('/api/customers/:id/repayments', ...guard('debts.repay'), async (req, res) => {
    const input = customerRepaymentSchema.parse(req.body);
    const { auth: context, requestId } = meta(req);
    res
      .status(201)
      .json(
        await recordCustomerRepayment(
          db,
          context,
          requestId,
          uuidSchema.parse(req.params.id),
          input,
        ),
      );
  });

  // --- Debts & Debt Repayments ---------------------------------------------------
  app.get('/api/debts/report', ...guard('debts.view'), async (_req, res) => {
    res.json(await getDebtReport(db));
  });
  app.get('/api/debts', ...guard('debts.view'), async (req, res) => {
    res.json(await listDebts(db, debtListQuerySchema.parse(req.query)));
  });
  app.get('/api/debts/:id', ...guard('debts.view'), async (req, res) => {
    res.json(await getDebtDetail(db, uuidSchema.parse(req.params.id)));
  });
  app.post('/api/debts/:id/repayments', ...guard('debts.repay'), async (req, res) => {
    const input = debtRepaymentSchema.parse(req.body);
    const { auth: context, requestId } = meta(req);
    res
      .status(201)
      .json(
        await recordDebtRepayment(db, context, requestId, uuidSchema.parse(req.params.id), input),
      );
  });

  // --- Financial & Sales Reports -------------------------------------------------
  app.get('/api/reports/sales', ...guard('reports.view'), async (req, res) => {
    res.json(await salesFinancialReport(db, salesReportQuerySchema.parse(req.query)));
  });
}
