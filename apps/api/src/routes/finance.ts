import type { Express, RequestHandler } from 'express';
import { z } from 'zod';
import type { Database } from '@medimart/database';
import {
  cashRegisterQuerySchema,
  expenseCreateSchema,
  expenseListQuerySchema,
  expenseReversalSchema,
  expenseUpdateSchema,
  financialExportQuerySchema,
  financialReportQuerySchema,
  goodsReceiptCreateSchema,
  goodsReceiptListQuerySchema,
  purchaseCancelSchema,
  purchaseCreateSchema,
  purchaseListQuerySchema,
  purchaseUpdateSchema,
  supplierAccountQuerySchema,
  supplierBalanceListQuerySchema,
  supplierPaymentCreateSchema,
  supplierPaymentListQuerySchema,
  supplierPaymentReversalSchema,
  uuidSchema,
} from '@medimart/shared';
import { requireAuth, requirePermission } from '../middleware/security';
import { audit } from '../services/audit';
import type { AuthService } from '../services/auth';
import {
  getSupplierAccountDetail,
  getSupplierStatement,
  listSupplierBalances,
} from '../services/finance/accounts';
import {
  createExpense,
  getExpenseDetail,
  listExpenseCategories,
  listExpenses,
  recordExpense,
  reverseExpense,
  updateExpense,
} from '../services/finance/expenses';
import {
  createGoodsReceipt,
  getGoodsReceiptDetail,
  listGoodsReceipts,
} from '../services/finance/receiving';
import {
  cancelPurchase,
  createPurchase,
  getPurchaseDetail,
  listPurchases,
  markPurchaseOrdered,
  updatePurchase,
} from '../services/finance/purchases';
import {
  cashRegisterSummary,
  exportFinancialReport,
  financialDashboard,
  buildFinancialReport,
} from '../services/finance/reports';
import {
  getSupplierPayment,
  listSupplierPayments,
  recordSupplierPayment,
  reverseSupplierPayment,
} from '../services/finance/supplierPayments';

const meta = (req: Parameters<RequestHandler>[0]) => ({
  auth: req.auth!,
  requestId: req.requestId,
});

