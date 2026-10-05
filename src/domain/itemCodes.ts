// -----------------------------------------------------------------------------
// Cabinet item-code decoder.
//
// Turns a code like "W0930" or "AL-WDC2430" into plain English:
//   W0930     -> Wall Cabinet, 9" wide x 30" high, single door, 2 shelves
//   WDC2430   -> Wall Diagonal Corner Cabinet, 24" wide x 30" high
//   AL-B09    -> Avalon collection, Base Cabinet, 9" wide
//
// Uses the industry-standard RTA cabinet naming that matches the
// 2025 price list. Edit the TYPE table below to add or change codes.
//
// THIS FILE IS SHARED: an identical copy lives in the web app at
// POS-frontend/src/lib/itemCodes.ts. Keep both in sync.
// -----------------------------------------------------------------------------

export type CodeFamily = "wall" | "base" | "tall" | "vanity" | "trim" | "panel" | "accessory";

interface TypeInfo {
  name: string;
  family: CodeFamily;
  /** How to read the digits after the letters. */
  dims: "WH" | "W" | "WHD" | "none";
  notes?: string;
}

/**
 * Prefix -> meaning. Longer prefixes are matched first (WDC before W).
 */
export const CODE_TYPES: Record<string, TypeInfo> = {
  // ---- Wall (upper) cabinets: digits = width + height (+ depth) ----
  W: { name: "Wall Cabinet", family: "wall", dims: "WHD" },
  WDC: { name: "Wall Diagonal Corner Cabinet", family: "wall", dims: "WHD", notes: "Sits in an inside corner at 45°." },
  WBC: { name: "Wall Blind Corner Cabinet", family: "wall", dims: "WH" },
  WEC: { name: "Wall End Angle Cabinet", family: "wall", dims: "WH", notes: "Angled end of a wall run." },
  WES: { name: "Wall End Shelf", family: "wall", dims: "WH", notes: "Open shelves at the end of a wall run." },
  WLS: { name: "Wall Corner Bi-Fold Door Cabinet", family: "wall", dims: "WH", notes: "Corner cabinet with bi-fold (folding) doors." },
  WMC: { name: "Wall Microwave Cabinet", family: "wall", dims: "WH" },
  WCD: { name: "Plate Rack Cabinet", family: "wall", dims: "WH" },
  GW: { name: "Glass-Ready Wall Cabinet", family: "wall", dims: "WH", notes: "Finished interior. Glass doors (GD) sold separately." },
  GWDC: { name: "Glass-Ready Wall Diagonal Corner Cabinet", family: "wall", dims: "WH", notes: "Finished interior. Glass door sold separately." },
  GD: { name: "Glass Door & Frame", family: "accessory", dims: "WH" },
  D: { name: "Decorative Door", family: "accessory", dims: "WH" },
  VAL: { name: "Large Valance", family: "trim", dims: "WH" },
  V: { name: "Valance", family: "trim", dims: "W" },
  HC: { name: "Wood Hood Cover", family: "wall", dims: "W" },

  // ---- Base (lower) cabinets: digits = width ----
  B: { name: "Base Cabinet", family: "base", dims: "W" },
  DB: { name: "Drawer Base Cabinet", family: "base", dims: "W", notes: "The number after the dash is the drawer count (DB18-3 = 3 drawers)." },
  SB: { name: "Sink Base Cabinet", family: "base", dims: "W", notes: "False drawer front, no shelf (room for plumbing)." },
  FSB: { name: "Farm Sink Base Cabinet", family: "base", dims: "W" },
  CSB: { name: "Diagonal Corner Sink Base", family: "base", dims: "W" },
  BBC: { name: "Base Blind Corner Cabinet", family: "base", dims: "W" },
  BLS: { name: "Base Lazy Susan Corner Cabinet", family: "base", dims: "W", notes: "\"N\" suffix = shelf only, no trays." },
  BEC: { name: "Base End Angle Cabinet", family: "base", dims: "W" },
  BEA: { name: "Base Angled Cabinet", family: "base", dims: "W" },
  BES: { name: "Base End Shelf", family: "base", dims: "W" },
  BFH: { name: "Base Full-Height Door Cabinet", family: "base", dims: "W", notes: "One tall door, no drawer." },
  BMC: { name: "Base Microwave Cabinet", family: "base", dims: "W" },
  BSR: { name: "Base Spice Rack Pull-Out", family: "base", dims: "W" },
  PD: { name: "Pot Drawer Cabinet", family: "base", dims: "W", notes: "The number after the dash is the drawer count." },
  FD: { name: "Knee Drawer", family: "base", dims: "W" },

  // ---- Tall cabinets: digits = width + height ----
  WP: { name: "Pantry Cabinet", family: "tall", dims: "WHD" },
  OC: { name: "Wall Oven Cabinet", family: "tall", dims: "WH" },

  // ---- Vanity ----
  FA: { name: "Vanity Sink Cabinet", family: "vanity", dims: "WHD", notes: "DL / DR = drawers on the left / right." },
  SVA: { name: "Vanity Drawer Base", family: "vanity", dims: "W" },
  SVAM: { name: "Vanity Mirror", family: "vanity", dims: "WH" },

  // ---- Fillers, panels, moldings ----
  WF: { name: "Filler", family: "trim", dims: "WH" },
  PCVFF: { name: "Fluted Tall Filler", family: "trim", dims: "WH" },
  BP: { name: "Back Panel 1/4\"", family: "panel", dims: "WH" },
  RRP: { name: "Refrigerator Panel (with 3\" return)", family: "panel", dims: "WH" },
  UREP: { name: "Universal Refrigerator Panel", family: "panel", dims: "none" },
  DWR: { name: "Dishwasher Panel", family: "panel", dims: "none" },
  ACM: { name: "Crown Molding", family: "trim", dims: "none" },
  CCM: { name: "Crown Molding", family: "trim", dims: "none" },
  CM: { name: "Curved Crown Molding", family: "trim", dims: "none" },
  OCM: { name: "Outside Corner Molding", family: "trim", dims: "none" },
  OGM: { name: "Ogee Molding", family: "trim", dims: "none" },
  BCB: { name: "Chair Rail Molding", family: "trim", dims: "none" },
  BM: { name: "Base Molding", family: "trim", dims: "none" },
  SM: { name: "Scribe Molding", family: "trim", dims: "none" },
  QR: { name: "Quarter Round", family: "trim", dims: "none" },
  TK: { name: "Toe Kick", family: "trim", dims: "none" },
  TLR: { name: "Light Rail Molding", family: "trim", dims: "none" },
  DMI: { name: "Dentil Insert Molding", family: "trim", dims: "none" },
  RMI: { name: "Rope Insert Molding", family: "trim", dims: "none" },
  FB: { name: "Rosette", family: "trim", dims: "none" },
  SS: { name: "Split Spool / Post", family: "trim", dims: "none" },
  SPOOL: { name: "Full Post", family: "trim", dims: "none" },
  CORBEL: { name: "Corbel", family: "accessory", dims: "none" },
  SD: { name: "Sample Door", family: "accessory", dims: "none" },
  GR: { name: "Glass Rack", family: "accessory", dims: "none" },
  WR: { name: "Wine Rack", family: "accessory", dims: "none" },
};

