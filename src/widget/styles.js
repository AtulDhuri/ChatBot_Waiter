// All widget styling, injected once as a single <style> tag. Kept as a string
// so the bundle stays a single self-contained file with no external CSS asset.

import { el } from "./dom.js";

export function injectStyles() {
  if (document.getElementById("waiter-widget-styles")) return;
  var css =
    "" +
    ".wa-root{position:fixed;bottom:20px;right:20px;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}" +
    ".wa-fab{width:60px;height:60px;border-radius:50%;background:#e4572e;color:#fff;border:none;box-shadow:0 6px 18px rgba(0,0,0,.25);font-size:26px;cursor:pointer;display:flex;align-items:center;justify-content:center;}" +
    ".wa-panel{position:fixed;bottom:92px;right:20px;width:360px;max-width:calc(100vw - 32px);height:70vh;max-height:620px;background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.28);display:flex;flex-direction:column;overflow:hidden;}" +
    ".wa-header{background:#e4572e;color:#fff;padding:14px 16px;font-weight:600;display:flex;justify-content:space-between;align-items:center;}" +
    ".wa-header small{display:block;font-weight:400;opacity:.9;font-size:12px;}" +
    ".wa-close{background:none;border:none;color:#fff;font-size:20px;cursor:pointer;line-height:1;}" +
    ".wa-body{flex:1;overflow-y:auto;padding:14px;background:#f7f7f8;}" +
    ".wa-msg{margin:8px 0;display:flex;}" +
    ".wa-msg.bot{justify-content:flex-start;}" +
    ".wa-msg.user{justify-content:flex-end;}" +
    ".wa-bubble{max-width:80%;padding:10px 12px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word;}" +
    ".wa-msg.bot .wa-bubble{background:#fff;color:#222;border:1px solid #eee;border-bottom-left-radius:4px;}" +
    ".wa-msg.user .wa-bubble{background:#e4572e;color:#fff;border-bottom-right-radius:4px;}" +
    ".wa-menu-item{background:#fff;border:1px solid #eee;border-radius:10px;padding:8px 10px;margin:6px 0;display:flex;justify-content:space-between;align-items:center;}" +
    ".wa-menu-item .wa-mi-info{flex:1;padding-right:8px;}" +
    ".wa-menu-item .wa-mi-name{font-weight:600;font-size:14px;}" +
    ".wa-menu-item .wa-mi-desc{font-size:12px;color:#666;}" +
    ".wa-cat{font-weight:700;margin:12px 0 4px;color:#e4572e;font-size:13px;text-transform:uppercase;letter-spacing:.4px;}" +
    ".wa-menu-search{width:100%;position:sticky;top:0;margin-bottom:6px;}" +
    ".wa-menu-count{margin-bottom:6px;}" +
    ".wa-cat-chips{overflow-x:auto;flex-wrap:nowrap;padding-bottom:4px;}" +
    ".wa-chip-on{background:#e4572e;color:#fff;}" +
    ".wa-add{background:#2e9e5b;color:#fff;border:none;border-radius:8px;padding:6px 10px;font-size:13px;cursor:pointer;white-space:nowrap;}" +
    ".wa-mi-action{display:flex;align-items:center;gap:6px;}" +
    ".wa-mi-remove{color:#b53030;font-size:16px;line-height:1;}" +
    ".wa-bill-updating{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:8px;background:rgba(255,255,255,.78);border-radius:10px;font-size:13px;color:#555;font-weight:600;}" +
    ".wa-spinner{width:16px;height:16px;border:2px solid #d9d9d9;border-top-color:#e4572e;border-radius:50%;display:inline-block;animation:wa-spin .7s linear infinite;}" +
    "@keyframes wa-spin{to{transform:rotate(360deg);}}" +
    ".wa-footer{border-top:1px solid #eee;padding:10px;background:#fff;}" +
    ".wa-row{display:flex;gap:8px;}" +
    ".wa-input{flex:1;border:1px solid #ddd;border-radius:10px;padding:10px;font-size:14px;outline:none;}" +
    ".wa-btn{background:#e4572e;color:#fff;border:none;border-radius:10px;padding:10px 14px;font-size:14px;cursor:pointer;}" +
    ".wa-btn.secondary{background:#333;}" +
    ".wa-btn:disabled,.wa-chip:disabled,.wa-add:disabled{opacity:.55;cursor:default;}" +
    ".wa-quick{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;}" +
    ".wa-chip{background:#efe9e6;color:#8a3b22;border:none;border-radius:16px;padding:6px 10px;font-size:12px;cursor:pointer;}" +
    ".wa-cart-badge{background:#2e9e5b;color:#fff;border-radius:12px;padding:1px 7px;font-size:11px;margin-left:6px;}" +
    ".wa-bill table{width:100%;border-collapse:collapse;font-size:13px;}" +
    ".wa-bill td{padding:3px 0;}" +
    ".wa-bill .r{text-align:right;}" +
    ".wa-bill .tot{font-weight:700;border-top:1px solid #ccc;}" +
    ".wa-cart-card{background:#fff;border:1px solid #eee;border-radius:10px;padding:10px;}" +
    ".wa-cart-title{font-weight:700;margin-bottom:6px;color:#e4572e;}" +
    ".wa-cart-row{display:flex;flex-direction:column;padding:6px 0;border-bottom:1px solid #f0f0f0;}" +
    ".wa-cart-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;}" +
    ".wa-cart-info{flex:1;padding-right:8px;}" +
    ".wa-item-note{margin-top:6px;width:100%;box-sizing:border-box;font-size:13px;padding:7px 9px;resize:vertical;min-height:38px;line-height:1.35;font-family:inherit;}" +
    ".wa-qty{display:flex;align-items:center;gap:6px;}" +
    ".wa-qty-btn{width:26px;height:26px;border-radius:6px;border:1px solid #ddd;background:#f7f7f8;font-size:16px;line-height:1;cursor:pointer;color:#333;}" +
    ".wa-qty-n{min-width:18px;text-align:center;font-size:14px;}" +
    ".wa-remove{border:none;background:none;cursor:pointer;font-size:15px;padding:2px 4px;}" +
    ".wa-cart-sum{text-align:right;font-weight:700;margin-top:8px;}" +
    ".wa-cart-actions{display:flex;gap:8px;margin-top:10px;}" +
    ".wa-cart-actions .wa-btn{flex:1;}" +
    ".wa-pay-card{background:#fff;border:1px solid #eee;border-radius:12px;padding:14px;text-align:center;}" +
    ".wa-pay-amt{font-size:20px;font-weight:800;color:#2e9e5b;}" +
    ".wa-qr{display:flex;justify-content:center;margin:12px 0;min-height:200px;align-items:center;}" +
    ".wa-qr img,.wa-qr canvas{display:block;}" +
    ".wa-pay-link{display:inline-block;margin:6px 0;background:#2e9e5b;color:#fff;text-decoration:none;padding:10px 16px;border-radius:10px;font-size:14px;}" +
    ".wa-order-card{background:#eafaf0;border:1px solid #bfe8cf;border-radius:12px;padding:14px;text-align:center;}" +
    ".wa-order-no{font-size:22px;font-weight:800;color:#2e9e5b;margin-bottom:4px;}" +
    ".wa-status-card{background:#fff;border:1px solid #ececec;border-radius:14px;padding:14px;box-shadow:0 2px 10px rgba(0,0,0,.04);}" +
    ".wa-status-title{font-weight:700;font-size:14px;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;}" +
    ".wa-status-live{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:700;color:#2e9e5b;text-transform:uppercase;letter-spacing:.4px;}" +
    ".wa-live-dot{width:7px;height:7px;border-radius:50%;background:#2e9e5b;box-shadow:0 0 0 0 rgba(46,158,91,.5);animation:wa-pulse 1.8s infinite;}" +
    "@keyframes wa-pulse{0%{box-shadow:0 0 0 0 rgba(46,158,91,.5);}70%{box-shadow:0 0 0 6px rgba(46,158,91,0);}100%{box-shadow:0 0 0 0 rgba(46,158,91,0);}}" +
    ".wa-status-row{border-top:1px solid #f1f1f1;padding:12px 0 4px;}" +
    ".wa-status-row:first-of-type{border-top:none;padding-top:2px;}" +
    ".wa-status-head{display:flex;justify-content:space-between;align-items:center;}" +
    ".wa-status-no{font-weight:700;font-size:13px;color:#222;}" +
    ".wa-status-badge{font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;text-transform:uppercase;letter-spacing:.3px;}" +
    ".wa-st-paid{background:#eef2ff;color:#3b53c0;}" +
    ".wa-st-preparing{background:#fff5e0;color:#a5720a;}" +
    ".wa-st-served{background:#eafaf0;color:#2e9e5b;}" +
    ".wa-st-cancelled{background:#fdecec;color:#b53030;}" +
    // ---- Connected progress tracker ----
    ".wa-track{position:relative;margin:16px 4px 6px;}" +
    ".wa-track-line{position:absolute;top:11px;left:11px;right:11px;height:3px;background:#ececec;border-radius:3px;overflow:hidden;}" +
    ".wa-track-fill{height:100%;background:#2e9e5b;border-radius:3px;transition:width .45s ease;}" +
    ".wa-track-nodes{position:relative;display:flex;justify-content:space-between;}" +
    ".wa-node{display:flex;flex-direction:column;align-items:center;gap:5px;flex:1;}" +
    ".wa-node-dot{width:23px;height:23px;border-radius:50%;background:#fff;border:2px solid #dcdcdc;color:#aaa;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;transition:all .3s ease;}" +
    ".wa-node-label{font-size:10px;color:#9a9a9a;font-weight:600;transition:color .3s ease;}" +
    ".wa-node.done .wa-node-dot{background:#2e9e5b;border-color:#2e9e5b;color:#fff;}" +
    ".wa-node.done .wa-node-label{color:#2e9e5b;}" +
    ".wa-node.active .wa-node-dot{background:#fff;border-color:#2e9e5b;color:#2e9e5b;box-shadow:0 0 0 0 rgba(46,158,91,.45);animation:wa-pulse 1.8s infinite;}" +
    ".wa-node.active .wa-node-label{color:#2e9e5b;font-weight:700;}" +
    ".wa-status-cancel-note{font-size:12px;color:#b53030;margin:10px 0 2px;}" +
    ".wa-status-total{display:flex;justify-content:space-between;align-items:baseline;margin-top:10px;padding-top:9px;border-top:1px dashed #eee;}" +
    ".wa-status-total-label{font-size:11px;color:#999;text-transform:uppercase;letter-spacing:.4px;font-weight:600;}" +
    ".wa-status-total-amt{font-size:15px;font-weight:800;color:#222;}" +
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
