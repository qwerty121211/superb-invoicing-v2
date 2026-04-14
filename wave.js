async function waveQuery(token, query, variables) {
  const response = await fetch("https://gql.waveapps.com/graphql/public", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables })
  });
  return response.json();
}

async function validateSession(sessionToken) {
  const KV_URL = process.env.KV_REST_API_URL;
  const KV_TOKEN = process.env.KV_REST_API_TOKEN;
  if (!KV_URL || !KV_TOKEN || !sessionToken) return null;
  const res = await fetch(`${KV_URL}/get/${encodeURIComponent('session:' + sessionToken)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  const data = await res.json();
  return data.result ? JSON.parse(data.result) : null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const sessionToken = req.headers["x-session-token"];
  const session = await validateSession(sessionToken);
  if (!session) {
    return res.status(401).json({ error: "Not authenticated. Please log in." });
  }

  const { action, data } = req.body;
  const token = process.env.WAVE_API_TOKEN;
  if (!token) return res.status(500).json({ error: "API token not configured on server." });

  try {

    // ─────────────────────────────────────────────
    //  getBusinessId
    // ─────────────────────────────────────────────
    if (action === "getBusinessId") {
      const result = await waveQuery(token, `query { businesses { edges { node { id name } } } }`);
      return res.status(200).json(result);
    }

    // ─────────────────────────────────────────────
    //  searchProducts
    // ─────────────────────────────────────────────
    if (action === "searchProducts") {
      const { businessId, query } = data;
      const result = await waveQuery(token, `
        query GetProducts($businessId: ID!) {
          business(id: $businessId) {
            products(page: 1, pageSize: 50) {
              edges { node { id name unitPrice description } }
            }
          }
        }
      `, { businessId });
      const products = result.data?.business?.products?.edges || [];
      const filtered = query
        ? products.filter(e => e.node.name.toLowerCase().includes(query.toLowerCase()))
        : products;
      return res.status(200).json({
        products: filtered.map(e => e.node),
        total: products.length
      });
    }

    // ─────────────────────────────────────────────
    //  searchCustomers
    // ─────────────────────────────────────────────
    if (action === "searchCustomers") {
      const { businessId, query } = data;
      const result = await waveQuery(token, `
        query GetCustomers($businessId: ID!) {
          business(id: $businessId) {
            customers(page: 1, pageSize: 200) {
              edges { node { id name email } }
            }
          }
        }
      `, { businessId });
      const customers = result.data?.business?.customers?.edges || [];
      const filtered = query
        ? customers.filter(e => e.node.name.toLowerCase().includes(query.toLowerCase()))
        : customers;
      return res.status(200).json({ customers: filtered.map(e => e.node) });
    }

    // ─────────────────────────────────────────────
    //  getInvoices — pull Wave invoices into history
    //  Paginates through ALL invoices (200/page)
    // ─────────────────────────────────────────────
    if (action === "getInvoices") {
      const { businessId } = data;
      let allInvoices = [];
      let page = 1;
      while (true) {
        const result = await waveQuery(token, `
          query GetInvoices($businessId: ID!, $page: Int!) {
            business(id: $businessId) {
              invoices(page: $page, pageSize: 200) {
                pageInfo { currentPage totalPages }
                edges {
                  node {
                    id
                    invoiceNumber
                    invoiceDate
                    dueDate
                    status
                    poNumber
                    pdfUrl
                    viewUrl
                    customer { name }
                    total { value currency { symbol } }
                    amountDue { value }
                    lastSentAt
                  }
                }
              }
            }
          }
        `, { businessId, page });

        if (result.errors) {
          return res.status(200).json({ error: "GraphQL error: " + JSON.stringify(result.errors) });
        }

        const edges = result.data?.business?.invoices?.edges || [];
        const pageInfo = result.data?.business?.invoices?.pageInfo;
        allInvoices = allInvoices.concat(edges.map(e => e.node));
        if (!pageInfo || page >= pageInfo.totalPages) break;
        page++;
      }
      return res.status(200).json({ invoices: allInvoices });
    }

    // ─────────────────────────────────────────────
    //  sendInvoice — email invoice via Wave
    // ─────────────────────────────────────────────
    if (action === "sendInvoice") {
      const { invoiceId, invoiceNumber, businessId, to, subject, message } = data;
      if (!invoiceId && !invoiceNumber) throw new Error("No invoiceId provided");

      // Re-fetch the invoice from Wave by number to get the current live ID.
      // The stored invoiceId may be stale after approval/edits — looking it up
      // fresh guarantees we have the right node ID for the send mutation.
      let liveInvoiceId = invoiceId;
      let customerEmail = null;

      if (businessId && invoiceNumber) {
        const cleanNumber = String(invoiceNumber).replace(/^#/, '').trim();
        let page = 1;
        let found = null;
        while (!found) {
          const lookup = await waveQuery(token, `
            query FindInvoice($businessId: ID!, $page: Int!) {
              business(id: $businessId) {
                invoices(page: $page, pageSize: 200) {
                  pageInfo { currentPage totalPages }
                  edges { node { id invoiceNumber customer { name email } } }
                }
              }
            }
          `, { businessId, page });
          const edges = lookup.data?.business?.invoices?.edges || [];
          const pageInfo = lookup.data?.business?.invoices?.pageInfo;
          found = edges.find(e => e.node.invoiceNumber === cleanNumber);
          if (found || !pageInfo || page >= pageInfo.totalPages) break;
          page++;
        }
        if (found) {
          liveInvoiceId = found.node.id;
          customerEmail = found.node.customer?.email || null;
        }
      }

      // Wave requires `to` as [String!]! — non-nullable array.
      let toEmails = to ? [to.trim()] : null;
      if (!toEmails) {
        if (!customerEmail) {
          throw new Error("No email on file for this customer in Wave. Please enter a recipient email in the To field.");
        }
        toEmails = [customerEmail];
      }

      const result = await waveQuery(token, `
        mutation SendInvoice($input: InvoiceSendInput!) {
          invoiceSend(input: $input) {
            didSucceed
            inputErrors { message }
          }
        }
      `, {
        input: {
          invoiceId: liveInvoiceId,
          to: toEmails,
          subject: subject || undefined,
          memo: message || undefined
        }
      });

      if (!result.data?.invoiceSend?.didSucceed) {
        const errors = result.data?.invoiceSend?.inputErrors || [];
        throw new Error(errors[0]?.message || "Failed to send invoice: " + JSON.stringify(result));
      }
      return res.status(200).json({ success: true });
    }

    // ─────────────────────────────────────────────
    //  createInvoice
    //  Now supports: customDescription, quantity
    // ─────────────────────────────────────────────
    if (action === "createInvoice") {
      const {
        businessId, customerName, invoiceDate, dueDate, poNumber,
        unitPrice, taxPercent, productName, customDescription, quantity
      } = data;

      // Step 1: Find or create customer
      const customersResult = await waveQuery(token, `
        query GetCustomers($businessId: ID!) {
          business(id: $businessId) {
            customers(page: 1, pageSize: 200) {
              edges { node { id name } }
            }
          }
        }
      `, { businessId });

      let customerId = null;
      const customers = customersResult.data?.business?.customers?.edges || [];
      const existing = customers.find(e => e.node.name.toLowerCase() === customerName.toLowerCase());

      if (existing) {
        customerId = existing.node.id;
      } else {
        const createCustomer = await waveQuery(token, `
          mutation CreateCustomer($input: CustomerCreateInput!) {
            customerCreate(input: $input) {
              didSucceed
              inputErrors { message }
              customer { id name }
            }
          }
        `, { input: { businessId, name: customerName, currency: "USD" } });

        if (!createCustomer.data?.customerCreate?.didSucceed) {
          throw new Error(createCustomer.data?.customerCreate?.inputErrors?.[0]?.message || "Failed to create customer");
        }
        customerId = createCustomer.data.customerCreate.customer.id;
      }

      // Step 2: Find or create product
      // productName = Wave product to find/create (from product search)
      // customDescription = label override shown on the invoice
      // Fall back chain: productName arg → "apartment turn" keyword match → create "Apartment Turn Cleaning"
      const resolvedProductName = productName || "Apartment Turn Cleaning";
      const productSearchTerm = productName
        ? productName.toLowerCase().substring(0, 20)
        : "apartment turn";

      const productsResult = await waveQuery(token, `
        query GetProducts($businessId: ID!) {
          business(id: $businessId) {
            products(page: 1, pageSize: 50) {
              edges { node { id name } }
            }
          }
        }
      `, { businessId });

      let productId = null;
      const products = productsResult.data?.business?.products?.edges || [];
      const existingProduct = products.find(e =>
        e.node.name.toLowerCase().includes(productSearchTerm)
      );

      if (existingProduct) {
        productId = existingProduct.node.id;
      } else {
        const accountsResult = await waveQuery(token, `
          query GetAccounts($businessId: ID!) {
            business(id: $businessId) {
              accounts(subtypes: [INCOME]) {
                edges { node { id name } }
              }
            }
          }
        `, { businessId });

        const accounts = accountsResult.data?.business?.accounts?.edges || [];
        if (!accounts.length) throw new Error("No income accounts found in Wave.");
        const salesAccount = accounts.find(e => e.node.name.toLowerCase().includes("sales")) || accounts[0];

        const createProduct = await waveQuery(token, `
          mutation CreateProduct($input: ProductCreateInput!) {
            productCreate(input: $input) {
              didSucceed
              inputErrors { message }
              product { id name }
            }
          }
        `, { input: { businessId, name: resolvedProductName, unitPrice: unitPrice || 150.00, incomeAccountId: salesAccount.node.id } });

        if (!createProduct.data?.productCreate?.didSucceed) {
          throw new Error(createProduct.data?.productCreate?.inputErrors?.[0]?.message || "Failed to create product");
        }
        productId = createProduct.data.productCreate.product.id;
      }

      // Step 3: Find or create sales tax (if needed)
      let salesTaxId = null;
      if (taxPercent) {
        const taxResult = await waveQuery(token, `
          query GetTaxes($businessId: ID!) {
            business(id: $businessId) {
              salesTaxes(page: 1, pageSize: 50) {
                edges { node { id name } }
              }
            }
          }
        `, { businessId });

        const taxes = taxResult.data?.business?.salesTaxes?.edges || [];
        const existingTax = taxes.find(e =>
          e.node.name.includes(String(taxPercent)) || e.node.name.toLowerCase().includes('nj')
        );

        if (existingTax) {
          salesTaxId = existingTax.node.id;
        } else {
          const createTax = await waveQuery(token, `
            mutation CreateTax($input: SalesTaxCreateInput!) {
              salesTaxCreate(input: $input) {
                didSucceed
                inputErrors { message }
                salesTax { id name }
              }
            }
          `, { input: { businessId, name: `Sales Tax (${taxPercent}%)`, abbreviation: "TAX", taxNumber: "", rate: taxPercent } });

          if (createTax.data?.salesTaxCreate?.didSucceed) {
            salesTaxId = createTax.data.salesTaxCreate.salesTax.id;
          } else {
            const errs = createTax.data?.salesTaxCreate?.inputErrors || [];
            throw new Error("Could not create sales tax: " + (errs[0]?.message || JSON.stringify(createTax)));
          }
        }
      }

      // Step 4: Build invoice item — now supports quantity and description override
      const itemInput = {
        productId,
        quantity: quantity || 1,
        unitPrice: unitPrice || 150.00
      };
      // If a custom description was provided, override the product name shown on the invoice
      if (customDescription) {
        itemInput.description = customDescription;
      }
      if (salesTaxId) {
        itemInput.taxes = [salesTaxId];
      }

      // Step 5: Create invoice as DRAFT
      const invoiceResult = await waveQuery(token, `
        mutation CreateInvoice($input: InvoiceCreateInput!) {
          invoiceCreate(input: $input) {
            didSucceed
            inputErrors { code message path }
            invoice { id invoiceNumber viewUrl pdfUrl }
          }
        }
      `, {
        input: {
          businessId,
          customerId,
          invoiceDate,
          dueDate,
          poNumber,
          currency: "USD",
          items: [itemInput]
        }
      });

      if (!invoiceResult.data?.invoiceCreate?.didSucceed) {
        const errors = invoiceResult.data?.invoiceCreate?.inputErrors || [];
        throw new Error(errors[0]?.message || "Failed to create invoice");
      }

      const invoice = invoiceResult.data.invoiceCreate.invoice;
      return res.status(200).json({ invoice });
    }

    // ─────────────────────────────────────────────
    //  createCustomInvoice
    //  Supports: lineItems with quantity per item
    // ─────────────────────────────────────────────
    if (action === "createCustomInvoice") {
      const { businessId, customerName, invoiceDate, dueDate, poNumber, lineItems, taxPercent } = data;

      // Step 1: Find or create customer
      const customersResult = await waveQuery(token, `
        query GetCustomers($businessId: ID!) {
          business(id: $businessId) {
            customers(page: 1, pageSize: 200) {
              edges { node { id name } }
            }
          }
        }
      `, { businessId });
      let customerId = null;
      const customers = customersResult.data?.business?.customers?.edges || [];
      const existingCustomer = customers.find(e => e.node.name.toLowerCase() === customerName.toLowerCase());
      if (existingCustomer) {
        customerId = existingCustomer.node.id;
      } else {
        const createCustomer = await waveQuery(token, `
          mutation CreateCustomer($input: CustomerCreateInput!) {
            customerCreate(input: $input) {
              didSucceed inputErrors { message } customer { id name }
            }
          }
        `, { input: { businessId, name: customerName, currency: "USD" } });
        if (!createCustomer.data?.customerCreate?.didSucceed) {
          throw new Error(createCustomer.data?.customerCreate?.inputErrors?.[0]?.message || "Failed to create customer");
        }
        customerId = createCustomer.data.customerCreate.customer.id;
      }

      // Step 2: Get income account for product creation
      const accountsResult = await waveQuery(token, `
        query GetAccounts($businessId: ID!) {
          business(id: $businessId) {
            accounts(subtypes: [INCOME]) { edges { node { id name } } }
          }
        }
      `, { businessId });
      const accounts = accountsResult.data?.business?.accounts?.edges || [];
      if (!accounts.length) throw new Error("No income accounts found in Wave.");
      const salesAccount = accounts.find(e => e.node.name.toLowerCase().includes("sales")) || accounts[0];

      // Step 3: Get or create a product for each line item
      const productsResult = await waveQuery(token, `
        query GetProducts($businessId: ID!) {
          business(id: $businessId) {
            products(page: 1, pageSize: 50) { edges { node { id name } } }
          }
        }
      `, { businessId });
      const products = productsResult.data?.business?.products?.edges || [];

      const itemInputs = [];
      for (const item of lineItems) {
        // productName = Wave product to find/create; description = custom label override
        const productName = item.productName || item.description;
        const existingProduct = products.find(p => p.node.name.toLowerCase() === productName.toLowerCase());
        let productId;
        if (existingProduct) {
          productId = existingProduct.node.id;
        } else {
          const createProduct = await waveQuery(token, `
            mutation CreateProduct($input: ProductCreateInput!) {
              productCreate(input: $input) {
                didSucceed inputErrors { message } product { id name }
              }
            }
          `, { input: { businessId, name: productName, unitPrice: item.unitPrice, incomeAccountId: salesAccount.node.id } });
          if (!createProduct.data?.productCreate?.didSucceed) {
            throw new Error(createProduct.data?.productCreate?.inputErrors?.[0]?.message || "Failed to create product: " + productName);
          }
          productId = createProduct.data.productCreate.product.id;
          products.push({ node: { id: productId, name: productName } });
        }
        // Support quantity per line item (default 1)
        const lineItemInput = {
          productId,
          quantity: item.quantity || 1,
          unitPrice: item.unitPrice
        };
        // If a custom description was provided, set it as the line item description override
        if (item.description && item.description !== productName) {
          lineItemInput.description = item.description;
        }
        itemInputs.push(lineItemInput);
      }

      // Step 4: Find or create sales tax if needed
      let salesTaxId = null;
      if (taxPercent) {
        const taxResult = await waveQuery(token, `
          query GetTaxes($businessId: ID!) {
            business(id: $businessId) {
              salesTaxes(page: 1, pageSize: 50) { edges { node { id name } } }
            }
          }
        `, { businessId });
        const taxes = taxResult.data?.business?.salesTaxes?.edges || [];
        const existingTax = taxes.find(e => e.node.name.includes(String(taxPercent)));
        if (existingTax) {
          salesTaxId = existingTax.node.id;
        } else {
          const createTax = await waveQuery(token, `
            mutation CreateTax($input: SalesTaxCreateInput!) {
              salesTaxCreate(input: $input) {
                didSucceed inputErrors { message } salesTax { id name }
              }
            }
          `, { input: { businessId, name: `Sales Tax (${taxPercent}%)`, abbreviation: "TAX", taxNumber: "", rate: taxPercent } });
          if (createTax.data?.salesTaxCreate?.didSucceed) {
            salesTaxId = createTax.data.salesTaxCreate.salesTax.id;
          }
        }
        if (salesTaxId) {
          itemInputs.forEach(item => { item.taxes = [salesTaxId]; });
        }
      }

      // Step 5: Create invoice as DRAFT
      const invoiceResult = await waveQuery(token, `
        mutation CreateInvoice($input: InvoiceCreateInput!) {
          invoiceCreate(input: $input) {
            didSucceed inputErrors { code message path }
            invoice { id invoiceNumber viewUrl pdfUrl }
          }
        }
      `, { input: { businessId, customerId, invoiceDate, dueDate, poNumber, currency: "USD", items: itemInputs } });

      if (!invoiceResult.data?.invoiceCreate?.didSucceed) {
        const errors = invoiceResult.data?.invoiceCreate?.inputErrors || [];
        throw new Error(errors[0]?.message || "Failed to create invoice");
      }

      return res.status(200).json({ invoice: invoiceResult.data.invoiceCreate.invoice });
    }

    // ─────────────────────────────────────────────
    //  getPaymentAccounts
    // ─────────────────────────────────────────────
    if (action === "getPaymentAccounts") {
      const { businessId } = data;
      const result = await waveQuery(token, `
        query GetAccounts($businessId: ID!) {
          business(id: $businessId) {
            accounts(types: [ASSET], subtypes: [CASH_AND_BANK]) {
              edges { node { id name } }
            }
          }
        }
      `, { businessId });
      const accounts = result.data?.business?.accounts?.edges || [];
      return res.status(200).json({ accounts: accounts.map(e => e.node) });
    }

    // ─────────────────────────────────────────────
    //  markInvoicePaid
    // ─────────────────────────────────────────────
    if (action === "markInvoicePaid") {
      const { businessId, invoiceNumber, paymentDate, accountId, paymentMethod } = data;
      if (!accountId) throw new Error('No deposit account specified.');

      const cleanNumber = invoiceNumber.replace(/^#/, '').trim();
      let invoice = null;
      let page = 1;
      while (!invoice) {
        const invoicesResult = await waveQuery(token, `
          query GetInvoices($businessId: ID!, $page: Int!) {
            business(id: $businessId) {
              invoices(page: $page, pageSize: 200) {
                pageInfo { currentPage totalPages }
                edges { node { id invoiceNumber status total { value } amountDue { value } } }
              }
            }
          }
        `, { businessId, page });

        if (invoicesResult.errors) {
          return res.status(200).json({ error: "GraphQL error: " + JSON.stringify(invoicesResult.errors) });
        }

        const edges = invoicesResult.data?.business?.invoices?.edges || [];
        const pageInfo = invoicesResult.data?.business?.invoices?.pageInfo;
        invoice = edges.find(e => e.node.invoiceNumber === cleanNumber);
        if (invoice || !pageInfo || page >= pageInfo.totalPages) break;
        page++;
      }

      if (!invoice) {
        return res.status(200).json({
          error: `Invoice #${cleanNumber} not found in Wave after searching all pages.`
        });
      }
      if (['PAID', 'paid'].includes(invoice.node.status)) {
        return res.status(200).json({ success: true, alreadyPaid: true });
      }

      const invoiceId = invoice.node.id;
      const amount = invoice.node.amountDue?.value || invoice.node.total?.value;
      if (!amount) {
        return res.status(200).json({
          error: `Could not determine amount. Invoice data: ${JSON.stringify(invoice.node)}`
        });
      }

      const paymentResult = await waveQuery(token, `
        mutation RecordPayment($input: InvoicePaymentCreateManualInput!) {
          invoicePaymentCreateManual(input: $input) {
            didSucceed
            inputErrors { message }
            invoicePayment { id }
          }
        }
      `, { input: {
        invoiceId,
        paymentAccountId: accountId,
        amount: String(amount),
        paymentDate,
        paymentMethod: paymentMethod || "UNSPECIFIED",
        exchangeRate: "1"
      }});

      if (!paymentResult.data?.invoicePaymentCreateManual?.didSucceed) {
        const errors = paymentResult.data?.invoicePaymentCreateManual?.inputErrors || [];
        return res.status(200).json({
          error: errors[0]?.message || "Payment mutation failed: " + JSON.stringify(paymentResult)
        });
      }

      return res.status(200).json({ success: true });
    }

    // ─────────────────────────────────────────────
    //  approveInvoice
    // ─────────────────────────────────────────────
    if (action === "approveInvoice") {
      const { invoiceId } = data;
      if (!invoiceId) throw new Error("No invoiceId provided");
      const result = await waveQuery(token, `
        mutation ApproveInvoice($input: InvoiceApproveInput!) {
          invoiceApprove(input: $input) {
            didSucceed
            inputErrors { message }
            invoice { id status }
          }
        }
      `, { input: { invoiceId } });
      if (!result.data?.invoiceApprove?.didSucceed) {
        const errors = result.data?.invoiceApprove?.inputErrors || [];
        throw new Error(errors[0]?.message || "Failed to approve invoice");
      }
      return res.status(200).json({ success: true });
    }

    // ─────────────────────────────────────────────
    //  deleteInvoice
    // ─────────────────────────────────────────────
    if (action === "deleteInvoice") {
      const { invoiceId } = data;
      if (!invoiceId) throw new Error("No invoiceId provided");
      const result = await waveQuery(token, `
        mutation DeleteInvoice($input: InvoiceDeleteInput!) {
          invoiceDelete(input: $input) {
            didSucceed
            inputErrors { message }
          }
        }
      `, { input: { invoiceId } });
      if (!result.data?.invoiceDelete?.didSucceed) {
        const errors = result.data?.invoiceDelete?.inputErrors || [];
        throw new Error(errors[0]?.message || "Failed to delete invoice");
      }
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: "Unknown action" });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
