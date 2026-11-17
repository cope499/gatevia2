'use strict';
/* Gatevia 最小版: 地図 + 検索 + 指定IC候補 + ルート表示。
   ルーティングは稼働中のサービス POST /route_candidates (v9) を使う。 */

var SERVICE_BASE = 'https://sedate-landmark-shrunk.ngrok-free.dev';

var state = {
  origin: null,       // {lat, lon, label}
  destination: null,  // {lat, lon, label}
  tapTarget: 'origin',
  candidates: [],
  selected: -1,
  abort: null,
  timer: null,
};

var map = L.map('map', { zoomControl: false }).setView([35.681, 139.767], 11);
L.control.zoom({ position: 'bottomleft' }).addTo(map);
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
  var input = document.getElementById(which === 'origin' ? 'origin-input' : 'dest-input');
  if (input && document.activeElement !== input) input.value = label;
  updatePointStatus();
}

function updatePointStatus() {
  var el = document.getElementById('point-status');
  var o = state.origin, d = state.destination;
  if (o && d) {
    el.textContent = '出発地: ' + o.label + ' ／ 目的地: ' + d.label +
      ' — 「ルート検索」で候補を計算します。';
  } else if (o) {
    el.textContent = '出発地: ' + o.label + ' — 目的地を指定してください。';
  } else if (d) {
    el.textContent = '目的地: ' + d.label + ' — 出発地を指定してください。';
  } else {
    el.textContent = '出発地・目的地は、検索か地図タップで指定してください。';
  }
}

/* ---------- 地図タップで指定 ---------- */
map.on('click', function (e) {
  setPoint(state.tapTarget, e.latlng.lat, e.latlng.lng, '地図で指定した地点');
});

function setTapTarget(which) {
  state.tapTarget = which;
  document.getElementById('tap-origin').classList.toggle('active', which === 'origin');
  document.getElementById('tap-dest').classList.toggle('active', which === 'destination');
}
document.getElementById('tap-origin').addEventListener('click', function () { setTapTarget('origin'); });
document.getElementById('tap-dest').addEventListener('click', function () { setTapTarget('destination'); });

/* ---------- 現在地 ---------- */
function useCurrentLocation(setAsOrigin) {
  if (!navigator.geolocation) {
    showError('このブラウザでは現在地が使えません。');
    return;
  }
  navigator.geolocation.getCurrentPosition(function (pos) {
    var lat = pos.coords.latitude, lon = pos.coords.longitude;
    if (setAsOrigin) setPoint('origin', lat, lon, '現在地');
    map.setView([lat, lon], Math.max(map.getZoom(), 13));
  }, function (err) {
    showError('現在地を取得できませんでした（' + err.message + '）。');
  }, { enableHighAccuracy: true, timeout: 15000 });
}
document.getElementById('locate-btn').addEventListener('click', function () { useCurrentLocation(false); });
document.getElementById('origin-gps').addEventListener('click', function () { useCurrentLocation(true); });

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
function nominatimSearch(query) {
  var url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8' +
    '&countrycodes=jp&accept-language=ja&q=' + encodeURIComponent(query);
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
function geocode(query, which) {
  var box = document.getElementById('geo-results');
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
  attempt(0)
    .then(function (rows) {
      rows = dedupeRows(rows);
      if (!rows.length) {
        box.innerHTML = '<div class="geo-item">見つかりませんでした。</div>';
        return;
      }
      box.innerHTML = '';
      rows.forEach(function (row) {
        var item = document.createElement('div');
        item.className = 'geo-item';
        var name = (row.display_name || '').split(',')[0];
        item.innerHTML = '';
        item.appendChild(document.createTextNode(name));
        var small = document.createElement('small');
        small.textContent = row.display_name || '';
        item.appendChild(small);
        item.addEventListener('click', function () {
          var lat = parseFloat(row.lat), lon = parseFloat(row.lon);
          setPoint(which, lat, lon, name);
          map.setView([lat, lon], Math.max(map.getZoom(), 13));
          box.hidden = true;
        });
        box.appendChild(item);
      });
    })
    .catch(function (e) {
      box.innerHTML = '<div class="geo-item">検索に失敗しました（' + e.message + '）。</div>';
    });
}
function bindSearch(inputId, btnId, which) {
  var input = document.getElementById(inputId);
  document.getElementById(btnId).addEventListener('click', function () {
    var q = input.value.trim();
    if (q) geocode(q, which);
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var q = input.value.trim();
      if (q) geocode(q, which);
    }
  });
}
bindSearch('origin-input', 'origin-search', 'origin');
bindSearch('dest-input', 'dest-search', 'destination');

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

/* ---------- ルート検索 ---------- */
function fmtTime(timeS) {
  var m = Math.round(timeS / 60);
  if (m >= 60) return Math.floor(m / 60) + '時間' + (m % 60) + '分';
  return m + '分';
}

function showPanel(id) {
  ['progress-panel', 'result-panel', 'error-panel'].forEach(function (p) {
    document.getElementById(p).hidden = (p !== id);
  });
}
function hidePanels() {
  ['progress-panel', 'result-panel', 'error-panel'].forEach(function (p) {
    document.getElementById(p).hidden = true;
  });
}
function showError(msg) {
  hidePanels();
  document.getElementById('error-text').textContent = msg;
  document.getElementById('error-panel').hidden = false;
}
document.getElementById('error-close').addEventListener('click', hidePanels);
document.getElementById('result-close').addEventListener('click', hidePanels);

