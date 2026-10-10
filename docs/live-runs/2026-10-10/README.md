# Live Claude run, 2026-10-10

First run of the live test plan from the "Service Report Test Set" page, with a real API key
(`USE_LIVE_CLAUDE=true`, model `claude-sonnet-5`). The key was set as an environment variable on
the API and worker processes only; it is not in any file here.

## Files used

| File | Source | SHA-256 starts |
| --- | --- | --- |
| Fortessa 2024 (`fortessa-service-report.pdf`) | Test Set page | `4d56320954bc3684` |
| Fortessa 2024 re-scan (`fortessa-rescan-2024.pdf`, image only) | Test Set page | `cef6fcf76e7cacce` |
| Fortessa 2021 (`fortessa-repair-2021.pdf`) | Test Set page | `fc562543bd95bd5c` |
| Aria intervention form (`aria-intervention-form.pdf`) | Test Set page | `abe601de3dbbb74c` |
| S8 PM (`..._Label_v3_S8_10-2-26.pdf`) | uploaded by the user | `4f97a7db6b4a432c` |
| S8 upgrade (`s8-software-upgrade.pdf`) | Test Set page | `acbd45f81966b7d2` |
| Aria WO-04215114, Nov 2025 (`..._Label_v3.pdf`, sent twice with identical bytes) | uploaded by the user; **not on the Test Set page** | `23dca4caa316d58a` |

All six Test Set files were fetched from the Test Set page's published files and their hashes
match the prefixes printed there. The Aria WO-04215114 report is an extra: it is not the Test Set's
Aria form, so it was scored against its own printed text (labor 6.5 + 7.5 + 12 + 5.75 = 31.75,
travel excluded; one part 644651).

## Results

Every file went through classification and extraction with `reader = model`, the report type came
from the task code on every file, and every report resolved automatically to its own unit by serial.

**Run 1 (each file once) and Run 4 (template fields):** all six Test Set files and the extra Aria
report pass every check: model, serial, task code, type, work order, visit date, labor hours,
parts lists, the four S8 calibrated tools (exact ids and both dates), the key facts of every free-text
field, the Fortessa 2021 `root_cause` left empty, and the Aria form's file-name work order
(WO-03376771) not used.

**Run 2 (date traps, three repeats each):** Fortessa 2024 (2024-04-11), Aria form (2024-03-17, not the
25 Mar signature date), S8 PM (2026-02-10, not the day-first 2026-10-02), S8 upgrade (2026-06-16, not the
06/17 footer date) and the extra Aria report returned the same correct date on all three repeats.

**Run 3 (duplicates and matching):** all as expected, and no upload was ever blocked.
- Fortessa 2024 uploaded twice with identical bytes: flagged at upload and at classification.
- Re-scan (different bytes): not flagged at upload, flagged at classification by WO-03424229
  (it matched the original and the identical copy), and read correctly from the image alone:
  serial, work order, date 2024-04-11, labor 3.75, and the same text fields.
- Fortessa 2021 after 2024, S8 PM and S8 upgrade together, and the Aria form (no work order):
  none flagged.

## One miss

**S8 upgrade `service_description`, repeat 3 of 3:** the model returned
`Software upgrade from 6.2 to 6.3 - S8 S/N R6651580000057`, keeping the Subject line's wrong serial.
The Test Set says to leave that out, and the other two repeats and Run 1 did. The instrument serial
read from the Installed Product block was correct (`MP6651580000057`) on every run, so matching was
not affected. It shows that free-text fields are not fully repeatable, which bears on the pending
decision about a rule-based extractor. Scorer check `service_description_key_fact` /
`wrong_serial_not_used` fails for `run2_s8-upgrade_3.json` (both checks trip on the same text); that is
the only extraction with a failing check out of 23.

## Open points

1. **S8 PM `service_description`:** the reference is `11 Month Recurring / SMX0457374`; the model
   returned `11 Month Recurring` on every run, leaving out the contract number. Passes under the
   "key facts" rule. Decide whether the number belongs in the reference.
2. **Multi-day visit date (extra Aria report):** labor runs 10 to 18 Nov 2025. The model returned
   2025-11-18 on every run, which is also the report and signature date. The Test Set has no rule for
   multi-day visits.
3. **Subject text in free fields:** `fault_description` often repeats the Subject line, sometimes with
   the serial text in it (extra Aria report, Fortessa 2021: "... S/N R647794E6092"). These pass the key
   facts rule, but it is the same behaviour as the miss above.
4. The scorer first required the words "ready to use"; the model wrote "ready for use". That was a
   scorer wording issue, not a model miss, and the check now accepts both.
5. The template-field reference values on the Test Set page were written from the extracted text and
   have still not been checked by a person against the printed forms. The live reads agreeing with
   them is corroboration, not that check.

## Cost and timing

50 model calls (27 classification, 23 extraction), 0 errors, 384,645 input and 24,430 output tokens.
Classification averaged 2.7 s (max 3.2 s), extraction 5.9 s (max 11.9 s).

## Files in this folder

- `raw-responses.jsonl`: one line per model call: request (PDF payload replaced by size and hash),
  full response, token usage, request id, elapsed seconds, or the error. The earlier smoke call that
  returned an "invalid PDF" error on the repo's synthetic fixture was not captured.
- `results/`: per run, the API's upload, classification and extraction results.
  `run1`/`run1b`/`run2`: classify and extract; `run3`: classify only.
- `scores.json`: every check for every extraction, and the duplicate checks.
- `harness/`: `capture_worker.py` (worker with every call recorded), `run_file.py` (drives one file
  through the API), `score.py` (reference values and scoring).
- These files contain real customer and technician details from the reports.

## Reproduce

Start Postgres, `alembic upgrade head`, seed instruments and templates, then start `uvicorn app.main:app`
and `python harness/capture_worker.py` (with `PYTHONPATH=backend`, `CAPTURE_FILE=<path>`,
`USE_LIVE_CLAUDE=true`, `ANTHROPIC_API_KEY` in the environment). Drive files with
`RESULTS_DIR=<dir> python harness/run_file.py <label> <pdf> --tag run1`, then
`python harness/score.py <results dir> <raw jsonl>`.