/** Two-letter collection (door style) prefixes from the 2025 price list. */
export const COLLECTIONS: Record<string, string> = {
  AL: "Avalon",
  AN: "Aspen",
  BA: "Barley",
  CM: "Crystal Maple",
  CT: "Charlton",
  DS: "Dove White Shaker",
  GL: "Glacier",
  GR: "Gray Stone",
  KS: "Kingston",
  NV: "Nova",
  PE: "Perla",
  SE: "Sedona",
  SG: "Sterling",
  VA: "Vista",
  WH: "White Stone",
  WW: "Wildwood",
};

/** Quartz top color codes from the 2025 price list. */
export const QUARTZ_COLORS: Record<string, string> = {
  Q001: "Calacatta Delphi",
  Q002: "White Quartz",
  Q006: "Calacatta Gold",
  Q007: "Misty Carrara",
  Q014: "Grey Quartz",
};

export interface DecodedItemCode {
  input: string;
  recognized: boolean;
  collectionCode: string;
  collection: string;
  typeCode: string;
  typeName: string;
  family: CodeFamily | "";
  widthIn: number | null;
  heightIn: number | null;
  depthIn: number | null;
  doors: string;
  shelves: string;
  drawers: number | null;
  notes: string[];
  /** One readable sentence, e.g. "Wall Cabinet - 9\" W x 30\" H, single door, 2 adjustable shelves" */
  summary: string;
}

