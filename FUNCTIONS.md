# Functions Reference — Superb Cleaning Invoice Tool

---

## api/auth.js

---

### `kvGet(key)`
Fetches a value from Upstash Redis via the REST API.
**Parameters** — `key`: string key to retrieve
**Returns** — Parsed JSON value, or `null` if key doesn't exist

---

### `kvSet(key, value, expirySeconds?)`
Stores a value in Upstash Redis via the REST API.
**Parameters** — `key`: string key · `value`: any JSON-serializable value · `expirySeconds`: optional TTL

---

### `kvDel(key)`
Deletes a key from Upstash Redis.

---

### `hashPassword(password)`
Simple integer hash of a password string. Not bcrypt-level — internal tool only.
**Returns** — Hex string hash

---

### `generateToken()`
Generates a 48-character alphanumeric session token.
**Returns** — Token string

---

### `validateSession(req)`
Reads `x-session-token` header, looks up `session:{token}` in Upstash.
**Returns** — Session object `{ username, displayName }` or `null`

---

### `handler(req, res)` *(default export — auth.js)*

Routes by `action` field. Public actions: `signup`, `login`. All others require a valid session.

#### `signup`
**Input:** `{ username, password, inviteCode }`
**Validates:** invite code, username ≥ 2 chars, password ≥ 6 chars, username not taken.
**Stores:** `user:{username}` → `{ username, displayName, passwordHash, createdAt }`
**Returns:** `{ success: true, displayName, sessionToken }`

#### `login`
**Input:** `{ username, password }`
**Returns:** `{ success: true, displayName, sessionToken }` or error

#### `logout`
Deletes `session:{token}` from Upstash immediately.
**Returns:** `{ success: true }`

#### `getHistory`
**Returns:** `{ history: [...] }` — array of history items from `invoice_history` key

#### `addHistory`
**Input:** `{ entry }` — history item object
**Behaviour:** Fetches current history, appends entry, trims to last 100, saves back.
**Returns:** `{ success: true, history: [...] }`

#### `voidHistory`
**Input:** `{ invoiceNumber }`
Sets `voided: true` and `voidedAt` timestamp on matching entry.
**Returns:** `{ success: true, history: [...] }`

#### `approveHistory`
**Input:** `{ invoiceNumber }`
Sets `approved: true` and `approvedAt` on matching entry.
**Returns:** `{ success: true, history: [...] }`

#### `deleteHistory`
**Input:** `{ invoiceNumber }`
Removes entry from history entirely.
**Returns:** `{ success: true, history: [...] }`

#### `markPaidHistory`
**Input:** `{ invoiceNumber, paymentDate }`
Sets `paid: true`, `paidAt: paymentDate` on matching entry.
**Returns:** `{ success: true, history: [...] }`

---

## api/wave.js

---

### `waveQuery(token, query, variables)`
Low-level helper that sends a single GraphQL request to the Wave API.
**Returns** — Raw parsed JSON response from Wave

---

### `validateSession(sessionToken)`
Reads `session:{token}` from Upstash to authenticate the request.
**Returns** — Session object or `null`

---

### `handler(req, res)` *(default export — wave.js)*

All actions require a valid session token via `x-session-token` header.

#### `getBusinessId`
**Returns:** Raw Wave `businesses` query response. Frontend filters for "superb cleaning" by name.

#### `searchCustomers`
**Input:** `{ businessId, query }`
**Returns:** `{ customers: [{ id, name, email }] }` filtered by query string.

#### `searchProducts`
**Input:** `{ businessId, query }`
**Returns:** `{ products: [{ id, name, unitPrice, description }], total }` filtered by query.

#### `getInvoices` *(NEW)*
Pulls **all** invoices from Wave by paginating at 200/page.
**Input:** `{ businessId }`
**Returns:** `{ invoices: [...] }` — each invoice includes `id`, `invoiceNumber`, `invoiceDate`, `dueDate`, `status`, `poNumber`, `pdfUrl`, `viewUrl`, `customer.name`, `total.value`, `amountDue.value`, `lastSentAt`.
**Use:** Powers "Sync from Wave" feature to import externally-created invoices into history.

