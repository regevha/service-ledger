"""Runs the search evaluation set against the real model.

    ANTHROPIC_API_KEY=... python -m app.tools.search_eval [--model claude-haiku-5-5] [--price-in 1.0 --price-out 5.0]

Only the cases that need the model are sent (the rules-only cases are checked without any call). Prints each
case that came out different from the expected filters, the pass rate, and the tokens used. Give the prices
per million tokens (from the Anthropic pricing page) to also get the cost; none are built in, because a
stale figure is worse than none. One run is about 25 small calls.

The expected answers are in app/tools/search_eval_cases.py. A difference is not always a mistake of the model:
look at it, and change the case if the model's answer is the better one.
"""
from __future__ import annotations

import argparse
import sys
from types import SimpleNamespace

from app.config import get_settings
from app.services import report_query_model as m
from app.tools.search_eval_cases import CASES, KNOWN, TODAY


class _Recorder:
    """Wraps the real client so the token counts of each call can be added up."""

    def __init__(self, client, usage: dict[str, int]) -> None:
        self._client, self._usage = client, usage
        self.messages = SimpleNamespace(create=self._create)

    def with_options(self, **options):
        return _Recorder(self._client.with_options(**options), self._usage)

    def _create(self, **kwargs):
        response = self._client.messages.create(**kwargs)
        usage = getattr(response, "usage", None)
        self._usage["calls"] += 1
        self._usage["input"] += getattr(usage, "input_tokens", 0) or 0
        self._usage["output"] += getattr(usage, "output_tokens", 0) or 0
        self._usage["cache_read"] += getattr(usage, "cache_read_input_tokens", 0) or 0
        self._usage["cache_write"] += getattr(usage, "cache_creation_input_tokens", 0) or 0
        return response


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--model", help="model to test (default: the ANTHROPIC_SEARCH_MODEL setting)")
    parser.add_argument("--price-in", type=float, help="price per million input tokens")
    parser.add_argument("--price-out", type=float, help="price per million output tokens")
    args = parser.parse_args()

    settings = get_settings()
    if not settings.anthropic_api_key:
        print("ANTHROPIC_API_KEY is not set.", file=sys.stderr)
        return 2
    settings.use_live_claude = True
    settings.search_model_enabled = True
    settings.search_model_daily_cap = 0
    if args.model:
        settings.anthropic_search_model = args.model

    usage = {"calls": 0, "input": 0, "output": 0, "cache_read": 0, "cache_write": 0}
    real_get_client = m._get_client
    m._get_client = lambda: _Recorder(real_get_client(), usage)

    needs_model = [c for c in CASES if c["model"] is not None]
    passed = 0
    for c in needs_model:
        out = m.parse(c["question"], KNOWN, TODAY)
        ok = out.source == "ai" and out.filters == c["filters"] and out.notes == c["notes"]
        passed += ok
        if not ok:
            print(f"DIFFERENT  {c['question']!r}  (source: {out.source})")
            print(f"   expected {c['filters']} notes={c['notes']}")
            print(f"   got      {out.filters} notes={out.notes}")
    print(f"\nmodel: {settings.anthropic_search_model}")
    print(f"{passed} of {len(needs_model)} model cases as expected")
    print(f"calls {usage['calls']}, input tokens {usage['input']}, output tokens {usage['output']}, "
          f"cache read {usage['cache_read']}, cache write {usage['cache_write']}")
    if usage["calls"] and args.price_in is not None and args.price_out is not None:
        cost = (usage["input"] * args.price_in + usage["output"] * args.price_out) / 1_000_000
        print(f"cost of this run (cache tokens not priced): {cost:.4f}  ({cost / usage['calls']:.5f} per call)")
    return 0 if passed == len(needs_model) else 1


if __name__ == "__main__":
    raise SystemExit(main())
