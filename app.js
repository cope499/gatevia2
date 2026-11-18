'use strict';
/* Gatevia 2（ローカル版）: カーナビ1の画面構成 + 通常ナビ式フロー。
   - 上部は単一検索バー + クイックチップ、右下に現在地ボタン、下部タブバー。
   - ルートは「乗るICを選ぶ → 降りるICを選ぶ」の順に選ばせ、選ばれたペアを
     その場で計算する（サービス側 B3 形式: presentation='lazy' で列挙、
     mode='explicit_pair' で指名ペアを計算）。
   - IC未指定の一般道ルートは、サービスが surface_candidate を返したら
     別枠で表示する（surface-candidate-spec.md の形）。
   - サービスが lazy 形式に未対応の場合は、通常モードの全計算結果を
     入口ICグループに畳んで同じ選択フローに載せる（縮退動作）。 */

var DEFAULT_SERVICE_BASE = 'https://sedate-landmark-shrunk.ngrok-free.dev';
var SERVICE_BASE = DEFAULT_SERVICE_BASE;
try {
  var savedBase = window.localStorage.getItem('gatevia2.serviceBase');
  if (savedBase) SERVICE_BASE = savedBase;
} catch (e) { /* localStorage 不可の環境では既定値のまま */ }

var state = {
  origin: null,       // {lat, lon, label}
  destination: null,  // {lat, lon, label}
  tapTarget: 'destination',
  searchTarget: 'destination', // 上部検索バーがどちらの地点を決めるか
  entries: [],        // [{unit, ic, road, caution, exits:[{unit, ic, road, estimate_min, candidate}]}]
  selectedEntry: null,
  surfaceCache: undefined, // 直近の通常モード応答に含まれていた surface_candidate
  abort: null,
  timer: null,
};

