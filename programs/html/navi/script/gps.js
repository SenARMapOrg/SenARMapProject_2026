// ================================================================
// gps.js
// 現在地の取得と、現在地からの最寄りノード・方位の計算。
// ================================================================

// ================================================================
// GPS
// ================================================================
function captureGPS() {
  if (!navigator.geolocation) { alert("位置情報に対応していません。"); return; }
  document.getElementById("gps-text").textContent = "取得中...";
  hideAccuracyWarn();
  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;
      gpsCoords = { lat, lng };
      document.getElementById("gps-text").textContent =
        `${lat.toFixed(5)}, ${lng.toFixed(5)}  ±${Math.round(accuracy)}m`;
      showAccuracyWarn(accuracy);
      renderGpsOnMap(lat, lng, accuracy);
    },
    () => {
      document.getElementById("gps-text").textContent = "取得失敗";
      alert("位置情報を取得できませんでした。\nGPSが有効か確認してください。");
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
  );
}

function captureFacGPS() {
  if (!navigator.geolocation) { alert("位置情報に対応していません。"); return; }
  document.getElementById("fac-gps-text").textContent = "取得中...";
  const warn = document.getElementById("fac-accuracy-warn");
  warn.style.display = "none"; warn.className = "";
  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;
      facGpsCoords = { lat, lng };
      document.getElementById("fac-gps-text").textContent =
        `${lat.toFixed(5)}, ${lng.toFixed(5)}  ±${Math.round(accuracy)}m`;
      if (accuracy > 30) {
        warn.style.display = "block"; warn.className = "warn-low";
        warn.innerHTML = `GPS精度が低下しています（±${Math.round(accuracy)}m）。屋内の可能性があります。<br>`
          + `近くの<b>部屋番号の案内板</b>を確認して教室名で検索してください。`;
      }
      renderGpsOnMap(lat, lng, accuracy);
    },
    () => {
      document.getElementById("fac-gps-text").textContent = "取得失敗";
      alert("位置情報を取得できませんでした。\nGPSが有効か確認してください。");
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
  );
}

function renderGpsOnMap(lat, lng, accuracy) {
  if (gpsMarker) gpsMarker.setMap(null);
  gpsMarker = new google.maps.Marker({
    position: { lat, lng }, map,
    title: "現在地",
    icon: {
      path: google.maps.SymbolPath.CIRCLE, scale: 9,
      fillColor: "#4285F4", fillOpacity: 1,
      strokeColor: "white", strokeWeight: 2.5,
    },
    zIndex: 5,
  });
  if (gpsCircle) gpsCircle.setMap(null);
  gpsCircle = new google.maps.Circle({
    center: { lat, lng }, radius: accuracy, map,
    fillColor: "#4285F4", fillOpacity: 0.08,
    strokeColor: "#4285F4", strokeOpacity: 0.3, strokeWeight: 1.5,
  });
  switchView("map");
  map.panTo({ lat, lng });
}

function showAccuracyWarn(accuracy) {
  const el = document.getElementById("accuracy-warn");
  if (accuracy <= 30) { hideAccuracyWarn(); return; }
  el.style.display = "block";
  el.className = "warn-low";
  el.innerHTML =
    `GPS精度が低下しています（±${Math.round(accuracy)}m）。屋内の可能性があります。<br>` +
    `近くの<b>部屋番号の案内板</b>を確認して教室名で検索してください。`;
}

function hideAccuracyWarn() {
  const el = document.getElementById("accuracy-warn");
  el.style.display = "none";
  el.className = "";
}

// 最寄り屋外ノードがこの距離[m]より遠い場合はキャンパス外とみなして null を返す
const MAX_GPS_NODE_DIST_M = 500;

function findNearestNode(lat, lng) {
  const outdoor = allNodes.filter(n => n.building === 0 && n.lat != null && n.lng != null);
  if (!outdoor.length) return null;
  let best = null, bestD = Infinity;
  outdoor.forEach(n => {
    const d = haversine({ lat, lng }, { lat: n.lat, lng: n.lng });
    if (d < bestD) { bestD = d; best = n; }
  });
  return bestD <= MAX_GPS_NODE_DIST_M ? best : null;
}

function haversine(a, b) {
  const R = 6371000;
  const dφ = (b.lat - a.lat) * Math.PI / 180;
  const dλ = (b.lng - a.lng) * Math.PI / 180;
  const φ1 = a.lat * Math.PI / 180, φ2 = b.lat * Math.PI / 180;
  const s  = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// ================================================================
// Route heading
// ================================================================
function calcRouteHeading(step) {
  const cur = pathCoords[step];
  if (!cur || cur.lat == null) return null;
  for (let i = step + 1; i < pathCoords.length; i++) {
    const n = pathCoords[i];
    if (n.lat != null && n.lng != null) return bearingDeg(cur.lat, cur.lng, n.lat, n.lng);
  }
  for (let i = step - 1; i >= 0; i--) {
    const n = pathCoords[i];
    if (n.lat != null && n.lng != null) return bearingDeg(n.lat, n.lng, cur.lat, cur.lng);
  }
  return null;
}

function bearingDeg(lat1, lng1, lat2, lng2) {
  const phi1 = lat1 * Math.PI / 180, phi2 = lat2 * Math.PI / 180;
  const dl   = (lng2 - lng1) * Math.PI / 180;
  const y = Math.sin(dl) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
