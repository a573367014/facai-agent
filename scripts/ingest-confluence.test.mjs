import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decodeHtmlEntities,
  extractPageLinks,
  sanitizeFileName,
  storageToText
} from "./ingest-confluence.mjs";

describe("ingest-confluence helpers", () => {
  it("extracts and dedupes ac:link page links from storage XHTML", () => {
    const html = `
      <ul>
        <li><ac:link><ri:page ri:space-key="ggq" ri:content-title="页面A" /><ac:plain-text-link-body><![CDATA[页面 A]]></ac:plain-text-link-body></ac:link></li>
        <li><ac:link><ri:page ri:content-title="页面B" ri:space-key="ggq" /><ac:plain-text-link-body><![CDATA[页面 B]]></ac:plain-text-link-body></ac:link></li>
        <li><ac:link><ri:page ri:space-key="ggq" ri:content-title="页面A" /><ac:plain-text-link-body><![CDATA[重复 A]]></ac:plain-text-link-body></ac:link></li>
      </ul>`;

    assert.deepEqual(extractPageLinks(html), [
      { spaceKey: "ggq", contentTitle: "页面A", anchorText: "页面 A" },
      { spaceKey: "ggq", contentTitle: "页面B", anchorText: "页面 B" }
    ]);
  });

  it("falls back to content title when link body is missing", () => {
    const html = `<ac:link><ri:page ri:space-key="ggq" ri:content-title="无正文链接" /></ac:link>`;
    assert.deepEqual(extractPageLinks(html), [
      { spaceKey: "ggq", contentTitle: "无正文链接", anchorText: "无正文链接" }
    ]);
  });

  it("returns empty list for empty input", () => {
    assert.deepEqual(extractPageLinks(""), []);
    assert.deepEqual(extractPageLinks(undefined), []);
  });

  it("converts storage XHTML into readable chunk-friendly text", () => {
    const html = `
      <h1>请假流程</h1>
      <p>员工请假的步骤如下&amp;说明。</p>
      <ul>
        <li>第一步：填写表单</li>
        <li>第二步：主管审批</li>
      </ul>
      <table><tbody>
        <tr><th>类型</th><th>天数</th></tr>
        <tr><td>事假</td><td>1</td></tr>
      </tbody></table>`;

    const text = storageToText(html);

    assert.match(text, /# 请假流程/);
    assert.match(text, /员工请假的步骤如下&说明。/);
    assert.match(text, /- 第一步：填写表单/);
    assert.match(text, /类型 \| 天数/);
    assert.equal(text.includes("<"), false);
  });

  it("strips ac:/ri: macro wrappers but keeps their text", () => {
    const html = `<p><ac:link><ri:page ri:content-title="X"/><ac:plain-text-link-body>显示文本</ac:plain-text-link-body></ac:link></p>`;
    const text = storageToText(html);
    assert.equal(text, "显示文本");
  });

  it("decodes numeric and named html entities", () => {
    assert.equal(decodeHtmlEntities("a&amp;b"), "a&b");
    assert.equal(decodeHtmlEntities("&#65;&#x42;"), "AB");
    assert.equal(decodeHtmlEntities("&#39;引号&#34;"), "'引号\"");
    assert.equal(decodeHtmlEntities(""), "");
  });

  it("sanitizes titles into safe file names", () => {
    assert.equal(sanitizeFileName("请假/流程:手册?"), "请假_流程_手册_");
    assert.equal(sanitizeFileName("   "), "confluence-page");
    const long = "标题".repeat(100);
    assert.ok(sanitizeFileName(long).length <= 120);
  });
});