var map = L.map('map', { zoomControl: false }).setView([35.681, 139.767], 11);
L.control.zoom({ position: 'topright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

var markers = { origin: null, destination: null };
var routeLine = null;

function pinIcon(kind) {
  return L.divIcon({
    className: 'pin-icon',
    html: '<div class="pin-dot ' + kind + '"></div>',
    iconSize: [22, 22], iconAnchor: [11, 11],
  });
}

function setPoint(which, lat, lon, label) {
  state[which] = { lat: lat, lon: lon, label: label };
  if (markers[which]) map.removeLayer(markers[which]);
  markers[which] = L.marker([lat, lon], {
    icon: pinIcon(which === 'origin' ? 'from' : 'to'),
  }).addTo(map);
  // 地点が変わったら前回のIC列挙・ルートは無効
  state.entries = [];
  state.selectedEntry = null;
  state.surfaceCache = undefined;
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  updateOdRows();
  resetFlowHint();
  if (which === 'destination') {
    openSheet();
    if (!state.origin) useCurrentLocation(true);
  }
}

function updateOdRows() {
  var o = state.origin, d = state.destination;
  document.getElementById('origin-row').textContent = o ? o.label : '現在地';
  document.getElementById('dest-row').textContent = d ? d.label : '目的地を指定';
}

/* ---------- 地図タップで指定 ---------- */
map.on('click', function (e) {
  setPoint(state.tapTarget, e.latlng.lat, e.latlng.lng, '地図で指定した地点');
  if (state.tapTarget === 'destination') map.setView(e.latlng, map.getZoom());
});

function setTapTarget(which) {
  state.tapTarget = which;
  document.getElementById('tap-origin').classList.toggle('active', which === 'origin');
  document.getElementById('tap-dest').classList.toggle('active', which === 'destination');
}
document.getElementById('tap-origin').addEventListener('click', function () { setTapTarget('origin'); });
document.getElementById('tap-dest').addEventListener('click', function () { setTapTarget('destination'); });

document.getElementById('swap-btn').addEventListener('click', function () {
  var o = state.origin, d = state.destination;
  if (!o && !d) return;
  state.origin = null; state.destination = null;
  if (markers.origin) { map.removeLayer(markers.origin); markers.origin = null; }
  if (markers.destination) { map.removeLayer(markers.destination); markers.destination = null; }
  if (d) setPoint('origin', d.lat, d.lon, d.label);
  if (o) setPoint('destination', o.lat, o.lon, o.label);
});

/* ---------- 現在地 ---------- */
function useCurrentLocation(setAsOrigin) {
  if (!navigator.geolocation) {
    if (setAsOrigin) showError('このブラウザでは現在地が使えません。出発地を検索か地図タップで指定してください。');
    return;
  }
  navigator.geolocation.getCurrentPosition(function (pos) {
    var lat = pos.coords.latitude, lon = pos.coords.longitude;
    if (setAsOrigin) setPoint('origin', lat, lon, '現在地');
    map.setView([lat, lon], Math.max(map.getZoom(), 13));
  }, function (err) {
    if (setAsOrigin) {
      setFlowMessage('現在地を取得できませんでした（' + err.message + '）。出発地は検索か地図タップで指定できます。');
    }
  }, { enableHighAccuracy: true, timeout: 15000 });
}
document.getElementById('locate-btn').addEventListener('click', function () { useCurrentLocation(false); });
document.getElementById('origin-gps').addEventListener('click', function () { useCurrentLocation(true); });

/* ---------- 自前施設辞書 (IC/JCT/SA/PA) ----------
   Nominatim では川越IC・所沢IC 本体が引けない (OSM 名称索引の問題) ため、
   IC 表と SA/PA マッピングから作った辞書 (facilities.json) を優先して引く。
   本家 Gatevia の辞書実装 (gatevia-facility-dictionary-report.md) と同一規則。
   辞書生成: kanabi2-dev/build-facility-dictionary.py
   形式: {"v":1,"entries":[{"n":表示名,"b":基名,"k":種別,"r":路線名,"lat","lng"}]}
   読み込みに失敗した場合は空辞書として Nominatim 経路にフォールバックする。 */
var facilityDictPromise = null;
function loadFacilities() {
  if (!facilityDictPromise) {
    facilityDictPromise = fetch('facilities.json')
      .then(function (r) { return r.json(); })
      .then(function (j) { return j.entries || []; })
      .catch(function () { return []; });
  }
  return facilityDictPromise;
}
function normalizeFacilityText(s) {
  return (s || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    })
    .replace(/サービスエリア/g, 'SA')
    .replace(/パーキングエリア/g, 'PA')
    .replace(/インターチェンジ/g, 'IC')
    .replace(/インタチェンジ/g, 'IC')
    .replace(/[\s　]/g, '')
    .toUpperCase();
}
function facilityQueryCore(qn) {
  return qn.replace(/(IC|SA|PA|JCT)$/, '');
}
// 完全一致 > 基名一致 > 前方一致 > 部分一致 の順に最大6件返す。
function searchFacilities(entries, query) {
  var qn = normalizeFacilityText(query);
  if (!qn) return [];
  var core = facilityQueryCore(qn);
  var scored = [];
  entries.forEach(function (e) {
    var dn = normalizeFacilityText(e.n);
    var bn = normalizeFacilityText(e.b);
    var score = -1;
    if (dn === qn) score = 100;
    else if (bn === qn || (core && bn === core)) score = 90;
    else if (core.length >= 2 && dn.indexOf(core) === 0) score = 70;
    else if (core.length >= 2 && bn.indexOf(core) === 0) score = 60;
    else if (core.length >= 2 && bn.indexOf(core) >= 0) score = 40;
    else if (qn.length >= 2 && dn.indexOf(qn) >= 0) score = 30;
    if (score >= 0) scored.push({ e: e, score: score });
  });
  scored.sort(function (a, b) { return b.score - a.score; });
  return scored.slice(0, 6).map(function (s) { return s.e; });
}

/* ---------- テキスト検索 (Nominatim) ---------- */
// OSM の施設名は「海老名SA」のような略称で登録されていることが多い。
// 正式名称（サービスエリア等）を略称に直したクエリを本命として先に試し、
// 結果が空なら元の表記→派生表記の順にフォールバックする。
function queryVariants(query) {
  var q = query.replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) {
    return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  });
  var variants = [];
  function push(v) { if (v && variants.indexOf(v) < 0) variants.push(v); }
  var normalized = q
    .replace(/サービスエリア/g, 'SA')
    .replace(/パーキングエリア/g, 'PA')
    .replace(/インターチェンジ/g, 'IC')
    .replace(/インタチェンジ/g, 'IC');
  if (normalized !== q) push(normalized);
  push(q);
  // スマートICは OSM では併設の PA/SA 名でしか引けないことがある
  var m = q.match(/^(.*)スマートIC$/);
  if (m) { push(m[1] + 'IC'); push(m[1] + 'PA'); push(m[1] + 'SA'); }
  return variants;
}
function nominatimSearch(query, viewbox) {
  var url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8' +
    '&countrycodes=jp&accept-language=ja&q=' + encodeURIComponent(query);
  if (viewbox) url += '&viewbox=' + viewbox + '&bounded=0';
  return fetch(url, { headers: { 'Accept': 'application/json' } })
    .then(function (r) { return r.json(); });
}
// 「○○IC」検索では、部分一致で無関係な IC（例: 川越IC→小船越IC）が
// 上位に来ることがあるため、当該ジャンクション本人だけに絞る。
// 絞って空になる場合はヒットなしとして扱う（誤った候補を出さない）。
function filterIcRows(rows, query) {
  if (!/IC$/.test(query)) return rows;
  return rows.filter(function (row) {
    var head = (row.display_name || '').split(',')[0];
    return row.type === 'motorway_junction' && head.indexOf(query) === 0;
  });
}
function dedupeRows(rows) {
  var out = [];
  rows.forEach(function (row) {
    var name = (row.display_name || '').split(',')[0];
    var dup = out.some(function (o) {
      return (o.display_name || '').split(',')[0] === name &&
        Math.abs(parseFloat(o.lat) - parseFloat(row.lat)) < 0.001 &&
        Math.abs(parseFloat(o.lon) - parseFloat(row.lon)) < 0.001;
    });
    if (!dup) out.push(row);
  });
  return out;
}

