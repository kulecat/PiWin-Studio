import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/renderer/src/components/Markdown";

function render(text: string): string {
  return renderToStaticMarkup(createElement(Markdown, { text }));
}

const display = render(
  String.raw`$$\hat{x} = \frac{x - \mu}{\sqrt{\sigma^2 + \epsilon}} \cdot \gamma + \beta$$`,
);
assert.match(display, /class="katex-display"/);
assert.match(display, /class="katex"/);
assert.doesNotMatch(display, /\$\$/);

const inline = render("The loss is $x^2 + y^2$.");
assert.match(inline, /class="katex"/);
assert.doesNotMatch(inline, /\$x\^2 \+ y\^2\$/);

const fenced = render(["```tex", "$$x^2$$", "```"].join("\n"));
assert.match(fenced, /\$\$x\^2\$\$/);

console.log("MARKDOWN_MATH_SMOKE_OK");