#### `sendInvoice`
Emails an invoice via Wave's `invoiceSend` mutation.
**Input:** `{ invoiceId, invoiceNumber, businessId, to?, subject?, message? }`
- `invoiceId` — stored ID (used as fallback)
- `invoiceNumber` + `businessId` — used to re-fetch the current live invoice ID from Wave (stored ID can go stale after approval)
- `to` — optional recipient email; if omitted, looks up customer email from Wave; throws if none found
- `subject` — optional email subject
- `message` — optional memo / body text

**Note:** Wave's `to` field is `[String!]!` — non-nullable. The handler always resolves a recipient before calling the mutation.
**Returns:** `{ success: true }` or `{ error: string }`

#### `createInvoice`
Runs the full invoice creation pipeline — up to 6 sequential Wave API calls.

**Input (`data` fields)**

| Field | Type | Required | Description |
|---|---|---|---|
| `businessId` | string | ✅ | Wave business ID |
| `customerName` | string | ✅ | Customer name to match or create |
| `invoiceDate` | string | ✅ | `YYYY-MM-DD` |
| `dueDate` | string | ✅ | Invoice date + 30 days |
| `poNumber` | string | ✅ | Work order number or address |
| `unitPrice` | number | ✅ | Line item unit price (overridden by `unitPriceOverride` if provided) |
| `taxPercent` | number\|null | ✅ | Tax rate e.g. `6.625`, or `null` |
| `productName` | string\|null | — | Wave product name to find or create (from product search). Falls back to "Apartment Turn Cleaning" if omitted. |
| `customDescription` | string\|null | — | Label shown on the invoice line item. Overrides the product name display only — does not affect which Wave product is used. |
| `quantity` | number | — | Line item quantity (default 1; supports decimals) |

**Pipeline:** find/create customer → find/create product (by `productName`) → find/create sales tax → create invoice (DRAFT)
**Returns:** `{ invoice: { id, invoiceNumber, viewUrl, pdfUrl } }`

#### `createCustomInvoice`
Creates a custom invoice for any client with multiple line items.

**Input:** `{ businessId, customerName, invoiceDate, dueDate, poNumber, lineItems[], taxPercent }`

**lineItems array item shape:**
```js
{
  productName: string,   // Wave product to find or create (matched by exact name)
  description: string|null, // Custom label shown on invoice — overrides productName display only
  unitPrice: number,
  quantity: number        // supports decimals
}
```
`productName` drives Wave product matching/creation. `description` is an optional display-only override for the invoice line item label.

**Returns:** `{ invoice: { id, invoiceNumber, viewUrl, pdfUrl } }`

#### `getPaymentAccounts`
**Input:** `{ businessId }`
**Returns:** `{ accounts: [{ id, name }] }` — Cash and Bank asset accounts.

#### `markInvoicePaid`
**Input:** `{ businessId, invoiceNumber, paymentDate, accountId, paymentMethod }`
Paginates through all invoices to find by number, records manual payment.
**Returns:** `{ success: true }` or `{ success: true, alreadyPaid: true }` or `{ error: string }`

#### `approveInvoice`
**Input:** `{ invoiceId }`
Approves a draft invoice in Wave.
**Returns:** `{ success: true }`

#### `deleteInvoice`
**Input:** `{ invoiceId }`
Permanently deletes a draft invoice in Wave.
**Returns:** `{ success: true }`

---

## index.html — JavaScript Functions

---

### Session & Auth

#### `checkSession()`
Runs on page load. Reads `superb_user` and `superb_session_token` from localStorage. If found, calls `showApp()`.

#### `showApp()`
Transitions to app screen. Sets avatar initials, today's date on invoice/payment date fields, calls `loadHistory()`.

#### `showLogin()` / `showSignup()`
Toggle between login and signup panels. Clear errors.

#### `logout()`
Calls `authAPI('logout')`, clears localStorage, resets state, shows auth screen.

#### `login()` / `signup()`
Read form fields, call `/api/auth`, save user + sessionToken to localStorage, call `showApp()`.

---

### API Helpers

#### `authAPI(action, payload)`
POST to `/api/auth` with session token header.

