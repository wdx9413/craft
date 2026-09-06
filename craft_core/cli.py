from __future__ import annotations

import argparse
import json

from .service import CraftService


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="craft", description="Craft local capability and workflow store"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("info")
    commands.add_parser("list-sources")
    add = commands.add_parser("add-source")
    add.add_argument("path")
    add.add_argument("--label")
    scan = commands.add_parser("scan")
    scan.add_argument("--source-id")
    update = commands.add_parser("update-source")
    update.add_argument("source_id")
    state = update.add_mutually_exclusive_group()
    state.add_argument("--enable", action="store_true")
    state.add_argument("--disable", action="store_true")
    update.add_argument("--label")
    remove = commands.add_parser("remove-source")
    remove.add_argument("source_id")
    search = commands.add_parser("search")
    search.add_argument("query")
    search.add_argument("--limit", type=int, default=6)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    service = CraftService()
    if args.command == "info":
        result = service.info()
    elif args.command == "list-sources":
        result = service.source_list()
    elif args.command == "add-source":
        result = service.source_add(args.path, args.label)
    elif args.command == "scan":
        result = service.source_scan(args.source_id)
    elif args.command == "update-source":
        enabled = True if args.enable else False if args.disable else None
        result = service.source_update(args.source_id, enabled=enabled, label=args.label)
    elif args.command == "remove-source":
        result = service.source_remove(args.source_id)
    else:
        result = service.capability_search(args.query, args.limit)
    print(json.dumps(result, ensure_ascii=False, indent=2))
