// admin.js — Restaurant Setup Wizard + Edit Mode
// sfetch, esc, getToken, promptToken are provided by sfetch.js


// ══════════════════════════════════════════════════
//  APP STATE
// ══════════════════════════════════════════════════
var currentStep = 1;
var ZONE_PALETTE = ["#e4572e","#2e6cf0","#2e9e5b","#f0a500","#9b59b6","#1abc9c","#e74c3c","#3498db"];
var zones = [
  { name: "Non-AC",  color: "#2e6cf0" },
  { name: "AC",      color: "#2e9e5b" },
  { name: "Outdoor", color: "#f0a500" },
  { name: "VIP",     color: "#9b59b6" }
];
var tables = []; // [{table_number, zone}]
var menuItems = []; // parsed rows
var _menuTarget = null; // prefix for menu parse target elements (null = wizard 'menu*', 'em-menu' = edit mode)

// ══════════════════════════════════════════════════
//  STEPPER NAVIGATION
// ══════════════════════════════════════════════════
function goStep(n) {
  if (n > currentStep) {
    // validate current step before advancing
    if (!validateStep(currentStep)) return;
  }
  currentStep = n;
  renderStepper();
  document.querySelectorAll('.step-panel').forEach(function(p) {
    p.classList.toggle('active', p.id === 'panel-' + n);
  });
  // refresh step-specific content
  if (n === 2) { renderZones(); renderTableGrid(); }
  if (n === 3) { /* upload area stays as-is */ }
  if (n === 5) { renderSummary(); }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderStepper() {
  var items = document.querySelectorAll('.step-item');
  items.forEach(function(item) {
    var s = parseInt(item.dataset.step);
    item.classList.toggle('active', s === currentStep);
    item.classList.toggle('done', s < currentStep);
    var circle = item.querySelector('.step-circle');
    if (s < currentStep) {
      circle.textContent = '✓';
    } else {
      circle.textContent = s;
    }
  });
}

function validateStep(n) {
  if (n === 1) {
    var slug = document.getElementById('restaurant').value.trim();
    var dname = document.getElementById('name').value.trim();
    var e = document.getElementById('err-step1');
    if (!slug) { showErr(e, 'Restaurant slug is required.'); return false; }
    if (!dname) { showErr(e, 'Display name is required.'); return false; }
    hideErr(e); return true;
  }
  if (n === 2) {
    var e2 = document.getElementById('err-step2');
    if (tables.length === 0) { showErr(e2, 'Add at least one table before continuing.'); return false; }
    hideErr(e2); return true;
  }
  if (n === 3) {
    var e3 = document.getElementById('err-step3');
    if (menuItems.length === 0) { showErr(e3, 'Upload and parse a menu file before continuing.'); return false; }
    hideErr(e3); return true;
  }
  return true;
}

function showErr(el, msg) { el.textContent = msg; el.classList.add('show'); }
function hideErr(el) { el.classList.remove('show'); el.textContent = ''; }

// ══════════════════════════════════════════════════
//  STEP 2 — ZONES
// ══════════════════════════════════════════════════
function nextZoneColor() {
  var used = zones.map(function(z) { return z.color; });
  for (var i = 0; i < ZONE_PALETTE.length; i++) {
    if (used.indexOf(ZONE_PALETTE[i]) === -1) return ZONE_PALETTE[i];
  }
  return ZONE_PALETTE[zones.length % ZONE_PALETTE.length];
}

function addZone() {
  var inp = document.getElementById('newZoneName');
  var name = inp.value.trim();
  if (!name) return;
  if (zones.find(function(z) { return z.name.toLowerCase() === name.toLowerCase(); })) {
    alert('Zone "' + name + '" already exists.');
    return;
  }
  zones.push({ name: name, color: nextZoneColor() });
  inp.value = '';
  renderZones();
  renderTableGrid();
}

function removeZone(name) {
  var usedInTables = tables.some(function(t) { return t.zone === name; });
  if (usedInTables) {
    if (!confirm('Zone "' + name + '" is used by tables. Removing it will unassign those tables. Continue?')) return;
    tables = tables.filter(function(t) { return t.zone !== name; });
  }
  zones = zones.filter(function(z) { return z.name !== name; });
  renderZones();
  renderTableGrid();
}

function openColorPicker(zoneName) {
  var z = zones.find(function(z) { return z.name === zoneName; });
  if (!z) return;
  var picker = document.getElementById('hiddenColorPicker');
  picker.value = z.color;
  picker.style.display = 'block';
  picker.style.pointerEvents = 'auto';
  picker.click();
  function onChange() {
    z.color = picker.value;
    renderZones();
    renderTableGrid();
    picker.removeEventListener('input', onChange);
    picker.removeEventListener('change', done);
  }
  function done() {
    z.color = picker.value;
    renderZones();
    renderTableGrid();
  }
  picker.addEventListener('input', onChange);
  picker.addEventListener('change', done);
}

function renderZones() {
  // Pills
  var pillsEl = document.getElementById('zonePills');
  if (zones.length === 0) {
    pillsEl.innerHTML = '<span style="color:var(--muted);font-size:13px">No zones defined. Add one above.</span>';
  } else {
    pillsEl.innerHTML = zones.map(function(z) {
      return '<span class="zone-pill" style="background:' + z.color + '">' +
        '<span class="swatch" style="background:' + z.color + ';filter:brightness(1.3)" onclick="openColorPicker(\'' + esc(z.name) + '\')" title="Change colour"></span>' +
        '<span>' + esc(z.name) + '</span>' +
        '<button class="remove-zone" onclick="removeZone(\'' + esc(z.name) + '\')" title="Remove zone">✕</button>' +
      '</span>';
    }).join('');
  }

  // Populate zone dropdowns
  var zoneOpts = zones.map(function(z) {
    return '<option value="' + esc(z.name) + '">' + esc(z.name) + '</option>';
  }).join('');
  ['singleZone','bulkZone'].forEach(function(id) {
    document.getElementById(id).innerHTML = zoneOpts ||
      '<option value="">— No zones —</option>';
  });

  // Legend
  var legendEl = document.getElementById('zoneLegend');
  legendEl.innerHTML = zones.map(function(z) {
    return '<span class="legend-item">' +
      '<span class="legend-swatch" style="background:' + z.color + '"></span>' +
      esc(z.name) +
    '</span>';
  }).join('');
}

// ══════════════════════════════════════════════════
//  STEP 2 — TABLES
// ══════════════════════════════════════════════════
function tableExists(name) {
  return tables.some(function(t) { return t.table_number === name; });
}

function addSingleTable() {
  var name = document.getElementById('singleName').value.trim();
  var zone = document.getElementById('singleZone').value;
  var errEl = document.getElementById('errSingle');
  if (!name) { showErr(errEl, 'Enter a table name.'); return; }
  if (!zone) { showErr(errEl, 'Select a zone.'); return; }
  if (tableExists(name)) { showErr(errEl, 'Table "' + name + '" already exists.'); return; }
  hideErr(errEl);
  tables.push({ table_number: name, zone: zone });
  document.getElementById('singleName').value = '';
  renderTableGrid();
}

function bulkAddTables() {
  var prefix = document.getElementById('bulkPrefix').value;
  var count  = parseInt(document.getElementById('bulkCount').value) || 0;
  var start  = parseInt(document.getElementById('bulkStart').value) || 1;
  var zone   = document.getElementById('bulkZone').value;
  var errEl  = document.getElementById('errBulk');
  if (!zone) { showErr(errEl, 'Select a zone.'); return; }
  if (count < 1) { showErr(errEl, 'Count must be at least 1.'); return; }
  hideErr(errEl);
  var added = 0, dupes = [];
  for (var i = 0; i < count; i++) {
    var tname = prefix + (start + i);
    if (tableExists(tname)) { dupes.push(tname); continue; }
    tables.push({ table_number: tname, zone: zone });
    added++;
  }
  if (dupes.length) showErr(errEl, 'Skipped duplicates: ' + dupes.join(', '));
  renderTableGrid();
}

function deleteTable(name) {
  tables = tables.filter(function(t) { return t.table_number !== name; });
  renderTableGrid();
}

var openPopoverFor = null; // table_number or null

function renderTableGrid() {
  var grid = document.getElementById('tableGrid');
  document.getElementById('tableCount').textContent =
    tables.length ? '(' + tables.length + ' tables)' : '';

  if (tables.length === 0) {
    grid.innerHTML = '<p style="color:var(--muted);font-size:13px;grid-column:1/-1">No tables added yet.</p>';
    return;
  }

  grid.innerHTML = tables.map(function(t) {
    var z = zones.find(function(z) { return z.name === t.zone; });
    var bg = z ? z.color : '#aaa';
    return '<div class="table-tile" style="background:' + bg + '" ' +
      'onclick="openTilePopover(\'' + esc(t.table_number) + '\', event)" ' +
      'id="tile-' + esc(t.table_number) + '">' +
      '<button class="tile-del" onclick="event.stopPropagation();deleteTable(\'' + esc(t.table_number) + '\')">✕</button>' +
      '<span class="tile-name">' + esc(t.table_number) + '</span>' +
      '<span class="tile-zone">' + esc(t.zone) + '</span>' +
    '</div>';
  }).join('');

  renderZoneLegend();
}

function renderZoneLegend() {
  var legendEl = document.getElementById('zoneLegend');
  legendEl.innerHTML = zones.map(function(z) {
    var cnt = tables.filter(function(t) { return t.zone === z.name; }).length;
    return '<span class="legend-item">' +
      '<span class="legend-swatch" style="background:' + z.color + '"></span>' +
      esc(z.name) + ' (' + cnt + ')' +
    '</span>';
  }).join('');
}

function openTilePopover(tableName, evt) {
  // Remove any existing popover
  var existing = document.getElementById('tilePopover');
  if (existing) existing.remove();
  if (openPopoverFor === tableName) { openPopoverFor = null; return; }
  openPopoverFor = tableName;

  var t = tables.find(function(t) { return t.table_number === tableName; });
  if (!t) return;

  var zoneOpts = zones.map(function(z) {
    return '<option value="' + esc(z.name) + '"' + (z.name === t.zone ? ' selected' : '') + '>' + esc(z.name) + '</option>';
  }).join('');

  var pop = document.createElement('div');
  pop.className = 'tile-popover';
  pop.id = 'tilePopover';
  pop.innerHTML =
    '<label>Table name</label>' +
    '<input id="popName" type="text" value="' + esc(tableName) + '" style="margin-bottom:8px" />' +
    '<label>Zone</label>' +
    '<select id="popZone">' + zoneOpts + '</select>' +
    '<div class="pop-row">' +
      '<button class="btn btn-primary btn-sm" onclick="saveTileEdit(\'' + esc(tableName) + '\')">Save</button>' +
      '<button class="btn btn-outline btn-sm" onclick="closeTilePopover()">Cancel</button>' +
    '</div>';

  // Position near tile
  var tile = document.getElementById('tile-' + tableName);
  if (tile) {
    tile.style.position = 'relative';
    tile.appendChild(pop);
  }

  evt.stopPropagation();
}

function saveTileEdit(oldName) {
  var newName = document.getElementById('popName').value.trim();
  var newZone = document.getElementById('popZone').value;
  if (!newName) { alert('Table name cannot be empty.'); return; }
  if (newName !== oldName && tableExists(newName)) {
    alert('Table "' + newName + '" already exists.'); return;
  }
  var t = tables.find(function(t) { return t.table_number === oldName; });
  if (t) { t.table_number = newName; t.zone = newZone; }
  closeTilePopover();
  renderTableGrid();
}

function closeTilePopover() {
  var p = document.getElementById('tilePopover');
  if (p) p.remove();
  openPopoverFor = null;
}

document.addEventListener('click', function(e) {
  var pop = document.getElementById('tilePopover');
  if (pop && !pop.contains(e.target)) closeTilePopover();
});

// ══════════════════════════════════════════════════
//  STEP 3 — MENU UPLOAD
// ══════════════════════════════════════════════════
// Drag & drop
(function() {
  var area = document.getElementById('uploadArea');
  area.addEventListener('dragover', function(e) { e.preventDefault(); area.classList.add('drag-over'); });
  area.addEventListener('dragleave', function() { area.classList.remove('drag-over'); });
  area.addEventListener('drop', function(e) {
    e.preventDefault();
    area.classList.remove('drag-over');
    var file = e.dataTransfer.files[0];
    if (file) { _menuTarget = null; handleMenuFile(file); }
  });
})();

document.getElementById('menuFile').addEventListener('change', function() {
  _menuTarget = null; // wizard mode
  if (this.files[0]) handleMenuFile(this.files[0]);
});

function clearMenu() {
  menuItems = [];
  document.getElementById('menuFile').value = '';
  document.getElementById('menuPreviewWrap').style.display = 'none';
  document.getElementById('menuStatus').textContent = '';
  document.getElementById('menuStatus').className = 'status';
}

function handleMenuFile(file) {
  var isXlsx = /\.xlsx$/i.test(file.name);
  var isCsv  = /\.csv$/i.test(file.name);
  var statusEl = _menuTarget ? document.getElementById(_menuTarget + 'Status') : document.getElementById('menuStatus');
  statusEl.className = 'status';
  statusEl.textContent = 'Parsing file…';

  if (isXlsx) {
    if (typeof XLSX === 'undefined') {
      var script = document.createElement('script');
      script.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
      script.onload = function() { parseXlsx(file); };
      script.onerror = function() {
        statusEl.className = 'status err';
        statusEl.textContent = 'Failed to load SheetJS. Check your internet connection.';
      };
      document.head.appendChild(script);
    } else {
      parseXlsx(file);
    }
  } else if (isCsv) {
    var reader = new FileReader();
    reader.onload = function(e) { parseCsvText(e.target.result); };
    reader.readAsText(file);
  } else {
    statusEl.className = 'status err';
    statusEl.textContent = 'Unsupported file type. Please upload a .csv or .xlsx file.';
  }
}

function parseXlsx(file) {
  var reader = new FileReader();
  reader.onload = function(e) {
    try {
      var wb = XLSX.read(e.target.result, { type: 'array' });
      var ws = wb.Sheets[wb.SheetNames[0]];
      var csv = XLSX.utils.sheet_to_csv(ws);
      parseCsvText(csv);
    } catch(ex) {
      var statusEl = _menuTarget ? document.getElementById(_menuTarget + 'Status') : document.getElementById('menuStatus');
      statusEl.className = 'status err';
      statusEl.textContent = 'Failed to parse Excel: ' + ex.message;
    }
  };
  reader.readAsArrayBuffer(file);
}

// Robust CSV parser: handles quoted fields, quoted newlines, quoted commas
function parseCSV(text) {
  var rows = [];
  var row = [];
  var field = '';
  var inQuotes = false;
  var i = 0;
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  while (i < text.length) {
    var c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i+1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
      i++; continue;
    }
    field += c; i++;
  }
  row.push(field);
  if (row.some(function(f) { return f !== ''; })) rows.push(row);
  return rows;
}

