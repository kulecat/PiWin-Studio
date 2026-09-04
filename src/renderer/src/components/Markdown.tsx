import { memo, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { codeToHtml } from "shiki";

const htmlCache = new Map<string, string>();

/**
 * Most agents emit a display formula as a single `$$...$$` line, while the
 * CommonMark math extension expects the delimiters on their own lines. Make
 * that common form a display block without touching inline content or fenced
 * code examples.
 */
function normalizeDisplayMath(text: string): string {
  const normalizedLines: string[] = [];
  let fencedWith: "`" | "~" | undefined;

  for (const line of text.split(/\r?\n/)) {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const marker = fence[1][0] as "`" | "~";
      if (!fencedWith) fencedWith = marker;
      else if (fencedWith === marker) fencedWith = undefined;
      normalizedLines.push(line);
      continue;
    }

    const compactDisplay = !fencedWith && /^(\s*)\$\$([\s\S]+?)\$\$\s*$/.exec(line);
    if (compactDisplay) {
      const [, indent, formula] = compactDisplay;
      normalizedLines.push(`${indent}$$`, formula.trim(), `${indent}$$`);
      continue;
    }

    normalizedLines.push(line);
  }

  return normalizedLines.join("\n");
}

function CodeBlock({ code, language }: { code: string; language: string }): React.JSX.Element {
  const cacheKey = `${language}\u0000${code}`;
  const [html, setHtml] = useState<string | undefined>(htmlCache.get(cacheKey));

  useEffect(() => {
    if (htmlCache.has(cacheKey)) {
      setHtml(htmlCache.get(cacheKey));
      return;
    }
    let cancelled = false;
    codeToHtml(code, {
      lang: language,
      themes: { light: "github-light-default", dark: "github-dark-default" },
      defaultColor: false,
    })
      .then((result) => {
        if (htmlCache.size > 500) htmlCache.clear();
        htmlCache.set(cacheKey, result);
        if (!cancelled) setHtml(result);
      })
      .catch(() => {
        // Unknown language: keep plain rendering
      });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, code, language]);

  if (html) {
    // eslint-disable-next-line react/no-danger
    return <div dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return (
    <pre>
      <code>{code}</code>
    </pre>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }): React.JSX.Element {
  const normalizedText = normalizeDisplayMath(text);

  return (
    <div className="markdown selectable">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          code(props) {
            const { children, className, ...rest } = props;
            const match = /language-(\w+)/.exec(className ?? "");
            const code = String(children).replace(/\n$/, "");
            if (match && code.includes("\n")) {
              return <CodeBlock code={code} language={match[1]} />;
            }
            if (!match && code.includes("\n")) {
              return <CodeBlock code={code} language="text" />;
            }
            return (
              <code className={className} {...rest}>
                {children}
              </code>
            );
          },
          pre({ children }) {
            return <>{children}</>;
          },
        }}
      >
        {normalizedText}
      </ReactMarkdown>
    </div>
  );
});
