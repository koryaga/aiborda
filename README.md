# aiborda

A live HTML page that acts as an interface to
[pi](https://github.com/earendil-works/pi): you write what you need, and pi
rebuilds the page itself in real time — writes text, draws a list, builds a
table — instead of replying in a separate chat. Along the way pi can edit
files on your computer or go to the internet if the answer needs it.

## What you need to run it

`aiborda` is only the page and the bridge to pi: all the AI, the model, the
keys and the tools come from pi — aiborda has none of its own.

- **Node.js 20 or newer** — the program itself is written in it.
- **[pi](https://github.com/earendil-works/pi)** — it provides the model, the
  API keys and internet access.

Install pi and connect a model to it (the example uses DeepSeek — any
provider pi supports will do):

```bash
npm install -g @earendil-works/pi-coding-agent
export DEEPSEEK_API_KEY=your-key
pi auth check --provider deepseek
```

`pi auth check` confirms that the key was found and the provider is ready.
The variables for other providers and the details are in the
[pi documentation](https://github.com/earendil-works/pi).

## Running it

```bash
git clone https://github.com/koryaga/aiborda.git
cd aiborda
npm install
npm start
```

Open `http://127.0.0.1:8730` in your browser.

## How to use it

The input field is at the bottom of the page. Write what you need and press
**Ctrl+Enter** (or **Cmd+Enter** on a Mac), or the **send** button. The reply
is not a new message in a feed but a change to the same page: pi edits the
DOM directly.

Examples of what you can ask for:

- "make a shopping list with three items"
- "draw a 3×4 table"
- "find out how many files are in the current folder" — the AI will run a
  shell command
- "remember that my name is Sergey" — it is stored and survives a page reload
- "go to site X and show me the top news"

Any text that appears on the page is usually editable right in the browser —
click and type. That is another way to answer the AI without typing anything
into the field at the bottom.

While a reply is in progress, the circle next to the button spins. The full
text of the AI's reasoning is visible in the terminal where `npm start` runs.

## Worth knowing

The AI has access to the terminal and the files on this computer, and it gets
that access immediately, without confirming each action. Do not use it to
open pages you do not trust — their content may try to give the AI its own,
malicious instructions.

## For developers

Architecture, protocol and known limitations are in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
