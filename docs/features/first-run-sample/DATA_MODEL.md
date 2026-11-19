# Data model: first-run sample

One reversible migration (`0017_sample_flag`, renumber at merge): `is_sample BOOLEAN NOT NULL DEFAULT false` on `reports`, `instruments` and `places`. Downgrade drops the three columns after deleting sample rows (they hold no real data).

Fixed sample values (invented): place "Demo lab" (kind as the places table uses for a room or lab), instrument "Demo flow cytometer", model "Demo Sorter D1", serial `DEMO-0001`, maker "Demo Maker". Report fields use the generic repair template's own field names; low-confidence fields are below `field_confidence_threshold` (0.7).
