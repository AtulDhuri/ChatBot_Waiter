// All widget styling, injected once as a single <style> tag. Kept as a string
// so the bundle stays a single self-contained file with no external CSS asset.

import { el } from "./dom.js";

export function injectStyles() {
  if (document.getElementById("waiter-widget-styles")) return;
  var css =
    "" +
    ".wa-root{position:fixed;bottom:20px;right:20px;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}" +
    ".wa-fab{width:60px;height:60px;border-radius:50%;background:#6366f1;color:#f8fafc;border:none;box-shadow:0 6px 18px rgba(0,0,0,.25);font-size:26px;cursor:pointer;display:flex;align-items:center;justify-content:center;}" +
    ".wa-panel{position:fixed;bottom:92px;right:20px;width:360px;max-width:calc(100vw - 32px);height:70vh;max-height:620px;background:#0f172a;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.28);display:flex;flex-direction:column;overflow:hidden;}" +
    ".wa-header{background:#6366f1;color:#f8fafc;padding:14px 16px;font-weight:600;display:flex;justify-content:space-between;align-items:center;}" +
    ".wa-header small{display:block;font-weight:400;opacity:.9;font-size:12px;}" +
    ".wa-close{background:none;border:none;color:#f8fafc;font-size:20px;cursor:pointer;line-height:1;}" +
    ".wa-body{flex:1;overflow-y:auto;padding:14px;background:#0f172a;}" +
    ".wa-msg{margin:8px 0;display:flex;}" +
    ".wa-msg.bot{justify-content:flex-start;}" +
    ".wa-msg.user{justify-content:flex-end;}" +
    ".wa-bubble{max-width:80%;padding:10px 12px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word;}" +
    ".wa-msg.bot .wa-bubble{background:#0f172a;color:#f8fafc;border:1px solid rgba(255,255,255,.10);border-bottom-left-radius:4px;}" +
    ".wa-msg.user .wa-bubble{background:#6366f1;color:#f8fafc;border-bottom-right-radius:4px;}" +
    ".wa-menu-item{background:#0f172a;border:1px solid rgba(255,255,255,.10);border-radius:10px;padding:8px 10px;margin:6px 0;display:flex;justify-content:space-between;align-items:center;}" +
    ".wa-menu-item .wa-mi-info{flex:1;padding-right:8px;}" +
    ".wa-menu-item .wa-mi-name{font-weight:600;font-size:14px;}" +
    ".wa-menu-item .wa-mi-desc{font-size:12px;color:#94a3b8;}" +
    ".wa-cat{font-weight:700;margin:12px 0 4px;color:#6366f1;font-size:13px;text-transform:uppercase;letter-spacing:.4px;}" +
    ".wa-menu-search{width:100%;position:sticky;top:0;margin-bottom:6px;}" +
    ".wa-menu-count{margin-bottom:6px;}" +
    ".wa-cat-chips{overflow-x:auto;flex-wrap:nowrap;padding-bottom:4px;}" +
    ".wa-chip-on{background:#6366f1;color:#f8fafc;}" +
    ".wa-add{background:#22c55e;color:#f8fafc;border:none;border-radius:8px;padding:6px 10px;font-size:13px;cursor:pointer;white-space:nowrap;}" +
    ".wa-mi-action{display:flex;align-items:center;gap:6px;}" +
    ".wa-mi-remove{color:#f87171;font-size:16px;line-height:1;}" +
    ".wa-bill-updating{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:8px;background:rgba(255,255,255,.78);border-radius:10px;font-size:13px;color:#94a3b8;font-weight:600;}" +
    ".wa-spinner{width:16px;height:16px;border:2px solid #475569;border-top-color:#6366f1;border-radius:50%;display:inline-block;animation:wa-spin .7s linear infinite;}" +
    "@keyframes wa-spin{to{transform:rotate(360deg);}}" +
    ".wa-footer{border-top:1px solid rgba(255,255,255,.10);padding:12px;background:linear-gradient(180deg,#0f172a 0%,#020617 100%);box-shadow:0 -8px 24px rgba(0,0,0,.18);}" +
    ".wa-row{display:flex;align-items:center;gap:8px;padding:5px 5px 5px 12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:16px;box-shadow:inset 0 1px 0 rgba(255,255,255,.04);}" +
    ".wa-input{flex:1;min-width:0;border:0;background:transparent;color:#f8fafc;border-radius:12px;padding:11px 4px;font-size:14px;outline:none;box-shadow:none;}" +
    ".wa-input::placeholder{color:#64748b;}" +
    ".wa-btn{background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 55%,#ec4899 100%);color:#f8fafc;border:none;border-radius:12px;padding:10px 16px;font-size:14px;font-weight:700;cursor:pointer;min-width:62px;box-shadow:0 5px 14px rgba(99,102,241,.28);transition:transform .15s ease,filter .15s ease;}" +
    ".wa-btn:hover{filter:brightness(1.08);transform:translateY(-1px);}" +
    ".wa-btn.secondary{background:#334155;}" +
    ".wa-btn:disabled,.wa-chip:disabled,.wa-add:disabled{opacity:.55;cursor:default;}" +
    ".wa-quick{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;}" +
    ".wa-chip{background:rgba(255,255,255,.10);color:#c4b5fd;border:none;border-radius:16px;padding:6px 10px;font-size:12px;cursor:pointer;}" +
    ".wa-cart-badge{background:#22c55e;color:#f8fafc;border-radius:12px;padding:1px 7px;font-size:11px;margin-left:6px;}" +
    ".wa-bill table{width:100%;border-collapse:collapse;font-size:13px;}" +
    ".wa-bill td{padding:3px 0;}" +
    ".wa-bill .r{text-align:right;}" +
    ".wa-bill .tot{font-weight:700;border-top:1px solid rgba(255,255,255,.10);}" +
    ".wa-cart-card{background:#0f172a;border:1px solid rgba(255,255,255,.10);border-radius:10px;padding:10px;}" +
    ".wa-cart-title{font-weight:700;margin-bottom:6px;color:#6366f1;}" +
    ".wa-cart-row{display:flex;flex-direction:column;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.10);}" +
    ".wa-cart-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;}" +
    ".wa-cart-info{flex:1;padding-right:8px;}" +
    ".wa-item-note{margin-top:6px;width:100%;box-sizing:border-box;font-size:13px;padding:7px 9px;resize:vertical;min-height:38px;line-height:1.35;font-family:inherit;}" +
    ".wa-qty{display:flex;align-items:center;gap:6px;}" +
    ".wa-qty-btn{width:26px;height:26px;border-radius:6px;border:1px solid rgba(255,255,255,.10);background:#0f172a;font-size:16px;line-height:1;color:#f8fafc;}" +
    ".wa-qty-n{min-width:18px;text-align:center;font-size:14px;}" +
    ".wa-remove{border:none;background:none;cursor:pointer;font-size:15px;padding:2px 4px;}" +
    ".wa-cart-sum{text-align:right;font-weight:700;margin-top:8px;}" +
    ".wa-cart-actions{display:flex;gap:8px;margin-top:10px;}" +
    ".wa-cart-actions .wa-btn{flex:1;}" +
    ".wa-pay-card{background:#0f172a;border:1px solid rgba(255,255,255,.10);border-radius:12px;padding:14px;text-align:center;}" +
    ".wa-pay-amt{font-size:20px;font-weight:800;color:#22c55e;}" +
    ".wa-qr{display:flex;justify-content:center;margin:12px 0;min-height:200px;align-items:center;}" +
    ".wa-qr img,.wa-qr canvas{display:block;}" +
    ".wa-pay-link{display:inline-block;margin:6px 0;background:#22c55e;color:#f8fafc;text-decoration:none;padding:10px 16px;border-radius:10px;font-size:14px;}" +
    ".wa-order-card{background:rgba(255,255,255,.05);border:1px solid rgba(34,197,94,.35);border-radius:12px;padding:14px;text-align:center;}" +
    ".wa-order-no{font-size:22px;font-weight:800;color:#22c55e;margin-bottom:4px;}" +
    ".wa-status-card{background:#0f172a;border:1px solid rgba(255,255,255,.10);border-radius:14px;padding:14px;box-shadow:0 2px 10px rgba(0,0,0,.04);}" +
    ".wa-status-title{font-weight:700;font-size:14px;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;}" +
    ".wa-status-live{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:700;color:#22c55e;text-transform:uppercase;letter-spacing:.4px;}" +
    ".wa-live-dot{width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 0 rgba(34,197,94,.5);animation:wa-pulse 1.8s infinite;}" +
    "@keyframes wa-pulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.5);}70%{box-shadow:0 0 0 6px rgba(34,197,94,0);}100%{box-shadow:0 0 0 0 rgba(34,197,94,0);}}" +
    ".wa-status-row{border-top:1px solid rgba(255,255,255,.10);padding:12px 0 4px;}" +
    ".wa-status-row:first-of-type{border-top:none;padding-top:2px;}" +
    ".wa-status-head{display:flex;justify-content:space-between;align-items:center;}" +
    ".wa-status-no{font-weight:700;font-size:13px;color:#f8fafc;}" +
    ".wa-status-badge{font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;text-transform:uppercase;letter-spacing:.3px;}" +
    ".wa-st-placed{background:#0f172a;color:#3b82f6;}" +
    ".wa-st-preparing{background:#1e293b;color:#f8fafc;}" +
    ".wa-st-served{background:rgba(255,255,255,.05);color:#22c55e;}" +
    ".wa-st-cancelled{background:rgba(248,113,113,.12);color:#f87171;}" +
    // ---- Connected progress tracker ----
    ".wa-track{position:relative;margin:16px 4px 6px;}" +
    ".wa-track-line{position:absolute;top:11px;left:11px;right:11px;height:3px;background:rgba(255,255,255,.10);border-radius:3px;overflow:hidden;}" +
    ".wa-track-fill{height:100%;background:#22c55e;border-radius:3px;transition:width .45s ease;}" +
    ".wa-track-nodes{position:relative;display:flex;justify-content:space-between;}" +
    ".wa-node{display:flex;flex-direction:column;align-items:center;gap:5px;flex:1;}" +
    ".wa-node-dot{width:23px;height:23px;border-radius:50%;background:#0f172a;border:2px solid rgba(255,255,255,.10);color:#f8fafc;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;transition:all .3s ease;}" +
    ".wa-node-label{font-size:10px;color:#64748b;font-weight:600;transition:color .3s ease;}" +
    ".wa-node.done .wa-node-dot{background:#22c55e;border-color:#22c55e;color:#f8fafc;}" +
    ".wa-node.done .wa-node-label{color:#22c55e;}" +
    ".wa-node.active .wa-node-dot{background:#0f172a;border-color:#22c55e;color:#22c55e;box-shadow:0 0 0 0 rgba(34,197,94,.45);animation:wa-pulse 1.8s infinite;}" +
    ".wa-node.active .wa-node-label{color:#22c55e;font-weight:700;}" +
    ".wa-status-cancel-note{font-size:12px;color:#f87171;margin:10px 0 2px;}" +
    ".wa-status-items{margin:10px 0 2px;padding:8px 0;border-top:1px dashed rgba(255,255,255,.10);border-bottom:1px dashed rgba(255,255,255,.10);display:flex;flex-direction:column;gap:5px;}" +
    ".wa-status-item{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#94a3b8;}" +
    ".wa-order-items{margin-top:9px;padding-top:8px;border-top:1px dashed rgba(255,255,255,.10);display:flex;flex-direction:column;gap:4px;}" +
    ".wa-order-item{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#94a3b8;}" +
    ".wa-status-total-label{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.4px;font-weight:600;}" +
    ".wa-status-total-amt{font-size:15px;font-weight:800;color:#f8fafc;}" +
    "@media (max-width:600px){" +
    // Full-screen chat on mobile.
    ".wa-panel{top:0;left:0;right:0;bottom:0;width:100%;max-width:100%;" +
    "height:100vh;height:100dvh;max-height:none;border-radius:0;}" +
    ".wa-header{padding-top:calc(14px + env(safe-area-inset-top));}" +
    ".wa-open .wa-fab{display:none;}" +
    ".wa-open,.wa-open body{overflow:hidden;}" +
    "}";
  var style = el("style", { id: "waiter-widget-styles" });
  style.appendChild(document.createTextNode(css));
  document.head.appendChild(style);
}