/** Registers every Phase 5 purchasing, supplier-payment, expense and finance endpoint. */
export function registerFinanceRoutes(app: Express, db: Database, auth: AuthService) {
  const authenticated = requireAuth(auth);
  const guard = (permission: Parameters<typeof requirePermission>[0]) => [
    authenticated,
    requirePermission(permission),
  ];

  // --- Purchases ----------------------------------------------------------------
  app.get('/api/purchases', ...guard('purchases.view'), async (req, res) => {
    res.json(await listPurchases(db, purchaseListQuerySchema.parse(req.query)));
  });
  app.post('/api/purchases', ...guard('purchases.create'), async (req, res) => {
    const input = purchaseCreateSchema.parse(req.body);
    const { auth: context, requestId } = meta(req);
    res.status(201).json(await createPurchase(db, context, requestId, input));
  });
  app.get('/api/purchases/:id', ...guard('purchases.view'), async (req, res) => {
    res.json(await getPurchaseDetail(db, uuidSchema.parse(req.params.id)));
  });
  app.put('/api/purchases/:id', ...guard('purchases.edit'), async (req, res) => {
    const input = purchaseUpdateSchema.parse(req.body);
    const { auth: context, requestId } = meta(req);
    res.json(await updatePurchase(db, context, requestId, uuidSchema.parse(req.params.id), input));
  });
  app.post('/api/purchases/:id/order', ...guard('purchases.edit'), async (req, res) => {
    z.strictObject({}).parse(req.body ?? {});
    const { auth: context, requestId } = meta(req);
    res.json(await markPurchaseOrdered(db, context, requestId, uuidSchema.parse(req.params.id)));
  });
  app.post('/api/purchases/:id/cancel', ...guard('purchases.cancel'), async (req, res) => {
    const { reason } = purchaseCancelSchema.parse(req.body);
    const { auth: context, requestId } = meta(req);
    res.json(await cancelPurchase(db, context, requestId, uuidSchema.parse(req.params.id), reason));
  });

  // --- Goods receiving ----------------------------------------------------------
  app.get('/api/goods-receipts', ...guard('purchases.view'), async (req, res) => {
    res.json(await listGoodsReceipts(db, goodsReceiptListQuerySchema.parse(req.query)));
  });
  app.get('/api/goods-receipts/:id', ...guard('purchases.view'), async (req, res) => {
    res.json(await getGoodsReceiptDetail(db, uuidSchema.parse(req.params.id)));
  });
  app.get('/api/purchases/:id/receipts', ...guard('purchases.view'), async (req, res) => {
    res.json({ receipts: (await getPurchaseDetail(db, uuidSchema.parse(req.params.id))).receipts });
  });
  app.post('/api/purchases/:id/receipts', ...guard('purchases.receive'), async (req, res) => {
    const input = goodsReceiptCreateSchema.parse(req.body);
    const { auth: context, requestId } = meta(req);
    res
      .status(201)
      .json(
        await createGoodsReceipt(db, context, requestId, uuidSchema.parse(req.params.id), input),
      );
  });

  // --- Supplier accounts, invoices and statements -------------------------------
  app.get('/api/suppliers/:id/account', ...guard('supplier_debts.view'), async (req, res) => {
    res.json(
      await getSupplierAccountDetail(
        db,
        uuidSchema.parse(req.params.id),
        supplierAccountQuerySchema.parse(req.query),
      ),
    );
  });
  app.get('/api/suppliers/:id/statement', ...guard('supplier_debts.view'), async (req, res) => {
    res.json(
      await getSupplierStatement(
        db,
        uuidSchema.parse(req.params.id),
        supplierAccountQuerySchema.parse(req.query),
      ),
    );
  });
  app.get('/api/supplier-balances', ...guard('supplier_debts.view'), async (req, res) => {
    res.json(await listSupplierBalances(db, supplierBalanceListQuerySchema.parse(req.query)));
  });

  // --- Supplier payments --------------------------------------------------------
  app.get('/api/supplier-payments', ...guard('supplier_payments.view'), async (req, res) => {
    res.json(await listSupplierPayments(db, supplierPaymentListQuerySchema.parse(req.query)));
  });
  app.post('/api/supplier-payments', ...guard('supplier_payments.record'), async (req, res) => {
    const input = supplierPaymentCreateSchema.parse(req.body);
    const { auth: context, requestId } = meta(req);
    res.status(201).json(await recordSupplierPayment(db, context, requestId, input));
  });
  app.get('/api/supplier-payments/:id', ...guard('supplier_payments.view'), async (req, res) => {
    res.json(await getSupplierPayment(db, uuidSchema.parse(req.params.id)));
  });
  app.post(
    '/api/supplier-payments/:id/reverse',
    ...guard('supplier_payments.reverse'),
    async (req, res) => {
      const input = supplierPaymentReversalSchema.parse(req.body);
      const { auth: context, requestId } = meta(req);
      res
        .status(201)
        .json(
          await reverseSupplierPayment(
            db,
            context,
            requestId,
            uuidSchema.parse(req.params.id),
            input,
          ),
        );
    },
  );

  // --- Expenses -----------------------------------------------------------------
  app.get('/api/expense-categories', ...guard('expenses.view'), async (_req, res) => {
    res.json({ categories: await listExpenseCategories(db) });
  });
  app.get('/api/expenses', ...guard('expenses.view'), async (req, res) => {
    res.json(await listExpenses(db, expenseListQuerySchema.parse(req.query)));
  });
  app.post('/api/expenses', ...guard('expenses.create'), async (req, res) => {
    const input = expenseCreateSchema.parse(req.body);
    const { auth: context, requestId } = meta(req);
    res.status(201).json(await createExpense(db, context, requestId, input));
  });
  app.get('/api/expenses/:id', ...guard('expenses.view'), async (req, res) => {
    res.json(await getExpenseDetail(db, uuidSchema.parse(req.params.id)));
  });
  app.put('/api/expenses/:id', ...guard('expenses.edit'), async (req, res) => {
    const input = expenseUpdateSchema.parse(req.body);
    const { auth: context, requestId } = meta(req);
    res.json(await updateExpense(db, context, requestId, uuidSchema.parse(req.params.id), input));
  });
  app.post('/api/expenses/:id/record', ...guard('expenses.edit'), async (req, res) => {
    z.strictObject({}).parse(req.body ?? {});
    const { auth: context, requestId } = meta(req);
    res.json(await recordExpense(db, context, requestId, uuidSchema.parse(req.params.id)));
  });
  app.post('/api/expenses/:id/reverse', ...guard('expenses.reverse'), async (req, res) => {
    const input = expenseReversalSchema.parse(req.body);
    const { auth: context, requestId } = meta(req);
    res
      .status(201)
      .json(await reverseExpense(db, context, requestId, uuidSchema.parse(req.params.id), input));
  });

  // --- Financial dashboard, reports, exports and cash movement -------------------
  app.get('/api/finance/dashboard', ...guard('reports.view'), async (req, res) => {
    res.json(await financialDashboard(db, financialReportQuerySchema.parse(req.query)));
  });
  app.get('/api/reports/finance', ...guard('reports.view'), async (req, res) => {
    res.json(await buildFinancialReport(db, financialReportQuerySchema.parse(req.query)));
  });
  app.get('/api/reports/finance/export', ...guard('reports.export'), async (req, res) => {
    const query = financialExportQuerySchema.parse(req.query);
    const exported = await exportFinancialReport(db, query.report, query);
    const { auth: context, requestId } = meta(req);
    await audit(db, {
      action: 'report.exported',
      actorId: context.user.id,
      deviceId: context.deviceId,
      requestId,
      entityType: 'financial_report',
      metadata: {
        report: query.report,
        from: exported.from,
        to: exported.to,
        rowCount: exported.rowCount,
      },
    });
    res.json(exported);
  });
  app.get('/api/cash-register', ...guard('cash_register.view'), async (req, res) => {
    res.json(await cashRegisterSummary(db, cashRegisterQuerySchema.parse(req.query)));
  });
}
