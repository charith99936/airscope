"""Land/sea mask for map cells from Natural Earth 1:50m land polygons (public domain).

The model is trained on land stations only, so predictions over the sea are not shown.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import requests
from matplotlib.path import Path as MplPath

NE_LAND_URL = "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_50m_land.geojson"
# India's own point of view (Natural Earth "worldview" edition): Jammu & Kashmir and Ladakh shown in full
NE_INDIA_POV_URL = "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_10m_admin_0_countries_ind.geojson"


def _rings(geom):
    if geom["type"] == "Polygon":
        yield geom["coordinates"]
    elif geom["type"] == "MultiPolygon":
        yield from geom["coordinates"]


def land_mask(lat2d: np.ndarray, lon2d: np.ndarray, cache_dir) -> np.ndarray:
    path = Path(cache_dir) / "ne_50m_land.geojson"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        r = requests.get(NE_LAND_URL, timeout=120)
        r.raise_for_status()
        path.write_bytes(r.content)
    features = json.loads(path.read_text())["features"]
    pts = np.c_[lon2d.ravel(), lat2d.ravel()]
    lo_lon, hi_lon, lo_lat, hi_lat = pts[:, 0].min(), pts[:, 0].max(), pts[:, 1].min(), pts[:, 1].max()
    inside = np.zeros(len(pts), bool)
    for feat in features:
        for poly in _rings(feat["geometry"]):
            shell = np.asarray(poly[0])
            if (shell[:, 0].max() < lo_lon or shell[:, 0].min() > hi_lon
                    or shell[:, 1].max() < lo_lat or shell[:, 1].min() > hi_lat):
                continue
            hit = MplPath(shell).contains_points(pts)
            for hole in poly[1:]:
                hit &= ~MplPath(np.asarray(hole)).contains_points(pts)
            inside |= hit
    return inside.reshape(lat2d.shape)


def india_polygons(cache_dir) -> list:
    """India's polygons (each a list of rings) from Natural Earth's India point-of-view boundaries."""
    path = Path(cache_dir) / "ne_10m_admin_0_countries_ind.geojson"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        r = requests.get(NE_INDIA_POV_URL, timeout=300)
        r.raise_for_status()
        path.write_bytes(r.content)
    for feat in json.loads(path.read_text())["features"]:
        props = feat["properties"]
        if props.get("ADM0_A3") == "IND" or props.get("ISO_A3") == "IND" or props.get("ADMIN") == "India":
            return list(_rings(feat["geometry"]))
    raise ValueError("India not found in the Natural Earth file")


def india_mask(lat2d: np.ndarray, lon2d: np.ndarray, cache_dir) -> np.ndarray:
    """True for cells inside India (India's point of view, lakes/holes excluded)."""
    pts = np.c_[lon2d.ravel(), lat2d.ravel()]
    inside = np.zeros(len(pts), bool)
    for poly in india_polygons(cache_dir):
        hit = MplPath(np.asarray(poly[0])).contains_points(pts)
        for hole in poly[1:]:
            hit &= ~MplPath(np.asarray(hole)).contains_points(pts)
        inside |= hit
    return inside.reshape(lat2d.shape)


def _simplify(ring, tol):
    """Ramer-Douglas-Peucker on a closed ring of [lon, lat] points.

    A closed ring starts and ends on the same point, so it is split at the vertex farthest from the
    start and each half is simplified on its own.
    """
    pts = np.asarray(ring, float)
    if len(pts) < 5:
        return pts.tolist()
    if np.allclose(pts[0], pts[-1]):
        far = int(np.argmax(np.hypot(*(pts - pts[0]).T)))
        first, second = _simplify_open(pts[: far + 1], tol), _simplify_open(pts[far:], tol)
        return first[:-1].tolist() + second.tolist()
    return _simplify_open(pts, tol).tolist()


def _simplify_open(pts, tol):
    keep = np.zeros(len(pts), bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        seg = pts[b] - pts[a]
        norm = np.hypot(*seg) or 1e-12
        d = np.abs(np.cross(seg, pts[a + 1:b] - pts[a])) / norm
        k = int(np.argmax(d))
        if d[k] > tol:
            keep[a + 1 + k] = True
            stack += [(a, a + 1 + k), (a + 1 + k, b)]
    return pts[keep]


def india_geojson(cache_dir, out_path, tol=0.01, digits=3) -> int:
    """Simplified India outline for the web map. Returns the file size in bytes."""
    polys = []
    for poly in india_polygons(cache_dir):
        rings = [[[round(x, digits), round(y, digits)] for x, y in _simplify(r, tol)] for r in poly]
        if len(rings[0]) >= 4:
            polys.append([r for r in rings if len(r) >= 4])
    gj = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"name": "India"}, "geometry": {"type": "MultiPolygon", "coordinates": polys}}]}
    Path(out_path).write_text(json.dumps(gj, separators=(",", ":")))
    return Path(out_path).stat().st_size