var geoBox = function () { return document.getElementById('geo-results'); };

function renderGeoItems(items, which) {
  var box = geoBox();
  box.innerHTML = '';
  if (!items.length) {
    box.innerHTML = '<div class="geo-item">見つかりませんでした。</div>';
    box.hidden = false;
    return;
  }
  items.forEach(function (it) {
    var item = document.createElement('div');
    item.className = 'geo-item';
    if (it.tag) {
      var tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = it.tag;
      item.appendChild(tag);
    }
    item.appendChild(document.createTextNode(it.name));
    if (it.sub) {
      var small = document.createElement('small');
      small.textContent = it.sub;
      item.appendChild(small);
    }
    item.addEventListener('click', function () {
      setPoint(which, it.lat, it.lon, it.name);
      map.setView([it.lat, it.lon], Math.max(map.getZoom(), 13));
      box.hidden = true;
      if (state.searchTarget === 'origin') setSearchTarget('destination');
    });
    box.appendChild(item);
  });
  box.hidden = false;
}

function geocode(query, which) {
  var box = geoBox();
  box.hidden = false;
  box.innerHTML = '<div class="geo-item">検索中…</div>';
  var variants = queryVariants(query);
  function attempt(i) {
    return nominatimSearch(variants[i]).then(function (rows) {
      rows = filterIcRows(rows, variants[i]);
      if (!rows.length && i + 1 < variants.length) return attempt(i + 1);
      return rows;
    });
  }
  // 辞書を先に引き、ヒットを先頭に並べ、その後に Nominatim 結果を続ける。
  var dictPromise = loadFacilities().then(function (entries) {
    return searchFacilities(entries, query).map(function (e) {
      return {
        name: e.n, sub: (e.r || '') + (e.k ? '（' + e.k + '）' : ''),
        lat: e.lat, lon: e.lng, tag: '施設辞書',
      };
    });
  });
  var nomPromise = attempt(0).then(function (rows) {
    return dedupeRows(rows).map(function (row) {
      return {
        name: (row.display_name || '').split(',')[0],
        sub: row.display_name || '',
        lat: parseFloat(row.lat), lon: parseFloat(row.lon), tag: null,
      };
    });
  });
  Promise.all([dictPromise, nomPromise.then(function (x) { return { ok: x }; },
    function (e) { return { err: e }; })])
    .then(function (res) {
      var dictHits = res[0];
      var nom = res[1];
      if (nom.err) {
        if (dictHits.length) { renderGeoItems(dictHits, which); return; }
        box.innerHTML = '<div class="geo-item">検索に失敗しました（' + nom.err.message + '）。</div>';
        return;
      }
      renderGeoItems(dictHits.concat(nom.ok), which);
    });
}

/* カテゴリ検索（クイックチップ）: 地図中心の周辺を探す */
function chipSearch(word) {
  var box = geoBox();
  box.hidden = false;
  box.innerHTML = '<div class="geo-item">周辺の「' + word + '」を検索中…</div>';
  var c = map.getCenter();
  var d = 0.09;
  var viewbox = [c.lng - d, c.lat + d, c.lng + d, c.lat - d].join(',');
  nominatimSearch(word, viewbox)
    .then(function (rows) {
      rows = dedupeRows(rows).slice(0, 8);
      renderGeoItems(rows.map(function (row) {
        return {
          name: (row.display_name || '').split(',')[0],
          sub: row.display_name || '',
          lat: parseFloat(row.lat), lon: parseFloat(row.lon), tag: null,
        };
      }), 'destination');
    })
    .catch(function (e) {
      box.innerHTML = '<div class="geo-item">検索に失敗しました（' + e.message + '）。</div>';
    });
}

