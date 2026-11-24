# ⚓ Deckhand

An HTML presentation editor, built for your AI.

Generate a deck with your AI (Claude Code, or anything that writes HTML), open it in Deckhand, and edit it like slides: click text to change it, drag things around, drop in images. For anything more than that, right-click and leave a note. When you're done, hand the whole lot back to your agent to implement.

The deck is a plain `.html` file the whole time. Deckhand writes every change straight back to it, so your hand edits and your AI's edits share one source of truth. Your conversation with your AI never overwrites what you did by hand.

## How it works

- The server serves your real `.html` file into an iframe, untouched. All the editor UI (selection, note pins, handles) lives on top, in the app, never in your file. The only thing Deckhand adds to the deck is a stable `data-ai-id` on editable elements so notes have something to anchor to.
- Every edit is written back to the file immediately (debounced).
- Notes go into a sidecar next to the deck: `<deck>.deckhand.json` (state) and `<deck>.deckhand.md` (a readable work order the agent reads).
- Manual moves and resizes are logged separately as "layout tweaks" with an instruction to reconcile them with the layout rather than hard-code pixels.

## Run it

```bash
npm install
npm run demo          # opens with the sample deck
# or point it at your own file:
node server.js /absolute/path/to/your-deck.html
```

Then open http://127.0.0.1:4321. If you start without a path, the app shows a file picker.

## The workflow

1. Ask your AI to build a presentation as a single HTML file.
2. Open it in Deckhand (or use "Open another deck" to switch files without restarting).
3. Edit by hand: double-click text to edit, single-click then drag to move, paste or add an image, drag a corner to resize.
4. Right-click anything to leave a note ("make this blue", "make all titles sans-serif"). Notes show as pins on the slide.
5. Apply the notes:
   - "Hand off to AI" runs your local Claude Code over all notes at once.
   - Or hit Run on a single note to apply just that one.
   - Either way the sidebar streams what Claude does (which file it read, what it edited), and the deck updates live. The caret next to "Hand off" also offers copy/show prompt if you'd rather drive it yourself.

## Running Claude

Deckhand shells out to your installed `claude` in the deck's folder with `--output-format stream-json` so the sidebar can show its actions. It's locked down hard: only `Read`/`Edit`/`Write`/`Glob`/`Grep` are allowed (no shell, git, or network), the working directory is the deck's folder, and an appended system prompt tells it to only edit this one HTML file and refuse anything else (so a note can't turn into "go review my PRs"). Runs are serialised, one at a time, because two Claudes editing the same file would corrupt it. For real parallelism, open a second deck: different files are safe to edit at once.

## Manual editing is deliberately tiny

Add text, edit text, move, add image, move/resize image. That's it. Everything else is a note. This keeps the surface area small and predictable, and pushes the hard stuff to the thing that's good at it.

## Notes / rough edges (MVP)

- A browser can't read a dragged file's real path, so opening is via the app's own file picker or a CLI arg, not OS drag-and-drop.
- Saving reserialises the document via the browser, so on-disk formatting gets normalised. Fine for a slide file; would want source-preserving edits later.
- Running needs `claude` on your PATH and permission to edit files (it uses `--permission-mode acceptEdits`). If it can't run, the caret menu still gives you the prompt to paste.
- Last writer wins if you and the AI edit at the exact same moment. In practice the flow is turn-based (you note, then it implements).
