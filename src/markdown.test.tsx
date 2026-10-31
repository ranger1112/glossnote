import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe('Markdown', () => {
  it('renders bold markers and bullet lists instead of raw syntax', () => {
    const html = render('**学术规范**：共同遵循的规则\n\n- 第一项\n- **第二项**');

    expect(html).toContain('<strong>学术规范</strong>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>第一项</li>');
    expect(html).toContain('<strong>第二项</strong>');
    expect(html).not.toContain('**');
  });

  it('renders headings, inline code and ordered lists', () => {
    const html = render('### 术语说明\n\n1. 使用 `Ctrl+Z` 撤销\n2. 第二项');

    expect(html).toContain('<h3>术语说明</h3>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<code>Ctrl+Z</code>');
  });

  it('keeps citations as plain text and escapes HTML', () => {
    const html = render('结论 [1]：<script>alert(1)</script>');

    expect(html).toContain('[1]');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});