function setSearchTarget(which) {
  state.searchTarget = which;
  var input = document.getElementById('search-input');
  input.placeholder = which === 'origin' ? '出発地を検索' : '目的地を検索';
  if (which === 'origin') input.focus();
}
document.getElementById('origin-row').addEventListener('click', function () {
  setSearchTarget('origin');
  window.scrollTo(0, 0);
});
document.getElementById('dest-row').addEventListener('click', function () {
  setSearchTarget('destination');
  document.getElementById('search-input').focus();
});

function runTopSearch() {
  var input = document.getElementById('search-input');
  var q = input.value.trim();
  if (q) geocode(q, state.searchTarget);
}
document.getElementById('search-go').addEventListener('click', runTopSearch);
document.getElementById('search-input').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') runTopSearch();
});

document.querySelectorAll('#chips .chip').forEach(function (chip) {
  chip.addEventListener('click', function () {
    var key = chip.dataset.chip;
    if (key === 'home') {
      var home = null;
      try { home = JSON.parse(window.localStorage.getItem('gatevia2.home') || 'null'); } catch (e) { home = null; }
      if (home && isFinite(home.lat) && isFinite(home.lon)) {
        setPoint('destination', home.lat, home.lon, '自宅');
        map.setView([home.lat, home.lon], Math.max(map.getZoom(), 13));
        geoBox().hidden = true;
        return;
      }
      var box = geoBox();
      box.innerHTML = '';
      var note = document.createElement('div');
      note.className = 'geo-note';
      note.textContent = '自宅はまだ登録されていません。今いる場所を自宅として登録できます。';
      var btn = document.createElement('button');
      btn.className = 'mini-btn';
      btn.type = 'button';
      btn.textContent = '現在地を自宅に登録';
      btn.style.marginTop = '8px';
      btn.addEventListener('click', function () {
        if (!navigator.geolocation) return;
        navigator.geolocation.getCurrentPosition(function (pos) {
          try {
            window.localStorage.setItem('gatevia2.home', JSON.stringify({
              lat: pos.coords.latitude, lon: pos.coords.longitude,
            }));
          } catch (e) { /* 保存できない環境では登録なしで続行 */ }
          setPoint('destination', pos.coords.latitude, pos.coords.longitude, '自宅');
          box.hidden = true;
        }, function (err) {
          note.textContent = '現在地を取得できませんでした（' + err.message + '）。';
        }, { enableHighAccuracy: true, timeout: 15000 });
      });
      note.appendChild(document.createElement('br'));
      note.appendChild(btn);
      box.appendChild(note);
      box.hidden = false;
      return;
    }
    setSearchTarget('destination');
    chipSearch(key);
  });
});

/* ---------- Valhalla shape (polyline, 精度6) のデコード ---------- */
function decodeShape(str) {
  var index = 0, lat = 0, lon = 0, coords = [];
  while (index < str.length) {
    var b, shift = 0, result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lon += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lat / 1e6, lon / 1e6]);
  }
  return coords;
}

function fmtTime(timeS) {
  var m = Math.round(timeS / 60);
  if (m >= 60) return Math.floor(m / 60) + '時間' + (m % 60) + '分';
  return m + '分';
}

/* ---------- ルートシートの開閉 ---------- */
var sheetEl = document.getElementById('route-sheet');
function adjustLocate() {
  var btn = document.getElementById('locate-btn');
  if (!sheetEl.hidden) {
    btn.style.bottom = (sheetEl.offsetHeight + 22) + 'px';
  } else {
    btn.style.bottom = '18px';
  }
}
function afterFlowRender() { setTimeout(adjustLocate, 30); }
function openSheet() {
  sheetEl.hidden = false;
  document.getElementById('sheet-open-btn').hidden = true;
  afterFlowRender();
}
function closeSheet() {
  sheetEl.hidden = true;
  document.getElementById('sheet-open-btn').hidden = !state.destination;
  adjustLocate();
}
document.getElementById('sheet-close').addEventListener('click', closeSheet);
document.getElementById('sheet-open-btn').addEventListener('click', openSheet);

