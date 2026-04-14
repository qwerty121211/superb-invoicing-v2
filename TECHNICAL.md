# Technical Reference — Superb Cleaning Invoice Tool

---

## Architecture Overview

```
Browser (index.html)
       │
       ├── POST /api/auth   (login, signup, history)
       │         │
       │         ▼
       │   Upstash Redis (KV store)
       │   - user accounts
       │   - shared invoice history
       │
       └── POST /api/wave   (Wave API proxy)
                 │
                 ▼
         Wave API (gql.waveapps.com/graphql/public)
```

The frontend never talks to Wave or Upstash directly. All calls go through Vercel serverless functions which read credentials from server-side environment variables.

---

## Frontend (index.html)

A single self-contained HTML file with embedded CSS and JavaScript. No frameworks, no build step.

### Changelog v2 — Full Invoicing Capabilities (April 2026)

#### New Features

| Feature | ID | Description |
|---|---|---|
| Advanced mode | F1 | Collapsible panel on Silverstone and Pleasant View — product search, separate custom description override, unit price override, and quantity fields. Fast path unchanged when collapsed. |
| Quantity per line item | F2 | Custom invoice line items: product search row + custom description row + qty + rate. Total = rate × qty |
| Improved customer search | F3 | 200ms debounce, keyboard navigation (↑↓ Enter Escape), works across all three client modes |
| Improved product search | F4 | 200ms debounce, keyboard navigation, price shown inline. Product search and custom description are separate fields in all modes. |
| Sync from Wave | F5 | "⇄ Sync" button in history header — modal shows all Wave invoices, greys already-imported ones, one-click import |
| Send invoice | F6 | "✉ Send" button on approved invoices — modal with To / Subject / Message fields; calls Wave `invoiceSend` mutation |
| Edit draft | F7 | "Edit" button on draft invoices — delete + recreate flow with full line item editing |
| History filter | F8 | Filter bar above history table — real-time client-side filter by work order, client, invoice #, or status keyword |

#### Bug Fixes (post-v2)

| Fix | ID | Description |
|---|---|---|
| Send invoice NOT_FOUND | B1 | Wave's `invoiceSend` requires `to: [String!]!` (non-nullable). Stored invoiceId goes stale after approval. Now re-fetches invoice by number for live node ID and uses customer email from Wave as fallback when To is blank. |
| Product search matched description | B2 | Product search was using the custom description field as the Wave product lookup term. Frontend now sends `productName` (Wave product) and `description` (invoice label) as separate fields. Backend uses `productName` for find/create and `description` only as a line item label override. |

#### Preserved Unchanged from v1

- All Silverstone / Pleasant View fast-path flows (single, queue, paste)
- All queue, createAll, bulk create logic
- All payment flows (single paid, bulk paid, CSV)
- All auth flows (login, signup, logout, session)
- Badge system, status box, progress bar
- API helpers: `authAPI()`, `waveAPI()`
- Session storage keys: `superb_user`, `superb_session_token`

---

### Design System

| Token | Value |
|---|---|
| Heading font | Libre Baskerville (serif) |
| Body font | DM Sans |
| Primary blue | `#185FA5` |
| Blue accent | `#378ADD` |
| Background | `#F1EFE8` (warm gray) |
| Card background | `#FFFFFF` |
| Border | `#E4E2D8` |
| Max content width | 1100px |

#### Component Inventory

- **Topbar** — sticky, logo + user avatar + sign out
- **Nav tabs** — Invoices / Payments (horizontally scrollable on mobile)
- **Property switcher** — card-style buttons with rate/tax info
- **Advanced panel** — collapsible per-property section for description override + quantity
- **Input tabs** — Add One / Paste from Sheets
- **Queue** — pending items with status badges and remove buttons
- **History table** — Work Order / Client / Amount / Status / Actions
- **History filter** — live client-side search
- **Modals** — Send Invoice, Edit Draft, Sync from Wave
- **Floating dropdown** — customer/product autocomplete with keyboard nav
- **Status box** — loading/success/error inline feedback
- **Progress bar** — bulk invoice creation progress

---

### State Variables

| Variable | Type | Purpose |
|---|---|---|
| `currentUser` | object | `{ username, displayName }` — null if not logged in |
| `sessionToken` | string | Server-issued session token for API calls |
| `invoiceHistory` | Array | Shared history loaded from Upstash on login |
| `queue` | Array | Pending/active/done invoice items `[{ woNum, status, ... }]` |
| `paidQueue` | Array | Invoice numbers to mark as paid `[{ invoiceNum, status, error? }]` |
| `currentProperty` | string | `'silverstone'`, `'pleasant'`, or `'custom'` |
| `selectedRate` | number | `135` or `170` — Pleasant View only |
| `lineItems` | Array | Custom invoice line items `[{ id, description, qty, rate }]` |
| `editLineItems` | Array | Line items in the edit draft modal (separate from `lineItems`) |
| `cachedBusinessId` | string\|null | Cached Wave business ID — fetched once per session |
| `ddItems` | Array | Current autocomplete dropdown results for keyboard nav |
| `ddHighlight` | number | Currently highlighted dropdown row index (-1 = none) |
| `ddTarget` | string\|null | Input element ID the dropdown is currently attached to |

---

### Line Item Shape (v2+)

```js
// In-memory (frontend state)
{
  id: 1234567890,              // timestamp-based local ID
  productSearchDisplay: 'string', // what's shown in the product search field
  description: 'string',       // custom label override (shown on invoice); empty = use product name
  qty: 1,                      // quantity (supports decimals)
  rate: '150.00'               // unit price as string or number
}

// Sent to API (createCustomInvoice)
{
  productName: 'string',       // Wave product to find or create (from productSearchDisplay)
  description: string|null,    // invoice label override — null if not overriding
  unitPrice: number,
  quantity: number
}
```