function parseCsvText(text) {
  var statusEl = _menuTarget ? document.getElementById(_menuTarget + 'Status') : document.getElementById('menuStatus');
  try {
    var rawRows = parseCSV(text);
    if (rawRows.length < 2) {
      statusEl.className = 'status warn';
      statusEl.textContent = 'File appears empty or has only a header row.';
      return;
    }

    // Find header row (skip # comment rows)
    var headerIdx = -1;
    for (var i = 0; i < rawRows.length; i++) {
      var first = (rawRows[i][0] || '').trim();
      if (first && first[0] !== '#') { headerIdx = i; break; }
    }
    if (headerIdx < 0) {
      statusEl.className = 'status err';
      statusEl.textContent = 'Could not find a header row.';
      return;
    }

    var headers = rawRows[headerIdx].map(function(h) { return h.trim().toLowerCase(); });
    var dataRows = rawRows.slice(headerIdx + 1).filter(function(row) {
      var first = (row[0] || '').trim();
      return first && first[0] !== '#';
    });

    // Warn about missing required columns
    var required = ['category','name','price'];
    var missing = required.filter(function(c) { return headers.indexOf(c) === -1; });
    if (missing.length) {
      statusEl.className = 'status warn';
      statusEl.textContent = '⚠ Missing columns: ' + missing.join(', ') + '. Some data may not import correctly.';
    } else {
      statusEl.className = 'status ok';
      statusEl.textContent = '';
    }

    // Parse rows into objects
    var items = [];
    dataRows.forEach(function(row) {
      if (row.length < headers.length && row.every(function(c) { return !c.trim(); })) return;
      var obj = {};
      headers.forEach(function(h, idx) {
        obj[h] = (row[idx] || '').trim();
      });

      var category = obj['category'] || '';
      var name     = obj['name'] || '';
      var price    = parseFloat(obj['price']) || 0;
      if (!category || !name) return;

      var item = {
        _category: category,
        name: name,
        description: obj['description'] || null,
        weight_gms: obj['weight_gms'] ? (parseFloat(obj['weight_gms']) || null) : null,
        calories_kcal: obj['calories_kcal'] ? (parseFloat(obj['calories_kcal']) || null) : null,
        price: price,
        zone_prices: {},
        available: true,
        variants: []
      };

      // available
      var avRaw = (obj['available'] || '').toLowerCase();
      item.available = avRaw === '' || avRaw === 'true' || avRaw === '1' || avRaw === 'yes';

      // zone prices
      zones.forEach(function(z) {
        var key = 'zone_' + z.name.toLowerCase().replace(/\s+/g,'_');
        // also try exact zone name as key
        var key2 = 'zone_' + z.name.toLowerCase();
        var raw = obj[key] || obj[key2] || '';
        item.zone_prices[z.name] = raw ? (parseFloat(raw) || price) : price;
      });

      // variants
      var varStr = obj['variants'] || '';
      if (varStr) {
        try { item.variants = JSON.parse(varStr); }
        catch(e) { item.variants = []; }
      }

      if (!item.description) item.description = null;
      if (item.variants && item.variants.length === 0) delete item.variants;

      items.push(item);
    });

    menuItems = items;
    renderMenuPreview(headers, dataRows);

    var msg = '✓ Parsed ' + items.length + ' menu items.';
    if (statusEl.className.indexOf('warn') === -1) {
      statusEl.className = 'status ok';
      statusEl.textContent = msg;
    } else {
      statusEl.textContent += '  ' + msg;
    }
  } catch(ex) {
    statusEl.className = 'status err';
    statusEl.textContent = 'Parse error: ' + ex.message;
  }
}

function renderMenuPreview(headers, dataRows) {
  var wrap  = _menuTarget ? document.getElementById(_menuTarget + 'PreviewWrap')  : document.getElementById('menuPreviewWrap');
  var label = _menuTarget ? document.getElementById(_menuTarget + 'PreviewLabel') : document.getElementById('menuPreviewLabel');
  var tbl   = _menuTarget ? document.getElementById(_menuTarget + 'PreviewTable') : document.getElementById('menuPreviewTable');
  wrap.style.display = 'block';

  var previewRows = dataRows.slice(0, 10);
  label.textContent = 'Preview (first ' + previewRows.length + ' of ' + dataRows.length + ' rows)';

  var thead = '<thead><tr>' +
    headers.map(function(h) { return '<th>' + esc(h) + '</th>'; }).join('') +
  '</tr></thead>';

  var tbody = '<tbody>' +
    previewRows.map(function(row) {
      return '<tr>' + headers.map(function(h, i) {
        return '<td title="' + esc(row[i] || '') + '">' + esc((row[i] || '').substring(0,30)) + '</td>';
      }).join('') + '</tr>';
    }).join('') +
  '</tbody>';

  tbl.innerHTML = thead + tbody;
}

