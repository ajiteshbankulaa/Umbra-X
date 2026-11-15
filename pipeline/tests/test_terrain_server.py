import pytest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from terrain_server import parse_query


def test_query_normalizes_longitude_and_defaults():
    assert parse_query("lat=-89&lon=222") == (-89, -138, 5, 96000)


@pytest.mark.parametrize("query", [
    "lat=nan&lon=0", "lat=-79&lon=0", "lat=-89&lon=0&mast=51",
    "lat=-89&lon=0&max_dist_m=999999", "lat=-89&lat=-88&lon=0",
    "lat=-89&lon=0&extra=1",
])
def test_query_rejects_unbounded_work(query):
    with pytest.raises(ValueError):
        parse_query(query)
