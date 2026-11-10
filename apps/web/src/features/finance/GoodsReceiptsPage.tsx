import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardList, Eye } from 'lucide-react';
import type { GoodsReceiptDetail, GoodsReceiptSummary, Paginated } from '@medimart/shared';
import { useApp } from '../../lib/context';
import { PageHeading } from '../../components/ui';
import { EmptyState, ErrorBlock, LoadingBlock, Pagination } from '../inventory/shared';
import { buildQuery, formatDate, formatMoney, useAsync } from './lib';

export function GoodsReceiptsPage() {
  const { api } = useApp();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<string | null>(null);
  const receipts = useAsync(
    () =>
      api.request<Paginated<GoodsReceiptSummary>>(
        `/api/goods-receipts${buildQuery({ from, to, page, pageSize: 20 })}`,
      ),
    [from, to, page],
  );
  const detail = useAsync(
    () =>
      viewing
        ? api.request<GoodsReceiptDetail>(`/api/goods-receipts/${viewing}`)
        : Promise.resolve(null),
    [viewing],
  );
  const data = receipts.data;

  return (
    <div className="inventory-workspace">
      <PageHeading
        eyebrow="Purchasing"
        title="Goods received"
        description="Every delivery, including partial deliveries and rejected quantities. Stock moves only through these receipts."
        action={
          <Link className="button button-secondary" to="/purchases">
            Purchase orders
          </Link>
        }
      />
      <div className="inventory-tabs">
        <Link className="inventory-tab" to="/purchases">
          Purchase orders
        </Link>
        <Link className="inventory-tab active" to="/purchases/receipts">
          Goods received
        </Link>
        <Link className="inventory-tab" to="/supplier-payments">
          Supplier payments
        </Link>
        <Link className="inventory-tab" to="/supplier-balances">
          Supplier balances
        </Link>
      </div>
      <section className="card inventory-card">
        <div className="inventory-filters">
          <label className="inline-date">
            <span className="small muted">From</span>
            <input
              type="date"
              aria-label="Receipts from date"
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <label className="inline-date">
            <span className="small muted">To</span>
            <input
              type="date"
              aria-label="Receipts to date"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                setPage(1);
              }}
            />
          </label>
        </div>
        {receipts.loading && !data ? (
          <LoadingBlock label="Loading goods receipts…" />
        ) : receipts.error ? (
          <ErrorBlock message={receipts.error} onRetry={receipts.reload} />
        ) : data && data.items.length === 0 ? (
          <EmptyState
            icon={<ClipboardList size={27} />}
            title="No goods received yet"
            message="Receive goods against an ordered purchase to create stock and supplier debt."
            action={
              <Link className="button button-primary" to="/purchases">
                Open purchases
              </Link>
            }
          />
        ) : data ? (
          <>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Receipt</th>
                    <th>Received</th>
                    <th>Purchase</th>
                    <th>Supplier</th>
                    <th>Items</th>
                    <th>Value</th>
                    <th>Rejected</th>
                    <th>Recorded by</th>
                    <th aria-label="View" />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((receipt) => (
                    <tr key={receipt.id}>
                      <td>
                        <span className="table-primary">{receipt.receiptNumber}</span>
                      </td>
                      <td>{formatDate(receipt.receivedDate)}</td>
                      <td>
                        <Link className="text-link" to={`/purchases/${receipt.purchaseOrderId}`}>
                          {receipt.purchaseReference}
                        </Link>
                      </td>
                      <td>{receipt.supplierName}</td>
                      <td>{receipt.itemCount}</td>
                      <td>{formatMoney(receipt.receivedValueKobo)}</td>
                      <td className={receipt.totalRejectedBaseQuantity > 0 ? 'text-amber' : ''}>
                        {receipt.totalRejectedBaseQuantity} base
                      </td>
                      <td>{receipt.receivedByName ?? '—'}</td>
                      <td className="row-actions">
                        <button
                          className="icon-button"
                          aria-label={`View ${receipt.receiptNumber}`}
                          onClick={() => setViewing(receipt.id)}
                        >
                          <Eye size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={data.page}
              totalPages={data.totalPages}
              total={data.total}
              onChange={setPage}
            />
          </>
        ) : null}
      </section>

      {viewing && (
        <section className="card inventory-card">
          <div className="card-heading">
            <div>
              <h2>{detail.data?.receiptNumber ?? 'Receipt details'}</h2>
              <p>
                Accepted quantities created stock movements. Rejected quantities never enter stock.
              </p>
            </div>
            <button className="button button-secondary" onClick={() => setViewing(null)}>
              Close
            </button>
          </div>
          {detail.loading ? (
            <LoadingBlock label="Loading receipt…" />
          ) : detail.error ? (
            <ErrorBlock message={detail.error} onRetry={detail.reload} />
          ) : detail.data ? (
            <>
              <div className="detail-list">
                <div>
                  <span>Purchase</span>
                  <strong>{detail.data.purchaseReference}</strong>
                </div>
                <div>
                  <span>Supplier</span>
                  <strong>{detail.data.supplierName}</strong>
                </div>
                <div>
                  <span>Received</span>
                  <strong>{formatDate(detail.data.receivedDate)}</strong>
                </div>
                <div>
                  <span>Notes</span>
                  <strong>{detail.data.notes ?? '—'}</strong>
                </div>
              </div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Unit</th>
                      <th>Received</th>
                      <th>Rejected</th>
                      <th>Batch</th>
                      <th>Expiry</th>
                      <th>Unit cost</th>
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.data.items.map((item) => (
                      <tr key={item.id}>
                        <td>{item.productName}</td>
                        <td>
                          {item.unitName} ({item.conversionFactor}x)
                        </td>
                        <td>
                          {item.quantityReceived}{' '}
                          <small className="muted">({item.baseQuantityReceived} base)</small>
                        </td>
                        <td>
                          {item.quantityRejected}
                          {item.rejectionReason && (
                            <small className="muted">{item.rejectionReason}</small>
                          )}
                        </td>
                        <td>{item.batchNumber ?? '—'}</td>
                        <td>{formatDate(item.expiryDate)}</td>
                        <td>{formatMoney(item.unitCostKobo)}</td>
                        <td>{formatMoney(item.totalCostKobo)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </section>
      )}
    </div>
  );
}