// ── CSV Template Download ──
function downloadCsvTemplate() {
  var zoneCols = zones.map(function(z) { return 'zone_' + z.name; });
  var headers = ['category','name','description','weight_gms','calories_kcal','price']
    .concat(zoneCols).concat(['available','variants']);

  // ── Sample data: all categories and items from the reference menu ──
  var sampleData = [
    // All Day Breakfast
    {cat:'All Day Breakfast',name:'Thatte Idli',desc:'Sambhar, gun powder, coconut chutney',wt:391,cal:385.57,price:1200,zones:{'Non-AC':1200,'AC':1320,'Outdoor':1260,'VIP':1500},avail:true,variants:''},
    {cat:'All Day Breakfast',name:'Bedmi Puri Raseele Aloo',desc:'Lentil stuffed fried bread, potato curry, fennel chutney',wt:487,cal:952.57,price:1200,zones:{'Non-AC':1200,'AC':1320,'Outdoor':1260,'VIP':1500},avail:true,variants:''},
    {cat:'All Day Breakfast',name:'Aloo Paratha',desc:'White butter, set curd, panchranga pickle',wt:336,cal:626.3,price:1250,zones:{'Non-AC':1250,'AC':1380,'Outdoor':1310,'VIP':1560},avail:true,variants:''},
    {cat:'All Day Breakfast',name:'Mascarpone Pancakes',desc:'Mascarpone whipped cream, maple syrup',wt:306,cal:585.07,price:1250,zones:{'Non-AC':1250,'AC':1380,'Outdoor':1310,'VIP':1560},avail:true,variants:''},
    {cat:'All Day Breakfast',name:'Bean Sprout & Roasted Beetroot Poha',desc:'Beaten rice, Sriracha peanuts, spices',wt:344,cal:850.71,price:1400,zones:{'Non-AC':1400,'AC':1540,'Outdoor':1470,'VIP':1750},avail:true,variants:''},
    {cat:'All Day Breakfast',name:'Accompaniments',desc:'Crispy bacon, sausages, hash brown, mushroom',wt:'',cal:'',price:850,zones:{'Non-AC':850,'AC':940,'Outdoor':890,'VIP':1060},avail:true,variants:''},
    {cat:'All Day Breakfast',name:'Eggs to Order',desc:'Organic or local chicken eggs',wt:'',cal:'',price:1100,zones:{'Non-AC':1100,'AC':1210,'Outdoor':1160,'VIP':1380},avail:true,variants:'[{"label":"Organic","weight_gms":217,"calories_kcal":429.1},{"label":"Local","weight_gms":101,"calories_kcal":297.95}]'},
    {cat:'All Day Breakfast',name:'Mediterranean Omelette',desc:'Feta, olives, tomatoes, spinach',wt:275,cal:441.1,price:1100,zones:{'Non-AC':1100,'AC':1210,'Outdoor':1160,'VIP':1380},avail:true,variants:''},
    {cat:'All Day Breakfast',name:'Shamiana Bread Omelette',desc:'Bread, cheese, mint chutney, ketchup, potato chips',wt:310,cal:520.49,price:1100,zones:{'Non-AC':1100,'AC':1210,'Outdoor':1160,'VIP':1380},avail:true,variants:''},
    {cat:'All Day Breakfast',name:'Brûlée French Toast',desc:'Maple syrup, powdered sugar',wt:180,cal:515.52,price:1600,zones:{'Non-AC':1600,'AC':1760,'Outdoor':1680,'VIP':2000},avail:true,variants:''},
    // Sharing Plates & Starters
    {cat:'Sharing Plates & Starters',name:'Vietnamese Pho',desc:'Vegetable broth, rice noodle, lime, sprouts, scallion, chilli, hoisin',wt:355,cal:342.15,price:1000,zones:{'Non-AC':1000,'AC':1100,'Outdoor':1050,'VIP':1250},avail:true,variants:''},
    {cat:'Sharing Plates & Starters',name:'Jimikand aur Shinghade Ke Kebab',desc:'Spiced yam, water chestnut, walnut chutney',wt:263,cal:296.4,price:1100,zones:{'Non-AC':1100,'AC':1210,'Outdoor':1160,'VIP':1380},avail:true,variants:''},
    {cat:'Sharing Plates & Starters',name:'Jaitooni Pudina Paneer Tikka',desc:'Pepitas, raisin chaat, tomato chutney',wt:353,cal:517.15,price:1100,zones:{'Non-AC':1100,'AC':1210,'Outdoor':1160,'VIP':1380},avail:true,variants:''},
    {cat:'Sharing Plates & Starters',name:'Spanish Socca',desc:'Chickpea, caramelized onion, olives, jalapeno, sour cream',wt:284,cal:701.39,price:1200,zones:{'Non-AC':1200,'AC':1320,'Outdoor':1260,'VIP':1500},avail:true,variants:''},
    {cat:'Sharing Plates & Starters',name:'Buddha Bowl',desc:'Quinoa, chickpeas, edamame, hummus, chipotle aioli',wt:308,cal:516.21,price:1400,zones:{'Non-AC':1400,'AC':1540,'Outdoor':1470,'VIP':1750},avail:true,variants:''},
    {cat:'Sharing Plates & Starters',name:"Memsahib's Chicken Broth",desc:'Poee bread',wt:316,cal:531.83,price:1000,zones:{'Non-AC':1000,'AC':1100,'Outdoor':1050,'VIP':1250},avail:true,variants:''},
    {cat:'Sharing Plates & Starters',name:'Tortilla Four Ways',desc:'Refried beans, cucumber, guacamole, jalapeno potatoes',wt:433,cal:'',price:1200,zones:{'Non-AC':1200,'AC':1320,'Outdoor':1260,'VIP':1500},avail:true,variants:'[{"label":"Vegetarian","calories_kcal":647.34,"price":1200},{"label":"With chicken sausages","calories_kcal":823.33,"price":1400}]'},
    {cat:'Sharing Plates & Starters',name:'Paneer/Chicken Wrap',desc:'Green apple relish',wt:'',cal:'',price:1350,zones:{'Non-AC':1350,'AC':1490,'Outdoor':1420,'VIP':1690},avail:true,variants:'[{"label":"Paneer","weight_gms":417,"calories_kcal":824.16},{"label":"Chicken","weight_gms":487,"calories_kcal":1031.42}]'},
    {cat:'Sharing Plates & Starters',name:'Chicken Kare Pan',desc:'Curried chicken bun, pickled vegetables, tonkatsu sauce',wt:405,cal:1890.58,price:1350,zones:{'Non-AC':1350,'AC':1490,'Outdoor':1420,'VIP':1690},avail:true,variants:''},
    {cat:'Sharing Plates & Starters',name:'Ajwaini Chicken Tikka',desc:'Smoked fruit chaat, mint chutney',wt:307,cal:265.95,price:1350,zones:{'Non-AC':1350,'AC':1490,'Outdoor':1420,'VIP':1690},avail:true,variants:''},
    {cat:'Sharing Plates & Starters',name:'Bohri Samosa',desc:'Smoked mutton mince, mint chutney',wt:192,cal:409.34,price:1750,zones:{'Non-AC':1750,'AC':1930,'Outdoor':1840,'VIP':2190},avail:true,variants:''},
    {cat:'Sharing Plates & Starters',name:'Kasundi Salmon Tikka',desc:'Quinoa sprouts salad, cashew curry leaf chutney',wt:346,cal:455.68,price:1950,zones:{'Non-AC':1950,'AC':2140,'Outdoor':2050,'VIP':2440},avail:true,variants:''},
    // Parsi Specials
    {cat:'Parsi Specials',name:'Masala ni Dar',desc:'Parsi style masala dal',wt:342,cal:519.5,price:1150,zones:{'Non-AC':1150,'AC':1260,'Outdoor':1210,'VIP':1440},avail:true,variants:''},
    {cat:'Parsi Specials',name:'Patra ma Paneer',desc:'Steamed cottage cheese in banana leaves',wt:367,cal:736.63,price:1350,zones:{'Non-AC':1350,'AC':1490,'Outdoor':1420,'VIP':1690},avail:true,variants:''},
    {cat:'Parsi Specials',name:'Lagansara Vegetable Stew',desc:'Sweet, sour, dry vegetable stew',wt:328,cal:596.63,price:1350,zones:{'Non-AC':1350,'AC':1490,'Outdoor':1420,'VIP':1690},avail:true,variants:''},
    {cat:'Parsi Specials',name:'Jardaloo Salli Boti',desc:'Lamb in sweet-sour gravy, straw potatoes',wt:388,cal:465.21,price:2250,zones:{'Non-AC':2250,'AC':2480,'Outdoor':2360,'VIP':2810},avail:true,variants:''},
    {cat:'Parsi Specials',name:'Patra Ni Machi',desc:'Steamed pomfret in banana leaves',wt:335,cal:824.64,price:2650,zones:{'Non-AC':2650,'AC':2920,'Outdoor':2780,'VIP':3310},avail:true,variants:''},
    {cat:'Parsi Specials',name:'Parsi Pulao with Lamb Kebab',desc:'',wt:670,cal:1028.25,price:2950,zones:{'Non-AC':2950,'AC':3250,'Outdoor':3100,'VIP':3690},avail:true,variants:''},
    // Nostalgic Shamiana
    {cat:'Nostalgic Shamiana',name:'Pav Bhaji',desc:'Spicy mashed potato & vegetables, buttered pav',wt:387,cal:391.33,price:1050,zones:{'Non-AC':1050,'AC':1160,'Outdoor':1100,'VIP':1310},avail:true,variants:''},
    {cat:'Nostalgic Shamiana',name:'Ragda Pattice',desc:'Potato pattice, dried peas stew',wt:370,cal:738.78,price:1150,zones:{'Non-AC':1150,'AC':1260,'Outdoor':1210,'VIP':1440},avail:true,variants:''},
    {cat:'Nostalgic Shamiana',name:'Asparagus Roesti',desc:'Potato roesti, creamed asparagus, Gruyere',wt:304,cal:646.61,price:1350,zones:{'Non-AC':1350,'AC':1490,'Outdoor':1420,'VIP':1690},avail:true,variants:''},
    {cat:'Nostalgic Shamiana',name:'Chicken Tikka Sandwich',desc:'',wt:374,cal:1857.55,price:1350,zones:{'Non-AC':1350,'AC':1490,'Outdoor':1420,'VIP':1690},avail:true,variants:''},
    {cat:'Nostalgic Shamiana',name:'Kheema Mutter',desc:'Minced lamb, peas, buttered pav',wt:369,cal:1820.17,price:1550,zones:{'Non-AC':1550,'AC':1710,'Outdoor':1630,'VIP':1940},avail:true,variants:''},
    {cat:'Nostalgic Shamiana',name:'Goan Pomfret Curry',desc:'Coconut curry, basmati rice',wt:688,cal:771.52,price:2400,zones:{'Non-AC':2400,'AC':2640,'Outdoor':2520,'VIP':3000},avail:true,variants:''},
    // Comfort Mains
    {cat:'Comfort Mains',name:'Chonka Mutter Palak',desc:'Spinach, peas',wt:612,cal:852.52,price:1250,zones:{'Non-AC':1250,'AC':1380,'Outdoor':1310,'VIP':1560},avail:true,variants:''},
    {cat:'Comfort Mains',name:'Paneer Butter Masala',desc:'Cottage cheese in tomato gravy',wt:632,cal:650.33,price:1250,zones:{'Non-AC':1250,'AC':1380,'Outdoor':1310,'VIP':1560},avail:true,variants:''},
    {cat:'Comfort Mains',name:'Malai Kofta',desc:'Milk dumpling, saffron gravy',wt:653,cal:1244.42,price:1250,zones:{'Non-AC':1250,'AC':1380,'Outdoor':1310,'VIP':1560},avail:true,variants:''},
    {cat:'Comfort Mains',name:'Rajma Chawal',desc:'Kidney beans stew, rice',wt:688,cal:663.37,price:1250,zones:{'Non-AC':1250,'AC':1380,'Outdoor':1310,'VIP':1560},avail:true,variants:''},
    {cat:'Comfort Mains',name:'Bombay Tawa Pulao',desc:'Spicy rice, vegetables, raita',wt:566,cal:598.26,price:1250,zones:{'Non-AC':1250,'AC':1380,'Outdoor':1310,'VIP':1560},avail:true,variants:''},
    {cat:'Comfort Mains',name:'Millet Khichdi',desc:'Mung bean, pearl millet, curd',wt:457,cal:1709.18,price:1350,zones:{'Non-AC':1350,'AC':1490,'Outdoor':1420,'VIP':1690},avail:true,variants:''},
    {cat:'Comfort Mains',name:'Chole Kulche',desc:'Chickpeas, leavened bread',wt:610,cal:1284.29,price:1350,zones:{'Non-AC':1350,'AC':1490,'Outdoor':1420,'VIP':1690},avail:true,variants:''},
    {cat:'Comfort Mains',name:'Pakode wali Kadhi',desc:'Rice, papad chura',wt:568,cal:1016.72,price:1350,zones:{'Non-AC':1350,'AC':1490,'Outdoor':1420,'VIP':1690},avail:true,variants:''},
    {cat:'Comfort Mains',name:'Risotto Amarillo',desc:'Rice, chilli, corn, arugula, cheese',wt:371,cal:517.17,price:1350,zones:{'Non-AC':1350,'AC':1490,'Outdoor':1420,'VIP':1690},avail:true,variants:''},
    {cat:'Comfort Mains',name:'Mac n Cheese',desc:'Double cheese sauce, baked',wt:247,cal:408.54,price:1350,zones:{'Non-AC':1350,'AC':1490,'Outdoor':1420,'VIP':1690},avail:true,variants:''},
    {cat:'Comfort Mains',name:'Orecchiette',desc:'Pasta, celeriac cream, basil oil',wt:321,cal:1288.43,price:1650,zones:{'Non-AC':1650,'AC':1820,'Outdoor':1730,'VIP':2060},avail:true,variants:''},
    {cat:'Comfort Mains',name:'Yellow Thai Curry',desc:'',wt:'',cal:'',price:1350,zones:{'Non-AC':1350,'AC':1490,'Outdoor':1420,'VIP':1690},avail:true,variants:'[{"label":"Vegetables","weight_gms":624,"calories_kcal":793.45},{"label":"Chicken","weight_gms":757,"calories_kcal":950.64}]'},
    {cat:'Comfort Mains',name:'Slow Roast Chicken',desc:'Root vegetables, mushrooms, rosemary jus',wt:363,cal:630.31,price:1550,zones:{'Non-AC':1550,'AC':1710,'Outdoor':1630,'VIP':1940},avail:true,variants:''},
    {cat:'Comfort Mains',name:'Murgh Makhanwala',desc:'Chicken in tomato cashew gravy',wt:513,cal:779.25,price:1650,zones:{'Non-AC':1650,'AC':1820,'Outdoor':1730,'VIP':2060},avail:true,variants:''},
    {cat:'Comfort Mains',name:'Qalia Mutton',desc:'Lamb curry, naan',wt:691,cal:771.85,price:1750,zones:{'Non-AC':1750,'AC':1930,'Outdoor':1840,'VIP':2190},avail:true,variants:''},
    {cat:'Comfort Mains',name:'Gosht Pulao',desc:'Mutton pulao, raita',wt:660,cal:1062.14,price:1750,zones:{'Non-AC':1750,'AC':1930,'Outdoor':1840,'VIP':2190},avail:true,variants:''},
    {cat:'Comfort Mains',name:'Cajun Fish n Chips',desc:'Cornmeal batter, fries, aioli',wt:365,cal:381.39,price:1750,zones:{'Non-AC':1750,'AC':1930,'Outdoor':1840,'VIP':2190},avail:true,variants:''},
    {cat:'Comfort Mains',name:'Pollo Guisado',desc:'Puerto Rican chicken, parsnip stew',wt:236,cal:246.86,price:1850,zones:{'Non-AC':1850,'AC':2040,'Outdoor':1940,'VIP':2310},avail:true,variants:''},
    {cat:'Comfort Mains',name:'Lumachine',desc:'Pasta, lamb ragout, parmesan',wt:339,cal:1190.91,price:1950,zones:{'Non-AC':1950,'AC':2140,'Outdoor':2050,'VIP':2440},avail:true,variants:''},
    {cat:'Comfort Mains',name:'Duck Adobo',desc:'Chilli peppers, jasmine rice, pakchoy',wt:285,cal:422.37,price:2800,zones:{'Non-AC':2800,'AC':3080,'Outdoor':2940,'VIP':3500},avail:false,variants:''},
    // International Grills
    {cat:'International Grills',name:'Yaki Onigiri with Grilled Tofu & Pineapple',desc:'Smoked paprika, miso butter',wt:374,cal:607.64,price:1250,zones:{'Non-AC':1250,'AC':1380,'Outdoor':1310,'VIP':1560},avail:true,variants:''},
    {cat:'International Grills',name:'Grilled Vegetable Skillet',desc:'Sweet potatoes, corn, eggplant, fondue sauce',wt:307,cal:148.56,price:1750,zones:{'Non-AC':1750,'AC':1930,'Outdoor':1840,'VIP':2190},avail:true,variants:''},
    {cat:'International Grills',name:'Herb & Lime Rubbed Salmon',desc:'Tomato salad, pickle',wt:202,cal:496.27,price:2950,zones:{'Non-AC':2950,'AC':3250,'Outdoor':3100,'VIP':3690},avail:true,variants:''},
    {cat:'International Grills',name:'Lamb Chops',desc:'Green beans, saffron potato salad',wt:349,cal:1087.83,price:2950,zones:{'Non-AC':2950,'AC':3250,'Outdoor':3100,'VIP':3690},avail:true,variants:''},
    {cat:'International Grills',name:'Pork Belly',desc:'Green beans, saffron potato salad',wt:354,cal:1058.21,price:2600,zones:{'Non-AC':2600,'AC':2860,'Outdoor':2730,'VIP':3250},avail:true,variants:''},
    // Desserts
    {cat:'Desserts',name:'Brownie Sundae',desc:'Waffle cup, butterscotch ice cream, hot chocolate brownie, almond brittle',wt:262,cal:818.1,price:1350,zones:{'Non-AC':1350,'AC':1490,'Outdoor':1420,'VIP':1690},avail:true,variants:''},
    {cat:'Desserts',name:'Basque Cheese Cake',desc:'Spanish cheesecake, cherry compote, vanilla Chantilly cream',wt:149,cal:462.97,price:1350,zones:{'Non-AC':1350,'AC':1490,'Outdoor':1420,'VIP':1690},avail:true,variants:''},
    {cat:'Desserts',name:'Tiramisu',desc:'Kahlua-soaked ladyfinger biscuit, mascarpone cheese',wt:225,cal:745.72,price:1350,zones:{'Non-AC':1350,'AC':1490,'Outdoor':1420,'VIP':1690},avail:true,variants:''},
    {cat:'Desserts',name:'Rasmalai',desc:'Poached cottage cheese dumplings in saffron milk, pistachio slivers',wt:172,cal:224.34,price:1000,zones:{'Non-AC':1000,'AC':1100,'Outdoor':1050,'VIP':1250},avail:true,variants:''},
    {cat:'Desserts',name:'Apple Crumble with Vanilla Ice Cream',desc:'',wt:200,cal:367.88,price:1100,zones:{'Non-AC':1100,'AC':1210,'Outdoor':1160,'VIP':1380},avail:true,variants:''},
    {cat:'Desserts',name:'Spiced Carrot Cake',desc:'Carrot cake, mascarpone frosting, carrot-orange jelly, pineapple compote',wt:141,cal:417.23,price:1350,zones:{'Non-AC':1350,'AC':1490,'Outdoor':1420,'VIP':1690},avail:true,variants:''},
    {cat:'Desserts',name:'Baked Almond Cake',desc:'Vanilla ice cream, toffee almond crumble, almond milk sauce',wt:124,cal:471.45,price:1350,zones:{'Non-AC':1350,'AC':1490,'Outdoor':1420,'VIP':1690},avail:true,variants:''},
    {cat:'Desserts',name:'Vegan Hazelnut Chocolate Cake',desc:'Vegan biscuit, hazelnut dark chocolate mousse',wt:174,cal:792.95,price:1000,zones:{'Non-AC':1000,'AC':1100,'Outdoor':1050,'VIP':1250},avail:true,variants:''}
  ];

  var csvLines = [headers.map(csvQ).join(',')];

  sampleData.forEach(function(item) {
    var row = [
      item.cat,
      item.name,
      item.desc,
      item.wt === '' ? '' : item.wt,
      item.cal === '' ? '' : item.cal,
      item.price
    ];
    // For each defined zone, use its price if available, else blank
    zoneCols.forEach(function(zc) {
      var zName = zc.replace('zone_', '');
      row.push(item.zones[zName] !== undefined ? item.zones[zName] : '');
    });
    row.push(item.avail ? 'true' : 'false');
    row.push(item.variants || '');
    csvLines.push(row.map(csvQ).join(','));
  });

  var blob = new Blob([csvLines.join('\n')], { type: 'text/csv' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'menu_template.csv';
  a.click();
}

function csvQ(s) {
  s = String(s);
  if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ══════════════════════════════════════════════════
//  STEP 4 — PAYMENT (copied & adapted from original)
// ══════════════════════════════════════════════════
document.getElementById('saveMode').addEventListener('click', function() {
  var restaurant = document.getElementById('restaurant').value.trim() || 'demo';
  var btn = document.getElementById('saveMode');
  var statusEl = document.getElementById('modeStatus');
  statusEl.textContent = '';
  btnLoad(btn, ' Saving…');
  sfetch('/pay/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      restaurant: restaurant,
      payment_mode: document.getElementById('paymentMode').value
    })
  })
    .then(function(r) {
      return r.json().then(function(d) {
        if (!r.ok) throw new Error(d.detail || 'save failed');
        return d;
      });
    })
    .then(function(d) {
      statusEl.className = 'status ok';
      statusEl.textContent = '✓ Payment mode saved: ' + d.payment_mode;
    })
    .catch(function(e) {
      statusEl.className = 'status err';
      statusEl.textContent = 'Couldn\'t save payment mode: ' + e.message;
    })
    .finally(function() { btnDone(btn); });
});