#### `waveAPI(action, data)`
POST to `/api/wave` with session token header.

---

### Navigation

#### `switchMainTab(tab)`
Switches between Invoices and Payments panels. Loads payment accounts when switching to Payments.

#### `switchProperty(prop)`
Switches between `'silverstone'`, `'pleasant'`, `'custom'`. Updates UI, resets queue, re-renders line items.

#### `toggleAdvanced(prop)` *(NEW)*
Toggles the Advanced Options panel for Silverstone or Pleasant View.
Shows/hides description override + quantity fields.

#### `getAdvancedOverrides(prop)` *(UPDATED)*
Reads the advanced panel fields for Silverstone or Pleasant View.
**Returns:** `{ productName: string|null, customDescription: string|null, quantity: number, unitPriceOverride: number|null }`
- `productName` — Wave product selected from search (stored in `window._advProductName_{prop}`); used for Wave product matching
- `customDescription` — free-text label override shown on invoice; does not affect product matching
- `unitPriceOverride` — overrides default rate if filled

#### `selectRate(rate)`
Sets selected rate for Pleasant View Gardens (135 or 170).

#### `getInvoiceConfig()`
Returns `{ customerName, unitPrice, taxPercent }` for current property.

#### `switchTab(tab)`
Switches between "Add one" and "Paste from Sheets" tabs.

#### `searchAdvProduct(prop, query)` *(NEW)*
Debounced (200ms) product search for Silverstone/Pleasant View advanced panels. Triggers `_doSearchAdvProduct`.

#### `_doSearchAdvProduct(prop, query)` *(NEW)*
Searches Wave products and renders the floating dropdown anchored to `{prop}-product-search` input. Renders product name + price per row.

#### `selectAdvProduct(prop, product)` *(NEW)*
Called when a product is chosen from the advanced panel dropdown. Stores product name in `window._advProductName_{prop}` (read by `getAdvancedOverrides`). Pre-fills custom description field with product name (editable). Auto-fills price field if empty.

#### `handleAdvProductKey(event, prop)` *(NEW)*
Handles ↑↓ Arrow and Enter keyboard navigation in the advanced panel product dropdown.

---

### Queue

#### `addToQueue()` / `addFromPaste()`
Add single or bulk work orders to the queue.

#### `removeFromQueue(idx)`
Remove item at index from queue.

#### `renderQueue()`
Re-renders queue list with status badges. Shows "WO# " prefix for Silverstone.

---

### Invoice Creation

#### `createSingle()`
Creates one invoice immediately. Passes `productName`, `customDescription`, `quantity`, and `unitPriceOverride` from the advanced panel to Wave API.

#### `createAll()`
Processes all pending queue items sequentially. Passes the same advanced overrides to each invoice.

#### `approveInvoice(btn)`
Approves draft in Wave, marks approved in shared history, reloads history.

#### `deleteInvoice(btn)`
Deletes draft in Wave, removes from shared history, reloads history.

#### `getBusinessId()` *(cached)*
Fetches and caches the Superb Cleaning Co. business ID.

---

### Custom Invoice

#### `searchCustomers(query, inputId)` *(UPDATED)*
Debounced (200ms) customer search. Supports `inputId` parameter so the same function works across all three client modes.

#### `_doSearchCustomers(query, inputId)` *(NEW)*
Executes the actual customer search, renders dropdown with keyboard-nav-ready `dd-item` elements.

#### `selectCustomer(name, inputId)` *(UPDATED)*
Populates the named input with the selected customer name and hides the dropdown.

#### `handleDropdownKey(event, inputId)` *(NEW)*
Handles ↑↓ Arrow and Enter keys for keyboard navigation in the customer dropdown.

#### `addLineItem()` / `removeLineItem(id)` / `updateLineItem(id, field, value)`
Add, remove, and update line items in the Custom invoice form.

#### `renderLineItems()` *(UPDATED)*
Renders line items as cards. Each card has: product search row (searches Wave products, fills price/qty on select), custom description row (override label for invoice), qty + rate row.