### History Item Shape

```js
{
  workOrder: '3471',                  // WO number or address
  billTo: 'Silverstone Properties',
  date: '2026-03-15',
  invoiceNumber: '0042',
  invoiceId: 'QmInvoiceId...',        // Wave internal ID
  url: 'https://...',                 // PDF or view URL
  amount: '$150.00',                  // e.g. '$135.00 + tax' or '$300.00' (qty 2 × $150)
  isAddress: false,                   // true for Pleasant View
  createdBy: 'Isaac',
  createdAt: '2026-03-15T...',
  voided: false,
  voidedAt: '...',
  approved: false,
  approvedAt: '...',
  paid: false,
  paidAt: '2026-03-15'
}
```

History is stored in Upstash (shared across all users), capped at 100 entries, displayed with real-time filter support.

---

## Backend — api/auth.js

No changes from v1. Handles auth and shared history storage via Upstash Redis.

### Actions

| Action | Auth Required | Purpose |
|---|---|---|
| `signup` | No | Create user, auto-login |
| `login` | No | Authenticate, return session token |
| `logout` | Yes | Invalidate session token |
| `getHistory` | Yes | Fetch full shared invoice history |
| `addHistory` | Yes | Append one invoice entry |
| `voidHistory` | Yes | Mark as voided |
| `approveHistory` | Yes | Mark as approved |
| `deleteHistory` | Yes | Remove entry entirely |
| `markPaidHistory` | Yes | Mark as paid with date |

---

## Backend — api/wave.js

### New Actions (v2)

| Action | Purpose |
|---|---|
| `getInvoices` | Fetch all Wave invoices (paginated) for Sync from Wave |
| `sendInvoice` | Email an invoice via Wave `invoiceSend` mutation |

### Updated Actions (v2 + post-v2 fixes)

| Action | Change |
|---|---|
| `createInvoice` | Now accepts `productName` (Wave product to match/create), `customDescription` (invoice label override), `quantity` (default 1), and `unitPriceOverride` |
| `createCustomInvoice` | `lineItems` now carry `productName` (Wave product) and `description` (label override) as separate fields; quantity per line item |
| `searchCustomers` | Now returns `email` field in addition to `id` and `name` |
| `sendInvoice` | Re-fetches the live invoice ID from Wave by invoice number before sending (stored ID goes stale after approval). Resolves customer email automatically if `to` is omitted. |

### All Actions

| Action | Input | Purpose |
|---|---|---|
| `getBusinessId` | — | List all Wave businesses |
| `searchCustomers` | `businessId, query` | Search customers by name; returns id, name, email |
| `searchProducts` | `businessId, query` | Search products by name; returns id, name, unitPrice, description |
| `getInvoices` | `businessId` | Fetch all invoices (all pages) |
| `sendInvoice` | `invoiceId, invoiceNumber, businessId, to?, subject?, message?` | Email invoice via Wave; re-fetches live ID by number |
| `createInvoice` | `businessId, customerName, invoiceDate, dueDate, poNumber, unitPrice, taxPercent, productName?, customDescription?, quantity?` | Create standard invoice as draft |
| `createCustomInvoice` | `businessId, customerName, invoiceDate, dueDate, poNumber, lineItems[], taxPercent` | Create multi-line-item invoice as draft |
| `getPaymentAccounts` | `businessId` | Return Cash & Bank accounts |
| `markInvoicePaid` | `businessId, invoiceNumber, paymentDate, accountId, paymentMethod` | Record manual payment |
| `approveInvoice` | `invoiceId` | Approve draft |
| `deleteInvoice` | `invoiceId` | Delete draft |

### Key Wave API Rules (Unchanged — Hard-Won)

- `InvoiceCreateInput` requires `customerId` — not inline
- `InvoiceItemInput` requires `productId` — not inline description
- `ProductCreateInput` does NOT accept `currency`; requires `incomeAccountId`
- `taxes` on a line item is an array of ID strings: `["QwSalesTaxId..."]`
- Sales tax `rate` expects full percentage (e.g. `6.625`) not decimal (`0.06625`)
- Wave API token is account-wide; business selected by name match
- Wave does NOT support unapproving approved invoices — only drafts can be deleted
- Edit flow = delete draft + recreate (Wave API limitation)
- `invoiceSend.to` is `[String!]!` — required, non-nullable array; must always be provided
- Stored invoice IDs can go stale after approval — always re-fetch by invoice number before sending

### Due Date Calculation
Invoice date + 30 days, calculated in JavaScript before passing to API.

---

## Environment Variables

| Variable | Where Set | Purpose |
|---|---|---|
| `WAVE_API_TOKEN` | Vercel project settings | Full-access Wave API token |
| `INVITE_CODE` | Vercel project settings | Code required to create a new account |
| `KV_REST_API_URL` | Auto-added by Upstash | Upstash Redis REST endpoint |
| `KV_REST_API_TOKEN` | Auto-added by Upstash | Upstash Redis auth token |

---

## Browser Storage

| Key | Storage | Contents |
|---|---|---|
| `superb_user` | `localStorage` | `{ username, displayName }` — persists across sessions |
| `superb_session_token` | `localStorage` | 48-char token — sent as `x-session-token` header |

### Session Security

48-character random token stored in Upstash as `session:{token}` with 30-day expiry. Validated on every protected API call. Deleted immediately on logout.
