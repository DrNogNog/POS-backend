// -----------------------------------------------------------------------------
// One PDF layout for every document: Estimate, Invoice, Purchase Order and
// Billing Order (supplier bill). Generated on the server from the saved data,
// so the PDF always matches the books. The top shows the invoice logo
// (assets/invoice-logo.png) and the store's address / phone / fax from
// Settings; dates, numbers, phone, fax and totals sit in labelled boxes.
//   style "themed" — brown & cream (estimates, purchase and billing orders)
//   style "plain"  — a normal black & white business document (invoices)
// -----------------------------------------------------------------------------
import fs from "fs";
import path from "path";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

type Color = ReturnType<typeof rgb>;
interface Palette {
  accent: Color; // titles, rules, box borders
  label: Color; // fill behind small box labels (DATE, PHONE…)
  labelText: Color;
  band: Color | null; // header background (null = none)
  boxHead: Color; // address box and table header fill
  boxHeadText: Color;
  stripe: Color | null; // every other line row
  text: Color;
  muted: Color;
}
const PALETTES: Record<"themed" | "plain", Palette> = {
  themed: {
    accent: rgb(0.36, 0.25, 0.17), // #5C4033
    label: rgb(0.96, 0.93, 0.89),
    labelText: rgb(0.36, 0.25, 0.17),
    band: rgb(0.96, 0.93, 0.89), // #F5EDE3
    boxHead: rgb(0.36, 0.25, 0.17),
    boxHeadText: rgb(1, 1, 1),
    stripe: rgb(0.96, 0.93, 0.89),
    text: rgb(0.17, 0.13, 0.1),
    muted: rgb(0.45, 0.4, 0.36),
  },
  plain: {
    accent: rgb(0, 0, 0),
    label: rgb(0.93, 0.93, 0.93),
    labelText: rgb(0, 0, 0),
    band: null,
    boxHead: rgb(0.9, 0.9, 0.9),
    boxHeadText: rgb(0, 0, 0),
    stripe: null,
    text: rgb(0, 0, 0),
    muted: rgb(0.35, 0.35, 0.35),
  },
};

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
  /** Customer / supplier phone and fax, each printed in its own box. */
  phone?: string;
  fax?: string;
  meta?: [string, string][]; // more boxes, like ["Salesperson", "Ana"]
  /** Adds a signature + date box, e.g. "Customer approval". */
  signatureLabel?: string;
  lines: PdfLine[];
  totals: [string, number, boolean?][]; // [label, amount, bold?]
  footerNote?: string;
  /** "plain" = normal black & white document. Default "themed". */
  style?: "themed" | "plain";
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
/** The invoice logo; falls back to the older logo.png if it isn't there. */
function loadLogo(): Buffer | null {
  if (logoBytes !== undefined) return logoBytes;
  const dir = path.join(process.cwd(), "assets");
  const file = ["invoice-logo.png", "logo.png"].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  logoBytes = file ? fs.readFileSync(file) : null;
  return logoBytes;
}

const NUMBER_LABEL: Record<PdfDocumentData["title"], string> = {
  ESTIMATE: "ESTIMATE NO.",
  INVOICE: "INVOICE NO.",
  "PURCHASE ORDER": "P.O. NO.",
  "BILLING ORDER": "BILL NO.",
};