// ══════════════════════════════════════════════════
//  UNIFIED PREFILL — fires whenever the slug changes
//  Loads: display name, tables, zones, menu items,
//         UPI, payment mode — all in parallel.
// ══════════════════════════════════════════════════
var _prefillTimer = null;

// ── Loader helpers ──────────────────────────────────
function btnLoad(btn, label) {
  btn._origHtml = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span>' + label;
  btn.classList.add('loading');
  btn.disabled = true;
}
function btnDone(btn) {
  btn.innerHTML = btn._origHtml || btn.innerHTML;
  btn.classList.remove('loading');
  btn.disabled = false;
}
function showTableSkeletons() {
  var grid = document.getElementById('tableGrid');
  var html = '';
  for (var i = 0; i < 8; i++) {
    html += '<div class="skeleton skeleton-tile"></div>';
  }
  grid.innerHTML = html;
  document.getElementById('tableLoadingSpinner').style.display = 'inline-block';
}
function hideTableSkeletons() {
  document.getElementById('tableLoadingSpinner').style.display = 'none';
}

function loadRestaurantData() {
  var restaurant = document.getElementById('restaurant').value.trim();
  if (!restaurant) restaurant = 'demo';
  var enc = encodeURIComponent(restaurant);

  var banner    = document.getElementById('prefillBanner');
  var loading   = document.getElementById('prefillLoading');
  var mBanner   = document.getElementById('menuPrefillBanner');
  var mCount    = document.getElementById('menuPrefillCount');
  var mSkel     = document.getElementById('menuLoadingSkeleton');
  var payBar    = document.getElementById('paymentLoadingBar');
  var slugInput = document.getElementById('restaurant');

  // Reset UI state
  banner.style.display  = 'none';
  mBanner.style.display = 'none';
  loading.style.display = 'block';
  mSkel.style.display   = 'block';
  payBar.style.display  = 'block';
  slugInput.classList.add('fetching');
  showTableSkeletons();

  // ── Single merged call — replaces 4 separate API calls ──
  sfetch('/manager/setup-data?restaurant=' + enc)
    .then(function(r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function(d) {
      var foundAny = false;

      // UPI
      if (d.upi_vpa)  { document.getElementById('upi').value     = d.upi_vpa;  foundAny = true; }
      if (d.upi_name) { document.getElementById('upiName').value = d.upi_name; foundAny = true; }

      // Payment mode
      if (d.payment_mode) {
        document.getElementById('paymentMode').value = d.payment_mode;
        foundAny = true;
      }

      // Restaurant name
      if (d.restaurant_name) {
        var nameEl = document.getElementById('name');
        if (!nameEl.value.trim() || nameEl.value.trim() === nameEl.getAttribute('data-server-name')) {
          nameEl.value = d.restaurant_name;
          nameEl.setAttribute('data-server-name', d.restaurant_name);
        }
        foundAny = true;
        // Let admin-header.js upgrade its display name without a /menu round-trip.
        document.dispatchEvent(new CustomEvent('dineos:restaurantName', {
          detail: { restaurant_name: d.restaurant_name }
        }));
      }

      // Tables
      var rows = d.tables || [];
      if (rows.length > 0) {
        foundAny = true;
        var seenZones = {};
        zones.forEach(function(z) { seenZones[z.name] = z.color; });
        var paletteIdx = zones.length;
        rows.forEach(function(row) {
          if (row.zone && !seenZones[row.zone]) {
            seenZones[row.zone] = ZONE_PALETTE[paletteIdx % ZONE_PALETTE.length];
            paletteIdx++;
          }
        });
        zones = Object.keys(seenZones).map(function(name) {
          var existing = zones.find(function(z) { return z.name === name; });
          return existing || { name: name, color: seenZones[name] };
        });
        tables = rows.map(function(row) {
          return { table_number: row.table_number, zone: row.zone };
        });
        renderZones();
        renderTableGrid();
      }

      // Menu items
      var items = d.menu_items || [];
      if (items.length > 0) {
        foundAny = true;
        menuItems = items.map(function(it) {
          return {
            _category:     it.category || 'General',
            name:          it.name,
            description:   it.description || null,
            weight_gms:    null,
            calories_kcal: null,
            price:         it.price || 0,
            zone_prices:   it.zone_prices || {},
            available:     it.available !== false
          };
        });
        mCount.textContent    = menuItems.length;
        mBanner.style.display = 'block';
        var headers     = ['category', 'name', 'description', 'price', 'available'];
        var previewRows = menuItems.slice(0, 10).map(function(it) {
          return [it._category, it.name, it.description || '', it.price, it.available ? 'true' : 'false'];
        });
        renderMenuPreview(headers, previewRows);
        var statusEl = document.getElementById('menuStatus');
        statusEl.className   = 'status ok';
        statusEl.textContent = '✓ ' + menuItems.length + ' items loaded from server. Upload a CSV to replace.';
      }

      loading.style.display = 'none';
      payBar.style.display  = 'none';
      mSkel.style.display   = 'none';
      slugInput.classList.remove('fetching');
      hideTableSkeletons();
      if (foundAny) banner.style.display = 'block';
      checkSetupComplete();
    })
    .catch(function() {
      // Not yet configured — show wizard
      loading.style.display = 'none';
      payBar.style.display  = 'none';
      mSkel.style.display   = 'none';
      slugInput.classList.remove('fetching');
      hideTableSkeletons();
      checkSetupComplete();
    });
}

// Debounce on input so it fires after typing stops (600 ms)
var _slugDebounce = null;
document.getElementById('restaurant').addEventListener('input', function() {
  clearTimeout(_slugDebounce);
  _slugDebounce = setTimeout(loadRestaurantData, 600);
  syncNav();
});
document.getElementById('restaurant').addEventListener('change', function() {
  clearTimeout(_slugDebounce);
  loadRestaurantData();
  syncNav();
});

// ── Save UPI ──
document.getElementById('saveUpi').addEventListener('click', function() {
  var restaurant = document.getElementById('restaurant').value.trim() || 'demo';
  var upi     = document.getElementById('upi').value.trim();
  var upiName = document.getElementById('upiName').value.trim();
  var btn     = document.getElementById('saveUpi');
  var statusEl = document.getElementById('upiStatus');
  if (!upi || !/^[^@\s]+@[^@\s]+$/.test(upi)) {
    statusEl.className = 'status err';
    statusEl.textContent = 'Enter a valid UPI ID (name@bank) to save.';
    return;
  }
  statusEl.textContent = '';
  btnLoad(btn, ' Saving…');
  sfetch('/pay/upi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurant: restaurant, upi_vpa: upi, upi_name: upiName })
  })
    .then(function(r) {
      return r.json().then(function(d) {
        if (!r.ok) throw new Error(d.detail || 'save failed');
        return d;
      });
    })
    .then(function(d) {
      statusEl.className = 'status ok';
      statusEl.textContent = '✓ UPI saved: ' + d.upi_vpa;
    })
    .catch(function(e) {
      statusEl.className = 'status err';
      statusEl.textContent = 'Couldn\'t save UPI: ' + e.message;
    })
    .finally(function() { btnDone(btn); });
});