/* ---------- フローエリア（シート内の段階表示） ---------- */
function flowArea() { return document.getElementById('flow-area'); }
function resetFlowHint() {
  var area = flowArea();
  if (!area) return;
  area.innerHTML = '<div class="flow-hint">出発地と目的地を指定して、「ICを選んで検索」を押してください。乗るIC → 降りるICの順に選びます。</div>';
  afterFlowRender();
}
function setFlowMessage(msg) {
  openSheet();
  flowArea().innerHTML = '';
  var div = document.createElement('div');
  div.className = 'flow-msg';
  div.textContent = msg;
  flowArea().appendChild(div);
  afterFlowRender();
}
function flowActions(buttons) {
  var wrap = document.createElement('div');
  wrap.className = 'flow-actions';
  buttons.forEach(function (b) {
    var btn = document.createElement('button');
    btn.className = 'mini-btn';
    btn.type = 'button';
    btn.textContent = b.label;
    btn.addEventListener('click', b.onClick);
    wrap.appendChild(btn);
  });
  return wrap;
}

function showError(msg) {
  document.getElementById('error-text').textContent = msg;
  document.getElementById('error-panel').hidden = false;
}
document.getElementById('error-close').addEventListener('click', function () {
  document.getElementById('error-panel').hidden = true;
});

/* ---------- 計算中表示 ---------- */
function startElapsedTimer() {
  var el = document.getElementById('progress-elapsed');
  if (!el) return;
  var t0 = Date.now();
  el.textContent = '0秒';
  state.timer = setInterval(function () {
    var s = Math.floor((Date.now() - t0) / 1000);
    el.textContent = s >= 60 ? Math.floor(s / 60) + '分' + (s % 60) + '秒' : s + '秒';
  }, 500);
}
function stopElapsedTimer() {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
}
function showProgress(title, note) {
  openSheet();
  flowArea().innerHTML =
    '<div class="progress-title">' + title + ' <span id="progress-elapsed">0秒</span></div>' +
    '<div class="progress-note">' + note + '</div>';
  var btn = document.createElement('button');
  btn.className = 'mini-btn';
  btn.type = 'button';
  btn.textContent = 'キャンセル';
  btn.addEventListener('click', function () { if (state.abort) state.abort.abort(); });
  flowArea().appendChild(btn);
  startElapsedTimer();
  afterFlowRender();
}

/* ---------- サービス呼び出し ---------- */
function postRoute(body) {
  var controller = new AbortController();
  state.abort = controller;
  return fetch(SERVICE_BASE + '/route_candidates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).then(function (r) {
    if (!r.ok) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        throw new Error('サービスがエラーを返しました（HTTP ' + r.status + '）' +
          (j.error ? ': ' + j.error : ''));
      });
    }
    return r.json();
  }).finally(function () {
    stopElapsedTimer();
    state.abort = null;
  });
}
function odBody() {
  return {
    origin: { lat: state.origin.lat, lon: state.origin.lon },
    destination: { lat: state.destination.lat, lon: state.destination.lon },
  };
}
function requireOd() {
  if (!state.origin || !state.destination) {
    openSheet();
    setFlowMessage('出発地と目的地の両方を指定してください。目的地は上の検索か地図タップ、出発地は現在地ボタンか検索で指定できます。');
    return false;
  }
  return true;
}

