// -----------------------------------------------------------------------------
// One PDF layout for every document: Estimate, Invoice, Purchase Order and
// Billing Order (supplier bill). Generated on the server from the saved data,
// so the PDF always matches the books. Uses the store logo and store details
// from Settings.
// -----------------------------------------------------------------------------
import fs from "fs";
import path from "path";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

const BROWN = rgb(0.36, 0.25, 0.17); // #5C4033
const LIGHT = rgb(0.96, 0.93, 0.89); // #F5EDE3
const TEXT = rgb(0.17, 0.13, 0.1);
const MUTED = rgb(0.45, 0.4, 0.36);

export interface PdfStore {
  name: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  fax: string;
  email: string;
  website: string;
}

export interface PdfLine {
  itemCode: string;
  description: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
}

export interface PdfDocumentData {
  title: "ESTIMATE" | "INVOICE" | "PURCHASE ORDER" | "BILLING ORDER";
  number: string;
  date: Date;
  dueDate?: Date | null;
  terms?: string;
  leftBoxTitle: string; // "Bill To" / "Supplier"
  leftBox: string;
  rightBoxTitle: string; // "Ship To" / "Deliver To"
  rightBox: string;
  meta?: [string, string][]; // extra rows like ["Fulfillment", "Delivery"]
  lines: PdfLine[];
  totals: [string, number, boolean?][]; // [label, amount, bold?]
  footerNote?: string;
}

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const dateStr = (d: Date) =>
  d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

