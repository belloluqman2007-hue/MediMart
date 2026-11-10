import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Barcode,
  CheckCircle2,
  CreditCard,
  Landmark,
  Minus,
  Plus,
  Printer,
  RefreshCw,
  ShieldAlert,
  ShoppingBag,
  Trash2,
  UserPlus,
  Wallet,
} from 'lucide-react';
import {
  customerInputSchema,
  hasPermission,
  paymentMethodLabels,
  paymentMethods,
  productTypeLabels,
  productTypes,
  type CustomerSummary,
  type Paginated,
  type PaymentMethod,
  type PosBootstrap,
  type PosProduct,
  type ProductType,
  type SaleDetail,
  type Prescription,
} from '@medimart/shared';
import { ApiClientError, errorMessage } from '../../lib/api';
import { useApp } from '../../lib/context';
import { Badge, Button, FormError, Modal, PageHeading } from '../../components/ui';
import {
  buildQuery,
  formatDate,
  formatMoney,
  koboToNairaInput,
  nairaToKobo,
  useAsync,
} from '../inventory/lib';
import {
  EmptyState,
  ErrorBlock,
  Field,
  LoadingBlock,
  SearchField,
  StatusBadge,
} from '../inventory/shared';
import { ReceiptDocument, type ReceiptPrintMode } from './ReceiptView';
import { SalesAccessGate } from './SalesAccessGate';
import { cacheCatalog, offlineAvailable, saveOfflineRecord } from '../../platform/offline';
import { CameraScanButton, CameraScanner } from '../../components/CameraScanner';

type CartLine = {
  key: string;
  product: PosProduct;
  unitId: string;
  quantity: number;
  lineDiscountInput: string;
};

type PaymentLegDraft = {
  id: string;
  method: PaymentMethod;
  amountInput: string;
  reference: string;
};

type CheckoutMode = 'cash' | 'bank_transfer' | 'pos_terminal' | 'split' | 'credit';

function createPaymentLeg(method: PaymentMethod = 'cash', amountInput = ''): PaymentLegDraft {
  return {
    id: crypto.randomUUID(),
    method,
    amountInput,
    reference: '',
  };
}