const PREFIXES_LONGEST_FIRST = Object.keys(CODE_TYPES).sort((a, b) => b.length - a.length);

/** Split "0930" -> [9, 30], "273615" -> [27, 36, 15], "36" -> [36]. */
function splitDigits(digits: string): number[] {
  const parts: number[] = [];
  for (let i = 0; i + 2 <= digits.length; i += 2) parts.push(Number(digits.slice(i, i + 2)));
  return parts;
}

function wallDoors(width: number): string {
  if (width <= 21) return "single door";
  return "double (butt) doors";
}

function wallShelves(height: number): string {
  if (height <= 18) return "no shelf";
  if (height <= 24) return "1 adjustable shelf";
  if (height <= 36) return "2 adjustable shelves";
  return "3 adjustable shelves";
}

export function decodeItemCode(raw: string): DecodedItemCode {
  const input = (raw || "").trim().toUpperCase();
  const result: DecodedItemCode = {
    input,
    recognized: false,
    collectionCode: "",
    collection: "",
    typeCode: "",
    typeName: "",
    family: "",
    widthIn: null,
    heightIn: null,
    depthIn: null,
    doors: "",
    shelves: "",
    drawers: null,
    notes: [],
    summary: "",
  };
  if (!input) return result;

  // 1) Optional collection prefix: "AL-B09"
  let code = input.replace(/\s*\(.*\)\s*$/, ""); // drop "(15\")" style notes
  const dash = code.indexOf("-");
  if (dash > 0 && COLLECTIONS[code.slice(0, dash)]) {
    result.collectionCode = code.slice(0, dash);
    result.collection = COLLECTIONS[result.collectionCode];
    code = code.slice(dash + 1);
  }

  // 2) Type prefix (letters) — longest match wins
  const letters = (code.match(/^[A-Z]+/) || [""])[0];
  const prefix = PREFIXES_LONGEST_FIRST.find((p) => letters === p) ??
    PREFIXES_LONGEST_FIRST.find((p) => code.startsWith(p) && /^[0-9]/.test(code.slice(p.length)));

  // Quartz vanity tops: Q001-36-1  (color 001, 36" vanity, 1 faucet hole)
  //                     Q001-60D-3 (60" with Double sinks, 3 faucet holes)
  const quartz = code.match(/^Q(\d{3})-(\d{2})([DS])?-(\d)$/);
  if (quartz) {
    const color = QUARTZ_COLORS[`Q${quartz[1]}`] ?? `color Q${quartz[1]}`;
    result.recognized = true;
    result.typeCode = "Q";
    result.typeName = "Quartz Vanity Top";
    result.family = "vanity";
    result.widthIn = Number(quartz[2]);
    result.notes.push("18mm quartz with sink, backsplash and side splash included.");
    const sinks = quartz[3] === "D" ? "double sinks" : "single sink";
    result.summary = `Quartz Vanity Top (${color}) — for ${quartz[2]}" vanity, ${sinks}, ${quartz[4]} faucet hole${quartz[4] === "1" ? "" : "s"}`;
    return result;
  }

  // Glass / wine racks are "30GR" / "36WR" (digits first)
  const rack = code.match(/^(\d{2})(GR|WR)$/);
  if (rack) {
    const info = CODE_TYPES[rack[2]];
    result.recognized = true;
    result.typeCode = rack[2];
    result.typeName = info.name;
    result.family = info.family;
    result.widthIn = Number(rack[1]);
    result.summary = `${info.name} for ${rack[1]}" cabinet`;
    if (result.collection) result.summary = `${result.collection} — ${result.summary}`;
    return result;
  }

  if (!prefix) {
    result.summary = "Unknown code — add it to the code table or enter a description.";
    return result;
  }

  const info = CODE_TYPES[prefix];
  result.recognized = true;
  result.typeCode = prefix;
  result.typeName = info.name;
  result.family = info.family;
  if (info.notes) result.notes.push(info.notes);

  const rest = code.slice(prefix.length);
  const digits = (rest.match(/^\d+/) || [""])[0];
  const suffix = rest.slice(digits.length);
  const nums = splitDigits(digits);

  if (info.dims === "W" && nums.length >= 1) {
    result.widthIn = nums[0];
  } else if ((info.dims === "WH" || info.dims === "WHD") && nums.length >= 2) {
    result.widthIn = nums[0];
    result.heightIn = nums[1];
    if (info.dims === "WHD" && nums.length >= 3) result.depthIn = nums[2];
  } else if (info.dims !== "none" && nums.length === 1) {
    result.widthIn = nums[0];
  }

  // Filler like WF330 = 3" x 30", WF1.5X96
  if (prefix === "WF") {
    const m = rest.match(/^(\d(?:\.\d)?)X?(\d{2})/);
    if (m) {
      result.widthIn = Number(m[1]);
      result.heightIn = Number(m[2]);
    }
  }

  // Drawer counts: DB18-3, PD30-2, SVA15D-3
  const drawerMatch = suffix.match(/-(\d)$/) || rest.match(/-(\d)$/);
  if ((prefix === "DB" || prefix === "PD" || prefix === "SVA") && drawerMatch) {
    result.drawers = Number(drawerMatch[1]);
  }

  // Door / shelf conventions
  if (info.family === "wall" && result.widthIn && result.heightIn && prefix === "W") {
    result.doors = wallDoors(result.widthIn);
    result.shelves = wallShelves(result.heightIn);
    if (result.depthIn && result.depthIn >= 24) result.notes.push("24\" deep — refrigerator wall cabinet.");
  }
  if (prefix === "B" && result.widthIn) {
    result.doors = result.widthIn <= 21 ? "single door, 1 drawer" : "double (butt) doors, 1–2 drawers";
    result.shelves = "1 adjustable shelf";
  }
  if (prefix === "WDC") {
    result.doors = "single door";
    if (result.heightIn) result.shelves = wallShelves(result.heightIn);
  }
  if (suffix.includes("DL")) result.notes.push("Drawers on the left.");
  if (suffix.includes("DR")) result.notes.push("Drawers on the right.");
  if (suffix.endsWith("N") && prefix === "BLS") result.notes.push("Shelf only — no trays.");
  if (suffix.endsWith("W") && prefix === "D") result.notes.push("For wall cabinets.");

  // Build the summary sentence
  const parts: string[] = [];
  const size: string[] = [];
  if (result.widthIn) size.push(`${result.widthIn}" W`);
  if (result.heightIn) size.push(`${result.heightIn}" H`);
  if (result.depthIn) size.push(`${result.depthIn}" D`);
  if (size.length) parts.push(size.join(" x "));
  if (result.doors) parts.push(result.doors);
  if (result.shelves) parts.push(result.shelves);
  if (result.drawers) parts.push(`${result.drawers} drawers`);
  result.summary = `${result.collection ? result.collection + " — " : ""}${info.name}${
    parts.length ? " — " + parts.join(", ") : ""
  }`;
  return result;
}
