"""Debug-only tool: renders a Leaflet map (HTML) for each geo-clustering
pipeline stage — HDBSCAN raw clusters, noise/region merge, K-Means
day-split, weekday matching — so a developer can visually compare what
each stage actually produced instead of reading raw JSON.

Opt-in via ENABLE_CLUSTERING_DEBUG_VIZ=true. Writes into the same shared
`logs/itinerary-plan-debug` folder api-service already uses for its own
plan-debug JSON dumps (already gitignored wholesale — see
GP-Travel-Advisor-Backend/.gitignore: `api-service/logs/`), so these HTML
files need no separate gitignore entry.

Never allowed to break real itinerary planning: every public entry point
swallows its own errors.
"""
from __future__ import annotations

import datetime
import html
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.core.config import BACKEND_ROOT, settings

OUTPUT_DIR = (
    BACKEND_ROOT / "api-service" / "logs" / "itinerary-plan-debug" / "clustering-viz"
)

_PALETTE = [
    "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
    "#46f0f0", "#f032e6", "#bcf60c", "#008080", "#9a6324",
    "#800000", "#808000", "#000075", "#e6beff", "#fabebe",
]


def _point_dict(p: Any) -> Dict[str, Any]:
    return {
        "id": str(getattr(p, "id", "")),
        "name": str(getattr(p, "name", "")),
        "lat": float(p.latitude),
        "lon": float(p.longitude),
    }


class ClusteringDebugRecorder:
    """Accumulates one request's pipeline-stage snapshots; call `.save()`
    once at the end. No-ops entirely when the feature flag is off, so call
    sites can record unconditionally without checking the flag themselves.
    """

    def __init__(self, run_label: str):
        self.run_label = run_label
        self.stages: List[Dict[str, Any]] = []

    def record(
        self,
        stage_name: str,
        groups: Dict[str, List[Any]],
        noise: Optional[List[Any]] = None,
        restaurants: Optional[Dict[str, List[Any]]] = None,
        cafes: Optional[Dict[str, List[Any]]] = None,
        hotel: Optional[Any] = None,
    ) -> None:
        """`groups` maps a group label -> list of Place-like objects (must
        have .id/.name/.latitude/.longitude). `restaurants`/`cafes`, when
        given, must use the SAME labels as `groups` (e.g. the same "Day N"
        key) so the renderer draws each day's restaurants/cafes in that
        day's color; `hotel` is drawn once per stage in its own fixed
        color/icon."""
        if not settings.enable_clustering_debug_viz:
            return
        try:
            self.stages.append({
                "stage_name": stage_name,
                "groups": {
                    str(label): [_point_dict(p) for p in points]
                    for label, points in groups.items()
                },
                "noise": [_point_dict(p) for p in (noise or [])],
                "restaurants": {
                    str(label): [_point_dict(p) for p in points]
                    for label, points in (restaurants or {}).items()
                },
                "cafes": {
                    str(label): [_point_dict(p) for p in points]
                    for label, points in (cafes or {}).items()
                },
                "hotel": _point_dict(hotel) if hotel is not None else None,
            })
        except Exception:
            pass

    def save(self) -> Optional[Path]:
        if not settings.enable_clustering_debug_viz or not self.stages:
            return None
        try:
            OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
            timestamp = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H-%M-%S-%f")[:-3] + "Z"
            safe_label = "".join(
                c if c.isalnum() or c in "-_" else "-" for c in self.run_label
            )
            path = OUTPUT_DIR / f"{timestamp}_{safe_label}_clustering.html"
            path.write_text(_render_html(self.run_label, self.stages), encoding="utf-8")
            return path
        except Exception:
            return None


