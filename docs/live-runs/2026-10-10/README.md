# Live Claude run, 2026-10-10

First run of the live test plan from the "Service Report Test Set" page, with a real API key
(`USE_LIVE_CLAUDE=true`, model `claude-sonnet-5`). The key was set as an environment variable on
the API and worker processes only; it is not in any file here.

## What was and was not run

Only part of the plan could run, because only two distinct PDFs were supplied (a third upload was
a byte-identical copy of one of them).

| File supplied | In the Test Set? | Used for |
| --- | --- | --- |
| `..._Label_v3_S8_10-2-26.pdf` (SHA-256 starts `4f97a7db6b4a432c`) | Yes, "S8 PM" | Runs 1, 2, 3 |
| `..._Label_v3.pdf` and `..._Label_v3_1.pdf` (identical bytes, SHA-256 starts `23dca4caa316d58a`) | **No.** A different Aria report: WO-04215114, 4 pages, Nov 2025 | Runs 1, 2, 3 |

Not run, files not supplied: Fortessa 2024, the Aria intervention form (SHA `abe601de3dbbb74c`),
S8 upgrade, Fortessa 2021 and `fortessa-rescan-2024.pdf`. So the Fortessa date trap (11/04/2024),
the Aria signature-date trap, the S8 footer-date trap, the re-scan check and the Fortessa 2021
`root_cause` check are still open.

## Results

All eight extractions scored 13 of 13 checks (`scores.json`; scorer in `harness/score.py`).

**S8 PM, against the Test Set values (runs 1 and 2, four extractions):** model, serial, task code,
type (source `task_code`), work order, automatic resolution, visit date 2026-02-10 (not the
day-first 2026-10-02), labor 6.25, one PM kit (667009, qty 1), all four calibrated tools with exact
ids and both dates, and the work_performed key facts. Identical on all three repeats.

**Aria WO-04215114, against its own printed text (no Test Set entry exists):** reference built from
the PDF text layer. Labor 31.75 (6.5 + 7.5 + 12 + 5.75, travel excluded), one part (644651, qty 1),
serial, work order, type and key facts all match. Identical on all three repeats.

**Run 3 (duplicates), partial:** the identical-bytes copy was flagged at upload and at
classification; the first Aria upload and the S8 upload were not flagged; every upload went
through. Re-uploads in Run 2 were flagged as expected (warn only) and still extracted.

## Open points for you

1. **S8 `service_description`:** the reference is `11 Month Recurring / SMX0457374`; the model returned
   `11 Month Recurring` on every run, leaving out the contract number. Passes under the "key facts"
   rule. Decide whether the contract number belongs in the reference.
2. **Aria visit date on a multi-day visit:** labor runs 10 to 18 Nov 2025 (day-first). The model
   returned 2025-11-18 on every run, which is also the report and signature date. The Test Set has no
   rule for multi-day visits (first day 2025-11-10 would be the other reading).
3. **Aria `fault_description`** repeats the Subject and Description lines, including the serial
   text, so it reads twice. Harmless, but not tidy.
4. The scorer first required the words "ready to use"; the model wrote "ready for use". That was a
   scorer wording issue, not a model miss, and the check now accepts both.

## Cost and timing

19 model calls (11 classification, 8 extraction), 0 errors, 180,853 input and 11,555 output tokens.
Classification averaged 2.7 s, extraction 8.6 s (max 11.9 s).

## Files

- `raw-responses.jsonl`: one line per model call: request (PDF payload replaced by size and hash),
  full response, token usage, request id, elapsed seconds, or the error. The pre-restart smoke call
  that returned an "invalid PDF" error on the repo's synthetic fixture was not captured.
- `results/`: per run, the API's upload, classification and extraction results.
  `run1`/`run2`: classify and extract; `run3`: classify only.
- `harness/`: `capture_worker.py` (worker with every call recorded), `run_file.py` (drives one file
  through the API), `score.py`.
- These files contain real customer and technician details from the reports.

## Reproduce

Start Postgres, `alembic upgrade head`, seed instruments and templates, then start `uvicorn app.main:app`
and `python harness/capture_worker.py` (with `PYTHONPATH=backend`, `CAPTURE_FILE=<path>`,
`USE_LIVE_CLAUDE=true`, `ANTHROPIC_API_KEY` in the environment). Drive files with
`RESULTS_DIR=<dir> python harness/run_file.py <label> <pdf> --tag run1`.