/** pdf-lib's standard fonts only support basic characters. */
function safe(text: string): string {
  return (text || "").replace(/[^\x20-\x7E]/g, (c) => (c === "—" || c === "–" ? "-" : ""));
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = safe(text).split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    const trial = current ? `${current} ${w}` : w;
    if (font.widthOfTextAtSize(trial, size) > maxWidth && current) {
      lines.push(current);
      current = w;
    } else current = trial;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

let logoBytes: Buffer | null | undefined;
function loadLogo(): Buffer | null {
  if (logoBytes !== undefined) return logoBytes;
  const p = path.join(process.cwd(), "assets", "logo.png");
  logoBytes = fs.existsSync(p) ? fs.readFileSync(p) : null;
  return logoBytes;
}

export async function renderDocumentPdf(store: PdfStore, d: PdfDocumentData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 612;
  const H = 792;
  const M = 40;
  let page: PDFPage = doc.addPage([W, H]);

  const text = (p: PDFPage, s: string, x: number, y: number, size = 10, f = font, color = TEXT) =>
    p.drawText(safe(s), { x, y, size, font: f, color });
  const right = (p: PDFPage, s: string, xRight: number, y: number, size = 10, f = font, color = TEXT) =>
    p.drawText(safe(s), { x: xRight - f.widthOfTextAtSize(safe(s), size), y, size, font: f, color });

  // ---- Header band ----
  page.drawRectangle({ x: 0, y: H - 110, width: W, height: 110, color: LIGHT });
  page.drawRectangle({ x: 0, y: H - 114, width: W, height: 4, color: BROWN });
  let headerX = M;
  const logo = loadLogo();
  if (logo) {
    try {
      const img = await doc.embedPng(logo);
      const scale = Math.min(110 / img.width, 70 / img.height);
      page.drawImage(img, { x: M, y: H - 92, width: img.width * scale, height: img.height * scale });
      headerX = M + img.width * scale + 14;
    } catch {
      /* logo is optional */
    }
  }
  text(page, store.name, headerX, H - 42, 15, bold, BROWN);
  const addr = [store.address, [store.city, store.state, store.zip].filter(Boolean).join(", ")]
    .filter(Boolean)
    .join("  |  ");
  text(page, addr, headerX, H - 58, 9, font, MUTED);
  const contact = [store.phone && `Tel ${store.phone}`, store.fax && `Fax ${store.fax}`, store.email, store.website]
    .filter(Boolean)
    .join("  |  ");
  text(page, contact, headerX, H - 71, 9, font, MUTED);

  right(page, d.title, W - M, H - 42, 20, bold, BROWN);
  right(page, `# ${d.number}`, W - M, H - 62, 11, bold);
  right(page, `Date: ${dateStr(d.date)}`, W - M, H - 77, 9);
  if (d.dueDate) right(page, `Due: ${dateStr(d.dueDate)}`, W - M, H - 90, 9);
  if (d.terms) right(page, `Terms: ${d.terms}`, W - M, H - 103, 9, font, MUTED);

  // ---- Address boxes ----
  let y = H - 135;
  const boxW = (W - 2 * M - 16) / 2;
  const boxH = 80;
  for (const [i, [title, body]] of [
    [d.leftBoxTitle, d.leftBox],
    [d.rightBoxTitle, d.rightBox],
  ].entries()) {
    const x = M + i * (boxW + 16);
    page.drawRectangle({ x, y: y - boxH, width: boxW, height: boxH, borderColor: BROWN, borderWidth: 0.8 });
    page.drawRectangle({ x, y: y - 16, width: boxW, height: 16, color: BROWN });
    text(page, title.toUpperCase(), x + 8, y - 12, 8.5, bold, rgb(1, 1, 1));
    let ly = y - 30;
    for (const line of (body || "").split("\n").filter((l) => l.trim()).slice(0, 4)) {
      text(page, line.trim(), x + 8, ly, 9.5);
      ly -= 12;
    }
  }
  y -= boxH + 12;

  if (d.meta?.length) {
    text(page, d.meta.map(([k, v]) => `${k}: ${v}`).join("     "), M, y, 9, font, MUTED);
    y -= 16;
  }

  // ---- Lines table ----
  // Column positions: text columns by left edge, number columns by right edge
  const col = { item: M + 6, desc: M + 100, descWidth: 245, qtyRight: M + 395, priceRight: M + 465, amountRight: W - M - 6 };
  const drawHeader = (p: PDFPage, yy: number) => {
    p.drawRectangle({ x: M, y: yy - 18, width: W - 2 * M, height: 18, color: BROWN });
    const white = rgb(1, 1, 1);
    text(p, "ITEM", col.item, yy - 13, 8.5, bold, white);
    text(p, "DESCRIPTION", col.desc, yy - 13, 8.5, bold, white);
    right(p, "QTY", col.qtyRight, yy - 13, 8.5, bold, white);
    right(p, "PRICE", col.priceRight, yy - 13, 8.5, bold, white);
    right(p, "AMOUNT", col.amountRight, yy - 13, 8.5, bold, white);
    return yy - 30;
  };
  y = drawHeader(page, y);

  d.lines.forEach((l, idx) => {
    const descLines = wrap(l.description, font, 9, col.descWidth);
    const rowH = Math.max(1, descLines.length) * 11 + 6;
    if (y - rowH < 150) {
      page = doc.addPage([W, H]);
      y = drawHeader(page, H - M);
    }
    if (idx % 2 === 1) page.drawRectangle({ x: M, y: y - rowH + 10, width: W - 2 * M, height: rowH, color: LIGHT });
    text(page, l.itemCode, col.item, y, 9, bold);
    descLines.forEach((dl, i) => text(page, dl, col.desc, y - i * 11, 9));
    right(page, String(Number(l.qty.toFixed(3))), col.qtyRight, y, 9);
    right(page, money(l.unitPrice), col.priceRight, y, 9);
    right(page, money(l.lineTotal), col.amountRight, y, 9, bold);
    y -= rowH;
  });

  // ---- Totals ----
  y -= 6;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: BROWN });
  y -= 16;
  for (const [label, amount, isBold] of d.totals) {
    if (y < 60) {
      page = doc.addPage([W, H]);
      y = H - M;
    }
    right(page, label, W - M - 110, y, isBold ? 11 : 9.5, isBold ? bold : font, isBold ? BROWN : TEXT);
    right(page, money(amount), W - M - 6, y, isBold ? 11 : 9.5, isBold ? bold : font, isBold ? BROWN : TEXT);
    y -= isBold ? 18 : 14;
  }

  if (d.footerNote) {
    for (const [i, l] of wrap(d.footerNote, font, 8.5, W - 2 * M).entries()) {
      text(page, l, M, 50 - i * 11, 8.5, font, MUTED);
    }
  }
  const pages = doc.getPages();
  pages.forEach((p, i) => right(p, `Page ${i + 1} of ${pages.length}`, W - M, 22, 8, font, MUTED));
  return doc.save();
}
