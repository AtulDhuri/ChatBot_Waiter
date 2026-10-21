// Browser-runtime test for the BUILT bundle (static/widget.js).
// Loads the real bundle into jsdom with a mocked fetch and drives the widget
// through its flows, asserting the DOM updates. This proves the refactored
// single-file bundle still behaves correctly end-to-end in a browser-like env.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(__dirname, "..", "static", "widget.js");
const bundle = readFileSync(bundlePath, "utf8");

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  console.log(`  [OK] ${name}`);
  passed++;
}

// ---- Mock backend ------------------------------------------------------
const MENU = {
  restaurant_name: "Demo Bistro",
  items: [
    { name: "Margherita Pizza", price: 9.5, category: "Mains", currency: "$", available: true },
    { name: "Garlic Bread", price: 4, category: "Starters", currency: "$", available: true },
  ],
  categories: {
    Starters: [{ name: "Garlic Bread", price: 4, category: "Starters", currency: "$", available: true }],
    Mains: [{ name: "Margherita Pizza", price: 9.5, category: "Mains", currency: "$", available: true }],
  },
};

const calls = [];
function mockFetch(url, opts) {
  const u = String(url);
  const method = (opts && opts.method) || "GET";
  calls.push(method + " " + u.replace(/^https?:\/\/[^/]+/, ""));
  const json = (body, status = 200) =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    });

  if (u.includes("/menu")) return json(MENU);
  if (u.includes("/session"))
    return json({ session_id: "sess-123", restaurant_name: "Demo Bistro" });
  if (u.includes("/bill"))
    return json({
      table_number: "12",
      line_items: [
        { quantity: 1, name: "Margherita Pizza", line_total: 9.5 },
        { quantity: 1, name: "Garlic Bread", line_total: 4 },
      ],
      subtotal: 13.5,
      tax_rate: 0.1,
      tax: 1.35,
      total: 14.85,
      dropped: [],
    });
  if (u.includes("/ask")) return json({ answer: "I recommend the pizza." });
  return json({}, 404);
}

// ---- jsdom environment -------------------------------------------------
const dom = new JSDOM(
  `<!DOCTYPE html><html><head></head><body></body></html>`,
  {
    url: "http://localhost:8000/?restaurant=demo&t=12",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  }
);
const { window } = dom;
window.fetch = mockFetch;
if (!window.crypto) window.crypto = {};
if (!window.crypto.randomUUID)
  window.crypto.randomUUID = () => "uuid-test-0000";

// Inject a <script> element so document.currentScript-style resolution has a
// src to read (the bundle falls back to the last <script> tag).
const scriptEl = window.document.createElement("script");
scriptEl.src = "http://localhost:8000/widget.js";
scriptEl.setAttribute("data-restaurant", "demo");
window.document.body.appendChild(scriptEl);

// Run the real bundle in the jsdom window context.
window.eval(bundle);

const tick = () => new Promise((r) => setTimeout(r, 0));

async function run() {
  // 1) Boot built the FAB and exposed the public API.
  await tick();
  check("FAB rendered", !!window.document.querySelector(".wa-fab"));
  check("window.ChatbotWaiter exposed", typeof window.ChatbotWaiter === "object");
  check("prefetched menu (restaurant name)", calls.some((c) => c.includes("/menu")));

  // 2) Open the panel -> legacy flow shows the dine-in/takeaway prompt.
  window.ChatbotWaiter.open();
  await tick();
  check("panel rendered", !!window.document.querySelector(".wa-panel"));
  const promptBtns = window.document.querySelectorAll(".wa-footer .wa-btn");
  check("order-type prompt shown (2 buttons)", promptBtns.length >= 2);

  // 3) Choose Eat-in -> asks for table number (preset from ?t=12).
  promptBtns[0].click();
  await tick();
  const tableInput = window.document.querySelector(".wa-footer input");
  check("table-number input shown", !!tableInput);
  check("preset table applied (?t=12)", tableInput && tableInput.value === "12");

  // 4) Start the session. Footer row is [back "←", input, go "Start"], so pick
  // the button whose label is "Start", not the first .wa-btn (which is back).
  const startBtn = [...window.document.querySelectorAll(".wa-footer .wa-btn")].find(
    (b) => /start/i.test(b.textContent)
  );
  check("Start button present", !!startBtn);
  startBtn.click();
  await tick();
  await tick();
  check("session started (POST /session)", calls.some((c) => c === "POST /session"));
  check("chat input rendered after session", !!window.document.querySelector(".wa-footer input"));

  // 5) View menu via quick chip.
  const chips = [...window.document.querySelectorAll(".wa-chip")];
  const menuChip = chips.find((c) => /view menu/i.test(c.textContent));
  check("menu quick-chip present", !!menuChip);
  menuChip.click();
  await tick();
  await tick();
  const menuItems = window.document.querySelectorAll(".wa-menu-item");
  check("menu items rendered", menuItems.length === 2);

  // 6) Add both dishes to the cart via their Add buttons, then open the cart
  // view and confirm both lines are present with a correct subtotal.
  const addButtons = [...window.document.querySelectorAll(".wa-menu-item .wa-add")];
  check("two Add buttons available", addButtons.length === 2);
  addButtons.forEach((b) => b.click());
  await tick();
  // After adding, the rows flip to a disabled "Added" button.
  const addedBtns = [...window.document.querySelectorAll(".wa-menu-item .wa-add")].filter(
    (b) => /added/i.test(b.textContent)
  );
  check("both menu rows now show 'Added'", addedBtns.length === 2);

  const cartChip = [...window.document.querySelectorAll(".wa-chip")].find((c) =>
    /my order/i.test(c.textContent)
  );
  cartChip.click();
  await tick();
  const cartRows = window.document.querySelectorAll(".wa-cart-row");
  check("cart view shows 2 line items", cartRows.length === 2);
  const subtotal = window.document.querySelector(".wa-cart-sum");
  check("cart subtotal is $13.50", subtotal && subtotal.textContent.includes("13.50"));
  // The note textarea must be a full-width sibling under .wa-cart-row (below the
  // info/qty top line), NOT nested inside the narrow .wa-cart-info column.
  const firstRow = cartRows[0];
  const noteEl = firstRow.querySelector(".wa-item-note");
  check("note textarea present in row", !!noteEl);
  check(
    "note is a direct child of the row (full width)",
    noteEl && noteEl.parentElement === firstRow
  );
  check(
    "note is NOT inside the narrow info column",
    noteEl && !noteEl.closest(".wa-cart-info")
  );
  check("row has a wa-cart-top header line", !!firstRow.querySelector(".wa-cart-top"));

  // 7) Ask for the bill via the chip and confirm totals render.
  const billChip = [...window.document.querySelectorAll(".wa-chip")].find((c) =>
    /my bill/i.test(c.textContent)
  );
  billChip.click();
  await tick();
  await tick();
  const billTable = window.document.querySelector(".wa-bill table");
  check("bill table rendered", !!billTable);
  const billText = window.document.querySelector(".wa-bill").textContent;
  check("bill shows computed total $14.85", billText.includes("14.85"));

  // 8) No uncaught errors were thrown during the whole flow.
  console.log(`\n${passed} checks passed. API calls observed:`);
  console.log("  " + calls.join("\n  "));
}

run().then(
  () => {
    console.log("\nRUNTIME TEST: PASS");
    process.exit(0);
  },
  (err) => {
    console.error("\nRUNTIME TEST: FAIL");
    console.error(err);
    process.exit(1);
  }
);
