# Markdown Render Speed

A fast, dependency-free drop-in replacement for [marked](https://github.com/markedjs/marked) 18.1.3: `parse.js` renders exactly the HTML marked produces with its default options (CommonMark 0.31.2 + GFM 0.29), several times faster on the practice set, and `main.ts` is the harness driver that renders a whole set of cases.

Built for the [make.fun](https://make.fun) bounty **markdown-render-speed-02** ($250, top 20 paid).

[![make.fun](https://make.fun/badge.svg)](https://make.fun?ref=s11m3687)

## Usage

```js
import { parse } from './parse.js';
parse('# Hello\n\nSome *text*.');
// '<h1>Hello</h1>\n<p>Some <em>text</em>.</p>\n'
```

## Files

- `parse.js` — the renderer. `parse(markdown)` returns the HTML string.
- `main.ts` — reads `/input/cases.json`, writes `/output/html.json`.
- `LICENSE` — MIT.

## Verification

Against the practice set (680 CommonMark/GFM spec examples + 40 generated documents): **720/720 cases identical to marked 18.1.3**.
