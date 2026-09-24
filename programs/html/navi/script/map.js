// ================================================================
// map.js
// 屋外の Google Maps 表示（初期化・経路ポリライン・現在ステップのマーカー）。
// ================================================================

// ================================================================
// Google Maps init
// ================================================================
function initMap() {
  map = new google.maps.Map(document.getElementById("map"), {
    zoom: 17,
    center: { lat: 35.61035, lng: 139.55466 },
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    rotateControl: true,
  });
  mapReady = true;
  if (_pendingMapCallback) {
    const fn = _pendingMapCallback;
    _pendingMapCallback = null;
    fn();
  }
}

function clearMapOverlays() {
  outdoorPolylines.forEach(p => p.setMap(null));
  outdoorPolylines = [];
  if (stepMarker) { stepMarker.setMap(null); stepMarker = null; }
}

function drawFullOutdoorRoute() {
  updateOutdoorPolylines(0);
}

function updateOutdoorPolylines(step) {
  outdoorPolylines.forEach(p => p.setMap(null));
  outdoorPolylines = [];

  let seg = [], segIdx = [];

  const flush = () => {
    if (seg.length < 2) { seg = []; segIdx = []; return; }

    let splitAt = -1;
    for (let i = segIdx.length - 1; i >= 0; i--) {
      if (segIdx[i] <= step) { splitAt = i; break; }
    }

    // 通過済み（グレー）
    if (splitAt > 0) {
      outdoorPolylines.push(new google.maps.Polyline({
        path: seg.slice(0, splitAt + 1).map(n => ({ lat: n.lat, lng: n.lng })),
        strokeColor: "#9E9E9E", strokeOpacity: 0.5, strokeWeight: 5, geodesic: true, map,
      }));
    }

    // これから（青）。通過済み末尾ノードを共有して線を繋ぐ
    const aheadFrom = Math.max(0, splitAt);
    if (aheadFrom < seg.length - 1) {
      outdoorPolylines.push(new google.maps.Polyline({
        path: seg.slice(aheadFrom).map(n => ({ lat: n.lat, lng: n.lng })),
        strokeColor: ACCENT_COLOR, strokeOpacity: 0.85, strokeWeight: 5, geodesic: true, map,
      }));
    }

    seg = []; segIdx = [];
  };

  pathCoords.forEach((n, idx) => {
    if (n.building === 0 && n.lat != null) { seg.push(n); segIdx.push(idx); }
    else flush();
  });
  flush();
}

// ================================================================
// Google Maps — step marker + route-direction heading
// ================================================================
function moveMapTo(node, step) {
  const pos = { lat: node.lat, lng: node.lng };
  if (!stepMarker) {
    stepMarker = new google.maps.Marker({
      position: pos, map,
      icon: {
        path: google.maps.SymbolPath.CIRCLE, scale: 10,
        fillColor: "#EF4444", fillOpacity: 1,
        strokeColor: "white", strokeWeight: 2,
      },
      zIndex: 10,
    });
  } else {
    stepMarker.setPosition(pos);
  }
  updateOutdoorPolylines(step);
  const heading = calcRouteHeading(step);
  if (heading != null) map.setHeading(heading);
  map.setCenter(pos);
  map.setZoom(17);
}
