# Nir proposals: mockups

`index.html` is a single self-contained page (open it in a browser) with eight clickable mockups in the app's
Slate and indigo look. They show layout and flow only; nothing saves or calls the backend, and the example
data is made up.

1. AI search and summary box (one rounded field like the Home page, with an ask-by-voice microphone; recording is simulated)
2. Template editor that picks fields straight from the PDF
3. Home page (built: the Home tab, the screen the app opens on)
4. Small-laptop layouts (1024, 1280, 1366 wide)
5. Several PDFs in one batch, with a confirmation step per file
6. Filters that start small and grow
7. More ideas
8. The AI search on a phone (a phone-sized frame with the voice sheet, result cards and summary; recording is simulated)

## What is built from these

- **Home** (was "Today"): a box to ask about the reports in plain words, a drop area that takes files anywhere
  on the page, and four figures that explain themselves. The data comes from `GET /home/summary`.
  "Fields read without edits" compares what the reading first produced (`reports.original_fields`, new,
  migration `0010`) with what was saved, so it is empty until reports read after the migration are finalized.
- **Fields on the page** (review screen): every extracted value is drawn on the PDF where it was read
  (`GET /attachments/{id}/field-locations`). Positions are found by looking the value up in the PDF's text
  layer, so a scan or photo shows its pages without boxes. Reading the position from the model for scans is
  not built.
