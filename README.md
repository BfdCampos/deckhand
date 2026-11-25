# Deckhand

Make slide decks with your AI, then finish them by hand.

Deckhand is a local editor for decks that are a single HTML file. Describe the deck you want and your coding agent (Claude Code or Codex) builds it, or open one you already have. Then edit it like slides: change text in place, drag things around, drop in images. For anything bigger, right-click and leave a note, and hand the notes back to your agent in one click. The deck stays a plain `.html` file the whole time, and Deckhand only ever changes the bytes you changed.

<!-- screenshot: home -->

## Quick start

```bash
git clone https://github.com/BfdCampos/deckhand.git
cd deckhand
npm install
npm start
```

Deckhand opens in your browser at `http://127.0.0.1:4321`. If that port is busy it picks the next free one and prints the real address. Press Ctrl+C to stop it; any agent it started stops too.

To skip Home and go straight to a deck:

```bash
npm start -- /path/to/deck.html
```

Options: `--port <n>` to choose the port, `--no-open` to keep the browser closed.

## Create a deck

Type what you want on Home ("a 6-slide pitch for our new coffee subscription, warm and minimal, for the leadership team") and press Create deck, or Cmd/Ctrl+Enter.

Deckhand gives your agent a short build contract along with your description: one self-contained HTML file, one `<section class="slide">` per slide, no network requests, real text elements you can edit. While it works you see what it's doing, a timer and a Stop button. When it finishes, the new deck opens in the editor.

New decks are saved in `~/Deckhand`, named after your description (`coffee-subscription-pitch.html`, then `-2` if that's taken). If a run fails or you stop it, no half-written file is left behind.

<!-- screenshot: generation -->

## Open a deck

Pick one from Recent, use Browse… to find it, or paste its full path. Deckhand opens `.html` and `.htm` files, and tells you plainly when something isn't a deck ("That's a folder. Pick an .html file inside it."). Recent shows your last eight decks and marks any that have moved or been deleted as Missing.

New here? Use "Try the sample deck".

## Editing

Hand editing is deliberately tiny:

- Double-click text to edit it.
- Drag anything to move it.
- "+ Text" adds a text box to the slide in view.
- "+ Image" or paste adds an image to the current slide; drag a corner to resize it.
- Delete or Backspace removes the selected element.
- Cmd/Ctrl+Z undoes and Shift+Cmd/Ctrl+Z redoes, and every step is written to the file.

Everything else is a note. Right-click an element, say what you want ("make this two columns"), and tick "Apply to all similar elements" if it's a style change across the deck. Notes show as numbered pins on the slide and as cards in the sidebar, where you can edit or delete them.

Every change is saved as you go. Deckhand edits the file's text in place, so formatting, comments and anything the deck's own scripts do at runtime never leak into the saved file. The only thing it adds is a `data-ai-id` attribute on editable elements, so notes and edits have a stable anchor.

<!-- screenshot: editor with notes -->

## Hand off and runs

Deckhand looks for `claude` and `codex` on your PATH and in the usual install folders. If both are there, choose one from the agent chip and Deckhand remembers your choice. If neither is installed, you can still edit and leave notes, and copy the prompt to use with any AI.

"Hand off to Claude Code" sends all your notes at once, and "Run" on a note sends just that one. While the agent works:

- The deck is read-only, so you can watch without your edits and the agent's colliding.
- The activity panel shows what it reads and edits, and anything it was blocked from doing.
- The deck reloads live as the file changes, and stays on the slide you were looking at.

When it's done you'll see how many notes it applied. Notes it didn't get to stay open, so nothing disappears silently. Stop ends the run straight away. Revert changes puts the deck and its notes back exactly as they were before the run.

<!-- screenshot: run finished -->

## Where files live

- `~/Deckhand/`: decks you create.
- `<deck>.deckhand.json`: your notes and layout tweaks, next to the deck.
- `<deck>.deckhand.md`: a readable work order the agent follows. It ticks a note's box when it has applied it.
- `deckhand-assets/`: images you add, next to the deck.
- `~/.deckhand/state.json`: recent decks and your chosen agent.

## Security model

Deckhand is a local tool and is built to stay that way.

- It only listens on `127.0.0.1`.
- Every request must carry a `127.0.0.1` or `localhost` Host header, which stops DNS rebinding.
- API calls and the live-update socket must come from Deckhand's own page. Changes must be JSON, so another website can't read your folders, write your deck or start a run.
- Uploads must be real images (PNG, JPEG, GIF, WebP or SVG), up to 20 MB, and are only written to the deck's `deckhand-assets/` folder.
- Paths are checked after decoding, so `..` tricks are refused. Deckhand only serves web files from the deck's folder (pages, styles, scripts, images, fonts and media), never hidden files.
- Agents run in a temporary copy of the deck's folder. Only the deck, its work order and new images are copied back. Claude Code is limited to file tools inside that folder. Codex runs in its workspace sandbox with network access off.

One risk is accepted on purpose: the deck runs in the editor with its own scripts enabled, at the same address as Deckhand. A deck written to misbehave could use that to drive Deckhand. Only open decks you trust, as you would any file you run.

## Requirements

- Node.js 20 or later.
- For the AI features, [Claude Code](https://docs.claude.com/en/docs/claude-code/setup) or [Codex](https://developers.openai.com/codex/cli), installed and logged in. Deckhand uses your existing login, and you can edit by hand without either.
- macOS or Linux. Windows isn't tested.

## Development

```bash
npm test              # unit tests, then the browser tests
npm run test:unit     # unit tests only
npm run test:e2e      # browser tests only
npm run test:live     # one real Claude Code run (needs a logged-in claude; uses tokens)
```

The tests use fake `claude` and `codex` CLIs, so they never call a real agent. The browser tests need Playwright's Chromium, which you install once with `npx playwright install chromium`. Running the app itself doesn't need it.

## Licence

MIT
