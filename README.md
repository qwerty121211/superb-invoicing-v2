# Superb Cleaning Co. — Wave Invoice Creator

A lightweight web tool for creating and managing invoices in Wave accounting software. Built for Superb Cleaning Co. to handle 30+ invoices per month across property clients and custom clients.

---

## What It Does

- Requires login — each user has their own account
- Creates invoices in Wave as drafts for review
- **Approve** invoices with one click from history
- **Delete** draft invoices before approving if there's a mistake
- **Edit** draft invoices — change description, quantity, or line items (delete + recreate)
- **Send** approved invoices by email directly from the tool
- **Sync from Wave** — import invoices created outside the tool into your history
- Mark invoices as paid by pasting invoice numbers or uploading a CSV
- Opens the PDF in a new tab automatically after creation
- Supports Silverstone, Pleasant View Gardens (with advanced overrides), and Custom mode for any client
- History filter — search by work order, client, invoice #, or status
- Shared invoice history visible to all users, showing who created each invoice

---

## Clients & Rates

| Property | PO Field | Rate | Tax |
|---|---|---|---|
| Silverstone Properties | Work order number | $150.00 flat | None |
| Pleasant View Gardens | Address | $135.00 or $170.00 | NJ 6.625% |
| Custom | Configurable | Per line item | Optional 6.625% |

### Advanced Options (Silverstone & Pleasant View)
Expand **Advanced options** below the property info to:
- Override the invoice line item description (default: "Apartment Turn Cleaning")
- Set a custom quantity (default: 1; supports decimals e.g. 0.5, 2)

These are optional — leaving them blank uses the standard fast path exactly as before.

---

## Project Structure

```
superb-invoice-vercel/
├── index.html        # Frontend — single-page app
├── api/
│   ├── wave.js       # Wave API proxy
│   └── auth.js       # Auth + shared history (Upstash)
├── README.md
├── TECHNICAL.md
└── FUNCTIONS.md
```

---

## Setup & Deployment

### 1. Prerequisites
- A [Vercel](https://vercel.com) account
- A [Wave](https://www.waveapps.com) account with an API token
- An [Upstash](https://upstash.com) Redis database connected to your Vercel project
- A GitHub repository containing this project

### 2. Get Your Wave API Token
1. Log in to Wave → **Settings → Developer → API Tokens**
2. Create a Full Access token and copy it

### 3. Connect Upstash to Vercel
1. Vercel project → **Storage** → **Create Database → Upstash**
2. Region: US-East-1 (Washington D.C.), free plan, no eviction
3. Connect to project — Vercel auto-adds the KV env vars

### 4. Set Environment Variables

| Variable | Value |
|---|---|
| `WAVE_API_TOKEN` | Your Wave full-access API token |
| `INVITE_CODE` | Signup code shared with users (e.g. `superb2024`) |

### 5. Deploy
Push to GitHub → import repo in Vercel → deploys automatically on every push.

---

## Security

- Wave API token stored server-side — never exposed to the browser
- User passwords hashed server-side before storage
- Sessions: 48-char random tokens in Upstash, 30-day expiry
- All API endpoints require a valid session token (401 if missing or expired)
- Logout immediately invalidates the token server-side
- New account creation requires an invite code

---

## Usage

### Creating Invoices

1. Open the deployed Vercel URL and sign in
2. Select the property (Silverstone, Pleasant View, Custom)
3. Set the invoice date (defaults to today)
4. **For Silverstone/Pleasant View:** optionally expand **Advanced options** to override description or quantity
5. **For Pleasant View:** select the rate ($135 or $170)
6. **For Custom:** enter customer name, add line items with description, qty, and rate
7. Enter a work order / address, then:
   - **⚡ Create Now** for a single invoice
   - **+ Queue** → **Create All Invoices** for bulk
8. Invoice is created as a **draft** in Wave
9. Review in Recent Invoices → click **Approve** or **Delete**

### Editing a Draft
Click **Edit** on any draft invoice in history. Modify line items, quantities, description, date, or PO number. Click **Delete & Recreate** — the draft is deleted and a new one is created with your changes.

### Sending an Invoice
After approving, click **✉ Send** on any approved invoice. Optionally enter a To email, subject, and message. Sends via Wave's email system.

### Syncing from Wave
Click **⇄ Sync** in the Recent Invoices header. All Wave invoices are shown — invoices already in your history are greyed out. Click **Import** to pull any missing invoice into your history.

### Bulk Entry
Switch to the **📋 Paste from Sheets** tab to paste a column of work orders or addresses from Google Sheets.

### Marking as Paid
Switch to the **Payments** tab. Enter invoice numbers one at a time or paste a list (or upload a CSV). Select deposit account, payment date, and method, then mark all paid at once.