/* ---------- IC列挙の組み立て ---------- */
function exitSort(a, b) {
  if (a.candidate && b.candidate) return a.candidate.time_s - b.candidate.time_s;
  if (a.candidate) return -1;
  if (b.candidate) return 1;
  return (a.estimate_min || 1e9) - (b.estimate_min || 1e9);
}
function entryBestMin(e) {
  var best = null;
  e.exits.forEach(function (x) {
    var v = x.candidate ? x.candidate.time_s / 60 : x.estimate_min;
    if (v != null && (best == null || v < best)) best = v;
  });
  return best;
}
function buildEntries(res) {
  var byUnit = {};
  function entryFor(unit, ic, road) {
    if (!unit) return null;
    if (!byUnit[unit]) {
      byUnit[unit] = { unit: unit, ic: ic, road: road || '', caution: [], exits: [], _map: {} };
    }
    var e = byUnit[unit];
    if (!e.road && road) e.road = road;
    return e;
  }
  (res.candidates || []).forEach(function (c) {
    var e = entryFor(c.entry_unit, c.entry_ic, c.entry_road);
    if (!e) return;
    if (c.caution && c.caution.length) e.caution = c.caution;
    e._map[c.exit_unit] = {
      unit: c.exit_unit, ic: c.exit_ic, road: c.exit_road || '',
      estimate_min: null, candidate: c,
    };
  });
  (res.uncomputed_by_entry || []).forEach(function (g) {
    var e = entryFor(g.entry_unit, g.entry_ic, '');
    if (!e) return;
    (g.pairs || []).forEach(function (p) {
      if (!e._map[p.exit_unit]) {
        e._map[p.exit_unit] = {
          unit: p.exit_unit, ic: p.exit_ic, road: '',
          estimate_min: p.estimate_min, candidate: null,
        };
      }
    });
  });
  (res.uncomputed || []).forEach(function (p) {
    var e = entryFor(p.entry_unit, p.entry_ic, '');
    if (!e) return;
    if (!e._map[p.exit_unit]) {
      e._map[p.exit_unit] = {
        unit: p.exit_unit, ic: p.exit_ic, road: '',
        estimate_min: p.estimate_min, candidate: null,
      };
    }
  });
  var entries = Object.keys(byUnit).map(function (k) {
    var e = byUnit[k];
    e.exits = Object.keys(e._map).map(function (x) { return e._map[x]; });
    delete e._map;
    e.exits.sort(exitSort);
    return e;
  });
  entries.sort(function (a, b) {
    var av = entryBestMin(a), bv = entryBestMin(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return av - bv;
  });
  return entries;
}

/* ---------- 段階1: 乗るICを選ぶ ---------- */
function renderEntries() {
  var area = flowArea();
  area.innerHTML = '';
  var title = document.createElement('div');
  title.className = 'flow-title';
  title.appendChild(document.createTextNode('乗るICを選んでください'));
  var sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = state.origin.label + ' → ' + state.destination.label +
    '（選べる入口IC ' + state.entries.length + '件）';
  title.appendChild(sub);
  area.appendChild(title);

  state.entries.forEach(function (e) {
    var btn = document.createElement('button');
    btn.className = 'pick-row';
    btn.type = 'button';
    var main = document.createElement('div');
    main.className = 'pick-main';
    main.appendChild(document.createTextNode(e.ic));
    if (e.caution && e.caution.length) {
      var badge = document.createElement('span');
      badge.className = 'badge-caution';
      badge.textContent = '要注意';
      main.appendChild(badge);
    }
    var small = document.createElement('small');
    small.textContent = e.road || '';
    main.appendChild(small);
    var side = document.createElement('div');
    side.className = 'pick-side';
    var best = e.exits[0];
    if (best && best.candidate) {
      side.innerHTML = '';
      var t = document.createElement('div');
      t.className = 't';
      t.textContent = fmtTime(best.candidate.time_s);
      var d = document.createElement('div');
      d.textContent = '→ ' + best.ic + '（計算済み）';
      side.appendChild(t); side.appendChild(d);
    } else if (best && best.estimate_min != null) {
      side.innerHTML = '';
      var t2 = document.createElement('div');
      t2.className = 't';
      t2.textContent = '推定' + Math.round(best.estimate_min) + '分〜';
      var d2 = document.createElement('div');
      d2.textContent = '降りるIC ' + e.exits.length + '件';
      side.appendChild(t2); side.appendChild(d2);
    } else {
      side.textContent = '降りるIC ' + e.exits.length + '件';
    }
    btn.appendChild(main); btn.appendChild(side);
    btn.addEventListener('click', function () {
      state.selectedEntry = e;
      renderExits();
    });
    area.appendChild(btn);
  });
  afterFlowRender();
}

/* ---------- 段階2: 降りるICを選ぶ ---------- */
function renderExits() {
  var e = state.selectedEntry;
  if (!e) { renderEntries(); return; }
  var area = flowArea();
  area.innerHTML = '';
  var title = document.createElement('div');
  title.className = 'flow-title';
  title.appendChild(document.createTextNode('降りるICを選んでください'));
  var sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = e.ic + (e.road ? '（' + e.road + '）' : '') + ' から乗ります';
  title.appendChild(sub);
  area.appendChild(title);

  e.exits.forEach(function (x) {
    var btn = document.createElement('button');
    btn.className = 'pick-row';
    btn.type = 'button';
    var main = document.createElement('div');
    main.className = 'pick-main';
    main.appendChild(document.createTextNode(x.ic));
    if (x.candidate) {
      var tag = document.createElement('span');
      tag.className = 'tag-computed';
      tag.textContent = '計算済み';
      main.appendChild(tag);
    }
    var small = document.createElement('small');
    small.textContent = x.road || '';
    main.appendChild(small);
    var side = document.createElement('div');
    side.className = 'pick-side';
    if (x.candidate) {
      var t = document.createElement('div');
      t.className = 't';
      t.textContent = fmtTime(x.candidate.time_s);
      var d = document.createElement('div');
      d.textContent = x.candidate.distance_km.toFixed(1) + ' km';
      side.appendChild(t); side.appendChild(d);
    } else if (x.estimate_min != null) {
      side.textContent = '推定' + Math.round(x.estimate_min) + '分・タップで計算';
    }
    btn.appendChild(main); btn.appendChild(side);
    btn.addEventListener('click', function () { pickExit(x); });
    area.appendChild(btn);
  });
  area.appendChild(flowActions([
    { label: '乗るICを選び直す', onClick: renderEntries },
  ]));
  afterFlowRender();
}

/* ---------- 段階3: 選んだペアを計算して表示 ---------- */
function dropReasonText(reason) {
  switch (reason) {
    case 'surface_only':
      return 'この組み合わせでは高速道路を使うルートを引けませんでした（一般道の方が速い区間です）。';
    case 'entry_throat_not_passed':
      return '指定した入口ICを実際に通るルートを引けませんでした。';
    case 'exit_throat_not_passed':
      return '指定した出口ICを実際に通るルートを引けませんでした。';
    default:
      return 'この組み合わせではルートを引けませんでした' + (reason ? '（' + reason + '）' : '') + '。';
  }
}

function pickExit(x) {
  var e = state.selectedEntry;
  if (x.candidate) { showRoute(x.candidate); return; }
  showProgress('ルートを計算しています…',
    e.ic + ' → ' + x.ic + ' の指定ルートを計算しています。通常は数秒で終わります。');
  var body = odBody();
  body.mode = 'explicit_pair';
  body.entry_unit = e.unit;
  body.exit_unit = x.unit;
  postRoute(body)
    .then(function (res) {
      var cand = (res.candidates || [])[0];
      if (cand) {
        x.candidate = cand;
        if (cand.caution && cand.caution.length) e.caution = cand.caution;
        showRoute(cand);
        return;
      }
      var dropped = (res.meta && res.meta.dropped && res.meta.dropped[0]) || {};
      setFlowMessage(dropReasonText(dropped.reason));
      flowArea().appendChild(flowActions([
        { label: '降りるICを選び直す', onClick: renderExits },
        { label: '一般道ルートを見る', onClick: fetchSurface },
      ]));
      afterFlowRender();
    })
    .catch(function (err) {
      if (err.name === 'AbortError') { renderExits(); return; }
      setFlowMessage('計算に失敗しました。通信環境を確認してください。詳細: ' + err.message);
      flowArea().appendChild(flowActions([
        { label: '降りるICを選び直す', onClick: renderExits },
      ]));
      afterFlowRender();
    });
}

function drawRoute(shape, color) {
  var coords = decodeShape(shape);
  if (routeLine) map.removeLayer(routeLine);
  routeLine = L.polyline(coords, { color: color, weight: 5, opacity: 0.9 }).addTo(map);
  map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
}

function showRoute(c) {
  openSheet();
  drawRoute(c.shape, '#58a6ff');
  var area = flowArea();
  area.innerHTML = '';
  var box = document.createElement('div');
  box.className = 'route-summary';
  var big = document.createElement('div');
  big.className = 'big';
  big.textContent = c.entry_ic + ' → ' + c.exit_ic;
  if (c.caution && c.caution.length) {
    var badge = document.createElement('span');
    badge.className = 'badge-caution';
    badge.textContent = '要注意';
    big.appendChild(badge);
  }
  box.appendChild(big);
  var line = document.createElement('div');
  line.textContent = '所要時間 ' + fmtTime(c.time_s) + ' ・ 距離 ' + c.distance_km.toFixed(1) + ' km';
  box.appendChild(line);
  if (c.roads && c.roads.length) {
    var roads = document.createElement('div');
    roads.textContent = '経由: ' + c.roads.join(' ・ ');
    box.appendChild(roads);
  }
  var note = document.createElement('div');
  note.className = 'note-line';
  note.textContent = 'このルートは指定したICを実際に通る形で計算されています。所要時間は通常所要時間（渋滞未反映）です。';
  box.appendChild(note);
  area.appendChild(box);
  area.appendChild(flowActions([
    { label: '降りるICを選び直す', onClick: renderExits },
    { label: '乗るICを選び直す', onClick: renderEntries },
  ]));
  afterFlowRender();
}

/* ---------- 一般道ルート（IC未指定） ---------- */
function fetchSurface() {
  if (!requireOd()) return;
  if (state.surfaceCache) { showSurface(state.surfaceCache); return; }
  showProgress('一般道ルートを計算しています…', '高速道路を使わないルートを引いています。');
  postRoute(odBody())
    .then(function (res) {
      if (res.surface_candidate) {
        state.surfaceCache = res.surface_candidate;
        showSurface(res.surface_candidate);
        return;
      }
      if (res.meta && res.meta.surface_status) {
        setFlowMessage('一般道ルートは見つかりませんでした（surface_status: ' +
          res.meta.surface_status + '）。');
        return;
      }
      setFlowMessage('今のサービスは一般道ルートをまだ返しません（サービス側の対応待ちです）。ICを選ぶルート検索は通常どおり使えます。');
    })
    .catch(function (err) {
      if (err.name === 'AbortError') { resetFlowHint(); return; }
      setFlowMessage('一般道ルートの取得に失敗しました。詳細: ' + err.message);
    });
}

function showSurface(sc) {
  openSheet();
  drawRoute(sc.shape, '#ffb454');
  var area = flowArea();
  area.innerHTML = '';
  var box = document.createElement('div');
  box.className = 'route-summary surface';
  var big = document.createElement('div');
  big.className = 'big';
  big.textContent = '一般道ルート';
  box.appendChild(big);
  var line = document.createElement('div');
  line.textContent = '所要時間 ' + fmtTime(sc.time_s) + ' ・ 距離 ' + sc.distance_km.toFixed(1) + ' km';
  box.appendChild(line);
  if (sc.roads && sc.roads.length) {
    var roads = document.createElement('div');
    roads.textContent = '経由: ' + sc.roads.join(' ・ ');
    box.appendChild(roads);
  }
  var note = document.createElement('div');
  note.className = 'note-line';
  note.textContent = '高速道路を使わないルートです（料金はかかりません）。所要時間は通常所要時間（渋滞未反映）です。';
  box.appendChild(note);
  area.appendChild(box);
  area.appendChild(flowActions([
    { label: 'ICを選んで検索', onClick: startIcFlow },
  ]));
  afterFlowRender();
}

/* ---------- ICフローの開始 ---------- */
function startIcFlow() {
  if (!requireOd()) return;
  openSheet();
  showProgress('乗れるICを列挙しています…',
    '出発地と目的地から、指定できる入口ICの一覧を作っています。区間によっては十数秒かかることがあります。');
  var body = odBody();
  body.presentation = 'lazy';
  postRoute(body)
    .then(function (res) {
      if (res.surface_candidate !== undefined) {
        state.surfaceCache = res.surface_candidate;
      }
      state.entries = buildEntries(res);
      state.selectedEntry = null;
      if (!state.entries.length) {
        setFlowMessage('この区間では、指定できるICが見つかりませんでした。一般道ルートは確認できます。');
        flowArea().appendChild(flowActions([
          { label: '一般道ルートを見る', onClick: fetchSurface },
        ]));
        afterFlowRender();
        return;
      }
      renderEntries();
    })
    .catch(function (err) {
      if (err.name === 'AbortError') { resetFlowHint(); return; }
      setFlowMessage('ICの列挙に失敗しました。通信環境を確認してください。詳細: ' + err.message);
    });
}
document.getElementById('ic-flow-btn').addEventListener('click', startIcFlow);
document.getElementById('surface-btn').addEventListener('click', fetchSurface);

/* ---------- タブ切り替え ---------- */
document.querySelectorAll('#tabbar .tab').forEach(function (tab) {
  tab.addEventListener('click', function () {
    document.querySelectorAll('#tabbar .tab').forEach(function (t) {
      t.classList.toggle('active', t === tab);
    });
    ['view-navi', 'view-myroute', 'view-settings'].forEach(function (v) {
      document.getElementById(v).hidden = (v !== tab.dataset.view);
    });
    if (tab.dataset.view === 'view-navi') {
      setTimeout(function () { map.invalidateSize(); }, 50);
    }
  });
});

/* ---------- 設定: サービスURL ---------- */
(function initSettings() {
  var input = document.getElementById('service-url');
  input.placeholder = DEFAULT_SERVICE_BASE;
  input.value = SERVICE_BASE === DEFAULT_SERVICE_BASE ? '' : SERVICE_BASE;
  document.getElementById('service-url-save').addEventListener('click', function () {
    var v = input.value.trim().replace(/\/+$/, '');
    SERVICE_BASE = v || DEFAULT_SERVICE_BASE;
    try {
      if (v) window.localStorage.setItem('gatevia2.serviceBase', v);
      else window.localStorage.removeItem('gatevia2.serviceBase');
    } catch (e) { /* 保存できない環境では今回の表示中だけ反映 */ }
    document.querySelector('.setting-note').textContent =
      '保存しました（現在のサービスURL: ' + SERVICE_BASE + '）。次回の検索から反映されます。';
  });
})();

/* ---------- 初期化 ---------- */
updateOdRows();
loadFacilities().then(function (entries) {
  var el = document.getElementById('dict-status');
  if (el && entries.length) {
    el.textContent = '読み込み済み（' + entries.length + '件、IC/JCT/SA/PA）';
  }
});