def _render_html(run_label: str, stages: List[Dict[str, Any]]) -> str:
    stages_json = json.dumps(stages)
    palette_json = json.dumps(_PALETTE)
    options_html = "".join(
        f'<option value="{i}">{html.escape(s["stage_name"])}</option>'
        for i, s in enumerate(stages)
    )
    safe_label = html.escape(run_label)
    return f"""<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Clustering debug — {safe_label}</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  html, body {{ margin:0; padding:0; height:100%; font-family: -apple-system, Segoe UI, sans-serif; }}
  #map {{ position:absolute; top:56px; bottom:0; left:0; right:0; }}
  #bar {{ height:56px; display:flex; align-items:center; gap:12px; padding:0 16px; background:#0f172a; color:white; box-sizing:border-box; }}
  #bar select {{ font-size:14px; padding:4px 8px; border-radius:6px; border:none; }}
  #stageInfo {{ color:#94a3b8; font-size:13px; }}
  #legend {{ position:absolute; bottom:16px; right:16px; background:white; padding:10px 14px; border-radius:8px; box-shadow:0 2px 10px rgba(0,0,0,.25); font-size:12px; max-height:45vh; overflow:auto; z-index:1000; min-width:160px; }}
  .legend-item {{ display:flex; align-items:center; gap:6px; margin:3px 0; }}
  .swatch {{ width:12px; height:12px; border-radius:50%; display:inline-block; flex-shrink:0; }}
  .swatch-square {{ width:11px; height:11px; border-radius:2px; display:inline-block; flex-shrink:0; }}
</style>
</head>
<body>
<div id="bar">
  <strong>{safe_label}</strong>
  <select id="stageSelect">{options_html}</select>
  <span id="stageInfo"></span>
</div>
<div id="map"></div>
<div id="legend"></div>
<script>
const STAGES = {stages_json};
const PALETTE = {palette_json};
const HOTEL_COLOR = '#212121';
const map = L.map('map');
L.tileLayer('https://{{s}}.tile.openstreetmap.org/{{z}}/{{x}}/{{y}}.png', {{
  attribution: '&copy; OpenStreetMap contributors',
  maxZoom: 19,
}}).addTo(map);
map.setView([10.78, 106.70], 11);

function squareIcon(color) {{
  return L.divIcon({{
    className: '',
    html: '<div style="width:14px;height:14px;background:' + color + ';border:2px solid white;border-radius:3px;box-shadow:0 0 2px rgba(0,0,0,.7);"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  }});
}}

function diamondIcon(color) {{
  return L.divIcon({{
    className: '',
    html: '<div style="width:12px;height:12px;background:' + color + ';border:2px solid white;box-shadow:0 0 2px rgba(0,0,0,.7);transform:rotate(45deg);"></div>',
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  }});
}}

function hotelIcon() {{
  return L.divIcon({{
    className: '',
    html: '<div style="font-size:20px;line-height:20px;filter:drop-shadow(0 0 2px white) drop-shadow(0 0 2px white);">🏨</div>',
    iconSize: [22, 22],
    iconAnchor: [11, 20],
  }});
}}

let markers = [];
function clearMarkers() {{
  markers.forEach(m => map.removeLayer(m));
  markers = [];
}}

// Real place data sometimes has several distinct POIs sharing the exact
// same (or a near-identical) lat/lon — e.g. missing precise geocoding
// falling back to one default point. Leaflet draws markers at literal
// pixel positions, so those would silently stack and hide all but the
// last one drawn, making the legend's count disagree with what's visibly
// clickable on the map. Spread same-point markers into a small rosette
// around their true location so every one of them stays visible.
function computeDisplayCoords(allPoints) {{
  const groups = {{}};
  allPoints.forEach(p => {{
    const key = p.lat.toFixed(5) + ',' + p.lon.toFixed(5);
    (groups[key] = groups[key] || []).push(p);
  }});
  const coordsByPoint = new Map();
  Object.values(groups).forEach(group => {{
    if (group.length === 1) {{
      coordsByPoint.set(group[0], [group[0].lat, group[0].lon]);
      return;
    }}
    const radius = 0.0015; // ~150m — visibly distinct at city zoom, still "same area"
    group.forEach((p, i) => {{
      const angle = (2 * Math.PI * i) / group.length;
      coordsByPoint.set(p, [
        p.lat + radius * Math.cos(angle),
        p.lon + radius * Math.sin(angle),
      ]);
    }});
  }});
  return coordsByPoint;
}}

function renderStage(idx) {{
  clearMarkers();
  const stage = STAGES[idx];
  const bounds = [];
  const legend = document.getElementById('legend');
  legend.innerHTML = '';
  let colorIdx = 0;
  const labels = Object.keys(stage.groups);

  const allPoints = [];
  labels.forEach(label => {{
    stage.groups[label].forEach(p => allPoints.push(p));
    ((stage.restaurants && stage.restaurants[label]) || []).forEach(p => allPoints.push(p));
    ((stage.cafes && stage.cafes[label]) || []).forEach(p => allPoints.push(p));
  }});
  if (stage.hotel) allPoints.push(stage.hotel);
  if (stage.noise) stage.noise.forEach(p => allPoints.push(p));
  const displayCoords = computeDisplayCoords(allPoints);

  labels.forEach(label => {{
    const color = PALETTE[colorIdx % PALETTE.length];
    colorIdx++;
    const pts = stage.groups[label];
    const restaurantPts = (stage.restaurants && stage.restaurants[label]) || [];
    const cafePts = (stage.cafes && stage.cafes[label]) || [];
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = '<span class="swatch" style="background:' + color + '"></span>' + label + ' (' + pts.length + ' điểm tham quan' +
      (restaurantPts.length ? ', ' + restaurantPts.length + ' nhà hàng' : '') +
      (cafePts.length ? ', ' + cafePts.length + ' cà phê' : '') + ')';
    legend.appendChild(item);
    pts.forEach(p => {{
      const [lat, lon] = displayCoords.get(p);
      const marker = L.circleMarker([lat, lon], {{
        radius: 7, color: color, fillColor: color, fillOpacity: 0.85, weight: 1
      }}).bindTooltip(p.name);
      marker.addTo(map);
      markers.push(marker);
      bounds.push([lat, lon]);
    }});
    restaurantPts.forEach(p => {{
      const [lat, lon] = displayCoords.get(p);
      const marker = L.marker([lat, lon], {{ icon: squareIcon(color) }})
        .bindTooltip(p.name + ' (nhà hàng)');
      marker.addTo(map);
      markers.push(marker);
      bounds.push([lat, lon]);
    }});
    cafePts.forEach(p => {{
      const [lat, lon] = displayCoords.get(p);
      const marker = L.marker([lat, lon], {{ icon: diamondIcon(color) }})
        .bindTooltip(p.name + ' (cà phê)');
      marker.addTo(map);
      markers.push(marker);
      bounds.push([lat, lon]);
    }});
  }});
  if (stage.hotel) {{
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = '<span>🏨</span>Khách sạn: ' + stage.hotel.name;
    legend.appendChild(item);
    const [lat, lon] = displayCoords.get(stage.hotel);
    const marker = L.marker([lat, lon], {{ icon: hotelIcon() }})
      .bindTooltip(stage.hotel.name + ' (khách sạn)');
    marker.addTo(map);
    markers.push(marker);
    bounds.push([lat, lon]);
  }}
  if (stage.noise && stage.noise.length) {{
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = '<span class="swatch" style="background:#999;opacity:.5"></span>Noise (' + stage.noise.length + ')';
    legend.appendChild(item);
    stage.noise.forEach(p => {{
      const [lat, lon] = displayCoords.get(p);
      const marker = L.circleMarker([lat, lon], {{
        radius: 5, color: '#999', fillColor: '#999', fillOpacity: 0.4, weight: 1
      }}).bindTooltip(p.name + ' (noise)');
      marker.addTo(map);
      markers.push(marker);
      bounds.push([lat, lon]);
    }});
  }}
  document.getElementById('stageInfo').textContent =
    labels.length + ' nhóm, ' + (stage.noise ? stage.noise.length : 0) + ' noise';
  if (bounds.length) map.fitBounds(bounds, {{ padding: [30, 30] }});
}}

document.getElementById('stageSelect').addEventListener('change', function (e) {{
  renderStage(parseInt(e.target.value, 10));
}});
renderStage(0);
</script>
</body>
</html>
"""