// ══════════════════════════════════════════════════
//  NAV SYNC
// ══════════════════════════════════════════════════
function syncNav() {
  // The old inline navbar was removed — navigation is now handled by
  // admin-header.js. This function is kept as a no-op so existing call
  // sites don't need to change.
}

window.addEventListener('load', function() {
  var params = new URLSearchParams(location.search);
  var r = params.get('r');
  if (r) document.getElementById('restaurant').value = r;

  // admin-header.js fires 'dineos:identity' synchronously before 'load'
  // fires (it runs inline), so we'll almost always have the identity by now.
  // Listen for it first; fall back to our own /auth/me after a tick in case
  // this page is used without admin-header.js.
  var identityHandled = false;

  function handleIdentity(identity) {
    if (identityHandled) return;
    identityHandled = true;
    var authenticatedSlug = identity && (identity.outletSlug || identity.restaurantSlug);
    if (authenticatedSlug) {
      r = authenticatedSlug;
      document.getElementById('restaurant').value = authenticatedSlug;
      history.replaceState(null, '', '/admin.html?r=' + encodeURIComponent(authenticatedSlug));
    } else if (r) {
      document.getElementById('restaurant').value = r;
    }
    syncNav();
    renderZones();
    renderTableGrid();
    loadRestaurantData();
  }

  document.addEventListener('dineos:identity', function handler(e) {
    document.removeEventListener('dineos:identity', handler);
    handleIdentity(e.detail);
  });

  // Fallback: if dineos:identity hasn't fired after one tick (no admin-header
  // on this page), call /auth/me ourselves.
  setTimeout(function() {
    if (identityHandled) return;
    fetch('/auth/me', { credentials: 'include' })
      .then(function(res) { return res.ok ? res.json() : null; })
      .then(function(identity) { handleIdentity(identity); })
      .catch(function() {
        if (r) document.getElementById('restaurant').value = r;
        if (!identityHandled) {
          identityHandled = true;
          syncNav(); renderZones(); renderTableGrid(); loadRestaurantData();
        }
      });
  }, 0);
});