#### `searchProducts(itemId, query)` *(UPDATED)*
Debounced (200ms) product search per line item. Attaches to `line-item-search-{id}` input. Shows price inline in dropdown.

#### `_doSearchProducts(itemId, query)` *(NEW)*
Executes the actual product search against `line-item-search-{id}` input.

#### `selectProduct(itemId, name, price)` *(UPDATED)*
On product selection: stores name as `productSearchDisplay`, pre-fills description field with product name (user can override), auto-fills rate. Focuses description field so user can quickly edit.

#### `handleProductKey(event, itemId)` *(NEW)*
Handles ↑↓ Arrow and Enter for keyboard navigation in product dropdowns.

#### `createCustomInvoice()` *(UPDATED)*
Validates and submits custom invoice. Sends `productName` (Wave product) and `description` (custom label override) as separate fields per line item. Uses `productSearchDisplay` as fallback productName when no custom description entered. Total = rate × qty.

---

### History

#### `loadHistory()`
Fetches shared history from Upstash, stores in `invoiceHistory`, calls `renderHistory()`.

#### `renderHistory()` *(UPDATED)*
Re-renders history table. Now:
- Applies filter from `#historyFilter` input if non-empty (F8)
- Shows **Edit** button on draft invoices (opens edit modal) (F7)
- Shows **Send** button on approved, non-voided, non-paid invoices (opens send modal) (F6)

---

### F5: Sync from Wave Modal *(NEW)*

#### `openSyncModal()`
Opens sync modal, fetches all Wave invoices via `waveAPI('getInvoices')`.
Renders a table showing all Wave invoices; greys out ones already in history.
Each non-imported row has an Import button.

#### `importWaveInvoice(btn)` *(NEW)*
Reads invoice data from `data-inv` attribute on button.
Calls `authAPI('addHistory')` with the invoice data, re-renders history.
Marks the row as imported in the sync table.

---

### F6: Send Invoice Modal *(NEW)*

#### `openSendModal(btn)`
Opens send modal. Reads `data-inv-id` and `data-inv-num` from the history table button.
Pre-clears all fields.

#### `submitSendInvoice()` *(UPDATED)*
Calls `waveAPI('sendInvoice', { invoiceId, invoiceNumber, businessId, to, subject, message })`.
Passes `businessId` and `invoiceNumber` so the backend can re-fetch the live invoice ID from Wave (stored ID goes stale after approval). Shows loading/success/error in modal status area. Closes modal on success after 1.8s.

---

### F7: Edit Draft Modal *(NEW)*

#### `openEditModal(inv)` *(NEW)*
Opens edit modal pre-filled with the draft invoice's data (date, PO, customer, line items).
Seed `editLineItems` from known invoice data.

#### `addEditLineItem()` / `removeEditLineItem(id)` / `updateEditLineItem(id, field, value)` *(NEW)*
Manage line items in the edit modal (separate array `editLineItems` from `lineItems`).

#### `renderEditLineItems()` *(NEW)*
Renders edit modal line items with Qty column, same layout as Custom invoice form.

#### `submitEditInvoice()` *(NEW)*
Delete + recreate flow:
1. Calls `waveAPI('deleteInvoice')` to remove the draft from Wave
2. Calls `authAPI('deleteHistory')` to remove from shared history
3. Calls `waveAPI('createCustomInvoice')` with new data
4. Calls `authAPI('addHistory')` with new invoice entry
5. Reloads history, closes modal on success

---

### Modal Helpers *(NEW)*

#### `closeModal(id)`
Removes `.open` class from modal backdrop.

#### `setModalStatus(elId, type, msg)`
Sets `.modal-status` element class (loading/success/error) and text.

---

### Payments

#### `loadPaymentAccounts()`
Loads Wave cash/bank accounts into the deposit account dropdown. Surfaces error message inline if it fails.

#### `markSinglePaid()` / `markAllPaid()`
Mark single or queued invoices as paid via Wave API and update shared history.

#### `switchPaidTab(tab)` / `addPaidItems()` / `addToPaidQueue(numbers)` / `renderPaidQueue()` / `removePaidItem(idx)` / `setPaidStatus(type, msg)`
Manage the payments queue UI and status display.
