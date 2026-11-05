# PaperToConcept

Upload a question paper PDF (questions only, or questions with an answer key) and get a
downloadable solutions PDF with, for every question:

- the question restated cleanly (with proper math typesetting)
- the topic and difficulty (Easy / Medium / Hard)
- the concept it tests
- the theory and formulas needed
- a step-by-step worked solution
- the final answer
- honest flags when the question is unclear, defective, or the answer key disagrees

## How it works

1. **Parse** - the PDF is read in your browser with PDF.js. Text PDFs are read as text;
   scanned/image pages are rendered and read visually by the model.
2. **Solve** - questions are sent to a Gemini model in small batches. The model returns
   structured solutions (concept, theory, steps, final answer, confidence).
3. **Verify** - when the PDF contains answers, solutions are cross-checked and mismatches
   are flagged instead of silently forced to match. Low-confidence solutions get a second
   checking pass.
4. **Render** - results are typeset (KaTeX for math) and exported to a styled PDF you can
   download or print.

## Privacy and cost

- The site itself is free and charges nothing. It is a fully client-side static page:
  your PDF is read in your browser and is never uploaded anywhere except to Google's
  Gemini API as part of solving requests.
- You bring **your own Gemini API key** from [Google AI Studio](https://aistudio.google.com/).
  The key is sent only to Google's API. It is NOT saved unless you tick "Remember key",
  which keeps it in this browser's local storage.
- What Google charges depends on YOUR Google project, which this app cannot see or control.
  A free-tier AI Studio project is not charged; if billing is enabled on your project,
  Google's API pricing applies. Rate limits and your usage tier are shown in AI Studio.
  The app batches requests, backs off on 429s and saves progress so an interrupted run
  can resume, but it cannot guarantee any particular speed or quota.
- AI solving is not perfect, especially on hard problems. Low-confidence and mismatched
  answers are flagged in the output - treat flags as "double-check by hand".

## Run it

It is a static site - open `index.html` or visit the deployed GitHub Pages URL.
No build step, no backend.

## Stack

Vanilla HTML/CSS/JS. CDN libraries: PDF.js, KaTeX, html2pdf.js.