// ══════════════════════════════════════════════════
//  STEP 5 — SUMMARY & SUBMIT
// ══════════════════════════════════════════════════
function renderSummary() {
  var slug  = document.getElementById('restaurant').value.trim() || 'demo';
  var dname = document.getElementById('name').value.trim();
  var upi   = document.getElementById('upi').value.trim();
  var mode  = document.getElementById('paymentMode').value;

  // Per-zone table breakdown
  var zoneBreakdown = zones.map(function(z) {
    var cnt = tables.filter(function(t) { return t.zone === z.name; }).length;
    return '<li><span class="legend-swatch" style="background:' + z.color +
      ';display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px"></span>' +
      esc(z.name) + ': ' + cnt + '</li>';
  }).join('');

  // Per-category menu breakdown
  var catMap = {};
  menuItems.forEach(function(item) {
    catMap[item._category] = (catMap[item._category] || 0) + 1;
  });
  var catList = Object.keys(catMap).map(function(c) {
    return '<li>' + esc(c) + ': ' + catMap[c] + ' items</li>';
  }).join('');

  var zonePillsHtml = zones.map(function(z) {
    return '<span class="zone-pill" style="background:' + z.color +
      ';padding:3px 10px;font-size:12px">' + esc(z.name) + '</span>';
  }).join(' ');

  document.getElementById('summaryGrid').innerHTML =
    '<div class="summary-box">' +
      '<h4>🏪 Restaurant</h4>' +
      '<p><strong>Slug:</strong> ' + esc(slug) + '</p>' +
      '<p><strong>Name:</strong> ' + esc(dname || '—') + '</p>' +
    '</div>' +
    '<div class="summary-box">' +
      '<h4>🪑 Tables</h4>' +
      '<p><strong>Total:</strong> ' + tables.length + '</p>' +
      '<ul>' + (zoneBreakdown || '<li>No tables</li>') + '</ul>' +
    '</div>' +
    '<div class="summary-box">' +
      '<h4>🍽️ Menu</h4>' +
      '<p><strong>Total items:</strong> ' + menuItems.length + '</p>' +
      '<ul>' + (catList || '<li>No items</li>') + '</ul>' +
    '</div>' +
    '<div class="summary-box">' +
      '<h4>💳 Payment</h4>' +
      '<p><strong>Mode:</strong> ' + esc(mode) + '</p>' +
      '<p><strong>UPI:</strong> ' + esc(upi || '—') + '</p>' +
      '<div style="margin-top:8px">' + zonePillsHtml + '</div>' +
    '</div>';
}

function buildPayload() {
  var slug    = document.getElementById('restaurant').value.trim() || 'demo';
  var dname   = document.getElementById('name').value.trim();
  var upi     = document.getElementById('upi').value.trim();
  var upiName = document.getElementById('upiName').value.trim();
  var payMode = document.getElementById('paymentMode').value || 'prepaid';

  // Build categories from menuItems
  var catMap = {};
  menuItems.forEach(function(item) {
    if (!catMap[item._category]) catMap[item._category] = [];
    var entry = {
      name:          item.name,
      description:   item.description,
      weight_gms:    item.weight_gms,
      calories_kcal: item.calories_kcal,
      price:         item.price,
      zone_prices:   item.zone_prices,
      available:     item.available
    };
    if (item.variants && item.variants.length) entry.variants = item.variants;
    catMap[item._category].push(entry);
  });

  var categories = Object.keys(catMap).map(function(c) {
    return { name: c, items: catMap[c] };
  });

  // Always send all fields — the backend does a full replace of every piece
  // of restaurant data on every submit. Omitting a field means clearing it.
  return {
    restaurant:   slug,
    name:         dname,
    currency:     '₹',
    zones:        zones.map(function(z) { return z.name; }),
    tables:       tables,
    categories:   categories,
    upi_vpa:      upi,
    upi_name:     upiName,
    payment_mode: payMode
  };
}

function submitAll() {
  var errContainer = document.getElementById('valErrors');
  var statusEl     = document.getElementById('submitStatus');
  var submitBtn    = document.getElementById('submitBtn');
  var overlay      = document.getElementById('submitOverlay');
  errContainer.innerHTML = '';

  // Validation
  var errors = [];
  var slug = document.getElementById('restaurant').value.trim();
  if (!slug)               errors.push('Restaurant slug is required.');
  if (tables.length === 0) errors.push('At least one table must be defined.');
  if (menuItems.length === 0) errors.push('Menu must have at least one item (upload a CSV/Excel file in step 3).');

  if (errors.length) {
    errContainer.innerHTML = errors.map(function(e) {
      return '<div class="inline-err show">⚠ ' + esc(e) + '</div>';
    }).join('');
    return;
  }

  // Show overlay and animate progress steps
  overlay.classList.add('show');
  btnLoad(submitBtn, ' Uploading…');
  statusEl.textContent = '';

  var steps = ['ps-menu','ps-tables','ps-embed','ps-payment'];
  var stepDelay = 1800; // ms between step highlights (purely cosmetic)
  steps.forEach(function(id, idx) {
    setTimeout(function() {
      // Mark previous as done
      if (idx > 0) {
        var prev = document.getElementById(steps[idx - 1]);
        prev.classList.remove('active');
        prev.classList.add('done');
        prev.querySelector('.ps-icon').textContent = '✅';
      }
      var el = document.getElementById(id);
      el.classList.add('active');
      // Replace icon with inline spinner while active
      var icon = el.querySelector('.ps-icon');
      icon.innerHTML = '<span class="ps-spinner"></span>';
    }, idx * stepDelay);
  });

  var payload = buildPayload();

  sfetch('/crawl/json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(function(r) {
      return r.json().then(function(d) {
        if (!r.ok) {
          var msg = d.detail
            ? (typeof d.detail === 'string' ? d.detail : JSON.stringify(d.detail))
            : 'upload failed (' + r.status + ')';
          throw new Error(msg);
        }
        return d;
      });
    })
    .then(function(data) {
      // Mark all steps done
      steps.forEach(function(id) {
        var el = document.getElementById(id);
        el.classList.remove('active');
        el.classList.add('done');
        el.querySelector('.ps-icon').textContent = '✅';
      });
      setTimeout(function() {
        overlay.classList.remove('show');
        // Reset step indicators for next submit
        var icons = ['🍽️','🪑','🧠','💳'];
        steps.forEach(function(id, i) {
          var el = document.getElementById(id);
          el.classList.remove('active','done');
          el.querySelector('.ps-icon').textContent = icons[i];
        });
        if (data.error && !data.chunks) {
          statusEl.className = 'status err';
          statusEl.textContent = 'Error: ' + data.error;
        } else {
          statusEl.className = data.error ? 'status warn' : 'status ok';
          statusEl.textContent =
            '✓ Done! Indexed ' + data.chunks + ' text chunks and ' +
            data.menu_items + ' menu items for \'' + data.restaurant + '\'.' +
            (data.error ? '\n\nNote: ' + data.error : '');
          loadRestaurantData();
        }
      }, 800);
    })
    .catch(function(e) {
      overlay.classList.remove('show');
      statusEl.className = 'status err';
      statusEl.textContent = 'Upload failed: ' + e.message;
      // Reset step indicators
      var icons = ['🍽️','🪑','🧠','💳'];
      steps.forEach(function(id, i) {
        var el = document.getElementById(id);
        el.classList.remove('active','done');
        el.querySelector('.ps-icon').textContent = icons[i];
      });
    })
    .finally(function() { btnDone(submitBtn); });
}

