#!/usr/bin/env python3
"""Fail if any Alembic versions directory has more than one head.

Static check (no dependencies): parses `revision` and `down_revision` from each
migration file. A head is a revision no other revision names as its parent.
Usage: check_alembic_heads.py [root]
"""
import ast
import sys
from pathlib import Path


def read_ids(path: Path):
    tree = ast.parse(path.read_text())
    values = {}
    for node in tree.body:
        target = None
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target, value = node.targets[0], node.value
        elif isinstance(node, ast.AnnAssign):
            target, value = node.target, node.value
        if isinstance(target, ast.Name) and target.id in ("revision", "down_revision") and value is not None:
            try:
                values[target.id] = ast.literal_eval(value)
            except ValueError:
                pass
    return values.get("revision"), values.get("down_revision")


def heads_for(versions: Path):
    revisions, parents = set(), set()
    for f in sorted(versions.glob("*.py")):
        rev, down = read_ids(f)
        if not rev:
            continue
        revisions.add(rev)
        if isinstance(down, (tuple, list)):
            parents.update(down)
        elif down:
            parents.add(down)
    return sorted(revisions - parents)


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".")
    failed = False
    dirs = sorted(p for p in root.rglob("versions") if p.is_dir() and ("migrations" in p.parts or "alembic" in p.parts)
                  and ".git" not in p.parts and "node_modules" not in p.parts)
    if not dirs:
        print("No Alembic versions directories found; nothing to check.")
        return 0
    for d in dirs:
        heads = heads_for(d)
        if len(heads) > 1:
            failed = True
            print(f"FAIL {d}: {len(heads)} heads: {', '.join(heads)}")
        else:
            print(f"ok   {d}: head {heads[0] if heads else '(none)'}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