function startElapsedTimer() {
  var el = document.getElementById('progress-elapsed');
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

document.getElementById('cancel-btn').addEventListener('click', function () {
  if (state.abort) state.abort.abort();
});

document.getElementById('route-btn').addEventListener('click', function () {
  var o = state.origin, d = state.destination;
  if (!o || !d) {
    showError('出発地と目的地の両方を指定してください。');
    return;
  }
  var btn = document.getElementById('route-btn');
  btn.disabled = true;
  showPanel('progress-panel');
  startElapsedTimer();
  var controller = new AbortController();
  state.abort = controller;

  fetch(SERVICE_BASE + '/route_candidates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origin: { lat: o.lat, lon: o.lon },
      destination: { lat: d.lat, lon: d.lon },
    }),
    signal: controller.signal,
  })
    .then(function (r) {
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          throw new Error('サービスがエラーを返しました（HTTP ' + r.status + '）' +
            (j.error ? ': ' + j.error : ''));
        });
      }
      return r.json();
    })
    .then(function (res) { renderResults(res); })
    .catch(function (e) {
      if (e.name === 'AbortError') {
        hidePanels();
      } else {
        showError('候補の取得に失敗しました。通信環境を確認してください。詳細: ' + e.message);
      }
    })
    .finally(function () {
      btn.disabled = false;
      stopElapsedTimer();
      state.abort = null;
    });
});

function renderResults(res) {
  var cands = res.candidates || [];
  state.candidates = cands;
  state.selected = -1;
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  var summary = document.getElementById('result-summary');
  var list = document.getElementById('candidate-list');
  list.innerHTML = '';
  document.getElementById('selected-summary').hidden = true;

  if (!cands.length) {
    summary.textContent = '候補が見つかりませんでした';
    var div = document.createElement('div');
    div.className = 'cand-roads';
    div.textContent = 'この区間では、指定できるICの組み合わせでルートを引けませんでした。' +
      '対応状況によっては候補が出ないことがあります。';
    list.appendChild(div);
    showPanel('result-panel');
    return;
  }
  summary.textContent = '候補 ' + cands.length + ' 件（速い順）';

  var lastEntry = null;
  cands.forEach(function (c, i) {
    if (c.entry_ic !== lastEntry) {
      lastEntry = c.entry_ic;
      var head = document.createElement('div');
      head.className = 'group-head';
      head.textContent = '入口: ' + c.entry_ic + (c.entry_road ? '（' + c.entry_road + '）' : '');
      list.appendChild(head);
    }
    var item = document.createElement('div');
    item.className = 'candidate';
    item.dataset.index = i;

    var main = document.createElement('div');
    main.className = 'cand-main';
    var rank = document.createElement('span');
    rank.className = 'cand-rank';
    rank.textContent = (i + 1) + '.';
    var ics = document.createElement('div');
    ics.className = 'cand-ics';
    ics.appendChild(document.createTextNode(c.entry_ic + ' → ' + c.exit_ic));
    if (c.caution && c.caution.length) {
      var badge = document.createElement('span');
      badge.className = 'badge-caution';
      badge.textContent = '要注意';
      ics.appendChild(badge);
    }
    var roadsSmall = document.createElement('small');
    roadsSmall.textContent = (c.entry_road || '') + ' → ' + (c.exit_road || '');
    ics.appendChild(roadsSmall);
    var time = document.createElement('div');
    time.className = 'cand-time';
    var t = document.createElement('div');
    t.className = 't';
    t.textContent = fmtTime(c.time_s);
    var dd = document.createElement('div');
    dd.className = 'd';
    dd.textContent = c.distance_km.toFixed(1) + ' km';
    time.appendChild(t); time.appendChild(dd);
    main.appendChild(rank); main.appendChild(ics); main.appendChild(time);
    item.appendChild(main);

    if (c.roads && c.roads.length) {
      var roads = document.createElement('div');
      roads.className = 'cand-roads';
      roads.textContent = '経由: ' + c.roads.join(' ・ ');
      item.appendChild(roads);
    }
    item.addEventListener('click', function () { selectCandidate(i); });
    list.appendChild(item);
  });
  showPanel('result-panel');
}

function selectCandidate(i) {
  state.selected = i;
  var c = state.candidates[i];
  if (!c) return;
  document.querySelectorAll('.candidate').forEach(function (el) {
    el.classList.toggle('selected', parseInt(el.dataset.index, 10) === i);
  });
  var coords = decodeShape(c.shape);
  if (routeLine) map.removeLayer(routeLine);
  routeLine = L.polyline(coords, { color: '#1f6feb', weight: 5, opacity: 0.9 }).addTo(map);
  map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
  var box = document.getElementById('selected-summary');
  box.hidden = false;
  box.textContent = '選択中: ' + c.entry_ic + '（' + (c.entry_road || '') + '）から乗り、' +
    c.exit_ic + '（' + (c.exit_road || '') + '）で降りるルート。' +
    '所要時間 ' + fmtTime(c.time_s) + '、距離 ' + c.distance_km.toFixed(1) + ' km。' +
    'このルートは指定したICを実際に通る形で計算されています。';
}

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

updatePointStatus();
