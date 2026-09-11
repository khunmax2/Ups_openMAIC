import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The prompt templates must not show the model Chinese *output*.
 *
 * A UAT of a Thai course found `启动` on a generated button and a fullwidth
 * `：` in a status label, with the body text otherwise correct Thai. The model
 * had not misread the language instruction — it had copied the worked examples,
 * which were Chinese: a course title style list of `"抛体运动实战", ...`, two
 * complete outline objects with Chinese titles, descriptions and keyPoints, and
 * a task-engine prompt announcing that the learner-facing product name is
 * `任务引擎`. Swapping the model did not help, because the model was never the
 * cause.
 *
 * The distinction this test draws is deliberate. Chinese in *prose* is usually
 * an example of something a learner might **say** — the language-inference
 * rules, the frustration signals in the director prompt, the "用中文讲" style
 * requests the agent must honour. Those are inputs, they are paired with English
 * equivalents, and deleting them would make the product worse for Chinese
 * users. What must stay clean is anything the model reads as a template for its
 * own answer: the fenced example blocks.
 *
 * So: CJK is allowed in prose, and banned inside ``` fences.
 */

const PROMPTS = join(__dirname, '..', '..', 'lib', 'prompts');

// CJK ideographs plus the fullwidth punctuation that travels with them — the
// `：` in the UAT screenshot never appeared in any example as an ideograph.
const CJK = /[一-鿿　-〿！-･]/u;

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return markdownFiles(full);
    return name.endsWith('.md') ? [full] : [];
  });
}

/** Lines inside ``` fences, with their 1-based line numbers. */
function fencedLines(text: string): Array<{ line: number; content: string }> {
  const out: Array<{ line: number; content: string }> = [];
  let inFence = false;
  text.split('\n').forEach((content, i) => {
    if (content.trimStart().startsWith('```')) {
      inFence = !inFence;
      return;
    }
    if (inFence) out.push({ line: i + 1, content });
  });
  return out;
}

describe('prompt templates', () => {
  const files = markdownFiles(PROMPTS);

  it('finds the prompt templates', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [f.slice(PROMPTS.length + 1), f] as const))(
    'has no CJK inside the worked examples of %s',
    (_label, file) => {
      const offenders = fencedLines(readFileSync(file, 'utf8'))
        .filter(({ content }) => CJK.test(content))
        .map(({ line, content }) => `  line ${line}: ${content.trim().slice(0, 80)}`);

      expect(
        offenders,
        `Chinese in an example block teaches the model to answer in Chinese ` +
          `regardless of the requested language:\n${offenders.join('\n')}`,
      ).toEqual([]);
    },
  );
});
