from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_ROOT))

from craft_core.service import CraftService  # noqa: E402
from craft_core.store import CraftStore  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=10_000)
    args = parser.parse_args()
    temp_root = Path(__file__).resolve().parent / ".tmp"
    temp_root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=temp_root) as temp:
        root = Path(temp)
        library = root / "library"
        library.mkdir()
        started = time.perf_counter()
        for index in range(args.count):
            folder = library / f"skill-{index:05d}"
            folder.mkdir()
            domain = "video storyboard continuity" if index == args.count - 1 else "general task helper"
            (folder / "SKILL.md").write_text(
                f"---\nname: skill-{index:05d}\ndescription: {domain}\n---\nHandle {domain}.\n",
                encoding="utf-8",
            )
        generated_seconds = time.perf_counter() - started
        service = CraftService(CraftStore(root / "data"))
        started = time.perf_counter()
        result = service.source_add(str(library))
        indexed_seconds = time.perf_counter() - started
        started = time.perf_counter()
        found = service.capability_search("video storyboard continuity")
        query_ms = (time.perf_counter() - started) * 1000
        print(json.dumps({
            "count": args.count,
            "generated_seconds": round(generated_seconds, 3),
            "indexed_seconds": round(indexed_seconds, 3),
            "query_ms": round(query_ms, 3),
            "added": result["scan"]["added"],
            "first_result": found["results"][0]["name"] if found["results"] else None,
        }, indent=2))


if __name__ == "__main__":
    main()
