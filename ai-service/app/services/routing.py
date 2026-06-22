"""
DEPRECATED — Không dùng trong production.

File này là dead code từ giai đoạn prototype ban đầu (được import bởi ai-service/main.py
đã bị xóa). TSP routing hiện tại được xử lý bởi:
  - app/services/itinerary/planner.py  — GA-based multi-day planner (production)
  - app/services/itinerary_optimizer.py — Greedy TSPTW day optimizer

File này có thể bị xóa trong phiên bản tiếp theo.
"""

import math
from typing import List, Dict, Any

try:
    from ortools.constraint_solver import routing_enums_pb2  # type: ignore[import]
    from ortools.constraint_solver import pywrapcp           # type: ignore[import]
    _ORTOOLS_AVAILABLE = True
except ImportError:
    _ORTOOLS_AVAILABLE = False

def haversine_distance(lat1, lon1, lat2, lon2):
    """
    Calculate the great circle distance between two points 
    on the earth (specified in decimal degrees)
    Returns distance in kilometers.
    """
    lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])

    dlon = lon2 - lon1 
    dlat = lat2 - lat1 
    a = math.sin(dlat/2)**2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon/2)**2
    c = 2 * math.asin(math.sqrt(a)) 
    r = 6371 # Radius of earth in kilometers
    return c * r

def create_distance_matrix(locations: List[Dict[str, float]]):
    """
    Create distance matrix for OR-Tools.
    Distances are scaled by 1000 and converted to integers as OR-Tools requires integers.
    """
    matrix = []
    for i in range(len(locations)):
        row = []
        for j in range(len(locations)):
            if i == j:
                row.append(0)
            else:
                dist = haversine_distance(
                    locations[i]['lat'], locations[i]['lng'],
                    locations[j]['lat'], locations[j]['lng']
                )
                row.append(int(dist * 1000))
        matrix.append(row)
    return matrix

def _nearest_neighbor_route(locations: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Greedy nearest-neighbor fallback — dùng khi OR-Tools không có sẵn."""
    if len(locations) <= 1:
        return locations

    coords = [
        {
            'lat': float(loc.get('latitude') or 0.0),
            'lng': float(loc.get('longitude') or 0.0),
        }
        for loc in locations
    ]

    unvisited = list(range(1, len(coords)))
    route = [0]

    while unvisited:
        current = route[-1]
        nearest = min(
            unvisited,
            key=lambda i: haversine_distance(
                coords[current]['lat'], coords[current]['lng'],
                coords[i]['lat'],       coords[i]['lng'],
            ),
        )
        route.append(nearest)
        unvisited.remove(nearest)

    return [locations[i] for i in route]


def optimize_route(locations: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Solves the TSP for the given locations.
    Assumes locations[0] is the depot (starting point).
    Falls back to greedy nearest-neighbor if OR-Tools is not installed.
    """
    if len(locations) <= 2:
        return locations

    if not _ORTOOLS_AVAILABLE:
        return _nearest_neighbor_route(locations)

    coords = [
        {
            'lat': float(loc.get('latitude') if loc.get('latitude') is not None else 0.0),
            'lng': float(loc.get('longitude') if loc.get('longitude') is not None else 0.0),
        }
        for loc in locations
    ]

    data: Dict[str, Any] = {}
    data['distance_matrix'] = create_distance_matrix(coords)
    data['num_vehicles'] = 1
    data['depot'] = 0

    manager = pywrapcp.RoutingIndexManager(  # type: ignore[possibly-undefined]
        len(data['distance_matrix']), data['num_vehicles'], data['depot']
    )
    routing = pywrapcp.RoutingModel(manager)  # type: ignore[possibly-undefined]

    def distance_callback(from_index: int, to_index: int) -> int:
        from_node = manager.IndexToNode(from_index)
        to_node   = manager.IndexToNode(to_index)
        return data['distance_matrix'][from_node][to_node]  # type: ignore[no-any-return]

    transit_callback_index = routing.RegisterTransitCallback(distance_callback)
    routing.SetArcCostEvaluatorOfAllVehicles(transit_callback_index)

    search_parameters = pywrapcp.DefaultRoutingSearchParameters()  # type: ignore[possibly-undefined]
    search_parameters.first_solution_strategy = (
        routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC  # type: ignore[possibly-undefined]
    )

    solution = routing.SolveWithParameters(search_parameters)

    if solution:
        ordered_locations = []
        index = routing.Start(0)
        while not routing.IsEnd(index):
            node_index = manager.IndexToNode(index)
            ordered_locations.append(locations[node_index])
            index = solution.Value(routing.NextVar(index))
        return ordered_locations

    return locations