export function PosTerminalPage() {
  const { api, user, notify, runtime, connection } = useApp();
  const navigate = useNavigate();
  const prescriptionId = new URLSearchParams(useLocation().search).get('prescriptionId');
  const [reviewedPrescription, setReviewedPrescription] = useState(false);
  const [loadingPrescription, setLoadingPrescription] = useState(false);
  async function loadPrescriptionCart() {
    if (!prescriptionId) return;
    setLoadingPrescription(true);
    setCheckoutError(null);
    try {
      const { prescription: rx } = await api.request<{ prescription: Prescription }>(
        `/api/prescriptions/${prescriptionId}`,
      );
      if (!['authorized', 'partial'].includes(rx.status))
        throw new Error('This prescription is not outstanding and authorized.');
      const lines: CartLine[] = [];
      for (const item of rx.items.filter((i) => i.quantity > i.dispensed)) {
        const found = await api.request<Paginated<PosProduct>>(
          `/api/pos/products?search=${encodeURIComponent(item.medicineName)}`,
        );
        const product = found.items.find((p) => p.id === item.productId);
        if (!product) throw new Error('A prescribed medicine is unavailable in the POS catalogue.');
        lines.push({
          key: crypto.randomUUID(),
          product,
          unitId: product.baseUnitId,
          quantity: item.quantity - item.dispensed,
          lineDiscountInput: '0.00',
        });
      }
      setCart(lines);
      setReviewedPrescription(false);
    } catch (e) {
      setCheckoutError(errorMessage(e));
    } finally {
      setLoadingPrescription(false);
    }
  }
  const canAccess = Boolean(user && hasPermission(user.permissions, 'pos.access'));
  const canCreateSale = Boolean(user && hasPermission(user.permissions, 'sales.create'));
  const canDiscountDirectly = Boolean(user && hasPermission(user.permissions, 'sales.discount'));
  const canManageCustomers = Boolean(user && hasPermission(user.permissions, 'customers.manage'));

  // Catalog filters
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<ProductType | ''>('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [inStockOnly, setInStockOnly] = useState(false);

  // Barcode scanner input
  const [scanCode, setScanCode] = useState('');
  const [scanning, setScanning] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const scanInputRef = useRef<HTMLInputElement>(null);

  // Cart & checkout state
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [customerSearch, setCustomerSearch] = useState('');
  const [cartDiscountInput, setCartDiscountInput] = useState('0.00');
  const [discountReason, setDiscountReason] = useState('');
  const [supervisorEmail, setSupervisorEmail] = useState('');
  const [supervisorPassword, setSupervisorPassword] = useState('');
  const [checkoutMode, setCheckoutMode] = useState<CheckoutMode>('cash');
  const [cashTenderedInput, setCashTenderedInput] = useState('');
  const [singleReference, setSingleReference] = useState('');
  const [splitLegs, setSplitLegs] = useState<PaymentLegDraft[]>(() => [
    createPaymentLeg('cash', ''),
    createPaymentLeg('bank_transfer', ''),
  ]);
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // A sale parked on this Android device because the shop computer was unreachable.
  const [parkedSale, setParkedSale] = useState<{
    receiptNumber: string | null;
    totalKobo: number;
  } | null>(null);
  const [parking, setParking] = useState(false);
  const [offlineOffer, setOfflineOffer] = useState<Parameters<typeof parkSaleOffline>[0] | null>(
    null,
  );

  // Completed sale receipt modal
  const [completedSale, setCompletedSale] = useState<SaleDetail | null>(null);
  const [receiptMode, setReceiptMode] = useState<ReceiptPrintMode>('thermal');

  // Quick customer creation modal
  const [customerModalOpen, setCustomerModalOpen] = useState(false);
  const [newCustName, setNewCustName] = useState('');
  const [newCustPhone, setNewCustPhone] = useState('');
  const [newCustEmail, setNewCustEmail] = useState('');
  const [newCustAddress, setNewCustAddress] = useState('');
  const [newCustLimit, setNewCustLimit] = useState('');
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [customerFormError, setCustomerFormError] = useState<string | null>(null);

  const idempotencyRef = useRef<{ payloadKey: string; operationId: string } | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(timer);
  }, [search]);

  const bootstrap = useAsync(
    () => (canAccess ? api.request<PosBootstrap>('/api/pos/bootstrap') : Promise.resolve(null)),
    [canAccess],
  );

  const catalog = useAsync(
    () =>
      canAccess
        ? api.request<Paginated<PosProduct>>(
            `/api/pos/products${buildQuery({
              search: debouncedSearch || undefined,
              type: typeFilter || undefined,
              categoryId: categoryFilter || undefined,
              inStockOnly: inStockOnly ? 'true' : undefined,
              pageSize: 40,
            })}`,
          )
        : Promise.resolve(null),
    [canAccess, debouncedSearch, typeFilter, categoryFilter, inStockOnly],
  );

  // Keep an offline product snapshot on this device so a clerk can still sell while disconnected.
  useEffect(() => {
    if (!offlineAvailable(runtime) || !catalog.data || connection !== 'online') return;
    void cacheCatalog(runtime, bootstrap.data?.shop.businessName ?? 'MediMart', catalog.data.items);
  }, [runtime, connection, catalog.data, bootstrap.data]);

  const customersState = useAsync(
    () =>
      canAccess
        ? api.request<Paginated<CustomerSummary>>(
            `/api/customers${buildQuery({
              search: customerSearch || undefined,
              status: 'active',
              pageSize: 50,
            })}`,
          )
        : Promise.resolve(null),
    [canAccess, customerSearch],
  );

  const selectedCustomer = useMemo(
    () => customersState.data?.items.find((c) => c.id === customerId) ?? null,
    [customersState.data, customerId],
  );

  function addProductToCart(product: PosProduct, requestedUnitId?: string) {
    if (product.sellableQuantity <= 0) {
      notify(
        product.expiredQuantity > 0
          ? `${product.name} only has expired stock remaining and cannot be sold.`
          : `${product.name} is out of stock.`,
        'error',
      );
      return;
    }
    const chosenUnitId = requestedUnitId ?? product.baseUnitId;
    const unitOption = product.units.find((u) => u.unitId === chosenUnitId) ?? product.units[0]!;

    setCart((current) => {
      const existingBaseUsed = current
        .filter((line) => line.product.id === product.id)
        .reduce((sum, line) => {
          const u = line.product.units.find((entry) => entry.unitId === line.unitId);
          return sum + line.quantity * (u?.factor ?? 1);
        }, 0);

      if (existingBaseUsed + unitOption.factor > product.sellableQuantity) {
        notify(
          `Only ${product.sellableQuantity} ${product.baseUnitSymbol} of ${product.name} available for sale.`,
          'error',
        );
        return current;
      }

      const existingIdx = current.findIndex(
        (line) => line.product.id === product.id && line.unitId === chosenUnitId,
      );
      if (existingIdx >= 0) {
        return current.map((line, idx) =>
          idx === existingIdx ? { ...line, quantity: line.quantity + 1 } : line,
        );
      }
      return [
        ...current,
        {
          key: crypto.randomUUID(),
          product,
          unitId: chosenUnitId,
          quantity: 1,
          lineDiscountInput: '0.00',
        },
      ];
    });
    setCheckoutError(null);
  }

  /** Add one product to the cart by barcode/SKU. Used by the keyboard and camera paths. */
  async function scanProductCode(code: string) {
    const trimmed = code.trim();
    if (!trimmed) return;
    setScanning(true);
    try {
      const response = await api.request<{ product: PosProduct }>(
        `/api/pos/lookup${buildQuery({ code: trimmed })}`,
      );
      addProductToCart(response.product);
      setScanCode('');
      scanInputRef.current?.focus();
    } catch (caught) {
      notify(errorMessage(caught), 'error');
    } finally {
      setScanning(false);
    }
  }

  async function handleBarcodeScan(event: FormEvent) {
    event.preventDefault();
    await scanProductCode(scanCode);
  }

  function updateLineUnit(lineKey: string, nextUnitId: string) {
    setCart((current) =>
      current.map((line) => {
        if (line.key !== lineKey) return line;
        const unit = line.product.units.find((u) => u.unitId === nextUnitId);
        if (!unit) return line;
        const maxQty = Math.max(1, Math.floor(line.product.sellableQuantity / unit.factor));
        return {
          ...line,
          unitId: nextUnitId,
          quantity: Math.min(line.quantity, maxQty),
        };
      }),
    );
  }

  function updateLineQuantity(lineKey: string, nextQty: number) {
    if (!Number.isInteger(nextQty) || nextQty < 1) return;
    setCart((current) =>
      current.map((line) => (line.key === lineKey ? { ...line, quantity: nextQty } : line)),
    );
  }

  function updateLineDiscount(lineKey: string, value: string) {
    setCart((current) =>
      current.map((line) => (line.key === lineKey ? { ...line, lineDiscountInput: value } : line)),
    );
  }

  function removeLine(lineKey: string) {
    setCart((current) => current.filter((line) => line.key !== lineKey));
  }

  // Integer-kobo cart math
  const cartMath = useMemo(() => {
    const baseUsedByProduct = new Map<string, number>();
    const computedLines = cart.map((line) => {
      const unit =
        line.product.units.find((u) => u.unitId === line.unitId) ?? line.product.units[0]!;
      const baseQuantity = line.quantity * unit.factor;
      baseUsedByProduct.set(
        line.product.id,
        (baseUsedByProduct.get(line.product.id) ?? 0) + baseQuantity,
      );
      const lineSubtotalKobo = line.quantity * unit.sellingPriceKobo;
      const parsedDiscount = nairaToKobo(line.lineDiscountInput || '0') ?? 0;
      const lineDiscountKobo = Math.min(Math.max(0, parsedDiscount), lineSubtotalKobo);
      const lineTotalKobo = lineSubtotalKobo - lineDiscountKobo;
      return {
        ...line,
        unit,
        baseQuantity,
        lineSubtotalKobo,
        lineDiscountKobo,
        lineTotalKobo,
      };
    });

    const subtotalKobo = computedLines.reduce((sum, l) => sum + l.lineSubtotalKobo, 0);
    const lineDiscountTotalKobo = computedLines.reduce((sum, l) => sum + l.lineDiscountKobo, 0);
    const afterLineDiscountsKobo = subtotalKobo - lineDiscountTotalKobo;
    const rawCartDiscountKobo = nairaToKobo(cartDiscountInput || '0') ?? 0;
    const cartDiscountKobo = Math.min(Math.max(0, rawCartDiscountKobo), afterLineDiscountsKobo);
    const discountTotalKobo = lineDiscountTotalKobo + cartDiscountKobo;
    const grandTotalKobo = afterLineDiscountsKobo - cartDiscountKobo;

    const overAllocatedProducts = computedLines
      .filter((l) => (baseUsedByProduct.get(l.product.id) ?? 0) > l.product.sellableQuantity)
      .map((l) => l.product.name);

    return {
      lines: computedLines,
      subtotalKobo,
      lineDiscountTotalKobo,
      cartDiscountKobo,
      discountTotalKobo,
      grandTotalKobo,
      baseUsedByProduct,
      overAllocatedProducts: [...new Set(overAllocatedProducts)],
    };
  }, [cart, cartDiscountInput]);

  // Integer-kobo payment preview math
  const paymentPreview = useMemo(() => {
    const total = cartMath.grandTotalKobo;
    let legs: Array<{ method: PaymentMethod; amountKobo: number; reference?: string | null }> = [];

    if (checkoutMode === 'cash') {
      const tendered =
        cashTenderedInput.trim() === '' ? total : (nairaToKobo(cashTenderedInput) ?? 0);
      if (tendered > 0) {
        legs = [{ method: 'cash', amountKobo: tendered }];
      }
    } else if (checkoutMode === 'bank_transfer' || checkoutMode === 'pos_terminal') {
      if (total > 0) {
        legs = [
          {
            method: checkoutMode,
            amountKobo: total,
            reference: singleReference.trim() || null,
          },
        ];
      }
    } else if (checkoutMode === 'split') {
      legs = splitLegs
        .map((leg) => ({
          method: leg.method,
          amountKobo: nairaToKobo(leg.amountInput || '0') ?? 0,
          reference: leg.reference.trim() || null,
        }))
        .filter((leg) => leg.amountKobo > 0);
    } else {
      // Full credit: 0 upfront payments
      legs = [];
    }

    const tenderedKobo = legs.reduce((sum, leg) => sum + leg.amountKobo, 0);
    const cashTenderedKobo = legs
      .filter((leg) => leg.method === 'cash')
      .reduce((sum, leg) => sum + leg.amountKobo, 0);
    const nonCashTenderedKobo = tenderedKobo - cashTenderedKobo;
    const changeDueKobo = Math.max(0, tenderedKobo - total);
    const amountPaidKobo = Math.min(total, tenderedKobo);
    const outstandingKobo = Math.max(0, total - amountPaidKobo);
    const nonCashOverpayment = nonCashTenderedKobo > total;

    return {
      legs,
      tenderedKobo,
      amountPaidKobo,
      changeDueKobo,
      outstandingKobo,
      nonCashOverpayment,
    };
  }, [cartMath.grandTotalKobo, checkoutMode, cashTenderedInput, singleReference, splitLegs]);

  const needsSupervisorApproval = cartMath.discountTotalKobo > 0 && !canDiscountDirectly;

  function resetSaleWorkspace() {
    setCart([]);
    setCustomerId('');
    setCartDiscountInput('0.00');
    setDiscountReason('');
    setSupervisorEmail('');
    setSupervisorPassword('');
    setCheckoutMode('cash');
    setCashTenderedInput('');
    setSingleReference('');
    setSplitLegs([createPaymentLeg('cash', ''), createPaymentLeg('bank_transfer', '')]);
    setDueDate('');
    setNotes('');
    setCheckoutError(null);
    setOfflineOffer(null);
    idempotencyRef.current = null;
  }

  /**
   * Park a sale on the device when the shop computer cannot be reached.
   * Only Android has the durable local store, and the server still validates every record later.
   */
  async function parkSaleOffline(corePayload: {
    customerId: string | null;
    items: Array<{
      productId: string;
      unitId: string;
      quantity: number;
      lineDiscountKobo: number;
    }>;
    cartDiscountKobo: number;
    discountReason: string | null;
    payments: Array<{ method: PaymentMethod; amountKobo: number; reference?: string | null }>;
    dueDate: string | null;
    notes: string | null;
  }) {
    if (!user) return;
    if (!offlineAvailable(runtime)) {
      setCheckoutError(
        'Offline sales are only stored on the MediMart Android application. Reconnect to the shop computer to complete this sale.',
      );
      return;
    }
    if (prescriptionId) {
      setCheckoutError(
        'A prescription dispense needs the shop computer. Park only ordinary shop sales offline.',
      );
      return;
    }
    if (cartMath.discountTotalKobo > 0 && !canDiscountDirectly) {
      setCheckoutError(
        'A discount needs a supervisor verified by the shop computer. Complete this sale when you are connected.',
      );
      return;
    }
    if (paymentPreview.outstandingKobo > 0 && !customerId) {
      setCheckoutError(
        'A credit sale needs an existing customer chosen from the shop computer. Park only fully paid sales offline.',
      );
      return;
    }
    setParking(true);
    try {
      const saved = await saveOfflineRecord(
        runtime,
        {
          recordType: 'sale',
          requiresOnlineReview: false,
          payload: {
            customerId: customerId || null,
            customerDraft: null,
            items: corePayload.items,
            cartDiscountKobo: corePayload.cartDiscountKobo,
            discountReason: corePayload.discountReason,
            payments: corePayload.payments.map((leg) => ({
              method: leg.method,
              amountKobo: leg.amountKobo,
              reference: leg.reference ?? null,
            })),
            dueDate: corePayload.dueDate,
            notes: corePayload.notes,
          },
        },
        user.id,
      );
      setParkedSale({
        receiptNumber: saved.receiptNumber,
        totalKobo: cartMath.grandTotalKobo,
      });
      resetSaleWorkspace();
      notify('Sale saved on this device. It will synchronize when you reconnect.', 'success');
    } catch (caught) {
      setCheckoutError(errorMessage(caught));
    } finally {
      setParking(false);
    }
  }

  async function submitSale(event: FormEvent) {
    event.preventDefault();
    setCheckoutError(null);

    if (cartMath.lines.length === 0) {
      setCheckoutError('Add at least one item to the cart before completing a sale.');
      return;
    }
    if (cartMath.overAllocatedProducts.length > 0) {
      setCheckoutError(
        `Cart quantity exceeds sellable stock for: ${cartMath.overAllocatedProducts.join(', ')}.`,
      );
      return;
    }
    if (paymentPreview.nonCashOverpayment) {
      setCheckoutError(
        'Bank transfer and POS terminal payments cannot exceed the sale total unless change is returned from a cash leg.',
      );
      return;
    }
    if (paymentPreview.outstandingKobo > 0 && !customerId) {
      setCheckoutError(
        'Select or register a customer before recording a credit or part-payment sale.',
      );
      return;
    }
    if (cartMath.discountTotalKobo > 0 && discountReason.trim().length < 3) {
      setCheckoutError('Enter a short reason (at least 3 characters) for the discount.');
      return;
    }
    if (needsSupervisorApproval && (!supervisorEmail.trim() || !supervisorPassword)) {
      setCheckoutError('Enter supervisor email and password to authorize this discount.');
      return;
    }

    if (prescriptionId && !reviewedPrescription) {
      setCheckoutError('Review the prescription and medicine warnings before checkout.');
      return;
    }
    const corePayload = {
      ...(prescriptionId ? { prescription: { id: prescriptionId, reviewedWarnings: true } } : {}),
      customerId: customerId || null,
      items: cartMath.lines.map((line) => ({
        productId: line.product.id,
        unitId: line.unitId,
        quantity: line.quantity,
        lineDiscountKobo: line.lineDiscountKobo,
      })),
      cartDiscountKobo: cartMath.cartDiscountKobo,
      discountReason: cartMath.discountTotalKobo > 0 ? discountReason.trim() : null,
      payments: paymentPreview.legs,
      dueDate: paymentPreview.outstandingKobo > 0 && dueDate ? dueDate : null,
      notes: notes.trim() || null,
    };

    const payloadKey = JSON.stringify(corePayload);
    if (!idempotencyRef.current || idempotencyRef.current.payloadKey !== payloadKey) {
      idempotencyRef.current = {
        payloadKey,
        operationId: crypto.randomUUID(),
      };
    }

    setSubmitting(true);
    try {
      const sale = await api.request<SaleDetail>('/api/sales', 'POST', {
        operationId: idempotencyRef.current.operationId,
        ...corePayload,
        ...(needsSupervisorApproval
          ? {
              discountAuthorization: {
                email: supervisorEmail.trim(),
                password: supervisorPassword,
              },
            }
          : {}),
      });
      setCompletedSale(sale);
      if (prescriptionId) navigate('/pos', { replace: true });
      resetSaleWorkspace();
      catalog.reload();
      customersState.reload();
      notify(`Sale ${sale.receiptNumber} completed.`, 'success');
    } catch (caught) {
      const offline =
        caught instanceof ApiClientError &&
        ['CONNECTION_FAILED', 'SERVER_NOT_CONFIGURED'].includes(caught.code);
      if (offline && offlineAvailable(runtime)) {
        // The shop computer is unreachable: offer to keep the sale on this device.
        setOfflineOffer(corePayload);
        setCheckoutError(
          'The shop computer is unreachable. You can keep this sale on this device and synchronize it later.',
        );
      } else {
        setCheckoutError(errorMessage(caught));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleQuickCreateCustomer(event: FormEvent) {
    event.preventDefault();
    setCustomerFormError(null);
    const limitKobo = newCustLimit.trim() ? nairaToKobo(newCustLimit) : null;
    if (newCustLimit.trim() && limitKobo === null) {
      setCustomerFormError('Enter a valid credit limit in naira (for example 50000.00).');
      return;
    }
    const parsed = customerInputSchema.safeParse({
      fullName: newCustName,
      phone: newCustPhone || null,
      email: newCustEmail || null,
      address: newCustAddress || null,
      creditLimitKobo: limitKobo,
      status: 'active',
    });
    if (!parsed.success) {
      setCustomerFormError(parsed.error.issues[0]!.message);
      return;
    }
    setCreatingCustomer(true);
    try {
      const created = await api.request<CustomerSummary>('/api/customers', 'POST', parsed.data);
      customersState.reload();
      setCustomerId(created.id);
      setCustomerModalOpen(false);
      setNewCustName('');
      setNewCustPhone('');
      setNewCustEmail('');
      setNewCustAddress('');
      setNewCustLimit('');
      notify(`Customer ${created.fullName} registered.`, 'success');
    } catch (caught) {
      setCustomerFormError(errorMessage(caught));
    } finally {
      setCreatingCustomer(false);
    }
  }

  if (!canAccess) {
    return (
      <SalesAccessGate
        eyebrow="Point of Sale"
        title="Point of Sale"
        description="Fast pharmacy and mini-mart checkout with FEFO stock protection."
        permission="pos.access"
      />
    );
  }

  const categories = bootstrap.data?.categories ?? [];
  const products = catalog.data?.items ?? [];

  return (
    <>
      <PageHeading
        eyebrow="Point of Sale"
        title="Checkout terminal"
        description="Scan barcodes, sell in base or pack units, and record cash, transfer, POS, split, or credit payments."
        action={
          <>
            <Button variant="secondary" onClick={catalog.reload} busy={catalog.loading}>
              <RefreshCw size={15} /> Refresh stock
            </Button>
            <Link to="/pos/sales" className="button button-secondary">
              Sales history
            </Link>
          </>
        }
      />

      {/* Barcode / SKU quick scan bar */}
      <section className="card pos-scanner-bar" aria-label="Barcode and SKU scanner">
        <form onSubmit={(event) => void handleBarcodeScan(event)} className="pos-scanner-form">
          <div className="pos-scanner-input-wrap">
            <Barcode size={18} />
            <input
              ref={scanInputRef}
              aria-label="Scan barcode or SKU"
              placeholder="Scan barcode or type exact SKU and press Enter…"
              value={scanCode}
              onChange={(event) => setScanCode(event.target.value)}
            />
          </div>
          <Button type="submit" variant="secondary" busy={scanning}>
            Scan / Add
          </Button>
          <CameraScanButton onClick={() => setCameraOpen(true)} />
        </form>
        <CameraScanner
          open={cameraOpen}
          onClose={() => setCameraOpen(false)}
          onDetected={(code) => {
            setScanCode('');
            void scanProductCode(code);
          }}
        />
      </section>

      <div className="pos-grid">
        {/* LEFT COLUMN: Product Catalog */}
        <section className="card inventory-card pos-catalog-card" aria-label="Sellable products">
          <div className="card-heading">
            <div>
              <h2>Products</h2>
              <p>Expired medicine batches are automatically excluded from sellable stock.</p>
            </div>
            <Badge tone="green">{catalog.data?.total ?? 0} active</Badge>
          </div>

          <div className="inventory-filters">
            <SearchField
              value={search}
              onChange={setSearch}
              placeholder="Search name, generic name, SKU, or barcode…"
              label="Search POS products"
            />
            <select
              aria-label="Filter by product type"
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value as ProductType | '')}
            >
              <option value="">All product types</option>
              {productTypes.map((type) => (
                <option key={type} value={type}>
                  {productTypeLabels[type]}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by category"
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value)}
            >
              <option value="">All categories</option>
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </select>
            <label className="checkbox-inline">
              <input
                type="checkbox"
                checked={inStockOnly}
                onChange={(event) => setInStockOnly(event.target.checked)}
              />
              <span>In stock only</span>
            </label>
          </div>

          {catalog.loading && !catalog.data ? (
            <LoadingBlock label="Loading sellable products…" />
          ) : catalog.error ? (
            <ErrorBlock message={catalog.error} onRetry={catalog.reload} />
          ) : products.length === 0 ? (
            <EmptyState
              icon={<ShoppingBag size={24} />}
              title="No matching products"
              message="Try clearing your search filters or receive stock in Inventory first."
            />
          ) : (
            <div className="pos-product-list">
              {products.map((product) => {
                const inCartBase = cartMath.baseUsedByProduct.get(product.id) ?? 0;
                const remainingSellable = Math.max(0, product.sellableQuantity - inCartBase);
                const outOfSellable = remainingSellable <= 0;
                return (
                  <div
                    key={product.id}
                    className={`pos-product-row ${outOfSellable ? 'is-depleted' : ''}`}
                  >
                    <div className="pos-product-info">
                      <div className="pos-product-title-row">
                        <strong>{product.name}</strong>
                        <Badge tone={product.productType === 'medicine' ? 'green' : 'neutral'}>
                          {productTypeLabels[product.productType]}
                        </Badge>
                      </div>
                      <div className="pos-product-sub">
                        {product.genericName && <span>{product.genericName}</span>}
                        {product.sku && <span>SKU: {product.sku}</span>}
                        {product.barcode && <span>Barcode: {product.barcode}</span>}
                      </div>
                      <div className="pos-product-stock-row">
                        <StatusBadge
                          tone={
                            product.sellableQuantity <= 0
                              ? 'red'
                              : product.sellableQuantity <= product.reorderLevel
                                ? 'amber'
                                : 'green'
                          }
                        >
                          {product.sellableQuantity} {product.baseUnitSymbol} sellable
                        </StatusBadge>
                        {product.expiredQuantity > 0 && (
                          <StatusBadge tone="red">
                            {product.expiredQuantity} {product.baseUnitSymbol} expired blocked
                          </StatusBadge>
                        )}
                        {product.nearestValidExpiryDate && (
                          <span className="muted small">
                            FEFO exp: {formatDate(product.nearestValidExpiryDate)}
                          </span>
                        )}
                      </div>
                      {product.units.length > 1 && (
                        <div className="pos-unit-chips">
                          {product.units.map((u) => (
                            <button
                              key={u.unitId}
                              type="button"
                              className="pos-unit-chip"
                              disabled={remainingSellable < u.factor || !canCreateSale}
                              onClick={() => addProductToCart(product, u.unitId)}
                            >
                              + 1 {u.symbol} ({formatMoney(u.sellingPriceKobo)})
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="pos-product-action">
                      <strong className="pos-price">
                        {formatMoney(product.sellingPriceKobo)}
                        <small>/{product.baseUnitSymbol}</small>
                      </strong>
                      <Button
                        type="button"
                        variant={outOfSellable ? 'secondary' : 'primary'}
                        disabled={outOfSellable || !canCreateSale}
                        onClick={() => addProductToCart(product)}
                        aria-label={`Add ${product.name} to cart`}
                      >
                        <Plus size={15} />
                        {inCartBase > 0 ? `Add (${inCartBase} in cart)` : 'Add'}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* RIGHT COLUMN: Cart & Checkout */}
        <section
          className="card inventory-card pos-cart-card"
          aria-label="Shopping cart and checkout"
        >
          <div className="card-heading">
            <div>
              <h2>Current sale</h2>
              <p>
                {cartMath.lines.length === 0
                  ? 'Cart is empty'
                  : `${cartMath.lines.length} line${cartMath.lines.length === 1 ? '' : 's'} ready for checkout`}
              </p>
            </div>
            {cart.length > 0 && (
              <Button variant="ghost" type="button" onClick={resetSaleWorkspace}>
                <Trash2 size={14} /> Clear
              </Button>
            )}
          </div>

          <form onSubmit={(event) => void submitSale(event)} className="pos-checkout-form">
            {cartMath.lines.length === 0 ? (
              <div className="pos-empty-cart">
                <ShoppingBag size={26} />
                <p>Select products on the left or scan a barcode above to build a basket.</p>
              </div>
            ) : (
              <div className="pos-cart-lines">
                {cartMath.lines.map((line) => {
                  const totalProductBase = cartMath.baseUsedByProduct.get(line.product.id) ?? 0;
                  const exceedsStock = totalProductBase > line.product.sellableQuantity;
                  const maxUnitQty = Math.max(
                    1,
                    Math.floor(line.product.sellableQuantity / line.unit.factor),
                  );
                  return (
                    <div
                      key={line.key}
                      className={`pos-cart-line ${exceedsStock ? 'has-stock-error' : ''}`}
                    >
                      <div className="pos-cart-line-top">
                        <div>
                          <strong>{line.product.name}</strong>
                          <small className="muted">
                            {formatMoney(line.unit.sellingPriceKobo)} per {line.unit.symbol}
                            {line.unit.factor > 1
                              ? ` (${line.baseQuantity} ${line.product.baseUnitSymbol})`
                              : ''}
                          </small>
                        </div>
                        <div className="pos-cart-line-amount">
                          <strong>{formatMoney(line.lineTotalKobo)}</strong>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`Remove ${line.product.name}`}
                            onClick={() => removeLine(line.key)}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>

                      <div className="pos-cart-line-controls">
                        <label className="pos-mini-field">
                          <span>Unit</span>
                          <select
                            aria-label={`Selling unit for ${line.product.name}`}
                            value={line.unitId}
                            onChange={(event) => updateLineUnit(line.key, event.target.value)}
                          >
                            {line.product.units.map((u) => (
                              <option key={u.unitId} value={u.unitId}>
                                {u.name} ({u.factor}× {line.product.baseUnitSymbol}) —{' '}
                                {formatMoney(u.sellingPriceKobo)}
                              </option>
                            ))}
                          </select>
                        </label>

                        <div className="pos-qty-stepper">
                          <span>Qty</span>
                          <div className="pos-stepper-box">
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={`Decrease quantity of ${line.product.name}`}
                              disabled={line.quantity <= 1}
                              onClick={() => updateLineQuantity(line.key, line.quantity - 1)}
                            >
                              <Minus size={14} />
                            </button>
                            <input
                              type="number"
                              min={1}
                              max={maxUnitQty}
                              aria-label={`Quantity for ${line.product.name}`}
                              value={line.quantity}
                              onChange={(event) =>
                                updateLineQuantity(line.key, Number(event.target.value))
                              }
                            />
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={`Increase quantity of ${line.product.name}`}
                              disabled={line.quantity >= maxUnitQty}
                              onClick={() => updateLineQuantity(line.key, line.quantity + 1)}
                            >
                              <Plus size={14} />
                            </button>
                          </div>
                        </div>

                        <label className="pos-mini-field">
                          <span>Line disc. (₦)</span>
                          <input
                            type="text"
                            inputMode="decimal"
                            aria-label={`Line discount for ${line.product.name}`}
                            value={line.lineDiscountInput}
                            onChange={(event) => updateLineDiscount(line.key, event.target.value)}
                          />
                        </label>
                      </div>

                      {exceedsStock && (
                        <p className="field-error small">
                          Exceeds sellable stock ({line.product.sellableQuantity}{' '}
                          {line.product.baseUnitSymbol} available).
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Customer Selection */}
            <div className="pos-section-block">
              <div className="pos-section-header">
                <strong>Customer</strong>
                {canManageCustomers && (
                  <button
                    type="button"
                    className="pos-link-btn"
                    onClick={() => setCustomerModalOpen(true)}
                  >
                    <UserPlus size={14} /> New customer
                  </button>
                )}
              </div>
              <div className="form-two-columns">
                <label className="field-label">
                  Filter customers
                  <input
                    aria-label="Filter customers"
                    placeholder="Type name or phone…"
                    value={customerSearch}
                    onChange={(event) => setCustomerSearch(event.target.value)}
                  />
                </label>
                <label className="field-label">
                  Selected customer
                  <select
                    aria-label="Select customer"
                    value={customerId}
                    onChange={(event) => setCustomerId(event.target.value)}
                  >
                    <option value="">Walk-in customer</option>
                    {(customersState.data?.items ?? []).map((cust) => (
                      <option key={cust.id} value={cust.id}>
                        {cust.fullName}
                        {cust.phone ? ` (${cust.phone})` : ''}
                        {cust.outstandingBalanceKobo > 0
                          ? ` · Owes ${formatMoney(cust.outstandingBalanceKobo)}`
                          : ''}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {selectedCustomer && (
                <p className="inventory-note">
                  <strong>{selectedCustomer.fullName}</strong> · Current balance:{' '}
                  <strong>{formatMoney(selectedCustomer.outstandingBalanceKobo)}</strong>
                  {selectedCustomer.creditLimitKobo !== null && (
                    <> · Credit limit: {formatMoney(selectedCustomer.creditLimitKobo)}</>
                  )}
                </p>
              )}
            </div>

            {/* Discount & Supervisor Override */}
            <div className="pos-section-block">
              <div className="form-two-columns">
                <Field label="Cart discount (₦)">
                  <input
                    aria-label="Cart discount (₦)"
                    inputMode="decimal"
                    value={cartDiscountInput}
                    onChange={(event) => setCartDiscountInput(event.target.value)}
                  />
                </Field>
                <Field
                  label="Discount reason"
                  hint={cartMath.discountTotalKobo > 0 ? 'Required when discounting' : 'Optional'}
                >
                  <input
                    aria-label="Discount reason"
                    placeholder="Wholesale / loyalty discount"
                    value={discountReason}
                    onChange={(event) => setDiscountReason(event.target.value)}
                  />
                </Field>
              </div>

              {needsSupervisorApproval && (
                <div
                  className="pos-supervisor-box"
                  role="region"
                  aria-label="Supervisor discount authorization"
                >
                  <div className="pos-supervisor-heading">
                    <ShieldAlert size={17} />
                    <div>
                      <strong>Supervisor discount authorization required</strong>
                      <p>
                        Your role does not include <code>sales.discount</code>. Ask a manager,
                        administrator, or owner to approve below.
                      </p>
                    </div>
                  </div>
                  <div className="form-two-columns">
                    <Field label="Supervisor email">
                      <input
                        type="email"
                        aria-label="Supervisor email"
                        value={supervisorEmail}
                        onChange={(event) => setSupervisorEmail(event.target.value)}
                      />
                    </Field>
                    <Field label="Supervisor password">
                      <input
                        type="password"
                        aria-label="Supervisor password"
                        autoComplete="off"
                        value={supervisorPassword}
                        onChange={(event) => setSupervisorPassword(event.target.value)}
                      />
                    </Field>
                  </div>
                </div>
              )}
            </div>

            {/* Payment Method & Split Builder */}
            <div className="pos-section-block">
              <strong>Payment method</strong>
              <div className="pos-mode-grid" role="group" aria-label="Checkout payment mode">
                {(
                  [
                    { id: 'cash', label: 'Cash', icon: Wallet },
                    { id: 'bank_transfer', label: 'Transfer', icon: Landmark },
                    { id: 'pos_terminal', label: 'POS card', icon: CreditCard },
                    { id: 'split', label: 'Split / Part', icon: Plus },
                    { id: 'credit', label: 'Full credit', icon: ShoppingBag },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`pos-mode-btn ${checkoutMode === option.id ? 'active' : ''}`}
                    onClick={() => setCheckoutMode(option.id)}
                  >
                    <option.icon size={15} />
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>

              {checkoutMode === 'cash' && (
                <div className="pos-payment-detail">
                  <Field
                    label="Cash tendered (₦)"
                    hint={`Leave blank for exact ${formatMoney(cartMath.grandTotalKobo)}, or enter cash handed over to calculate change or part-payment.`}
                  >
                    <input
                      aria-label="Cash tendered (₦)"
                      inputMode="decimal"
                      placeholder={koboToNairaInput(cartMath.grandTotalKobo)}
                      value={cashTenderedInput}
                      onChange={(event) => setCashTenderedInput(event.target.value)}
                    />
                  </Field>
                  {cartMath.grandTotalKobo > 0 && (
                    <div className="pos-quick-cash">
                      <button
                        type="button"
                        className="pos-unit-chip"
                        onClick={() =>
                          setCashTenderedInput(koboToNairaInput(cartMath.grandTotalKobo))
                        }
                      >
                        Exact ({formatMoney(cartMath.grandTotalKobo)})
                      </button>
                      {[100_000, 200_000, 500_000, 1_000_000].map((preset) =>
                        preset >= cartMath.grandTotalKobo ? (
                          <button
                            key={preset}
                            type="button"
                            className="pos-unit-chip"
                            onClick={() => setCashTenderedInput(koboToNairaInput(preset))}
                          >
                            {formatMoney(preset)}
                          </button>
                        ) : null,
                      )}
                    </div>
                  )}
                </div>
              )}

              {(checkoutMode === 'bank_transfer' || checkoutMode === 'pos_terminal') && (
                <div className="pos-payment-detail">
                  <Field
                    label={
                      checkoutMode === 'bank_transfer'
                        ? 'Transfer reference / session ID'
                        : 'POS terminal RRN / receipt reference'
                    }
                    hint={`Full sale total of ${formatMoney(cartMath.grandTotalKobo)} will be recorded under ${paymentMethodLabels[checkoutMode]}.`}
                  >
                    <input
                      aria-label="Payment reference"
                      placeholder={checkoutMode === 'bank_transfer' ? 'NIP-...' : 'RRN-...'}
                      value={singleReference}
                      onChange={(event) => setSingleReference(event.target.value)}
                    />
                  </Field>
                </div>
              )}

              {checkoutMode === 'split' && (
                <div className="pos-split-list">
                  {splitLegs.map((leg, idx) => (
                    <div key={leg.id} className="pos-split-row">
                      <select
                        aria-label={`Split payment ${idx + 1} method`}
                        value={leg.method}
                        onChange={(event) =>
                          setSplitLegs((current) =>
                            current.map((item) =>
                              item.id === leg.id
                                ? { ...item, method: event.target.value as PaymentMethod }
                                : item,
                            ),
                          )
                        }
                      >
                        {paymentMethods.map((method) => (
                          <option key={method} value={method}>
                            {paymentMethodLabels[method]}
                          </option>
                        ))}
                      </select>
                      <input
                        aria-label={`Split payment ${idx + 1} amount (₦)`}
                        inputMode="decimal"
                        placeholder="Amount (₦)"
                        value={leg.amountInput}
                        onChange={(event) =>
                          setSplitLegs((current) =>
                            current.map((item) =>
                              item.id === leg.id
                                ? { ...item, amountInput: event.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                      <input
                        aria-label={`Split payment ${idx + 1} reference`}
                        placeholder="Ref (optional)"
                        value={leg.reference}
                        onChange={(event) =>
                          setSplitLegs((current) =>
                            current.map((item) =>
                              item.id === leg.id
                                ? { ...item, reference: event.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                      {splitLegs.length > 1 && (
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Remove payment leg ${idx + 1}`}
                          onClick={() =>
                            setSplitLegs((current) => current.filter((item) => item.id !== leg.id))
                          }
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      setSplitLegs((current) => [...current, createPaymentLeg('pos_terminal', '')])
                    }
                  >
                    <Plus size={14} /> Add payment leg
                  </Button>
                </div>
              )}

              {paymentPreview.outstandingKobo > 0 && (
                <div className="pos-credit-callout">
                  <p>
                    <strong>Credit / unpaid balance:</strong>{' '}
                    {formatMoney(paymentPreview.outstandingKobo)} will be recorded as an outstanding
                    customer debt and is <strong>not</strong> counted as cash received.
                  </p>
                  <div className="form-two-columns">
                    <Field label="Debt due date (optional)">
                      <input
                        type="date"
                        aria-label="Debt due date"
                        value={dueDate}
                        onChange={(event) => setDueDate(event.target.value)}
                      />
                    </Field>
                    <Field label="Sale note (optional)">
                      <input
                        aria-label="Sale note"
                        placeholder="Approved credit / delivery note"
                        value={notes}
                        onChange={(event) => setNotes(event.target.value)}
                      />
                    </Field>
                  </div>
                </div>
              )}
            </div>

            {/* Totals Summary Box */}
            <dl className="pos-totals-card">
              <div>
                <dt>Subtotal</dt>
                <dd>{formatMoney(cartMath.subtotalKobo)}</dd>
              </div>
              {cartMath.discountTotalKobo > 0 && (
                <div>
                  <dt>Total discounts</dt>
                  <dd>−{formatMoney(cartMath.discountTotalKobo)}</dd>
                </div>
              )}
              <div className="pos-grand-row">
                <dt>Total sale amount</dt>
                <dd>{formatMoney(cartMath.grandTotalKobo)}</dd>
              </div>
              <div>
                <dt>Total tendered</dt>
                <dd>{formatMoney(paymentPreview.tenderedKobo)}</dd>
              </div>
              <div>
                <dt>Amount paid (applied)</dt>
                <dd>{formatMoney(paymentPreview.amountPaidKobo)}</dd>
              </div>
              {paymentPreview.changeDueKobo > 0 && (
                <div className="pos-change-row">
                  <dt>Change due to customer</dt>
                  <dd>{formatMoney(paymentPreview.changeDueKobo)}</dd>
                </div>
              )}
              {paymentPreview.outstandingKobo > 0 && (
                <div className="pos-debt-row">
                  <dt>Outstanding credit balance</dt>
                  <dd>{formatMoney(paymentPreview.outstandingKobo)}</dd>
                </div>
              )}
            </dl>

            {prescriptionId && (
              <div className="health-warning">
                <Link to={`/prescriptions/${prescriptionId}`}>Review linked prescription</Link>
                <Button
                  variant="secondary"
                  disabled={loadingPrescription || submitting}
                  onClick={loadPrescriptionCart}
                >
                  Load remaining prescription into cart
                </Button>
                <p>
                  Add only prescribed medicines and quantities. Payment and dispensing are saved
                  together, with a single stock deduction.
                </p>
                <label>
                  <input
                    type="checkbox"
                    checked={reviewedPrescription}
                    onChange={(e) => setReviewedPrescription(e.target.checked)}
                  />{' '}
                  I reviewed the current prescription, allergies and medicine warnings
                </label>
              </div>
            )}
            <FormError message={checkoutError} />

            <Button
              type="submit"
              variant="primary"
              className="pos-submit-btn"
              busy={submitting}
              disabled={!canCreateSale || cartMath.lines.length === 0}
            >
              <CheckCircle2 size={17} />
              Complete sale · {formatMoney(cartMath.grandTotalKobo)}
            </Button>
          </form>
        </section>
      </div>

      {/* Completed Sale Receipt Modal */}
      <Modal
        open={Boolean(completedSale)}
        onClose={() => setCompletedSale(null)}
        title={completedSale ? `Sale ${completedSale.receiptNumber} completed` : 'Sale completed'}
      >
        {completedSale && (
          <div className="pos-completed-modal">
            <div className="pos-completed-highlights">
              <div>
                <span>Grand total</span>
                <strong>{formatMoney(completedSale.totalKobo)}</strong>
              </div>
              <div>
                <span>Amount paid</span>
                <strong>{formatMoney(completedSale.amountPaidKobo)}</strong>
              </div>
              <div>
                <span>Change due</span>
                <strong>{formatMoney(completedSale.changeDueKobo)}</strong>
              </div>
              <div>
                <span>Credit balance</span>
                <strong>{formatMoney(completedSale.currentOutstandingKobo)}</strong>
              </div>
            </div>

            <div className="receipt-toolbar no-print">
              <div className="segmented-control" role="group" aria-label="Preview receipt format">
                <button
                  type="button"
                  className={receiptMode === 'thermal' ? 'active' : ''}
                  onClick={() => setReceiptMode('thermal')}
                >
                  Thermal (80mm)
                </button>
                <button
                  type="button"
                  className={receiptMode === 'standard' ? 'active' : ''}
                  onClick={() => setReceiptMode('standard')}
                >
                  Ordinary paper (A4)
                </button>
              </div>
              <Button type="button" variant="secondary" onClick={() => window.print()}>
                <Printer size={15} /> Print
              </Button>
              <Link to={`/pos/receipts/${completedSale.id}`} className="button button-secondary">
                Open receipt page
              </Link>
              <Button type="button" onClick={() => setCompletedSale(null)}>
                Next customer
              </Button>
            </div>

            <div className="pos-modal-receipt-scroll">
              <ReceiptDocument sale={completedSale} mode={receiptMode} />
            </div>
          </div>
        )}
      </Modal>

      {/* Offline offer: the shop computer could not be reached. */}
      <Modal
        open={Boolean(offlineOffer)}
        onClose={() => setOfflineOffer(null)}
        title="Shop computer unreachable"
      >
        <div className="modal-form">
          <p>
            This sale could not be sent to the shop computer. You can keep it safely on this phone
            and synchronize it later, or cancel and wait until the connection returns.
          </p>
          <p className="small muted">
            The shop computer checks every kept sale again before it counts stock or money. Anything
            it cannot verify will be listed for review instead of being forced through.
          </p>
          <div className="modal-actions">
            <Button type="button" variant="secondary" onClick={() => setOfflineOffer(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={parking}
              onClick={() => {
                if (!offlineOffer) return;
                const offer = offlineOffer;
                setOfflineOffer(null);
                void parkSaleOffline(offer);
              }}
            >
              <Wallet size={15} /> Keep sale on this device
            </Button>
          </div>
        </div>
      </Modal>

      {/* Parked sale receipt */}
      <Modal
        open={Boolean(parkedSale)}
        onClose={() => setParkedSale(null)}
        title={
          parkedSale?.receiptNumber
            ? `Sale ${parkedSale.receiptNumber} kept on this device`
            : 'Sale kept on this device'
        }
      >
        {parkedSale && (
          <div className="pos-completed-modal">
            <div className="pos-completed-highlights">
              <div>
                <span>Grand total</span>
                <strong>{formatMoney(parkedSale.totalKobo)}</strong>
              </div>
              <div>
                <span>Synchronization</span>
                <strong>Waiting</strong>
              </div>
            </div>
            <p>
              This sale is stored in this phone&rsquo;s encrypted database and survives an app
              restart. It will be sent automatically when the phone reaches the shop computer. Write
              the reference number above on the customer&rsquo;s slip.
            </p>
            <div className="modal-actions">
              <Button type="button" onClick={() => setParkedSale(null)}>
                Next customer
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Quick Register Customer Modal */}
      <Modal
        open={customerModalOpen}
        onClose={() => setCustomerModalOpen(false)}
        title="Register customer"
      >
        <form onSubmit={(event) => void handleQuickCreateCustomer(event)} className="modal-form">
          <FormError message={customerFormError} />
          <Field label="Customer full name">
            <input
              aria-label="Customer full name"
              required
              minLength={2}
              maxLength={160}
              value={newCustName}
              onChange={(event) => setNewCustName(event.target.value)}
            />
          </Field>
          <div className="form-two-columns">
            <Field label="Phone number">
              <input
                aria-label="Customer phone"
                value={newCustPhone}
                onChange={(event) => setNewCustPhone(event.target.value)}
              />
            </Field>
            <Field label="Email (optional)">
              <input
                type="email"
                aria-label="Customer email"
                value={newCustEmail}
                onChange={(event) => setNewCustEmail(event.target.value)}
              />
            </Field>
          </div>
          <Field label="Address (optional)">
            <input
              aria-label="Customer address"
              value={newCustAddress}
              onChange={(event) => setNewCustAddress(event.target.value)}
            />
          </Field>
          <Field
            label="Credit limit in ₦ (optional)"
            hint="Leave blank for no fixed limit, or enter 0.00 to block credit sales."
          >
            <input
              aria-label="Credit limit (₦)"
              inputMode="decimal"
              placeholder="50000.00"
              value={newCustLimit}
              onChange={(event) => setNewCustLimit(event.target.value)}
            />
          </Field>
          <div className="form-actions">
            <Button type="button" variant="secondary" onClick={() => setCustomerModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" busy={creatingCustomer}>
              Save &amp; select customer
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
