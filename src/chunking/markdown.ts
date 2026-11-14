import { WindowChunker, type Section } from './window.js';

// PORT NOTE: the PHP reference matches these WITHOUT the /u flag, so its \s is
// ASCII whitespace only and "." matches any byte but \n. The lines are decoded
// as latin1 here (one char per byte) so the same patterns match the same bytes;
// JavaScript's own \s and "." are Unicode-wide and would not.
const FENCE = /^[ \t\n\x0B\f\r]{0,3}(```|~~~)/;
const HEADING = /^[ \t\n\x0B\f\r]{0,3}(#{1,6})[ \t]+([^\n]+?)[ \t#]*$/;

/**
 * Markdown-aware: windows never cross an ATX heading (# .. ######), and each
 * chunk carries the heading path above it. Headings inside fenced code blocks
 * are ignored. The heading line belongs to the section it opens.
 */
export class MarkdownChunker extends WindowChunker {
  protected override name(): string {
    return 'markdown';
  }

  protected override sections(bytes: Buffer): Section[] {
    const sections: Section[] = [];
    let stack = new Map<number, string>();
    let sectionStart = 0;
    let sectionPath: string[] = [];
    let offset = 0;
    let inFence = false;
    const length = bytes.length;
    while (offset < length) {
      const nl = bytes.indexOf(0x0a, offset);
      const lineEnd = nl === -1 ? length : nl + 1;
      const line = phpRtrim(bytes.subarray(offset, lineEnd).toString('latin1'), '\r\n');
      const heading = FENCE.test(line) ? null : HEADING.exec(line);
      if (FENCE.test(line)) {
        inFence = !inFence;
      } else if (!inFence && heading !== null) {
        if (offset > sectionStart) {
          sections.push([sectionStart, offset, sectionPath]);
        }
        // level => title; a heading closes every deeper level, even across skipped levels.
        const level = heading[1]!.length;
        stack = new Map([...stack].filter(([l]) => l < level));
        stack.set(level, Buffer.from(phpTrim(heading[2]!), 'latin1').toString('utf8'));
        stack = new Map([...stack].sort(([a], [b]) => a - b));
        sectionStart = offset;
        sectionPath = [...stack.values()];
      }
      offset = lineEnd;
    }
    if (length > sectionStart) {
      sections.push([sectionStart, length, sectionPath]);
    }

    return sections;
  }
}

/** PHP's trim() default: " \t\n\r\0\x0B" only. */
function phpTrim(value: string): string {
  return value.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
}

/** PHP's rtrim($value, $chars) for a set of single characters. */
function phpRtrim(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1]!)) {
    end--;
  }

  return value.slice(0, end);
}
