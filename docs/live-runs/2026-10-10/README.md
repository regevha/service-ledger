# Live Claude run, 2026-10-10 (summary)

The raw responses, per-run results, scorer and harness from this run were removed from the repository
because they contained real customer and technician details. This page keeps the findings only, with
no names, serial numbers or work-order numbers. The full set is in the git history before the commit
that removed it, and with the project owner.

First run of the live test plan with a real API key (`USE_LIVE_CLAUDE=true`, model `claude-sonnet-5`),
key set as an environment variable on the API and worker only. Seven files: six from the Test Set page
(including one image-only re-scan) and one extra report uploaded by the user.

## Results

Every file went through classification and extraction with `reader = model`; the report type came
from the task code on every file, and every report resolved automatically to its own unit by serial.

- **Each file once, plus template fields:** all seven files passed every check (model, serial, task code,
  type, work order, visit date, labor hours, parts lists, calibrated tools, key facts of the free-text
  fields, an empty field left empty, a file-name work order not used).
- **Date traps, three repeats each:** every file returned the same correct date on all three repeats,
  including cases where the signature date, a footer date or a day-first reading would have been wrong.
- **Duplicates and matching:** a file uploaded twice with identical bytes was flagged at upload and at
  classification; a re-scan (different bytes) was flagged at classification through its work order and
  read correctly from the image alone; unrelated files and a form without a work order were not
  flagged. No upload was ever blocked.

## One miss

On one of three repeats, a free-text field kept a wrong serial from the Subject line, which the Test Set
says to leave out. The other two repeats did not. The serial read from the Installed Product block was
right on every run, so matching was not affected. Free-text fields are not fully repeatable, which bears
on the pending decision about a rule-based extractor. Of 23 extractions this was the only one with a
failing check.

## Open points

1. A contract number printed after the visit type was left out by the model on every run; it passes
   under the "key facts" rule. Decide whether it belongs in the reference.
2. For a multi-day visit the model returned the last labor day, which is also the report date. The Test
   Set has no rule for multi-day visits.
3. `fault_description` often repeats the Subject line, sometimes with serial text in it. It passes the
   key-facts rule but is the same behaviour as the miss above.
4. The scorer first required the words "ready to use"; the model wrote "ready for use". A scorer wording
   issue; the check now accepts both.
5. The template-field reference values on the Test Set page were written from extracted text and have
   not been checked by a person against the printed forms. The live reads agreeing with them is
   corroboration, not that check.

## Cost and timing

50 model calls (27 classification, 23 extraction), 0 errors, 384,645 input and 24,430 output tokens.
Classification averaged 2.7 s (max 3.2 s), extraction 5.9 s (max 11.9 s).
