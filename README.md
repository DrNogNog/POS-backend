# POS backend (API)

The server behind the Champion POS: sales, estimates, invoices, accounts receivable,
purchase orders, supplier bills, accounts payable, inventory costing (FIFO / LIFO /
weighted average), payroll, financial reports and a full history log.

**Two stores, two databases.** Store A and Store B each have their own PostgreSQL
database with the same tables, so inventory, customers, prices, taxes and books never
mix. The web app sends `X-Store: A` or `X-Store: B` with every request.

---

## First-time setup (Windows, PowerShell)

1. **Create the two databases** in PostgreSQL (pgAdmin or `psql`):
   ```sql
   CREATE DATABASE pos_store_a;
   CREATE DATABASE pos_store_b;
   ```
2. **Settings file:** copy `.env.example` to `.env` and fill it in. You need:
   - both database addresses, plus `DATABASE_URL` pointing at Store A
   - a long random `JWT_SECRET`. Generate one with
     `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
   - `OWNER_EMAIL` / `OWNER_PASSWORD` for the first login
   - each store's sales tax rate
3. **Install packages:**
   ```powershell
   npm install
   ```
4. **Create the tables.** This is a one-time step for the new schema:
   ```powershell
   npx prisma migrate dev --name accounting_v2   # creates the migration on Store A
   npm run db:migrate                             # applies it to Store A and Store B
   ```
5. **Add the basics** (chart of accounts, price levels AA–D, categories, tax rate, owner login):
   ```powershell
   npm run seed
   ```
6. **Load the 2025 price list.** This is optional. It loads 3,485 cabinet and vanity-top items with list prices and the 61% supplier discount:
   ```powershell
   npm run import:pricelist -- A data/pricelist-2025.csv
   npm run import:pricelist -- B data/pricelist-2025.csv
   ```
   You can also import it from the web app: **Items & stock → Import price list**.
7. **Start the server:**
   ```powershell
   npm run dev
   ```
   It runs on http://localhost:4000. Then start `POS-frontend`.

The old database (`pos_db`) and its migrations (`prisma/migrations_legacy`) are not
touched. They are kept only for reference.

### After changing `prisma/schema.prisma`
```powershell
npx prisma migrate dev --name what-changed   # Store A
npm run db:migrate                            # Store B (and any other store)
```

---

## How the code is organized

```
src/
  server.ts            starts the API
  app.ts               every route in one readable list
  config/env.ts        reads .env (stores, secrets)
  db/stores.ts         one database connection per store
  middleware/auth.ts   login check, store selection, roles
  domain/              PURE business rules (no database), all unit-tested
    accounts.ts          chart of accounts + the journal entry for every event
    costing.ts           FIFO / LIFO / weighted average
    terms.ts             net 30/60/90, early-pay discounts, late fees, aging
    receivablesHealth.ts A/R too high / too low (DSO)
    documentTotals.ts    subtotal, discount, tax, total
    pricing.ts           price in / price out / price levels
    payroll.ts           gross and net pay
    itemCodes.ts         cabinet code decoder (W0930, WDC2430 ...)
  services/            business actions that change the database
    sales.ts             estimates, invoices, payments, late fees, collections
    purchasing.ts        purchase orders, receiving, supplier bills and payments
    inventory.ts         the ONLY place stock levels change
    journal.ts           writes journal entries
    reports.ts           balance sheet, P&L, A/R and A/P boards, dashboard
  routes/              thin HTTP layer: validate input -> call a service
  pdf/documentPdf.ts   one PDF layout for estimates, invoices, POs, billing orders
scripts/               seed, migrate both stores, import price list
tests/                 unit tests + end-to-end tests
data/pricelist-2025.csv
```

Every action that changes money or stock runs in **one database transaction**. It
updates the documents, moves stock, posts a balanced journal entry and writes a
History line. If any step fails, nothing is saved.

## Accounting rules (double-entry)

| Event | Debit | Credit |
|---|---|---|
| Sale on invoice | A/R | Sales, Sales Tax Payable |
| …cost of the goods | Cost of Goods Sold | Inventory |
| Customer pays | Cash (cash) / Bank (card, check), Sales Discounts | A/R |
| Late fee to customer | A/R | Late Fee Income |
| Write off bad debt | Bad Debt Expense | A/R |
| Receive stock + supplier bill | Inventory (incl. freight) | A/P |
| Other bill (rent…) | Expense | A/P |
| Pay supplier | A/P | Cash/Bank, Purchase Discounts |
| Supplier late fee | Late Fees Paid | A/P |
| Opening stock / count up | Inventory | Opening Balance Equity |
| Damage / count down | Inventory Shrinkage | Inventory |
| Payroll | Wages, Payroll Tax Expense | Bank, Payroll Liabilities |

- **Costing method** (Settings): FIFO, LIFO or weighted average decides cost of goods
  sold. The Costing screen also shows the other two methods for comparison.
- **Early-payment discount**, e.g. 2/10 net 30: granted automatically when the customer
  pays the rest in full within the window.
- Bad debts use the direct write-off method. Ask your accountant whether you need an
  allowance method for your tax situation.

## Security and privacy

- Every route needs a login. Roles: Owner, Manager, Accountant, Cashier.
- Passwords are hashed with bcrypt, and logins are rate-limited.
- The server refuses to start without a strong `JWT_SECRET`.
- **Card on file:** only the brand, last 4 digits, expiry and the card processor's token
  are stored. A full card number is rejected.
- No Social Security or bank numbers are stored for employees.
- `.env` and database backups (`*.sql`) are git-ignored. Never commit them.
- Run the API on your store's own computer or network. Don't expose port 4000 to the
  internet without HTTPS.

## Tests

```powershell
npm test                 # accounting rules (no database needed)
npm run test:prepare     # once: builds the test database client
$env:TEST_DB_URL_A="postgresql://postgres:PASS@localhost:5432/pos_test_a"
$env:TEST_DB_URL_B="postgresql://postgres:PASS@localhost:5432/pos_test_b"
npm run test:e2e         # full flow on two THROWAWAY databases (they get wiped)
```
