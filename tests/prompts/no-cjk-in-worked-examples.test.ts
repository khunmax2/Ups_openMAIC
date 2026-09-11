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

// The second template root. The outline templates above decide what a course
// IS; these decide what the learner SEES -- the HTML of a simulation, a game,
// a 3D view, a diagram. The Thai orbit lesson's 启动 button came from here:
// simulation-content told the model, in prose rather than a fence, that the
// control button reads "启动" / "暂停" / "继续" / "重新开始". A guard that
// only looked at fences and only at lib/prompts passed while that shipped.
const GENERATION = join(__dirname, '..', '..', 'packages', '@openmaic', 'generation');

// Templates whose output is learner-facing markup. Nothing in them is an
// example of what a learner might say, so here CJK is banned outright, prose
// included: a label named in a bullet is copied exactly as one named in a
// fence.
const RENDERS_LEARNER_UI =
  /[\\/](?:simulation|game|visualization3d|diagram|code|procedural-skill)-content[\\/]/u;

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

function label(file: string): string {
  return file.startsWith(PROMPTS)
    ? file.slice(PROMPTS.length + 1)
    : file.slice(GENERATION.length + 1);
}

describe('prompt templates', () => {
  const files = [
    ...markdownFiles(PROMPTS),
    ...markdownFiles(join(GENERATION, 'templates')),
    ...markdownFiles(join(GENERATION, 'snippets')),
  ];

  it('finds the prompt templates in both roots', () => {
    expect(files.filter((f) => f.startsWith(PROMPTS)).length).toBeGreaterThan(0);
    expect(files.filter((f) => f.startsWith(GENERATION)).length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [label(f), f] as const))(
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

  it.each(files.filter((f) => RENDERS_LEARNER_UI.test(f)).map((f) => [label(f), f] as const))(
    'has no CJK anywhere in the learner-facing template %s',
    (_label, file) => {
      const offenders = readFileSync(file, 'utf8')
        .split('\n')
        .map((content, i) => ({ line: i + 1, content }))
        .filter(({ content }) => CJK.test(content))
        .map(({ line, content }) => `  line ${line}: ${content.trim().slice(0, 80)}`);
      expect(
        offenders,
        `This template produces the markup the learner sees; a label named here in ` +
          `any language is the label they get:\n${offenders.join('\n')}`,
      ).toEqual([]);
    },
  );

  // The course-title style examples are output shapes written as prose. One
  // line in each outline template; named explicitly because no general rule
  // separates them from the learner-input examples around them.
  it.each([
    join(PROMPTS, 'templates', 'interactive-outlines', 'system.md'),
    join(GENERATION, 'templates', 'requirements-to-outlines', 'system.md'),
  ])('shows course-title style examples without CJK in %s', (file) => {
    const style = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.includes('**Style**'));
    expect(style.length).toBeGreaterThan(0);
    expect(style.filter((l) => CJK.test(l))).toEqual([]);
  });
});
