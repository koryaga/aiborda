# aiborda

A live HTML page that acts as an interface to
[pi](https://github.com/earendil-works/pi): you write what you need, and pi
rebuilds the page itself in real time — writing text, drawing a list, building
a table — instead of answering in a separate chat. Along the way pi can edit
files on your computer or go out to the internet, if that is what the answer
takes.

## What you need to run it

`aiborda` is only the page and the bridge to pi: all the AI, the model, the
keys and the tools come from pi — aiborda has none of its own.

- **Node.js 20 or newer** — the program itself is written on it.
- **[pi](https://github.com/earendil-works/pi)** — it provides the model, the
  API keys and the internet access.

Install pi and connect a model to it (the example uses DeepSeek — any provider
pi supports will do):

```bash
npm install -g @earendil-works/pi-coding-agent
export DEEPSEEK_API_KEY=your-key
pi auth check --provider deepseek
```

`pi auth check` confirms that the key was found and the provider is ready. The
variables for other providers and the details are in the
[pi documentation](https://github.com/earendil-works/pi).

## Running it

```bash
git clone https://github.com/koryaga/aiborda.git
cd aiborda
npm install
npm start
```

Open `http://127.0.0.1:8730` in a browser.

## How to use it

The input field is at the bottom of the page. Write what you need and press
**Ctrl+Enter** (or **Cmd+Enter** on a Mac), or the **send** button. The answer
is not a new message in a feed but a change to the same page: pi edits the DOM
directly.

The answer comes in the form that fits it, not as a paragraph of text: a single
number is set large, items become a table, amounts to compare become a chart, a
plan becomes a checklist you can tick.

Examples of what you can ask for:

- "make a shopping list with three items"
- "compare the population of Paris, Berlin and Madrid" — a chart, with its
  numbers in an editable table
- "find out how many files are in the current folder" — the AI will run a
  command in the terminal
- "remember that my name is Sergey" — this is saved and survives a page reload
- "go to site X and show me the top news"

### Three ways to answer the AI

- **Type into the field at the bottom.**
- **Edit the page itself.** Text the AI puts on the page is editable — all of
  it except buttons, links and status messages: click and type — fix a number
  in a table, rewrite a line, untick a step. Then press send, and the AI gets
  exactly what you changed and where.
- **Point, then ask.** Click something on the page, or select a few words in
  it, then type your question into the field: "why is this so big?". The AI
  knows what "this" is.

While an answer is in progress, the dot next to the button spins; it turns red
if something went wrong. The details are in the **log** under the button — it
stays collapsed until you open it. The full text of the AI's reasoning is
visible in the terminal where `npm start` is running.

## Worth knowing

The AI has access to the terminal and the files on this computer, and it gets
that access immediately, without confirming each action. Do not use it to open
pages you do not trust — their contents may try to give the AI instructions of
their own, malicious ones.

## For developers

The architecture, the protocol and the known limitations are in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
