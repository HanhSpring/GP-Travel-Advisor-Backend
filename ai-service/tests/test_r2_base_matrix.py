from pathlib import Path

import pytest

from retrain.r2_base_matrix import CANONICAL_FILES, LEGACY_FILES, resolve_source_files


def _touch_all(root: Path, names: tuple[str, ...]) -> None:
    for name in names:
        (root / name).write_bytes(name.encode())


def test_resolve_prefers_canonical_names(tmp_path: Path):
    _touch_all(tmp_path, CANONICAL_FILES)
    resolved = resolve_source_files(tmp_path)
    assert [source.name for source, _ in resolved] == list(CANONICAL_FILES)
    assert [target for _, target in resolved] == list(CANONICAL_FILES)


def test_resolve_maps_legacy_drive_names_to_canonical_r2_keys(tmp_path: Path):
    _touch_all(tmp_path, LEGACY_FILES)
    resolved = resolve_source_files(tmp_path)
    assert [source.name for source, _ in resolved] == list(LEGACY_FILES)
    assert [target for _, target in resolved] == list(CANONICAL_FILES)


def test_resolve_rejects_incomplete_matrix_set(tmp_path: Path):
    (tmp_path / CANONICAL_FILES[0]).write_bytes(b"matrix")
    with pytest.raises(FileNotFoundError):
        resolve_source_files(tmp_path)