export async function renderDocumentPdf(store: PdfStore, d: PdfDocumentData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 612;
  const H = 792;
  const M = 36;
  const C = PALETTES[d.style ?? "themed"];
  const RULE = 0.75;
  let page: PDFPage = doc.addPage([W, H]);

  const text = (p: PDFPage, s: string, x: number, y: number, size = 10, f = font, color = C.text) =>
    p.drawText(safe(s), { x, y, size, font: f, color });
  const right = (p: PDFPage, s: string, xRight: number, y: number, size = 10, f = font, color = C.text) =>
    p.drawText(safe(s), { x: xRight - f.widthOfTextAtSize(safe(s), size), y, size, font: f, color });
  const center = (p: PDFPage, s: string, x: number, w: number, y: number, size = 10, f = font, color = C.text) =>
    p.drawText(safe(s), { x: x + (w - f.widthOfTextAtSize(safe(s), size)) / 2, y, size, font: f, color });
  /** Shrinks text until it fits the width (for values in narrow boxes). */
  const fit = (s: string, f: PDFFont, size: number, w: number) => {
    let sz = size;
    while (sz > 6 && f.widthOfTextAtSize(safe(s), sz) > w) sz -= 0.5;
    return sz;
  };
  const box = (p: PDFPage, x: number, yTop: number, w: number, h: number, fill?: Color) =>
    p.drawRectangle({ x, y: yTop - h, width: w, height: h, borderColor: C.accent, borderWidth: RULE, ...(fill ? { color: fill } : {}) });

  /**
   * A row of labelled boxes: a small shaded label band on top, the value
   * below — like the fields on a printed business form.
   */
  const LABEL_H = 13;
  const boxRow = (p: PDFPage, x: number, yTop: number, w: number, cells: [string, string][], valueH = 18, align: "left" | "center" = "center") => {
    const cw = w / cells.length;
    cells.forEach(([label, value], i) => {
      const cx = x + i * cw;
      box(p, cx, yTop, cw, LABEL_H, C.label);
      center(p, label.toUpperCase(), cx, cw, yTop - 9.5, 7, bold, C.labelText);
      box(p, cx, yTop - LABEL_H, cw, valueH);
      const v = value || "-";
      const sz = fit(v, font, 9.5, cw - 8);
      if (align === "center") center(p, v, cx, cw, yTop - LABEL_H - valueH / 2 - sz / 2 + 2, sz);
      else text(p, v, cx + 5, yTop - LABEL_H - valueH / 2 - sz / 2 + 2, sz);
    });
    return yTop - LABEL_H - valueH;
  };

  // ---- Header: logo + store contact (left), title + boxed number/date (right) ----
  if (C.band) page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: C.accent });
  let leftY = H - M;
  const logo = loadLogo();
  let drewLogo = false;
  if (logo) {
    try {
      const img = await doc.embedPng(logo);
      const scale = Math.min(230 / img.width, 56 / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawImage(img, { x: M, y: leftY - h, width: w, height: h });
      leftY -= h + 8;
      drewLogo = true;
    } catch {
      /* logo is optional */
    }
  }
  if (!drewLogo && store.name) {
    text(page, store.name, M, leftY - 16, 16, bold, C.accent);
    leftY -= 24;
  }
  const contactLines = [
    [store.address, [store.city, store.state, store.zip].filter(Boolean).join(", ")].filter(Boolean).join(", "),
    [store.phone && `Tel ${store.phone}`, store.fax && `Fax ${store.fax}`].filter(Boolean).join("   |   "),
    [store.email, store.website].filter(Boolean).join("   |   "),
  ].filter(Boolean);
  for (const l of contactLines) {
    text(page, l, M, leftY - 8, 8.5, font, C.muted);
    leftY -= 11;
  }

  const titleSize = 22;
  right(page, d.title, W - M, H - M - titleSize + 4, titleSize, bold, C.accent);
  const gridW = 236;
  const gridX = W - M - gridW;
  let rightY = H - M - titleSize - 8;
  rightY = boxRow(page, gridX, rightY, gridW, [["Date", dateStr(d.date)], [NUMBER_LABEL[d.title], d.number]]);
  const second: [string, string][] = [];
  if (d.terms) second.push(["Terms", d.terms]);
  if (d.dueDate) second.push([d.title === "PURCHASE ORDER" ? "Expected" : "Due date", dateStr(d.dueDate)]);
  if (second.length) rightY = boxRow(page, gridX, rightY - 4, gridW, second);

  // ---- Bill to / Ship to ----
  let y = Math.min(leftY, rightY) - 14;
  const gap = 12;
  const boxW = (W - 2 * M - gap) / 2;
  const boxH = 76;
  for (const [i, [title, body]] of [
    [d.leftBoxTitle, d.leftBox],
    [d.rightBoxTitle, d.rightBox],
  ].entries()) {
    const x = M + i * (boxW + gap);
    box(page, x, y, boxW, LABEL_H + 2, C.boxHead);
    text(page, title.toUpperCase(), x + 7, y - 10.5, 7.5, bold, C.boxHeadText);
    box(page, x, y - LABEL_H - 2, boxW, boxH - LABEL_H - 2);
    let ly = y - LABEL_H - 15;
    for (const line of (body || "").split("\n").filter((l) => l.trim()).slice(0, 4)) {
      text(page, line.trim(), x + 7, ly, 9.5);
      ly -= 12;
    }
  }
  y -= boxH + 10;

  // ---- Phone / fax / other details, each in its own box ----
  const details: [string, string][] = [];
  if (d.phone !== undefined) details.push(["Phone", d.phone]);
  if (d.fax !== undefined) details.push(["Fax", d.fax]);
  for (const m of d.meta ?? []) details.push(m);
  if (details.length) y = boxRow(page, M, y, W - 2 * M, details) - 12;

  // ---- Lines table: every column ruled ----
  const x0 = M;
  const x5 = W - M;
  const x1 = x0 + 92;
  const x4 = x5 - 86;
  const x3 = x4 - 76;
  const x2 = x3 - 48;
  const cols = [x0, x1, x2, x3, x4, x5];
  const descWidth = x2 - x1 - 12;
  const HEAD_H = 18;
  const drawHeader = (p: PDFPage, yy: number) => {
    p.drawRectangle({ x: x0, y: yy - HEAD_H, width: x5 - x0, height: HEAD_H, color: C.boxHead, borderColor: C.accent, borderWidth: RULE });
    const t = C.boxHeadText;
    text(p, "ITEM", x0 + 6, yy - 12.5, 7.5, bold, t);
    text(p, "DESCRIPTION", x1 + 6, yy - 12.5, 7.5, bold, t);
    center(p, "QTY", x2, x3 - x2, yy - 12.5, 7.5, bold, t);
    right(p, "PRICE", x4 - 6, yy - 12.5, 7.5, bold, t);
    right(p, "AMOUNT", x5 - 6, yy - 12.5, 7.5, bold, t);
    return yy - HEAD_H;
  };
  /** Vertical rules + outer border for the rows drawn between top and bottom. */
  const ruleColumns = (p: PDFPage, top: number, bottom: number) => {
    for (const cx of cols) p.drawLine({ start: { x: cx, y: top }, end: { x: cx, y: bottom }, thickness: RULE, color: C.accent });
    p.drawLine({ start: { x: x0, y: bottom }, end: { x: x5, y: bottom }, thickness: RULE, color: C.accent });
  };

  let tableTop = drawHeader(page, y);
  y = tableTop;
  const BOTTOM = 70;
  d.lines.forEach((l, idx) => {
    const descLines = wrap(l.description, font, 9, descWidth);
    const rowH = descLines.length * 11 + 8;
    if (y - rowH < BOTTOM) {
      ruleColumns(page, tableTop, y);
      page = doc.addPage([W, H]);
      tableTop = drawHeader(page, H - M);
      y = tableTop;
    }
    if (C.stripe && idx % 2 === 1) page.drawRectangle({ x: x0, y: y - rowH, width: x5 - x0, height: rowH, color: C.stripe });
    const base = y - 13;
    text(page, l.itemCode, x0 + 6, base, 8.5, bold);
    descLines.forEach((dl, i) => text(page, dl, x1 + 6, base - i * 11, 9));
    center(page, String(Number(l.qty.toFixed(3))), x2, x3 - x2, base, 9);
    right(page, money(l.unitPrice), x4 - 6, base, 9);
    right(page, money(l.lineTotal), x5 - 6, base, 9, bold);
    y -= rowH;
    page.drawLine({ start: { x: x0, y }, end: { x: x5, y }, thickness: 0.3, color: C.muted });
  });
  // A few empty ruled rows make short documents look like a finished form
  for (let i = d.lines.length; i < 6 && y - 18 > BOTTOM + 160; i++) {
    y -= 18;
    page.drawLine({ start: { x: x0, y }, end: { x: x5, y }, thickness: 0.3, color: C.muted });
  }
  ruleColumns(page, tableTop, y);

  // ---- Totals: boxed label | amount rows, under the money columns ----
  const rowsNeeded = d.totals.length * 18 + 10;
  if (y - rowsNeeded < BOTTOM) {
    page = doc.addPage([W, H]);
    y = H - M;
  }
  const tLabelX = x3;
  const tLabelW = x4 - x3;
  const tAmtW = x5 - x4;
  let ty = y - 8;
  for (const [label, amount, isBold] of d.totals) {
    const h = isBold ? 20 : 17;
    box(page, tLabelX, ty, tLabelW, h, isBold ? C.boxHead : C.label);
    box(page, x4, ty, tAmtW, h, isBold ? C.label : undefined);
    const lsz = fit(label.toUpperCase(), bold, isBold ? 8.5 : 7.5, tLabelW - 10);
    right(page, label.toUpperCase(), x4 - 6, ty - h / 2 - lsz / 2 + 2, lsz, bold, isBold ? C.boxHeadText : C.labelText);
    right(page, money(amount), x5 - 6, ty - h / 2 - 3, isBold ? 10.5 : 9.5, isBold ? bold : font, isBold ? C.accent : C.text);
    ty -= h;
  }

  // ---- Notes and signature, boxed, beside the totals ----
  const leftW = tLabelX - M - 14;
  let ly = y - 8;
  if (d.footerNote) {
    const noteLines = wrap(d.footerNote, font, 8.5, leftW - 12).slice(0, 6);
    const nh = LABEL_H + noteLines.length * 11 + 10;
    box(page, M, ly, leftW, LABEL_H, C.label);
    text(page, "NOTES", M + 6, ly - 9.5, 7, bold, C.labelText);
    box(page, M, ly - LABEL_H, leftW, nh - LABEL_H);
    noteLines.forEach((l, i) => text(page, l, M + 6, ly - LABEL_H - 12 - i * 11, 8.5, font, C.muted));
    ly -= nh + 8;
  }
  if (d.signatureLabel) {
    const sigW = leftW * 0.68;
    box(page, M, ly, sigW, LABEL_H, C.label);
    text(page, d.signatureLabel.toUpperCase(), M + 6, ly - 9.5, 7, bold, C.labelText);
    box(page, M, ly - LABEL_H, sigW, 30);
    box(page, M + sigW, ly, leftW - sigW, LABEL_H, C.label);
    center(page, "DATE", M + sigW, leftW - sigW, ly - 9.5, 7, bold, C.labelText);
    box(page, M + sigW, ly - LABEL_H, leftW - sigW, 30);
  }

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: 34 }, end: { x: W - M, y: 34 }, thickness: 0.5, color: C.muted });
    text(p, `${d.title} ${d.number}`, M, 22, 7.5, font, C.muted);
    right(p, `Page ${i + 1} of ${pages.length}`, W - M, 22, 7.5, font, C.muted);
  });
  return doc.save();
}