// ══════════════════════════════════════════════════
//  SETUP COMPLETE CHECK & EDIT MODE
// ══════════════════════════════════════════════════

/**
 * Called once loadRestaurantData() settles.
 * If tables AND menu items are already configured → show edit mode,
 * hide the step wizard. Otherwise keep the wizard visible.
 */
function checkSetupComplete() {
  var isComplete = tables.length > 0 && menuItems.length > 0;
  setMode(isComplete ? 'edit' : 'wizard');
}

function setMode(mode) {
  var wizardView = document.getElementById('wizardView');
  var editMode   = document.getElementById('editMode');
  var pageTitle  = document.querySelector('.page-header h1');
  var pageSub    = document.querySelector('.page-header p');
  if (mode === 'edit') {
    wizardView.style.display = 'none';
    editMode.style.display   = 'block';
    if (pageTitle) pageTitle.textContent = '⚙️ Restaurant Settings';
    if (pageSub)   pageSub.textContent   = 'Your restaurant is live. Edit any section below and save independently.';
    syncEditMode();
  } else {
    wizardView.style.display = 'block';
    editMode.style.display   = 'none';
    if (pageTitle) pageTitle.textContent = '🍴 DineOS Restaurant Setup';
    if (pageSub)   pageSub.textContent   = 'Configure your restaurant, tables, menu and payment settings in a few easy steps.';
  }
}

/** Populate all edit-mode fields from the current shared state. */
function syncEditMode() {
  var slug = document.getElementById('restaurant').value.trim() || 'demo';
  var name = document.getElementById('name').value.trim();
  var upi  = document.getElementById('upi').value.trim();
  var upiN = document.getElementById('upiName').value.trim();
  var mode = document.getElementById('paymentMode').value;

  document.getElementById('em-slug-display').value = slug;
  if (name) document.getElementById('em-name').value = name;
  if (upi)  document.getElementById('em-upi').value  = upi;
  if (upiN) document.getElementById('em-upiName').value = upiN;
  document.getElementById('em-paymentMode').value = mode;

  // Menu count text
  var countEl = document.getElementById('em-menuCurrentCount');
  if (countEl) countEl.textContent = menuItems.length + ' menu item' + (menuItems.length !== 1 ? 's' : '');

  // Badges
  setEditBadge('tables',  tables.length > 0);
  setEditBadge('menu',    menuItems.length > 0);
  setEditBadge('payment', !!upi);

  // Sync zone/table editors inside edit mode
  emRenderZones();
  emRenderTableGrid();
}

function setEditBadge(section, isOk) {
  var el = document.getElementById('em-badge-' + section);
  if (!el) return;
  if (isOk) {
    el.className = 'es-badge ok';
    el.textContent = 'Configured';
  } else {
    el.className = 'es-badge warn';
    el.textContent = 'Not set';
  }
}

/** Toggle a collapsible edit section. */
function toggleEditSection(name) {
  var btn  = document.querySelector('#em-section-' + name + ' .edit-section-toggle');
  var body = document.getElementById('em-body-' + name);
  var isOpen = body.classList.contains('open');
  // Close all
  document.querySelectorAll('.edit-section-body').forEach(function(b) { b.classList.remove('open'); });
  document.querySelectorAll('.edit-section-toggle').forEach(function(b) { b.classList.remove('open'); });
  if (!isOpen) {
    body.classList.add('open');
    btn.classList.add('open');
    // Refresh zone/table grids when tables section opens
    if (name === 'tables') { emRenderZones(); emRenderTableGrid(); }
  }
}

/** Switch back to the full wizard (admin choice). */
function switchToWizard() {
  setMode('wizard');
}

// ── Edit mode: Info save ──
function saveEditInfo() {
  var slug    = document.getElementById('restaurant').value.trim() || 'demo';
  var newName = document.getElementById('em-name').value.trim();
  var status  = document.getElementById('em-info-status');
  if (!newName) { status.className = 'status err'; status.textContent = 'Display name is required.'; return; }
  status.className = 'status'; status.textContent = 'Saving…';
  // Update the shared name field and re-submit only the name via crawl/json
  // (we send the full payload to avoid partial state; tables + menu are already loaded)
  document.getElementById('name').value = newName;
  var payload = buildPayload();
  sfetch('/crawl/json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  .then(function(r) { return r.json().then(function(d) { if (!r.ok) throw new Error(d.detail || 'save failed'); return d; }); })
  .then(function() { status.className = 'status ok'; status.textContent = '✓ Name saved.'; })
  .catch(function(e) { status.className = 'status err'; status.textContent = 'Error: ' + e.message; });
}

// ── Edit mode: Tables save ──
function saveEditTables() {
  var status = document.getElementById('em-tables-status');
  if (tables.length === 0) {
    document.getElementById('em-err-tables').textContent = 'Add at least one table.';
    document.getElementById('em-err-tables').classList.add('show');
    return;
  }
  document.getElementById('em-err-tables').classList.remove('show');
  status.className = 'status'; status.textContent = 'Saving…';
  var payload = buildPayload();
  sfetch('/crawl/json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  .then(function(r) { return r.json().then(function(d) { if (!r.ok) throw new Error(d.detail || 'save failed'); return d; }); })
  .then(function() {
    status.className = 'status ok';
    status.textContent = '✓ Tables saved (' + tables.length + ').';
    setEditBadge('tables', true);
  })
  .catch(function(e) { status.className = 'status err'; status.textContent = 'Error: ' + e.message; });
}

// ── Edit mode: Menu save ──
function saveEditMenu() {
  var status = document.getElementById('em-menu-status');
  var errEl  = document.getElementById('em-err-menu');
  if (menuItems.length === 0) {
    errEl.textContent = 'Upload and parse a menu file before saving.';
    errEl.classList.add('show');
    return;
  }
  errEl.classList.remove('show');
  status.className = 'status'; status.textContent = 'Saving…';
  var payload = buildPayload();
  sfetch('/crawl/json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  .then(function(r) { return r.json().then(function(d) { if (!r.ok) throw new Error(d.detail || 'save failed'); return d; }); })
  .then(function(data) {
    status.className = 'status ok';
    status.textContent = '✓ Menu saved — ' + data.menu_items + ' items.';
    document.getElementById('em-menuCurrentCount').textContent = menuItems.length + ' menu item' + (menuItems.length !== 1 ? 's' : '');
    setEditBadge('menu', true);
  })
  .catch(function(e) { status.className = 'status err'; status.textContent = 'Error: ' + e.message; });
}

// ── Edit mode: UPI save ──
function saveEditUpi() {
  var restaurant = document.getElementById('restaurant').value.trim() || 'demo';
  var upi     = document.getElementById('em-upi').value.trim();
  var upiName = document.getElementById('em-upiName').value.trim();
  var status  = document.getElementById('em-upi-status');
  if (upi && !/^[^@\s]+@[^@\s]+$/.test(upi)) {
    status.className = 'status err'; status.textContent = 'Enter a valid UPI ID (name@bank).'; return;
  }
  status.className = 'status'; status.textContent = 'Saving…';
  sfetch('/pay/upi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurant: restaurant, upi_vpa: upi, upi_name: upiName })
  })
  .then(function(r) { return r.json().then(function(d) { if (!r.ok) throw new Error(d.detail || 'save failed'); return d; }); })
  .then(function(d) {
    // sync back to wizard fields
    document.getElementById('upi').value     = upi;
    document.getElementById('upiName').value = upiName;
    status.className = 'status ok';
    status.textContent = upi ? '✓ UPI saved: ' + d.upi_vpa : '✓ UPI cleared.';
    setEditBadge('payment', !!upi);
  })
  .catch(function(e) { status.className = 'status err'; status.textContent = 'Error: ' + e.message; });
}

// ── Edit mode: Payment mode save ──
function saveEditMode() {
  var restaurant = document.getElementById('restaurant').value.trim() || 'demo';
  var mode   = document.getElementById('em-paymentMode').value;
  var status = document.getElementById('em-mode-status');
  status.className = 'status'; status.textContent = 'Saving…';
  sfetch('/pay/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurant: restaurant, payment_mode: mode })
  })
  .then(function(r) { return r.json().then(function(d) { if (!r.ok) throw new Error(d.detail || 'save failed'); return d; }); })
  .then(function() {
    document.getElementById('paymentMode').value = mode;
    status.className = 'status ok';
    status.textContent = '✓ Mode saved: ' + mode + '.';
  })
  .catch(function(e) { status.className = 'status err'; status.textContent = 'Error: ' + e.message; });
}

// ══════════════════════════════════════════════════
//  EDIT MODE — Zone / Table helpers
//  These mirror the wizard helpers but target em-* elements.
// ══════════════════════════════════════════════════

function emRenderZones() {
  var pills = document.getElementById('em-zonePills');
  if (!pills) return;
  pills.innerHTML = zones.map(function(z, i) {
    return '<div class="zone-pill" style="background:' + z.color + '">' +
      esc(z.name) +
      '<button class="pill-del" onclick="emRemoveZone(' + i + ')" title="Remove zone">✕</button>' +
    '</div>';
  }).join('');
  // Sync zone selects
  ['em-singleZone','em-bulkZone'].forEach(function(id) {
    var sel = document.getElementById(id);
    if (!sel) return;
    var val = sel.value;
    sel.innerHTML = zones.map(function(z) {
      return '<option value="' + esc(z.name) + '">' + esc(z.name) + '</option>';
    }).join('');
    if (zones.find(function(z) { return z.name === val; })) sel.value = val;
  });
  emRenderZoneLegend();
}

function emRenderZoneLegend() {
  var leg = document.getElementById('em-zoneLegend');
  if (!leg) return;
  leg.innerHTML = zones.map(function(z) {
    return '<div class="legend-item"><span class="legend-swatch" style="background:' + z.color + '"></span>' + esc(z.name) + '</div>';
  }).join('');
}

function emRemoveZone(idx) {
  var zoneName = zones[idx].name;
  if (tables.some(function(t) { return t.zone === zoneName; })) {
    alert('Cannot remove zone "' + zoneName + '" — it has tables assigned. Remove those tables first.');
    return;
  }
  zones.splice(idx, 1);
  emRenderZones();
}

function emAddZone() {
  var inp = document.getElementById('em-newZoneName');
  var name = (inp.value || '').trim();
  if (!name) return;
  if (zones.find(function(z) { return z.name.toLowerCase() === name.toLowerCase(); })) {
    alert('Zone "' + name + '" already exists.'); return;
  }
  zones.push({ name: name, color: nextZoneColor() });
  inp.value = '';
  emRenderZones();
}

function emRenderTableGrid() {
  var grid = document.getElementById('em-tableGrid');
  if (!grid) return;
  var countEl = document.getElementById('em-tableCount');
  if (countEl) countEl.textContent = '(' + tables.length + ' tables)';

  if (tables.length === 0) {
    grid.innerHTML = '<p style="color:var(--muted);font-size:13px;grid-column:1/-1">No tables added yet.</p>';
    return;
  }
  var zoneColorMap = {};
  zones.forEach(function(z) { zoneColorMap[z.name] = z.color; });

  grid.innerHTML = tables.map(function(t, i) {
    var color = zoneColorMap[t.zone] || '#888';
    return '<div class="table-tile" style="--tile-color:' + color + '" title="Click to edit">' +
      '<span class="tile-num">' + esc(t.table_number) + '</span>' +
      '<span class="tile-zone">' + esc(t.zone || '') + '</span>' +
      '<button class="tile-del" onclick="emDeleteTable(' + i + ')">✕</button>' +
    '</div>';
  }).join('');
}

function emDeleteTable(idx) {
  tables.splice(idx, 1);
  emRenderTableGrid();
  setEditBadge('tables', tables.length > 0);
}

function emAddSingleTable() {
  var name = (document.getElementById('em-singleName').value || '').trim();
  var zone = (document.getElementById('em-singleZone').value || '').trim();
  var errEl = document.getElementById('em-errSingle');
  if (!name) { errEl.textContent = 'Table name is required.'; errEl.classList.add('show'); return; }
  if (tables.find(function(t) { return t.table_number === name; })) {
    errEl.textContent = 'Table "' + name + '" already exists.'; errEl.classList.add('show'); return;
  }
  errEl.classList.remove('show');
  tables.push({ table_number: name, zone: zone });
  document.getElementById('em-singleName').value = '';
  emRenderTableGrid();
  // also refresh wizard grid
  renderTableGrid();
}

function emBulkAddTables() {
  var prefix = (document.getElementById('em-bulkPrefix').value || 'T').trim();
  var count  = parseInt(document.getElementById('em-bulkCount').value)  || 4;
  var start  = parseInt(document.getElementById('em-bulkStart').value)  || 1;
  var zone   = (document.getElementById('em-bulkZone').value || '').trim();
  var errEl  = document.getElementById('em-errBulk');
  if (count < 1 || count > 200) { errEl.textContent = 'Count must be 1–200.'; errEl.classList.add('show'); return; }
  errEl.classList.remove('show');
  var added = 0;
  for (var i = 0; i < count; i++) {
    var num = String(start + i);
    var tname = prefix + num;
    if (!tables.find(function(t) { return t.table_number === tname; })) {
      tables.push({ table_number: tname, zone: zone });
      added++;
    }
  }
  emRenderTableGrid();
  renderTableGrid();
}

function emClearMenu() {
  menuItems = [];
  document.getElementById('em-menuPreviewWrap').style.display = 'none';
  document.getElementById('em-menuStatus').textContent = '';
  document.getElementById('em-menuCurrentCount').textContent = '0 menu items';
}

// ── Wire up the em-menuFile input ──
(function() {
  var fileInput = document.getElementById('em-menuFile');
  if (!fileInput) return;
  fileInput.addEventListener('change', function() {
    if (!fileInput.files || !fileInput.files[0]) return;
    _menuTarget = 'em-menu';
    handleMenuFile(fileInput.files[0]);
  });
  var uploadArea = document.getElementById('em-uploadArea');
  if (uploadArea) {
    uploadArea.addEventListener('dragover', function(e) { e.preventDefault(); uploadArea.classList.add('drag-over'); });
    uploadArea.addEventListener('dragleave', function() { uploadArea.classList.remove('drag-over'); });
    uploadArea.addEventListener('drop', function(e) {
      e.preventDefault(); uploadArea.classList.remove('drag-over');
      var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) {
        _menuTarget = 'em-menu';
        handleMenuFile(file);
      }
    });
  }
})();

