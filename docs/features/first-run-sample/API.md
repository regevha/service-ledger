# API: first-run sample

- `POST /sample-report` -> 201 `ReportOut`. Creates the demo place, demo instrument, a draft report (status `in_review`, `is_sample` true), its scan (a generated synthetic PDF), a succeeded classify job and a succeeded extract job holding the stored field confidences. If a sample report already exists it is returned unchanged (200). 409 if the generic repair template is missing.
- `DELETE /sample-report` -> 204. Runs `remove_sample_data`; 204 even when there is no sample.
- `ReportOut` gains `is_sample: bool`.
- Guards: `POST /reports/{id}/finalize` and the extraction-starting endpoint answer 409 for a sample report ("A sample report cannot be finalized / read again").
- No new list endpoint: the New report screen asks `GET /reports?status=finalized&limit=1` (samples are excluded from it) to decide whether the ledger is empty.
