# POS backend (API)

The server behind the Champion POS: sales, estimates, invoices, accounts receivable,
purchase orders, supplier bills, accounts payable, inventory costing (FIFO / LIFO /
weighted average), payroll, financial reports and a full history log.

**One database, one drive per store.** The app talks to a single PostgreSQL
database (`DATABASE_URL`). Each store's data lives on its own drive — PostgreSQL's
`data_directory` points at that drive's mount path — so whichever drive PostgreSQL is
running from is the store you're working in. The store's name, address, taxes and
everything else come from that drive's own Settings, so stores never mix.

---

## First-time setup (Windows, PowerShell)

1. **Settings file:** copy `.env.example` to `.env` and fill it in:
   - `DATABASE_URL` — the same address for every drive (e.g. `.../pos`)
   - a long random `JWT_SECRET`. Generate one with
     `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
   - `OWNER_EMAIL` / `OWNER_PASSWORD` (10+ characters) for the first login
   - `WORKER_EMAIL` / `WORKER_PASSWORD` (8+ characters) for the worker login — it can only
     create estimates and see the approvals list. It's applied every time the server
     starts, so change it here (not in Settings) and restart
   - `STORE_NAME`, `TAX_NAME`, `TAX_RATE` for a new drive (change later in Settings)
2. **Install packages:**
   ```powershell
   npm install
   ```
3. **Prepare each store's drive** (once per drive — see the next section), then with
   that drive running:
   ```powershell
   npm run db:migrate   # creates the tables on this drive
                        # (if Windows blocks Prisma's schema-engine: npm run db:migrate:direct)
   npm run seed         # chart of accounts, price levels AA–D, categories, tax, owner login
                        # can't log in as owner? set OWNER_EMAIL/OWNER_PASSWORD in .env, then: npm run owner:reset
   ```
4. **Load a price list** (optional) — from the web app: **Items & stock → Import price
   list**, or `npm run import:pricelist -- data/pricelist-2025.csv`.
   `data/test-pricelist.csv` is a made-up list for trying things out.
5. **Start the server:**
   ```powershell
   npm run dev
   ```
   It runs on http://localhost:4000 and prints which database it's using. Then start
   `POS-frontend`.

## Keeping a store's data on a drive (USB or second disk)

Each drive holds a complete PostgreSQL data directory. Run these from PostgreSQL's `bin`
folder (e.g. `C:\Program Files\PostgreSQL\16\bin`) in an Administrator PowerShell.

**Make a new store drive** (format the drive **NTFS** first — PostgreSQL needs its
file permissions):
```powershell
.\initdb.exe -D "E:\pos-data" -U postgres -W -E UTF8      # asks for the postgres password
.\pg_ctl.exe -D "E:\pos-data" -o "-p 5432" start
.\psql.exe -U postgres -c "CREATE DATABASE pos;"
```
Then run `npm run db:migrate` and `npm run seed` (step 3 above).

**Already have PostgreSQL installed?** Stop the service, point its `data_directory` at
the drive (`data_directory = 'E:/pos-data'` in `postgresql.conf`, or re-register the
service with `pg_ctl register -N postgresql-pos -D "E:\pos-data"`), and start it again.

**Switching stores:** stop PostgreSQL, swap the drive (or point `data_directory` at the
other mount path), start PostgreSQL, refresh the web app. The header shows the store's
name from its Settings.

- **Always stop PostgreSQL before unplugging a drive** (`pg_ctl -D "E:\pos-data" stop`
  or stop the service). Pulling a drive while it's running can corrupt the store's data.
- Keep the same drive letter / mount path for a drive, or update `data_directory`.
- Back up each drive regularly: `pg_dump -U postgres -F c pos > store-backup.dump`.

The old database (`pos_db`) and its migrations (`prisma/migrations_legacy`) are not
touched. They are kept only for reference.

### After changing `prisma/schema.prisma`
```powershell
npx prisma migrate dev --name what-changed   # on the drive that's running now
npm run db:migrate                            # then on each other drive (swap it in first)
```

---

## How the code is organized

```
src/
  server.ts            starts the API
  app.ts               every route in one readable list
  config/env.ts        reads .env (database, secrets)
  db/stores.ts         the database connection
  middleware/auth.ts   login check and roles
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
scripts/               seed, migrate, import price list
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
$env:TEST_DB_URL="postgresql://postgres:PASS@localhost:5432/pos_test"
npm run test:e2e         # full flow on a THROWAWAY database (it gets wiped)
```