// ══════════════════════════════════════════════════
//  UTILITY
// ══════════════════════════════════════════════════
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

// ── STAFF MANAGEMENT ──────────────────────────────
function staffMessage(text, kind) {
  var el = document.getElementById('staffMessage');
  el.className = 'status ' + (kind || '');
  el.textContent = text || '';
}
function loadStaffUsers() {
  sfetch('/staff').then(function(r) {
    return r.json().then(function(d) { if (!r.ok) throw new Error(d.detail || 'Could not load staff.'); return d; });
  }).then(function(data) {
    var countEl = document.getElementById('staffCount');
    if (countEl) countEl.textContent = (data.users || []).length + ' users';
    var rows = document.getElementById('staffRows');
    rows.innerHTML = (data.users || []).map(function(u) {
      var action = u.role === 'admin' ? '—' : '<button class="btn btn-secondary btn-sm" data-staff-status="' + u.id + '" data-next-status="' + (u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE') + '">' + (u.status === 'ACTIVE' ? 'Disable' : 'Enable') + '</button> <button class="btn btn-secondary btn-sm" data-staff-reset="' + u.id + '">Reset password</button>';
      return '<tr><td style="padding:8px;border-top:1px solid var(--border)">' + esc(u.name) + '</td><td style="padding:8px;border-top:1px solid var(--border)">' + esc(u.username) + '</td><td style="padding:8px;border-top:1px solid var(--border)">' + esc(String(u.role).toUpperCase()) + '</td><td style="padding:8px;border-top:1px solid var(--border)">' + esc(u.status) + '</td><td style="padding:8px;border-top:1px solid var(--border)">' + (u.last_login ? new Date(u.last_login).toLocaleString() : 'Never') + '</td><td style="padding:8px;border-top:1px solid var(--border)">' + action + '</td></tr>';
    }).join('');
    rows.querySelectorAll('[data-staff-status]').forEach(function(btn) { btn.onclick = function() { sfetch('/staff/' + btn.dataset.staffStatus + '/status', { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({status:btn.dataset.nextStatus}) }).then(function(r){if(!r.ok) throw new Error('Could not update user.'); return r.json();}).then(loadStaffUsers).catch(function(e){staffMessage(e.message,'err');}); }; });
    rows.querySelectorAll('[data-staff-reset]').forEach(function(btn) { btn.onclick = function() { var password = window.prompt('New password, at least 10 characters:'); if (!password) return; sfetch('/staff/' + btn.dataset.staffReset + '/reset-password', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:password}) }).then(function(r){if(!r.ok) return r.json().then(function(d){throw new Error(d.detail || 'Could not reset password.');}); return r.json();}).then(function(){staffMessage('Password reset successfully.','ok');}).catch(function(e){staffMessage(e.message,'err');}); }; });
  }).catch(function(e) { staffMessage(e.message, 'err'); });
}
var staffForm = document.getElementById('staffCreateForm');
if (staffForm) staffForm.addEventListener('submit', function(event) {
  event.preventDefault();
  var password = document.getElementById('staffPassword').value;
  if (password !== document.getElementById('staffConfirm').value) { staffMessage('Passwords do not match.', 'err'); return; }
  var button = event.target.querySelector('button[type=submit]'); button.disabled = true; staffMessage('');
  sfetch('/staff', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:document.getElementById('staffName').value.trim(), username:document.getElementById('staffUsername').value.trim(), email:document.getElementById('staffEmail').value.trim(), password:password, role:document.getElementById('staffRole').value}) }).then(function(r){return r.json().then(function(d){if(!r.ok) throw new Error(d.detail || 'Could not create user.'); return d;});}).then(function(){event.target.reset();staffMessage('User created successfully.','ok');loadStaffUsers();}).catch(function(e){staffMessage(e.message,'err');}).finally(function(){button.disabled=false;});
});
if (document.getElementById('staffPanel')) loadStaffUsers();
// adminLogout button was removed — logout is handled by admin-header.js global nav.
var _adminLogoutBtn = document.getElementById('adminLogout');
if (_adminLogoutBtn) {
  _adminLogoutBtn.addEventListener('click', function() {
    fetch('/auth/logout', { method:'POST', credentials:'include' }).finally(function() { window.location.href = '/login.html'; });
  });
}
document.querySelectorAll('.staff-role').forEach(function(roleButton) {
  roleButton.addEventListener('click', function() {
    document.querySelectorAll('.staff-role').forEach(function(button) { button.classList.remove('active'); });
    roleButton.classList.add('active');
    document.getElementById('staffRole').value = roleButton.dataset.role;
  });
});
